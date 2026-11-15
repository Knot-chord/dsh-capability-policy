/**
 * Regression suite for @local/dsh-capability-policy.
 *
 * Rules are passed inline through apply(ctx, { rules }) so the shipped rules.json is
 * never rewritten mid-test, and the assertions run against the *shipped* group config
 * instead of a simplified fixture.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TMP = join(process.env.TEMP ?? process.env.TMPDIR ?? ROOT, `capability-policy-test-${process.pid}`)

let failures = 0
let checks = 0
function check (label, actual, expected) {
  checks++
  const okv = JSON.stringify(actual) === JSON.stringify(expected)
  if (!okv) failures++
  console.log(`${okv ? 'PASS' : 'FAIL'} ${label} -> ${JSON.stringify(actual)}${okv ? '' : ` (expected ${JSON.stringify(expected)})`}`)
}
function ok (label, condition, detail = '') {
  checks++
  if (!condition) failures++
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` -> ${detail}`}`)
}

rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const mod = await import(pathToFileURL(join(ROOT, 'index.js')).href + `?v=${Date.now()}`)

let seq = 0
function makeEnv (rules = {}, tag) {
  const name = tag ?? `env${++seq}`
  const auditFile = join(TMP, `${name}.jsonl`)
  const merged = {
    scope: rules.scope ?? mod.DEFAULTS.scope,
    claims: { ...mod.DEFAULTS.claims, ...(rules.claims ?? {}) },
    audit: { enabled: true, file: auditFile, ...(rules.audit ?? {}) },
    deny: rules.deny ?? [],
    ask: rules.ask ?? [],
    agents: rules.agents ?? [],
    owners: rules.owners ?? {},
  }
  const handlers = new Map()
  const sections = []
  let guardRegistrations = 0
  let guardFn
  const ctx = {
    effect: (fn) => fn(),
    systemPrompt: { section: (section) => { sections.push(section); return () => {} } },
    tools: { guard: (fn) => { guardRegistrations++; guardFn = fn; return () => {} } },
    on: (name, fn) => { handlers.set(name, fn); return () => {} },
  }
  mod.apply(ctx, { rules: merged })
  const rows = () => existsSync(auditFile)
    ? readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
  return {
    auditFile,
    sections,
    rows,
    guardRegistrations: () => guardRegistrations,
    guard: (exec) => guardFn?.(exec),
    pre: handlers.get('tools/pre-execute'),
    turnStopping: handlers.get('agent/turn-stopping'),
    onResult: handlers.get('tools/result'),
    call: (agent, name, args = {}) => handlers.get('tools/pre-execute')({ name, agent: { id: agent }, arguments: args }, async () => ({ kind: 'allow' })),
    fail: (agent, name, args = {}) => handlers.get('tools/result')({ name, agent: { id: agent }, arguments: args }, { isError: true }),
    stop: (agent) => handlers.get('agent/turn-stopping')({ agent: { id: agent }, turn: 1, signal: new AbortController().signal }),
  }
}

/* ------------------------------------------------------------------ contracts */
console.log('\n## 1. 提示词与契约')
const base = makeEnv()
check('只注册一段提示词', base.sections.length, 1)
check('提示词段落名', base.sections[0].name, 'capability-policy:routing')
ok('提示词含闸门顺序', base.sections[0].text.includes('Gates in order'))
ok('提示词不含已废弃的分数模式', !/weighted|multiplicative|lexicographic/.test(base.sections[0].text))
ok('提示词长度在预算内', mod.PROMPT.length <= 1600, `${mod.PROMPT.length} chars`)
ok('提示词不含规则文件内容', !mod.PROMPT.includes('rules.json') && !mod.PROMPT.includes('"deny"'))
check('没有 deny 规则时不注册 guard', base.guardRegistrations(), 0)
const withDeny = makeEnv({ deny: [{ tool: '^forbidden_', reason: 'blocked for test' }] })
check('有 deny 规则时注册 guard', withDeny.guardRegistrations(), 1)
check('guard 对命中工具返回字符串（0.2.1-0.2.2 兼容的返回类型）', typeof withDeny.guard({ name: 'forbidden_write', arguments: {} }), 'string')
check('guard 返回规则里的理由', withDeny.guard({ name: 'forbidden_write', arguments: {} }), 'blocked for test')
check('guard 放行未命中工具', withDeny.guard({ name: 'read', arguments: {} }), undefined)

