/**
 * Config: one raw rules object in, one frozen runtime config out.
 *
 * Structural mistakes throw. A policy plugin that silently runs with half its deny rules,
 * or with a mistyped class table, is worse than one that refuses to start — and a key that
 * no longer exists (the 1.x `owners` / `claims.readOnly` / `claims.exempt`) must say so
 * instead of being ignored, because ignoring it makes the user believe a changed policy is
 * in force.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DEFAULT_CAPABILITIES, DEFAULT_GROUPS, EFFECTS, OWNERS, compileCapabilities } from './capability.js'
import { resolveLedgerFile, resolveRulesFile, resolveStateDir } from './paths.js'
import { isPlainObject, nonEmptyString } from './util.js'

const CONFLICT_MODES = ['ask', 'deny', 'allow']
const AUDIT_MAX_BYTES = 4 * 1024 * 1024
const TTL_MINUTES = 30

const TOP_LEVEL = ['scope', 'capabilities', 'claims', 'deny', 'ask', 'agents', 'audit', 'watch']

/** Keys that existed in 1.x and were replaced by a better concept, never by a tweak. */
const REPLACED = {
  owners: 'capabilities（按 (tool, action) 与 effect 分类，而不是按工具名一遍遍正则）',
  selection: '闸门制已固定，无需选择模式（该字段从不影响拦截）',
  'claims.readOnly': 'capabilities 里 effect: "observe" 的行',
  'claims.exempt': 'capabilities 里 effect: "select" 的行',
}

const SCOPE_OWNERS = ['app', 'page', 'native', 'pixel', 'capture', 'system']

export const DEFAULTS = Object.freeze({
  /* The spaces whose requests are scheduled. Values are space names, not tool classes. */
  scope: Object.freeze({ spaces: Object.freeze([...SCOPE_OWNERS]) }),
  /* Empty means "use the shipped table"; entries here are prepended, so a deployment can
   * override or narrow any built-in row without forking the table. */
  capabilities: Object.freeze([]),
  claims: Object.freeze({
    enabled: true,
    conflict: 'ask',
    maxAttempts: 2,
    ttlMinutes: TTL_MINUTES,
    /* Derived from which spaces can denote the same physical surface, not hand-listed. */
    groups: DEFAULT_GROUPS,
  }),
  deny: Object.freeze([]),
  ask: Object.freeze([]),
  agents: Object.freeze([]),
  audit: Object.freeze({ enabled: true, file: null, maxBytes: AUDIT_MAX_BYTES }),
  /* Re-read the rules file when it changes, so a config edit does not need a profile reload */
  watch: true,
})

/* ------------------------------------------------------------------ file loading */

export function readRulesFile (file) {
  if (!existsSync(file)) return { raw: {}, present: false, text: '' }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`capability-policy: 读不了规则文件 ${file}（${error.message}）`)
  }
  try {
    return { raw: JSON.parse(text), present: true, text }
  } catch (error) {
    throw new Error(`capability-policy: ${file} 不是合法 JSON（${error.message}）。规则未生效，改好再重载。`)
  }
}

export const digestOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)

export function loadConfig (options = {}) {
  const file = options.file ?? resolveRulesFile(options.baseDir ?? process.cwd())
  const { raw, text } = readRulesFile(file)
  return resolveConfig(raw, {
    ...options,
    baseDir: options.baseDir ?? dirname(file),
    rulesFile: file,
    rulesDigest: digestOf(text),
  })
}

/* --------------------------------------------------------------------- matching */

function compilePattern (value, where, problems) {
  if (typeof value !== 'string' || value === '') {
    problems.push(`${where}: 必须是非空正则字符串`)
    return undefined
  }
  try {
    return new RegExp(value)
  } catch (error) {
    problems.push(`${where}: 正则无效 "${value}"（${error.message}）`)
    return undefined
  }
}

