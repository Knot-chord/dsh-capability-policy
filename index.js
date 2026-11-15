/**
 * Capability ownership and dispatch gate for DeepSeek Harness.
 *
 * Three cooperating pieces:
 * 1. one system-prompt section: ownership classes plus the ordered selection gates;
 * 2. a hydrate-time rules file (rules.json): scope, deny/ask rules, exclusive acting
 *    classes, agent allowlists and the audit ledger;
 * 3. two enforcement paths over those rules:
 *    - ctx.tools.guard(): synchronous, order-independent deny backstop;
 *    - 'tools/pre-execute' waterfall: deny, ask, read-only bypass, resource claims, audit.
 *
 * v4 semantics for claims (see SPEC.md):
 * - only calls that change state claim a resource; read-only inspection never does;
 * - a claim's identity is resource-level when the call names one (page URL, window
 *   handle, system item) and falls back to the acting class otherwise;
 * - two classes contend unless their resources are provably distinct, so an unknown
 *   identity is treated as the same resource instead of being silently ignored;
 * - a conflict asks the user; after `claims.maxAttempts` failed classes on one resource
 *   it denies and demands evidence;
 * - a failed call releases its claim and counts as one attempt, so the fallback runs.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const inject = ['systemPrompt', 'tools']

const HERE = dirname(fileURLToPath(import.meta.url))

const OWNERS = ['app', 'page', 'native', 'pixel', 'capture', 'system', 'other']

const CONFLICT_MODES = ['ask', 'deny', 'allow']

const PROMPT = `## Capability ownership and dispatch
One owner per resource per turn: never let two acting classes touch the same target in one task — if they would, ask instead of guessing.

Most specific first: app (the application's own driver) > page (DOM/CDP) > native (accessibility tree) > pixel (coordinates, keys) > system (OS state); a lower class is a fallback, not a preference. capture (screenshots, OCR, frames, read_image) is read-only: it never owns a target and never replaces a surface that can be read directly.

Gates in order, first survivor wins:
0 target — name the instance (path, URL, handle, system item); no target, no call.
1 qualification (hard) — it must be able to finish on that target now (surface, tool, permission, dependency); partial coverage is not qualification.
2 layer (hard) — keep only the most specific class present.
3 authorization — write, send, delete or system state needs explicit authorization for this exact action; prefer a reversible path.
4 state — drop this target's failed candidates; prefer verified, then untried over known-failed; no retry without new evidence.
5 cost — cheapest evidence: text before image, one capture before many, reuse what you already have.

Escalate only on structured evidence (named error, unreadable surface, unnamed control, permission denial), one class per attempt and two at most. A failure releases the claim and re-runs the gates; after two failed classes on one target, stop and ask.`

const DEFAULT_OWNERS = {
  // 应用专用驱动：懂某个应用自己的语义，优先级最高
  app: ['^wechat', '^qq_', '^wecom', '^notion', '^email_'],
  // 页面语义：DOM / CDP
  page: ['^ego_', '^browser_', 'playwright', '\\bcdp\\b', '^chrome_', '^page_', '^tab_', '^dom_'],
  // 桌面语义：可访问性树
  native: ['^windows$', '^ui_elements$', '^open_application$'],
  // 像素与原始输入：鼠标、键盘、坐标点击、整窗截图
  pixel: ['^computer_(left_click|right_click|double_click|triple_click|mouse_move|scroll|drag|key|type|hold_key|batch|cursor_position)', '^screen_', '^mouse_', '^keyboard_'],
  // 采集：只读取，不控制
  capture: ['screenshot', '^read_image$', '^video_', 'storyboard', '^ocr', '^capture', '^record'],
  // 系统状态：改设置而非读内容
  system: ['^system_', '^service_', '^registry', '^power_'],
}

/**
 * Calls that only read. They stay in their acting class for reporting, but they never
 * claim a resource, because collecting evidence must not lock the fallback path.
 * `actions` limits the rule to a multiplexed tool such as windows or ego_tabs.
 */
const DEFAULT_READ_ONLY = [
  { tool: /^ui_elements$/ },
  { tool: /^windows$/, actions: ['list'] },
  { tool: /^ego_(help|doctor|status|page_info|read_element|snapshot|captcha)$/ },
  { tool: /^ego_wait/ },
  { tool: /^ego_tabs$/, actions: ['list'] },
]