/* -------------------------------------------------------------- classification */
console.log('\n## 2. 分类（真实工具名）')
const classified = [
  ['computer', { action: 'screenshot' }, 'capture'],
  ['computer', { action: 'zoom' }, 'capture'],
  ['computer', { action: 'left_click' }, 'pixel'],
  ['computer_batch', { actions: [] }, 'pixel'],
  ['ego_screenshot', {}, 'capture'],
  ['ego_click', {}, 'page'],
  ['ego_download', {}, 'page'],
  ['windows', { action: 'list' }, 'native'],
  ['ui_elements', {}, 'native'],
  ['open_application', {}, 'native'],
  ['read_image', {}, 'capture'],
  ['univer_screenshot', {}, 'capture'],
  ['wechat_send', {}, 'app'],
  ['bilibili_extract', {}, 'other'],
  ['read', {}, 'other'],
  ['clipboard', {}, 'other'],
]
for (const [tool, args, expected] of classified) {
  check(`classify ${tool} ${JSON.stringify(args)}`, mod.classifyTool(tool, args), expected)
}
const custom = mod.resolveConfig({ owners: { page: ['^p_'] } })
check('owners 覆盖后 classify 跟随配置', mod.classifyTool('p_navigate', {}, custom), 'page')

/* ---------------------------------------------------------------------- claims */
console.log('\n## 3. 归属互斥（出厂 6 组配置，P0 回归）')
const claims = makeEnv()
const a = await claims.call('s1', 'ego_navigate', { url: 'https://example.com' })
check('page 首次放行', a.kind, 'allow')
const b = await claims.call('s1', 'computer', { action: 'left_click', coordinate: [1, 2] })
check('page 之后 pixel 变为 ask（而不是静默放行）', b.kind, 'ask')
ok('ask 带双语 displayReason', Boolean(b.displayReason?.en && b.displayReason?.zh), b.displayReason?.zh?.slice(0, 24))
const c = await claims.call('s2', 'ego_click', { ref: 'e1' })
check('page 首次放行（另一会话）', c.kind, 'allow')
check('page 之后 native 变为 ask', (await claims.call('s2', 'windows', { action: 'maximize' })).kind, 'ask')
const d = await claims.call('s3', 'windows', { action: 'maximize', hwnd: 1 })
check('native 首次放行', d.kind, 'allow')
check('native 之后 pixel 变为 ask', (await claims.call('s3', 'computer', { action: 'left_click', hwnd: 1 })).kind, 'ask')
check('app 之后 page 变为 ask', (await claims.call('s4', 'wechat_send', { to: 'x' }), await claims.call('s4', 'ego_click', { ref: 'e2' })).kind, 'ask')

console.log('\n## 4. 资源身份')
const identity = makeEnv()
await identity.call('t1', 'windows', { action: 'maximize', hwnd: 100 })
check('同一桌面族、不同句柄不互斥', (await identity.call('t1', 'computer', { action: 'left_click', hwnd: 200 })).kind, 'allow')
const pages = makeEnv()
await pages.call('t2', 'ego_navigate', { url: 'https://a.com/x' })
check('同一页面族、不同 URL 不互斥', (await pages.call('t2', 'ego_click', { url: 'https://b.com/y' })).kind, 'allow')
const cross = makeEnv()
await cross.call('t3', 'ego_navigate', { url: 'https://a.com/x?tab=2' })
check('URL 归一化：同源同径不同 query 视为同一资源', (await cross.call('t3', 'computer', { action: 'left_click', coordinate: [1, 1] })).kind, 'ask')
const families = makeEnv()
await families.call('t4', 'ego_navigate', { url: 'https://a.com/x' })
check('page 的 url 与 desktop 的 hwnd 无法证明不同 -> 判为同一资源', (await families.call('t4', 'computer', { action: 'left_click', hwnd: 7 })).kind, 'ask')