function staticRule (entry, where, problems) {
  if (!isPlainObject(entry)) {
    problems.push(`${where}: 必须是对象`)
    return undefined
  }
  const tool = compilePattern(entry.tool, `${where}.tool`, problems)
  if (tool === undefined) return undefined
  let args
  if (entry.args !== undefined) args = compilePattern(entry.args, `${where}.args`, problems)
  return {
    tool,
    args,
    reason: nonEmptyString(entry.reason) ? entry.reason : undefined,
  }
}

/**
 * `textOf` is a thunk: arguments are only stringified when a rule actually inspects them.
 * Serialising every call up front would tax the whole tool path for rules that do not exist.
 */
const ruleMatches = (rule, name, textOf) => {
  if (!rule.tool.test(name)) return false
  if (rule.args === undefined) return true
  const text = textOf()
  return text !== null && text !== undefined && rule.args.test(text)
}

/**
 * Static rules, in the one order that matters: an outright deny always beats an allowlist,
 * which always beats a confirmation prompt. Both enforcement paths (the synchronous guard
 * and the pre-execute waterfall) call this, so they cannot drift apart.
 */
export function evaluateStaticRules (config, { name, argsText, agent }) {
  const textOf = typeof argsText === 'function' ? argsText : () => argsText

  for (const rule of config.deny) {
    if (!ruleMatches(rule, name, textOf)) continue
    return { kind: 'deny', source: 'deny-rule', code: 'capability_policy_denied', reason: rule.reason ?? 'blocked by capability-policy' }
  }

  const agentRule = config.agents.find(entry =>
    (entry.id !== undefined && entry.id === agent) ||
    (entry.prefix !== undefined && agent.startsWith(entry.prefix)))
  if (agentRule !== undefined) {
    if (agentRule.deny.some(rx => rx.test(name))) {
      return { kind: 'deny', source: 'agent-deny', code: 'capability_policy_denied', reason: `tool ${name} is denied for this session by capability-policy` }
    }
    if (agentRule.allow.length > 0 && !agentRule.allow.some(rx => rx.test(name))) {
      return { kind: 'deny', source: 'agent-allowlist', code: 'capability_policy_denied', reason: `tool ${name} is not in this session's allow list (capability-policy)` }
    }
  }

  for (const rule of config.ask) {
    if (!ruleMatches(rule, name, textOf)) continue
    const reason = rule.reason ?? 'needs confirmation'
    return { kind: 'ask', source: 'ask-rule', reason, displayReason: { en: reason, zh: reason } }
  }

  return undefined
}

/* ----------------------------------------------------------------- capabilities */

const WHEN_KEYS = ['tool', 'actions', 'present', 'absent']