/**
 * Calls that change state but never drive a surface, so they must not claim one.
 * `open_application` launches or foregrounds an application; the class that then
 * works inside it still owns the target, which is exactly the documented desktop
 * flow (open the app, then act in it).
 */
const DEFAULT_EXEMPT = [{ tool: /^open_application$/ }]

/** Resource identity per acting family. Families never compare across each other. */
const FAMILY = { app: 'app', page: 'page', native: 'desktop', pixel: 'desktop', system: 'system' }

const KEY_SPACE = {
  app: [],
  page: ['url', 'href', 'pageUrl'],
  desktop: ['hwnd', 'handle', 'windowId', 'title'],
  system: ['item', 'setting', 'name'],
}

const CLAIM_TTL_MS = 30 * 60 * 1000
const AUDIT_MAX_BYTES = 4 * 1024 * 1024

const DEFAULTS = {
  scope: { automationOwners: ['app', 'page', 'native', 'pixel', 'capture', 'system'] },
  claims: {
    enabled: true,
    /* 冲突时的裁决：ask 询问（审批关闭的会话会被自动拒），deny 直接拒绝并说明，allow 只记账 */
    conflict: 'ask',
    /* 两次失败后不再自动换类，逼模型说出证据 */
    maxAttempts: 2,
    groups: [
      ['app', 'page'],
      ['app', 'native'],
      ['app', 'pixel'],
      ['page', 'native'],
      ['page', 'pixel'],
      ['native', 'pixel'],
    ],
    readOnly: [],
    exempt: [],
  },
  deny: [],
  ask: [],
  agents: [],
  owners: {},
  audit: { enabled: true, file: null, maxBytes: AUDIT_MAX_BYTES },
  /* v3 的 selection.mode 只影响提示词措辞，v4 统一用闸门制，字段保留但被忽略 */
  selection: { mode: 'gates' },
}

function compile (pattern) {
  try {
    return new RegExp(pattern)
  } catch {
    return undefined
  }
}

function buildMatchers (owners) {
  return Object.entries(owners).map(([owner, patterns]) => ({
    owner,
    matchers: patterns.map(compile).filter(Boolean),
  }))
}

/* ------------------------------------------------------------------ config */

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readRulesFile (file) {
  if (!existsSync(file)) return { raw: {}, present: false }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`capability-policy: 读不了规则文件 ${file}（${error.message}）`)
  }
  try {
    return { raw: JSON.parse(text), present: true }
  } catch (error) {
    throw new Error(`capability-policy: ${file} 不是合法 JSON（${error.message}）。规则未生效，改好再重载。`)
  }
}

/**
 * Where the ledger lives. The Host process does not carry DSH_PROFILE_DIR (only the
 * shells it spawns do), so the profile lookup is opportunistic and the durable
 * fallbacks matter: never write into the package, which for a `link:` install is the
 * author's source tree.
 */
function defaultAuditFile (baseDir) {
  const profileDir = process.env.DSH_PROFILE_DIR
  if (profileDir) return resolve(profileDir, 'capability-policy', 'audit.jsonl')
  const stateHome = process.env.LOCALAPPDATA ?? process.env.XDG_STATE_HOME ?? process.env.XDG_DATA_HOME
  if (stateHome) return resolve(stateHome, 'dsh-capability-policy', 'audit.jsonl')
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (home) return resolve(home, '.dsh-capability-policy', 'audit.jsonl')
  return resolve(baseDir, 'audit.jsonl')
}

/**
 * Resolve one raw rules object into the runtime config.
 * Structural mistakes throw: a policy plugin that silently runs with half its deny
 * rules is worse than one that refuses to start.
 */