/* ------------------------------------------------------------------- read-only */
console.log('\n## 5. 只读取证不占目标')
const reads = makeEnv()
for (const [tool, args] of [
  ['ego_snapshot', {}],
  ['ego_doctor', {}],
  ['ego_page_info', {}],
  ['ego_read_element', { selector: 'x' }],
  ['ego_wait_for_selector', { selector: 'x' }],
  ['windows', { action: 'list' }],
  ['ui_elements', {}],
  ['ego_tabs', { action: 'list' }],
  ['read_image', { file_path: 'x.png' }],
]) {
  const env = makeEnv({}, `read-${tool}-${args.action ?? ''}`)
  await env.call('r1', tool, args)
  const after = await env.call('r1', 'computer', { action: 'left_click', coordinate: [1, 1] })
  check(`只读 ${tool} ${args.action ?? ''} 之后 pixel 仍可动手`, after.kind, 'allow')
}
const acts = makeEnv()
await acts.call('r2', 'windows', { action: 'maximize', hwnd: 9 })
check('windows 的写动作仍然占目标', (await acts.call('r2', 'computer', { action: 'left_click', hwnd: 9 })).kind, 'ask')

const launcher = makeEnv()
await launcher.call('r3', 'open_application', { name: 'Chrome' })
check('open_application 只是启动/置前，不占目标', (await launcher.call('r3', 'computer', { action: 'left_click', coordinate: [1, 1] })).kind, 'allow')
ok('open_application 仍按 act 入账', launcher.rows().some(row => row.tool === 'open_application' && row.mode === 'act'))

const exemptCustom = makeEnv({ claims: { exempt: [{ tool: '^windows$' }] } })
await exemptCustom.call('r4', 'windows', { action: 'maximize', hwnd: 3 })
check('claims.exempt 可追加豁免', (await exemptCustom.call('r4', 'computer', { action: 'left_click', hwnd: 3 })).kind, 'allow')

/* --------------------------------------------------------------- release path */
console.log('\n## 6. 失败释放与两次上限')
const rel = makeEnv()
await rel.call('f1', 'ego_click', { ref: 'e1' })
check('先由 page 占住', (await rel.call('f1', 'computer', { action: 'left_click' })).kind, 'ask')
rel.fail('f1', 'ego_click', { ref: 'e1' })
check('失败后降级到 pixel 被放行', (await rel.call('f1', 'computer', { action: 'left_click', coordinate: [1, 1] })).kind, 'allow')
ok('审计含 release 行', rel.rows().some(row => row.decision === 'release' && row.source === 'failure'))

const wrongTool = makeEnv()
await wrongTool.call('f2', 'ego_click', { ref: 'e1' })
wrongTool.fail('f2', 'ego_js', { expression: '1' })
check('别的工具失败不释放占用', (await wrongTool.call('f2', 'computer', { action: 'left_click' })).kind, 'ask')

const limited = makeEnv()
await limited.call('f3', 'ego_click', { ref: 'e1' })
limited.fail('f3', 'ego_click', { ref: 'e1' })
await limited.call('f3', 'ego_click', { ref: 'e1' })
limited.fail('f3', 'ego_click', { ref: 'e1' })
await limited.call('f3', 'ego_click', { ref: 'e1' })
const third = await limited.call('f3', 'computer', { action: 'left_click' })
check('两次失败后再换类被拒绝', third.kind, 'deny')
check('拒绝带 attempts 错误码', third.info?.code, 'capability_policy_attempts')
const unlimited = makeEnv({ claims: { maxAttempts: 0 } })
await unlimited.call('f4', 'ego_click', { ref: 'e1' })
unlimited.fail('f4', 'ego_click', { ref: 'e1' })
await unlimited.call('f4', 'ego_click', { ref: 'e1' })
unlimited.fail('f4', 'ego_click', { ref: 'e1' })
await unlimited.call('f4', 'ego_click', { ref: 'e1' })
check('maxAttempts=0 时只问不拒', (await unlimited.call('f4', 'computer', { action: 'left_click' })).kind, 'ask')

const turns = makeEnv()
await turns.call('g1', 'ego_click', { ref: 'e1' })
turns.stop('g1')
check('回合结束清空占用', (await turns.call('g1', 'computer', { action: 'left_click' })).kind, 'allow')