function capabilityRow (entry, where, problems) {
  if (!isPlainObject(entry)) {
    problems.push(`${where}: 必须是对象 { tool, owner, effect?, cases? }`)
    return undefined
  }
  const tool = compilePattern(entry.tool, `${where}.tool`, problems)
  if (tool === undefined) return undefined

  const owner = entry.owner
  if (!OWNERS.includes(owner) || owner === 'other') {
    problems.push(`${where}.owner: 必须是 ${OWNERS.filter(name => name !== 'other').join('/')} 之一（当前 ${JSON.stringify(owner)}）`)
    return undefined
  }
  const effect = entry.effect ?? 'act'
  if (!EFFECTS.includes(effect)) {
    problems.push(`${where}.effect: 只能是 ${EFFECTS.join(' / ')}（当前 ${JSON.stringify(entry.effect)}）`)
    return undefined
  }

  const cases = []
  if (entry.cases !== undefined) {
    if (!Array.isArray(entry.cases)) problems.push(`${where}.cases: 必须是数组`)
    else {
      for (const [index, item] of entry.cases.entries()) {
        const at = `${where}.cases[${index}]`
        if (!isPlainObject(item)) {
          problems.push(`${at}: 必须是对象 { when?, effect }`)
          continue
        }
        if (!EFFECTS.includes(item.effect)) {
          problems.push(`${at}.effect: 只能是 ${EFFECTS.join(' / ')}`)
          continue
        }
        let when
        if (item.when !== undefined) {
          if (!isPlainObject(item.when)) {
            problems.push(`${at}.when: 必须是对象`)
            continue
          }
          const unknown = Object.keys(item.when).filter(key => !WHEN_KEYS.includes(key))
          if (unknown.length > 0) {
            problems.push(`${at}.when: 未知条件 ${unknown.map(key => JSON.stringify(key)).join(', ')}（可用 ${WHEN_KEYS.join('/')}）`)
            continue
          }
          when = {}
          if (item.when.tool !== undefined) {
            const pattern = compilePattern(item.when.tool, `${at}.when.tool`, problems)
            if (pattern === undefined) continue
            when.tool = pattern
          }
          for (const key of ['actions', 'present', 'absent']) {
            if (item.when[key] === undefined) continue
            if (!Array.isArray(item.when[key]) || !item.when[key].every(nonEmptyString)) {
              problems.push(`${at}.when.${key}: 必须是非空字符串数组`)
              continue
            }
            when[key] = [...item.when[key]]
          }
        }
        cases.push({ when, effect: item.effect })
      }
    }
  }

  /* A capture call is read-only by definition; claiming through it would lock the surface
   * that the evidence was collected from. */
  if (owner === 'capture') {
    const offending = [effect, ...cases.map(item => item.effect)].filter(value => value !== 'observe')
    if (offending.length > 0) {
      problems.push(`${where}: capture 类只能是 observe（发现 ${offending.join(' / ')}）`)
      return undefined
    }
  }

  return { tool: tool.source, owner, effect, cases }
}

/* ----------------------------------------------------------------- resolveConfig */