export function resolveConfig (raw = {}, options = {}) {
  const problems = []
  const baseDir = options.baseDir ?? HERE

  if (!isPlainObject(raw)) {
    throw new Error('capability-policy: 规则必须是 JSON 对象')
  }

  const owners = { ...DEFAULT_OWNERS }
  if (raw.owners !== undefined) {
    if (!isPlainObject(raw.owners)) problems.push('owners 必须是对象')
    else {
      for (const [name, patterns] of Object.entries(raw.owners)) {
        if (!OWNERS.includes(name)) problems.push(`owners.${name}: 未知类别（可用 ${OWNERS.join('/')}）`)
        else if (!Array.isArray(patterns)) problems.push(`owners.${name}: 必须是正则字符串数组`)
        else {
          const compiled = patterns.map((pattern, index) => {
            if (typeof pattern !== 'string') {
              problems.push(`owners.${name}[${index}]: 必须是字符串`)
              return undefined
            }
            const rx = compile(pattern)
            if (!rx) problems.push(`owners.${name}[${index}]: 正则无效 "${pattern}"`)
            return rx
          })
          owners[name] = compiled.filter(Boolean)
        }
      }
    }
  }

  const denySource = raw.deny ?? []
  const askSource = raw.ask ?? []
  if (!Array.isArray(denySource)) problems.push('deny 必须是数组')
  if (!Array.isArray(askSource)) problems.push('ask 必须是数组')

  const rule = (entry, where) => {
    if (!isPlainObject(entry)) {
      problems.push(`${where}: 必须是对象`)
      return undefined
    }
    if (typeof entry.tool !== 'string') {
      problems.push(`${where}.tool: 必须是正则字符串`)
      return undefined
    }
    const tool = compile(entry.tool)
    if (!tool) {
      problems.push(`${where}.tool: 正则无效 "${entry.tool}"`)
      return undefined
    }
    let args
    if (entry.args !== undefined) {
      if (typeof entry.args !== 'string') problems.push(`${where}.args: 必须是正则字符串`)
      else {
        args = compile(entry.args)
        if (!args) problems.push(`${where}.args: 正则无效 "${entry.args}"`)
      }
    }
    return {
      tool,
      args,
      reason: typeof entry.reason === 'string' && entry.reason !== '' ? entry.reason : undefined,
    }
  }

  const deny = (Array.isArray(denySource) ? denySource : [])
    .map((entry, index) => rule(entry, `deny[${index}]`))
    .filter(Boolean)
  const ask = (Array.isArray(askSource) ? askSource : [])
    .map((entry, index) => rule(entry, `ask[${index}]`))
    .filter(Boolean)

  const matchEntry = (entry, where) => {
    if (!isPlainObject(entry) || typeof entry.tool !== 'string') return undefined
    const tool = compile(entry.tool)
    if (!tool) {
      problems.push(`${where}.tool: 正则无效 "${entry.tool}"`)
      return undefined
    }
    if (entry.actions !== undefined && !Array.isArray(entry.actions)) {
      problems.push(`${where}.actions: 必须是字符串数组`)
      return undefined
    }
    return { tool, actions: entry.actions ? entry.actions.map(String) : undefined }
  }

  const scopeSource = raw.scope ?? DEFAULTS.scope
  if (scopeSource !== undefined && !isPlainObject(scopeSource)) problems.push('scope 必须是对象')
  const automationOwners = Array.isArray(scopeSource?.automationOwners)
    ? scopeSource.automationOwners
    : DEFAULTS.scope.automationOwners
  for (const owner of automationOwners) {
    if (!OWNERS.includes(owner)) problems.push(`scope.automationOwners: 未知类别 "${owner}"`)
  }

  const claimsSource = isPlainObject(raw.claims) ? raw.claims : {}
  if (raw.claims !== undefined && !isPlainObject(raw.claims)) problems.push('claims 必须是对象')
  const rawGroups = Array.isArray(claimsSource.groups) ? claimsSource.groups : DEFAULTS.claims.groups
  const groups = []
  for (const [index, group] of rawGroups.entries()) {
    if (!Array.isArray(group) || group.length < 2) {
      problems.push(`claims.groups[${index}]: 至少两个类别的数组`)
      continue
    }
    const bad = group.filter(owner => !OWNERS.includes(owner))
    if (bad.length > 0) {
      problems.push(`claims.groups[${index}]: 未知类别 ${bad.map(b => JSON.stringify(b)).join(', ')}`)
      continue
    }
    groups.push(group.map(String))
  }

  const readOnly = [...DEFAULT_READ_ONLY]
  const exempt = [...DEFAULT_EXEMPT]
  if (claimsSource.readOnly !== undefined) {
    if (!Array.isArray(claimsSource.readOnly)) problems.push('claims.readOnly 必须是数组')
    else {
      for (const [index, entry] of claimsSource.readOnly.entries()) {
        const parsed = matchEntry(entry, `claims.readOnly[${index}]`)
        if (parsed) readOnly.push(parsed)
        else problems.push(`claims.readOnly[${index}]: 需要 { tool: 正则, actions?: [..] }`)
      }
    }
  }
  if (claimsSource.exempt !== undefined) {
    if (!Array.isArray(claimsSource.exempt)) problems.push('claims.exempt 必须是数组')
    else {
      for (const [index, entry] of claimsSource.exempt.entries()) {
        const parsed = matchEntry(entry, `claims.exempt[${index}]`)
        if (parsed) exempt.push(parsed)
        else problems.push(`claims.exempt[${index}]: 需要 { tool: 正则, actions?: [..] }`)
      }
    }
  }

  const maxAttempts = Number.isInteger(claimsSource.maxAttempts) && claimsSource.maxAttempts >= 0
    ? claimsSource.maxAttempts
    : DEFAULTS.claims.maxAttempts

  if (claimsSource.conflict !== undefined && !CONFLICT_MODES.includes(claimsSource.conflict)) {
    problems.push(`claims.conflict: 只能是 ${CONFLICT_MODES.join(' / ')}（当前是 ${JSON.stringify(claimsSource.conflict)}）`)
  }
  const conflictMode = CONFLICT_MODES.includes(claimsSource.conflict)
    ? claimsSource.conflict
    : DEFAULTS.claims.conflict

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
          return list.map((pattern, position) => {
            const rx = typeof pattern === 'string' ? compile(pattern) : undefined
            if (!rx) problems.push(`agents[${index}].${field}[${position}]: 正则无效`)
            return rx
          }).filter(Boolean)
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

  const auditSource = isPlainObject(raw.audit) ? raw.audit : {}
  if (raw.audit !== undefined && !isPlainObject(raw.audit)) problems.push('audit 必须是对象')
  let auditFile
  if (typeof auditSource.file === 'string' && auditSource.file !== '') {
    auditFile = isAbsolute(auditSource.file) ? auditSource.file : resolve(baseDir, auditSource.file)
  } else if (auditSource.file !== undefined && auditSource.file !== null) {
    problems.push('audit.file 必须是路径字符串')
  } else {
    auditFile = defaultAuditFile(baseDir)
  }
  const auditMaxBytes = Number.isInteger(auditSource.maxBytes) && auditSource.maxBytes > 0
    ? auditSource.maxBytes
    : AUDIT_MAX_BYTES

  if (problems.length > 0) {
    throw new Error(`capability-policy: 规则有 ${problems.length} 处问题，已拒绝启动：\n- ${problems.join('\n- ')}`)
  }

  return {
    owners,
    ownerMatchers: buildMatchers(owners),
    deny,
    ask,
    agents,
    groups,
    readOnly,
    exempt,
    maxAttempts,
    conflictMode,
    claimsEnabled: claimsSource.enabled !== false && groups.length > 0,
    automationOwners,
    audit: { enabled: auditSource.enabled !== false, file: auditFile, maxBytes: auditMaxBytes },
    problems,
  }
}