/* ------------------------------------------------------------- conflict modes */
console.log('\n## 6b. 冲突裁决模式')
const denyMode = makeEnv({ claims: { conflict: 'deny' } })
await denyMode.call('c1', 'ego_click', { ref: 'e1' })
const denied = await denyMode.call('c1', 'computer', { action: 'left_click' })
check('conflict=deny 直接拒绝', denied.kind, 'deny')
check('deny 带 conflict 错误码', denied.info?.code, 'capability_policy_conflict')
ok('deny 理由说明了怎么解除', denied.reason.includes('claims.conflict'))

const allowMode = makeEnv({ claims: { conflict: 'allow' } })
await allowMode.call('c2', 'ego_click', { ref: 'e1' })
check('conflict=allow 放行', (await allowMode.call('c2', 'computer', { action: 'left_click' })).kind, 'allow')
ok('allow 仍记冲突账', allowMode.rows().some(row => row.source === 'claims' && row.decision === 'allow'))

const allowAttempts = makeEnv({ claims: { conflict: 'allow', maxAttempts: 2 } })
await allowAttempts.call('c3', 'ego_click', { ref: 'e1' })
allowAttempts.fail('c3', 'ego_click', { ref: 'e1' })
await allowAttempts.call('c3', 'ego_click', { ref: 'e1' })
allowAttempts.fail('c3', 'ego_click', { ref: 'e1' })
await allowAttempts.call('c3', 'windows', { action: 'maximize' })
check('allow 模式下两次失败后仍只观察不拒绝', (await allowAttempts.call('c3', 'computer', { action: 'left_click' })).kind, 'allow')

/* ---------------------------------------------------------------- cross-agent */
console.log('\n## 7. 跨会话')
const agents = makeEnv()
await agents.call('sub-1', 'windows', { action: 'maximize', hwnd: 42 })
check('同一窗口跨会话互斥', (await agents.call('lead', 'computer', { action: 'left_click', hwnd: 42 })).kind, 'ask')
check('不同窗口跨会话不互斥', (await agents.call('lead', 'computer', { action: 'left_click', hwnd: 43 })).kind, 'allow')
const unknownAgents = makeEnv()
await unknownAgents.call('sub-2', 'ego_click', { ref: 'e1' })
check('双方目标未知时不跨会话互斥', (await unknownAgents.call('lead', 'computer', { action: 'left_click' })).kind, 'allow')
const crossFamily = makeEnv()
await crossFamily.call('sub-3', 'ego_navigate', { url: 'https://a.com/x' })
check('page 与 desktop 跨会话无法证明同一目标，不互斥（已知局限）', (await crossFamily.call('lead', 'computer', { action: 'left_click' })).kind, 'allow')

/* ------------------------------------------------------------------- policies */
console.log('\n## 8. deny / ask / 白名单')
const rules = makeEnv({
  deny: [{ tool: '^forbidden_', reason: 'blocked for test' }],
  ask: [{ tool: '^danger_', reason: 'needs confirmation' }],
  agents: [{ id: 's-restricted', allow: ['^read$'], deny: [] }, { prefix: 'locked-', deny: ['^ego_'] }],
})
check('瀑布 deny 带错误码', (await rules.call('p1', 'forbidden_write', {})).info?.code, 'capability_policy_denied')
check('白名单内工具放行', (await rules.call('s-restricted', 'read', {})).kind, 'allow')
check('白名单外工具拒绝', (await rules.call('s-restricted', 'ego_js', {})).kind, 'deny')
check('前缀规则按会话生效', (await rules.call('locked-7', 'ego_click', {})).kind, 'deny')
const asked = await rules.call('p2', 'danger_publish', {})
check('ask 规则返回 ask', asked.kind, 'ask')
ok('ask 规则的 displayReason 完整', Boolean(asked.displayReason?.en && asked.displayReason?.zh))

/* ---------------------------------------------------------------------- audit */
console.log('\n## 9. 审计')
const audited = makeEnv()
await audited.call('a1', 'read', { file_path: 'x' })
await audited.call('a1', 'ego_click', { ref: 'e1' })
await audited.call('a1', 'read_image', { file_path: 'x.png' })
const auditRows = audited.rows()
ok('普通读取不入账', !auditRows.some(row => row.tool === 'read'))
ok('自动化工具入账', auditRows.some(row => row.tool === 'ego_click' && row.decision === 'allow'))
ok('capture 入账且标 read 模式', auditRows.some(row => row.tool === 'read_image' && row.mode === 'read'))