export function resolveConfig (raw = {}, options = {}) {
  if (!isPlainObject(raw)) throw new Error('capability-policy: 规则必须是 JSON 对象')

  const problems = []
  const baseDir = options.baseDir ?? process.cwd()

  for (const key of Object.keys(raw)) {
    if (key.startsWith('_')) continue
    if (TOP_LEVEL.includes(key)) continue
    const hint = REPLACED[key]
    problems.push(hint === undefined
      ? `未知配置项 "${key}"（可用 ${TOP_LEVEL.join(' / ')}）`
      : `${key} 在 2.0 已被移除，改用 ${hint}`)
  }
  for (const removed of ['readOnly', 'exempt']) {
    if (isPlainObject(raw.claims) && raw.claims[removed] !== undefined) {
      problems.push(`claims.${removed} 在 2.0 已被移除，改用 ${REPLACED[`claims.${removed}`]}`)
    }
  }

  /* scope */
  const scopeSource = raw.scope ?? DEFAULTS.scope
  if (!isPlainObject(scopeSource)) problems.push('scope 必须是对象')
  /* The scheduler's scope is a set of *spaces*, not of tool classes: what matters is which
   * surfaces it arbitrates, not which plugins happen to exist. */
  if (scopeSource?.automationOwners !== undefined) {
    problems.push('scope.automationOwners 已改名为 scope.spaces（值是空间名：app / page / native / pixel / capture / system）')
  }
  const spaces = Array.isArray(scopeSource?.spaces)
    ? [...scopeSource.spaces]
    : [...DEFAULTS.scope.spaces]
  for (const space of spaces) {
    if (!OWNERS.includes(space) || space === 'other') problems.push(`scope.spaces: 未知空间 ${JSON.stringify(space)}`)
  }
  if (new Set(spaces).size !== spaces.length) problems.push('scope.spaces: 有重复项')

  /* capabilities: user rows win over the shipped table, so a deployment can narrow any
   * built-in behaviour without editing code. */
  const userRows = []
  if (raw.capabilities !== undefined) {
    if (!Array.isArray(raw.capabilities)) problems.push('capabilities 必须是数组')
    else {
      for (const [index, entry] of raw.capabilities.entries()) {
        const parsed = capabilityRow(entry, `capabilities[${index}]`, problems)
        if (parsed !== undefined) userRows.push(parsed)
      }
    }
  }
  const allRows = [...userRows, ...DEFAULT_CAPABILITIES.map(row => ({ ...row }))]
  /* Duplicates are only a mistake inside one origin. A user row deliberately repeating a
   * built-in pattern is how a deployment overrides that row: the table is matched top-down
   * and user rows come first. */
  for (const [label, rows] of [['capabilities', userRows], ['内置分类表', DEFAULT_CAPABILITIES]]) {
    const seen = new Map()
    for (const row of rows) {
      const key = String(row.tool)
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    for (const [pattern, count] of seen) {
      if (count > 1) problems.push(`${label}: 工具正则 ${JSON.stringify(pattern)} 出现 ${count} 次；第一条之后的永远不会命中`)
    }
  }

  /* claims */
  const claimsSource = isPlainObject(raw.claims) ? raw.claims : {}
  if (raw.claims !== undefined && !isPlainObject(raw.claims)) problems.push('claims 必须是对象')

  const rawGroups = Array.isArray(claimsSource.groups) ? claimsSource.groups : DEFAULTS.claims.groups
  const groups = []
  for (const [index, group] of rawGroups.entries()) {
    if (!Array.isArray(group) || group.length < 2) {
      problems.push(`claims.groups[${index}]: 至少两个类别的数组`)
      continue
    }
    const bad = group.filter(owner => !OWNERS.includes(owner) || owner === 'other')
    if (bad.length > 0) {
      problems.push(`claims.groups[${index}]: 未知类别 ${bad.map(item => JSON.stringify(item)).join(', ')}`)
      continue
    }
    /* capture never claims, so a group holding it could never fire. */
    if (group.includes('capture')) {
      problems.push(`claims.groups[${index}]: 不能包含 capture（它永不占位）`)
      continue
    }
    groups.push(group.map(String))
  }

  const claimsEnabled = claimsSource.enabled !== false
  if (claimsSource.enabled !== undefined && typeof claimsSource.enabled !== 'boolean') problems.push('claims.enabled 必须是布尔值')
  if (claimsEnabled && groups.length === 0) {
    problems.push('claims.groups 为空会让占用完全失效；要关闭就设 claims.enabled: false')
  }

  if (claimsSource.conflict !== undefined && !CONFLICT_MODES.includes(claimsSource.conflict)) {
    problems.push(`claims.conflict: 只能是 ${CONFLICT_MODES.join(' / ')}（当前 ${JSON.stringify(claimsSource.conflict)}）`)
  }
  const conflictMode = CONFLICT_MODES.includes(claimsSource.conflict) ? claimsSource.conflict : DEFAULTS.claims.conflict

  if (claimsSource.maxAttempts !== undefined && !(Number.isInteger(claimsSource.maxAttempts) && claimsSource.maxAttempts >= 0)) {
    problems.push('claims.maxAttempts 必须是 >= 0 的整数（0 = 不限）')
  }
  const maxAttempts = Number.isInteger(claimsSource.maxAttempts) && claimsSource.maxAttempts >= 0
    ? claimsSource.maxAttempts
    : DEFAULTS.claims.maxAttempts

  if (claimsSource.ttlMinutes !== undefined && !(Number.isInteger(claimsSource.ttlMinutes) && claimsSource.ttlMinutes > 0)) {
    problems.push('claims.ttlMinutes 必须是正整数')
  }
  const ttlMinutes = Number.isInteger(claimsSource.ttlMinutes) && claimsSource.ttlMinutes > 0
    ? claimsSource.ttlMinutes
    : DEFAULTS.claims.ttlMinutes

  /* deny / ask */
  const deny = (Array.isArray(raw.deny) ? raw.deny : [])
    .map((entry, index) => staticRule(entry, `deny[${index}]`, problems))
    .filter(Boolean)
  if (raw.deny !== undefined && !Array.isArray(raw.deny)) problems.push('deny 必须是数组')
  const ask = (Array.isArray(raw.ask) ? raw.ask : [])
    .map((entry, index) => staticRule(entry, `ask[${index}]`, problems))
    .filter(Boolean)
  if (raw.ask !== undefined && !Array.isArray(raw.ask)) problems.push('ask 必须是数组')

  /* agents */
  const agents = []
  if (raw.agents !== undefined) {
    if (!Array.isArray(raw.agents)) problems.push('agents 必须是数组')
    else {
      for (const [index, entry] of raw.agents.entries()) {
        if (!isPlainObject(entry) || (typeof entry.id !== 'string' && typeof entry.prefix !== 'string')) {
          problems.push(`agents[${index}]: 需要 id 或 prefix`)
          continue
        }
        const map = (list, field) => {
          if (list === undefined) return []
          if (!Array.isArray(list)) {
            problems.push(`agents[${index}].${field}: 必须是正则字符串数组`)
            return []
          }
          return list
            .map((pattern, position) => compilePattern(pattern, `agents[${index}].${field}[${position}]`, problems))
            .filter(Boolean)
        }
        agents.push({
          id: typeof entry.id === 'string' ? entry.id : undefined,
          prefix: typeof entry.prefix === 'string' ? entry.prefix : undefined,
          allow: map(entry.allow, 'allow'),
          deny: map(entry.deny, 'deny'),
        })
      }
    }
  }

  /* audit */
  const auditSource = isPlainObject(raw.audit) ? raw.audit : {}
  if (raw.audit !== undefined && !isPlainObject(raw.audit)) problems.push('audit 必须是对象')
  if (auditSource.enabled !== undefined && typeof auditSource.enabled !== 'boolean') problems.push('audit.enabled 必须是布尔值')
  const auditEnabled = auditSource.enabled !== false

  /* Relative paths resolve inside the plugin state directory, never next to the package:
   * the package copy is replaced on upgrade and may be read-only in a registry install. */
  let auditFile
  if (auditSource.file === undefined || auditSource.file === null) {
    auditFile = resolveLedgerFile(baseDir)
  } else if (isAbsolute(String(auditSource.file))) {
    auditFile = resolve(String(auditSource.file))
  } else if (nonEmptyString(auditSource.file)) {
    auditFile = join(resolveStateDir(baseDir), String(auditSource.file))
  } else {
    problems.push('audit.file 必须是路径字符串或 null')
    auditFile = resolveLedgerFile(baseDir)
  }
  if (auditSource.maxBytes !== undefined && !(Number.isInteger(auditSource.maxBytes) && auditSource.maxBytes > 0)) {
    problems.push('audit.maxBytes 必须是正整数')
  }
  const auditMaxBytes = Number.isInteger(auditSource.maxBytes) && auditSource.maxBytes > 0
    ? auditSource.maxBytes
    : AUDIT_MAX_BYTES

  if (raw.watch !== undefined && typeof raw.watch !== 'boolean') problems.push('watch 必须是布尔值')

  if (problems.length > 0) {
    throw new Error(`capability-policy: 规则有 ${problems.length} 处问题，已拒绝启动：\n- ${problems.join('\n- ')}`)
  }

  return Object.freeze({
    capabilities: compileCapabilities(allRows),
    spaces: Object.freeze(spaces),
    groups: Object.freeze(groups.map(group => Object.freeze(group))),
    maxAttempts,
    conflictMode,
    claimsEnabled,
    ttlMs: ttlMinutes * 60 * 1000,
    deny: Object.freeze(deny),
    ask: Object.freeze(ask),
    agents: Object.freeze(agents),
    audit: Object.freeze({ enabled: auditEnabled, file: auditFile, maxBytes: auditMaxBytes }),
    watch: raw.watch !== false,
    rulesFile: options.rulesFile ?? (options.inline === true ? '<inline>' : undefined),
    /* Always present, so a ledger row can answer "did the config I edited actually load?" */
    rulesDigest: options.rulesDigest ?? digestOf(JSON.stringify(raw)),
  })
}

export { AUDIT_MAX_BYTES, TTL_MINUTES }