export function loadConfig (options = {}) {
  const file = options.file ?? resolve(HERE, 'rules.json')
  const { raw } = readRulesFile(file)
  return resolveConfig(raw, { ...options, baseDir: options.baseDir ?? dirname(file) })
}

/* ------------------------------------------------------------ classification */

function collectActions (args) {
  if (!isPlainObject(args)) return []
  const actions = []
  if (typeof args.action === 'string') actions.push(args.action)
  if (Array.isArray(args.actions)) {
    for (const entry of args.actions) {
      if (isPlainObject(entry) && typeof entry.action === 'string') actions.push(entry.action)
    }
  }
  return actions
}

export function classifyTool (name, args, config) {
  const matchers = config?.ownerMatchers ?? buildMatchers(DEFAULT_OWNERS)
  const tool = String(name ?? '')

  // Capture first: a name like ego_screenshot is a read, even though the plugin
  // family is page. Names come from the live tool schema, not README prose.
  const capture = matchers.find(entry => entry.owner === 'capture')
  if (capture && capture.matchers.some(rx => rx.test(tool))) return 'capture'

  // The computer tool multiplexes actions: screenshot/zoom/cursor_position read
  // pixels, everything else acts on the desktop.
  if (tool === 'computer') {
    const action = typeof args?.action === 'string' ? args.action : ''
    return action === 'screenshot' || action === 'zoom' || action === 'cursor_position' ? 'capture' : 'pixel'
  }

  for (const { owner, matchers: list } of matchers) {
    if (owner === 'capture') continue
    if (list.some(rx => rx.test(tool))) return owner
  }
  return 'other'
}