const rotated = makeEnv({ audit: { maxBytes: 400 } })
for (let i = 0; i < 12; i++) await rotated.call('a2', 'ego_click', { ref: `e${i}` })
ok('审计超过上限后轮转出 .1', existsSync(`${rotated.auditFile}.1`))

/* --------------------------------------------------------------------- config */
console.log('\n## 10. 配置校验')
function throwsWith (label, fn, fragment) {
  try {
    fn()
    ok(label, false, '没有抛错')
  } catch (error) {
    ok(label, error.message.includes(fragment), error.message.split('\n')[0])
  }
}
const defaults = mod.resolveConfig({})
check('空配置回落到出厂互斥组', defaults.groups.length, 6)
check('空配置默认启用占用', defaults.claimsEnabled, true)
check('冲突裁决默认 ask', defaults.conflictMode, 'ask')
throwsWith('未知冲突模式被拒绝', () => mod.resolveConfig({ claims: { conflict: 'maybe' } }), 'claims.conflict')
throwsWith('坏正则被拒绝', () => mod.resolveConfig({ deny: [{ tool: '^computer_(' }] }), 'deny[0].tool')
throwsWith('只读正则写错也被拒绝', () => mod.resolveConfig({ claims: { readOnly: [{ tool: '^(' }] } }), 'claims.readOnly[0].tool')
throwsWith('豁免正则写错也被拒绝', () => mod.resolveConfig({ claims: { exempt: [{ tool: '^(' }] } }), 'claims.exempt[0].tool')
throwsWith('未知类别被拒绝', () => mod.resolveConfig({ claims: { groups: [['page', 'pixle']] } }), '未知类别')
throwsWith('非对象被拒绝', () => mod.resolveConfig([]), 'JSON 对象')
throwsWith('单组被拒绝', () => mod.resolveConfig({ claims: { groups: [['page']] } }), '至少两个类别')
const rulesFile = join(TMP, 'broken.json')
writeFileSync(rulesFile, '{ "deny": [] ,, }', 'utf8')
throwsWith('rules.json 语法错误被拒绝', () => mod.loadConfig({ file: rulesFile }), '不是合法 JSON')
const goodFile = join(TMP, 'good.json')
writeFileSync(goodFile, JSON.stringify({ audit: { file: 'audit-x.jsonl' } }), 'utf8')
const goodConfig = mod.loadConfig({ file: goodFile })
ok('相对审计路径落在规则文件目录', goodConfig.audit.file === join(TMP, 'audit-x.jsonl'), goodConfig.audit.file)
function withEnv (overrides, fn) {
  const keys = ['DSH_PROFILE_DIR', 'LOCALAPPDATA', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'USERPROFILE', 'HOME']
  const saved = new Map(keys.map(key => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  Object.assign(process.env, overrides)
  try {
    return fn()
  } finally {
    for (const key of keys) {
      const value = saved.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
const profilePath = withEnv({ DSH_PROFILE_DIR: TMP }, () => mod.resolveConfig({}).audit.file)
ok('审计路径优先 profile 目录', profilePath === join(TMP, 'capability-policy', 'audit.jsonl'), profilePath)
const localPath = withEnv({ LOCALAPPDATA: TMP }, () => mod.resolveConfig({}).audit.file)
ok('Host 里没有 profile 变量时落到 LOCALAPPDATA', localPath === join(TMP, 'dsh-capability-policy', 'audit.jsonl'), localPath)
const homePath = withEnv({ USERPROFILE: TMP }, () => mod.resolveConfig({}).audit.file)
ok('再退一层用 HOME', homePath === join(TMP, '.dsh-capability-policy', 'audit.jsonl'), homePath)

/* --------------------------------------------------------------------- report */
rmSync(TMP, { recursive: true, force: true })
console.log(`\n## 11. 提示词预算`)
console.log(`PROMPT: ${mod.PROMPT.length} chars, 约 ${Math.round(mod.PROMPT.length / 3.6)} token`)
console.log(failures === 0 ? `\nALL PASS (${checks} checks)` : `\n${failures} FAILURE(S) of ${checks} checks`)
process.exitCode = failures === 0 ? 0 : 1