function callMatches (entries, name, args) {
  for (const entry of entries) {
    if (!entry.tool.test(name)) continue
    if (entry.actions === undefined) return true
    const actions = collectActions(args)
    if (actions.length === 0) continue
    if (actions.every(action => entry.actions.includes(action))) return true
  }
  return false
}

function resourceOf (owner, args, config) {
  const family = FAMILY[owner]
  if (family === undefined) return undefined
  const keys = KEY_SPACE[family] ?? []
  if (isPlainObject(args)) {
    for (const key of keys) {
      const value = args[key]
      if (typeof value === 'string' && value.trim() !== '') {
        return { family, key: normalizeKey(family, value) }
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return { family, key: normalizeKey(family, String(value)) }
      }
    }
  }
  return { family, key: undefined }
}

function normalizeKey (family, value) {
  const text = String(value).trim()
  if (family !== 'page') return text.toLowerCase()
  try {
    const url = new URL(text)
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
  } catch {
    return text.replace(/[?#].*$/, '').replace(/\/+$/, '')
  }
}

/** True only when both sides name the same key family and the keys differ. */
function provablyDistinct (left, right) {
  if (!left || !right) return false
  if (left.family !== right.family) return false
  if (left.key === undefined || right.key === undefined) return false
  return left.key !== right.key
}

function sameResource (left, right) {
  if (provablyDistinct(left, right)) return false
  return true
}

function exclusive (left, right, groups) {
  return groups.some(group => group.includes(left) && group.includes(right))
}

/* ------------------------------------------------------------------- apply */

export function apply (ctx, rowConfig = {}) {
  const inline = isPlainObject(rowConfig?.rules) ? rowConfig.rules : undefined
  const config = inline !== undefined
    ? resolveConfig(inline, { baseDir: HERE })
    : loadConfig()

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'capability-policy:routing',
    order: 9000,
    text: PROMPT,
  }))

  let auditBytes = -1
  const writeAudit = (entry) => {
    if (!config.audit.enabled) return
    try {
      const file = config.audit.file
      mkdirSync(dirname(file), { recursive: true })
      if (auditBytes < 0) auditBytes = existsSync(file) ? statSync(file).size : 0
      const line = JSON.stringify(entry) + '\n'
      const size = Buffer.byteLength(line)
      if (auditBytes > 0 && auditBytes + size > config.audit.maxBytes) {
        try {
          renameSync(file, `${file}.1`)
        } catch {
          /* rotation is best effort */
        }
        auditBytes = 0
      }
      appendFileSync(file, line, 'utf8')
      auditBytes += size
    } catch {
      /* audit is best-effort, never blocks dispatch */
    }
  }

  const agentRuleFor = (agentId) => {
    for (const rule of config.agents) {
      if (rule.id !== undefined && rule.id === agentId) return rule
      if (rule.prefix !== undefined && agentId.startsWith(rule.prefix)) return rule
    }
    return undefined
  }

  const agentVerdict = (agentId, name) => {
    const rule = agentRuleFor(agentId)
    if (!rule) return undefined
    if (rule.deny.some(rx => rx.test(name))) return 'deny'
    if (rule.allow.length > 0 && !rule.allow.some(rx => rx.test(name))) return 'not-allowed'
    return undefined
  }

  // Synchronous, order-independent backstop for the static deny rules.
  // Returns a plain reason string on purpose: `ToolGuard` is `string | undefined`
  // across 0.2.1-rc.1 … 0.2.2-rc.2 and only accepts `{ reason, info }` from
  // 0.2.2-rc.3 on. The string is the one return type every supported version reads,
  // and the waterfall path below still carries the structured error identity.
  if (config.deny.length > 0) {
    ctx.effect(() => ctx.tools.guard(execution => {
      const name = String(execution?.name ?? '')
      let argsText
      const argsOf = () => {
        if (argsText === undefined) {
          try {
            argsText = JSON.stringify(execution?.arguments ?? null)
          } catch {
            argsText = null
          }
        }
        return argsText
      }
      for (const rule of config.deny) {
        if (!rule.tool.test(name)) continue
        if (rule.args !== undefined) {
          const text = argsOf()
          if (text === null || !rule.args.test(text)) continue
        }
        return rule.reason ?? 'blocked by capability-policy'
      }
      return undefined
    }))
  }

  /* Claims are keyed by resource, not by session: two agents driving the same
   * window contend even when they are different subagent sessions. An unknown
   * identity is keyed per agent, because "unknown" is only comparable within
   * one caller's own view. */
  const claims = new Map()
  /* Failed acting classes per agent this turn. After `claims.maxAttempts` of them the
   * next switch away from a live claim is denied instead of merely asked. */
  const attempts = new Map()

  const claimKey = (resource, agentId, owner) => {
    if (resource === undefined) return `unknown:${agentId}:${owner}`
    return resource.key === undefined
      ? `unknown:${agentId}:${resource.family}`
      : `${resource.family}:${resource.key}`
  }

  const releaseClaims = (agentId) => {
    let dropped = 0
    for (const [key, claim] of claims) {
      if (claim.agent !== agentId) continue
      claims.delete(key)
      dropped++
    }
    return dropped
  }

  const countAttempt = (agentId, now) => {
    const prior = attempts.get(agentId)
    attempts.set(agentId, { count: (prior?.count ?? 0) + 1, at: now })
  }

  const dropExpired = (now) => {
    for (const [key, claim] of claims) {
      if (now - claim.at > CLAIM_TTL_MS) claims.delete(key)
    }
    for (const [agentId, record] of attempts) {
      if (now - record.at > CLAIM_TTL_MS) attempts.delete(agentId)
    }
  }

  const conflictFor = (owner, resource, agentId) => {
    for (const [key, claim] of claims) {
      if (claim.owner === owner) continue
      if (!exclusive(owner, claim.owner, config.groups)) continue
      if (provablyDistinct(resource, claim.resource)) continue
      /* "One owner per turn" is per agent. Across agents a conflict must be provable,
       * so it needs two known keys in the same family (typically a window handle):
       * a page URL and a window handle name the same surface but cannot show it. */
      if (claim.agent !== agentId) {
        if (resource?.key === undefined || claim.resource?.key === undefined) continue
        if (resource.family !== claim.resource.family) continue
      }
      return { key, claim }
    }
    return undefined
  }

  ctx.effect(() => ctx.on('agent/turn-stopping', (payload) => {
    // `payload.agent.id` is the documented shape; the bare `payload.id` keeps the
    // cleanup working if an older runtime hands the Agent itself.
    const id = payload?.agent?.id ?? payload?.id
    if (!id) return
    attempts.delete(id)
    releaseClaims(id)
  }))

  ctx.effect(() => ctx.on('tools/result', (exec, result) => {
    if (!result?.isError) return
    const id = String(exec?.agent?.id ?? '')
    if (id === '') return
    const name = String(exec?.name ?? '')
    if (claims.size === 0) return
    const owner = classifyTool(name, exec?.arguments, config)
    const resource = resourceOf(owner, exec?.arguments, config)
    const now = Date.now()
    let released = 0
    for (const [key, claim] of claims) {
      if (claim.agent !== id) continue
      if (claim.tool !== name) continue
      if (!sameResource(claim.resource, resource)) continue
      claims.delete(key)
      released++
      writeAudit({
        at: now,
        agent: id,
        tool: name,
        owner,
        mode: 'act',
        decision: 'release',
        source: 'failure',
        resource: resource?.key,
      })
    }
    if (released > 0) countAttempt(id, now)
  }))

  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    const name = String(exec?.name ?? '')
    const agentId = String(exec?.agent?.id ?? 'global')
    const args = exec?.arguments

    let argsText
    const argsOf = () => {
      if (argsText === undefined) {
        try {
          argsText = JSON.stringify(args ?? null)
        } catch {
          argsText = null
        }
      }
      return argsText
    }

    const owner = classifyTool(name, args, config)
    const automation = config.automationOwners.includes(owner)
    const readOnly = owner === 'capture' || callMatches(config.readOnly, name, args)
    const exempt = !readOnly && callMatches(config.exempt, name, args)
    const mode = readOnly ? 'read' : 'act'

    for (const rule of config.deny) {
      if (!rule.tool.test(name)) continue
      if (rule.args !== undefined) {
        const text = argsOf()
        if (text === null || !rule.args.test(text)) continue
      }
      writeAudit({ at: Date.now(), agent: agentId, tool: name, owner, mode, decision: 'deny', source: 'deny-rule', reason: rule.reason })
      return { kind: 'deny', reason: rule.reason ?? 'blocked by capability-policy', info: { name, code: 'capability_policy_denied' } }
    }

    const verdict = agentVerdict(agentId, name)
    if (verdict === 'deny' || verdict === 'not-allowed') {
      const reason = verdict === 'deny'
        ? `tool ${name} is denied for this session by capability-policy`
        : `tool ${name} is not in this session's allow list (capability-policy)`
      writeAudit({ at: Date.now(), agent: agentId, tool: name, owner, mode, decision: 'deny', source: verdict === 'deny' ? 'agent-deny' : 'agent-allowlist', reason })
      return { kind: 'deny', reason, info: { name, code: 'capability_policy_denied' } }
    }

    for (const rule of config.ask) {
      if (!rule.tool.test(name)) continue
      if (rule.args !== undefined) {
        const text = argsOf()
        if (text === null || !rule.args.test(text)) continue
      }
      const reason = rule.reason ?? 'needs confirmation'
      writeAudit({ at: Date.now(), agent: agentId, tool: name, owner, mode, decision: 'ask', source: 'ask-rule', reason })
      return { kind: 'ask', reason, displayReason: { en: reason, zh: reason } }
    }

    /* Read-only calls never claim: inspection collects evidence for the gates and
     * must not lock the class the policy may still escalate to. */
    const canClaim = config.claimsEnabled && automation && !readOnly && !exempt && Boolean(exec?.agent?.id)
    if (canClaim) {
      const now = Date.now()
      dropExpired(now)
      const resource = resourceOf(owner, args, config)
      const conflict = conflictFor(owner, resource, agentId)
      if (conflict !== undefined) {
        const prior = attempts.get(agentId)?.count ?? 0
        const exhausted = config.maxAttempts > 0 && prior >= config.maxAttempts
        const holder = `${conflict.claim.owner}:${conflict.claim.tool}`
        const verdict = config.conflictMode === 'allow'
          ? 'allow'
          : exhausted ? 'deny' : config.conflictMode
        writeAudit({
          at: now,
          agent: agentId,
          tool: name,
          owner,
          mode,
          decision: verdict,
          source: 'claims',
          resource: resource?.key,
          reason: `${holder} (attempts ${prior})`,
        })
        if (verdict === 'deny') {
          return {
            kind: 'deny',
            reason: exhausted
              ? `${owner} is blocked on this target: ${holder} already failed here ${prior} times this turn. State the evidence and ask the user before switching again.`
              : `${owner} cannot take this target this turn: ${holder} holds it and claims.conflict is "deny". Ask the user to authorize the switch, or set claims.conflict to ask.`,
            info: { name, code: exhausted ? 'capability_policy_attempts' : 'capability_policy_conflict' },
          }
        }
        if (verdict === 'ask') {
          return {
            kind: 'ask',
            reason: `switching this target from ${conflict.claim.owner} (${conflict.claim.tool}) to ${owner} needs the user's approval`,
            displayReason: {
              en: `This turn already drives the target through ${conflict.claim.owner} (${conflict.claim.tool}); switching to ${owner} needs your approval.`,
              zh: `这一轮已经用 ${conflict.claim.owner} 类工具处理同一目标（${conflict.claim.tool}），切到 ${owner} 类需要你确认。`,
            },
          }
        }
        /* conflict: allow — record the overlap and let the newer class take the claim. */
      }
      claims.set(claimKey(resource, agentId, owner), { owner, tool: name, agent: agentId, at: now, resource })
    }

    if (automation) {
      writeAudit({
        at: Date.now(),
        agent: agentId,
        tool: name,
        owner,
        mode,
        decision: 'allow',
        source: 'policy',
        resource: resourceOf(owner, args, config)?.key,
      })
    }
    return next()
  }))
}

export { PROMPT, DEFAULTS }
