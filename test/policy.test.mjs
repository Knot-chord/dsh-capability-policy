/**
 * Regression suite for @local/dsh-capability-policy 2.0.
 *
 * Rules are passed inline through apply(ctx, { rules }) so the shipped rules.json is never
 * rewritten mid-test, and every assertion runs against the *shipped* table and group config
 * rather than a simplified fixture.
 *
 * The fake ctx mirrors the real dispatch shape closely enough to be meaningful: a call
 * goes through `tools/pre-execute`, is dispatched through `tools/execute` when allowed (or
 * when a conflict was approved), and reports failures through `tools/result`. That is the
 * only way to cover the approved-ask path, which used to dispatch without an owner.
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
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  if (!same) failures++
  console.log(`${same ? 'PASS' : 'FAIL'} ${label} -> ${JSON.stringify(actual)}${same ? '' : ` (expected ${JSON.stringify(expected)})`}`)
}
function ok (label, condition, detail = '') {
  checks++
  if (!condition) failures++
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` -> ${detail}`}`)
}

/** Poll a predicate; the rules watcher is asynchronous by nature. */
async function waitFor (predicate, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return false
}

rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
mkdirSync(join(TMP, 'plain'), { recursive: true })

const mod = await import(pathToFileURL(join(ROOT, 'index.js')).href + `?v=${Date.now()}`)

const ENV_KEYS = ['DSH_PROFILE_DIR', 'LOCALAPPDATA', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'USERPROFILE', 'HOME']
function withEnv (overrides, fn) {
  const saved = new Map(ENV_KEYS.map(key => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  Object.assign(process.env, overrides)
  try {
    return fn()
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

let seq = 0
function makeEnv (rules = {}, tag, options = {}) {
  const name = tag ?? `env${++seq}`
  const auditFile = options.auditFile ?? join(TMP, `${name}.jsonl`)
  const merged = {
    scope: rules.scope ?? { spaces: [...mod.DEFAULTS.scope.spaces] },
    capabilities: rules.capabilities ?? [],
    claims: { ...mod.DEFAULTS.claims, ...(rules.claims ?? {}) },
    deny: rules.deny ?? [],
    ask: rules.ask ?? [],
    agents: rules.agents ?? [],
    audit: { enabled: true, file: auditFile, ...(rules.audit ?? {}) },
  }
  const handlers = new Map()
  const sections = []
  const disposers = []
  let guardRegistrations = 0
  let guardFn
  const ctx = {
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    systemPrompt: { section: (section) => { sections.push(section); return () => {} } },
    tools: { guard: (fn) => { guardRegistrations++; guardFn = fn; return () => {} } },
    on: (event, fn) => { handlers.set(event, fn); return () => {} },
  }
  /* Either inline rules (the default) or a real file, which is the only way to exercise the
   * watcher. Both paths go through the same apply(). */
  const applyOptions = { clock: options.clock }
  if (options.rulesFile !== undefined) {
    applyOptions.rulesFile = options.rulesFile
    applyOptions.watchInterval = options.watchInterval ?? 40
  } else {
    applyOptions.rules = merged
  }
  mod.apply(ctx, applyOptions)

  let calls = 0
  const execOf = (agent, name, args) => ({
    name,
    arguments: args,
    callId: `call-${++calls}`,
    ...(agent === null ? {} : { agent: { id: agent } }),
  })

  const rows = () => existsSync(auditFile)
    ? readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []

  return {
    auditFile,
    sections,
  /* 段落 text 可以是函数（动态段落）；测试里统一求值一次 */
  sectionText: () => (typeof sections[0]?.text === 'function' ? sections[0].text({}) : sections[0]?.text),
    rows,
    guardRegistrations: () => guardRegistrations,
    guard: (exec) => guardFn?.(exec),
    /* Release effects (the rules watcher) so the process can exit. */
    teardown: () => { for (const stopEffect of disposers.splice(0)) stopEffect() },
    /* A full dispatch: verdict, then dispatch when it is allowed (or approved). */
    call: async (agent, name, args = {}, opts = {}) => {
      const exec = execOf(agent, name, args)
      const decision = await handlers.get('tools/pre-execute')(exec, async () => ({ kind: 'allow' }))
      const dispatch = opts.dispatch ?? true
      if ((decision?.kind === 'allow' && dispatch) || (decision?.kind === 'ask' && opts.approve)) {
        await handlers.get('tools/execute')(exec, async () => ({ isError: false }))
      }
      return decision
    },
    /* Verdict only, never dispatched. */
    peek: async (agent, name, args = {}) => handlers.get('tools/pre-execute')(execOf(agent, name, args), async () => ({ kind: 'allow' })),
    /* Run the waterfall on a caller-supplied exec object (identity matters for dedupe). */
    pre: async (exec) => handlers.get('tools/pre-execute')(exec, async () => ({ kind: 'allow' })),
    fail: (agent, name, args = {}) => handlers.get('tools/result')(execOf(agent, name, args), { isError: true }),
    succeed: (agent, name, args = {}) => handlers.get('tools/result')(execOf(agent, name, args), { isError: false }),
    stop: (agent) => handlers.get('agent/turn-stopping')?.({ agent: { id: agent }, turn: 1, signal: new AbortController().signal }),
    dispose: (agent) => handlers.get('agent/disposed')?.({ agent: { id: agent } }),
  }
}

const lastRow = (env, predicate) => env.rows().filter(predicate).at(-1)

/* ------------------------------------------------------------ 1. contracts */
console.log('\n## 1. 契约与提示词')
const base = makeEnv()
check('只注册一段提示词', base.sections.length, 1)
check('提示词段落名', base.sections[0].name, 'capability-policy:routing')
check('提示词顺序', base.sections[0].order, 9000)
ok('提示词含闸门顺序', base.sectionText().includes('Gates in order'))
ok('提示词写明了 select 不占位', base.sectionText().includes('Pointing at a surface'))
ok('提示词不含废弃的分数模式', !/weighted|multiplicative|lexicographic/.test(base.sectionText()))
ok('提示词长度在预算内', mod.PROMPT.length <= 1600, `${mod.PROMPT.length} chars`)
ok('提示词不含规则文件内容', !mod.PROMPT.includes('rules.json') && !mod.PROMPT.includes('"deny"'))
/* The backstop is always registered: `watch` can add a deny rule to a live profile, and a
 * guard that only exists when the file happened to have one at load time is not a backstop. */
check('总是注册 guard（热重载可能新增 deny 规则）', base.guardRegistrations(), 1)
check('无规则时 guard 放行', base.guard({ name: 'forbidden_write', arguments: {}, agent: { id: 'g' } }), undefined)
const withDeny = makeEnv({ deny: [{ tool: '^forbidden_', reason: 'blocked for test' }] })
check('有 deny 规则时注册 guard', withDeny.guardRegistrations(), 1)
check('guard 返回字符串（0.2.1–0.2.2 唯一通用返回类型）', typeof withDeny.guard({ name: 'forbidden_write', arguments: {}, agent: { id: 'g' } }), 'string')
check('guard 返回规则里的理由', withDeny.guard({ name: 'forbidden_write', arguments: {}, agent: { id: 'g' } }), 'blocked for test')
check('guard 放行未命中工具', withDeny.guard({ name: 'read', arguments: {}, agent: { id: 'g' } }), undefined)

/* The guard runs before the waterfall, so a refusal there ends the call before pre-execute
 * is reached: if it did not record, a profile with deny rules would have a ledger that says
 * nothing was ever blocked. */
const guardAudit = makeEnv({ deny: [{ tool: '^forbidden_', reason: 'blocked for test' }] }, 'guard-audit')
const sharedExec = { name: 'forbidden_write', arguments: {}, agent: { id: 'g1' }, callId: 'shared-1' }
check('guard 拒绝仍返回理由字符串', guardAudit.guard(sharedExec), 'blocked for test')
const guardRow = lastRow(guardAudit, row => row.tool === 'forbidden_write')
check('guard 拒绝写审计', guardRow?.decision, 'deny')
check('guard 审计标记出处', guardRow?.via, 'guard')
await guardAudit.pre(sharedExec)
check('同一调用被 guard 与瀑布都看到时只记一行', guardAudit.rows().filter(row => row.tool === 'forbidden_write').length, 1)
ok('导出了纯决策函数', typeof mod.describeRequest === 'function' && typeof mod.classifyTool === 'function')
ok('导出了分类表', Array.isArray(mod.DEFAULT_CAPABILITIES) && mod.DEFAULT_CAPABILITIES.length > 8, `${mod.DEFAULT_CAPABILITIES.length} rows`)

/* --------------------------------------------------------- 2. classification */
console.log('\n## 2. 分类表：owner + effect（真实工具名）')
const defaults = mod.resolveConfig({}, { baseDir: TMP })
const effectOf = (tool, args) => {
  const info = mod.describeRequest(tool, args, defaults)
  return [info.owner, info.effect ?? null]
}
for (const [tool, args, expected] of [
  ['computer', { action: 'screenshot' }, ['pixel', 'observe']],
  ['computer', { action: 'zoom' }, ['pixel', 'observe']],
  ['computer', { action: 'cursor_position' }, ['pixel', 'observe']],
  ['computer', { action: 'wait' }, ['pixel', 'observe']],
  ['computer', { action: 'left_click' }, ['pixel', 'act']],
  ['computer', { action: 'type' }, ['pixel', 'act']],
  ['computer_batch', { actions: [{ action: 'screenshot' }, { action: 'zoom' }] }, ['pixel', 'observe']],
  ['computer_batch', { actions: [{ action: 'left_click' }] }, ['pixel', 'act']],
  /* A batch is as strong as its strongest element: a click next to a screenshot still acts. */
  ['computer_batch', { actions: [{ action: 'screenshot' }, { action: 'left_click' }] }, ['pixel', 'act']],
  ['windows', { action: 'list' }, ['native', 'observe']],
  ['windows', { action: 'focus', hwnd: 1 }, ['native', 'select']],
  ['windows', { action: 'restore', hwnd: 1 }, ['native', 'select']],
  ['windows', { action: 'maximize', hwnd: 1 }, ['native', 'act']],
  ['windows', { action: 'minimize', hwnd: 1 }, ['native', 'act']],
  ['windows', { action: 'close', hwnd: 1 }, ['native', 'act']],
  ['windows', { action: 'tidy' }, ['native', 'act']],
  ['ui_elements', {}, ['native', 'observe']],
  ['open_application', { name: 'Chrome' }, ['native', 'select']],
  ['switch_display', {}, ['pixel', 'observe']],
  ['switch_display', { index: 1 }, ['pixel', 'act']],
  ['ego_click', {}, ['page', 'act']],
  ['ego_navigate', { url: 'https://a.com' }, ['page', 'act']],
  ['ego_js', {}, ['page', 'act']],
  ['ego_tabs', { action: 'list' }, ['page', 'observe']],
  ['ego_tabs', { action: 'switch' }, ['page', 'select']],
  ['ego_tabs', { action: 'close' }, ['page', 'act']],
  ['ego_snapshot', {}, ['page', 'observe']],
  ['ego_page_info', {}, ['page', 'observe']],
  ['ego_read_element', { selector: 'x' }, ['page', 'observe']],
  ['ego_wait_for_selector', { selector: 'x' }, ['page', 'observe']],
  ['ego_wait_for_human', {}, ['page', 'observe']],
  ['ego_doctor', {}, ['page', 'observe']],
  ['ego_screenshot', {}, ['capture', 'observe']],
  ['read_image', { file_path: 'x.png' }, ['capture', 'observe']],
  ['univer_screenshot', {}, ['capture', 'observe']],
  ['wechat_send', {}, ['app', 'act']],
  ['bilibili_extract', {}, ['other', null]],
  ['read', {}, ['other', null]],
  ['pwsh', {}, ['other', null]],
]) {
  check(`classify ${tool} ${JSON.stringify(args)}`, effectOf(tool, args), expected)
}
ok('分类表覆盖本 profile 的全部桌面/页面工具（不得静默落到 other）',
  ['computer', 'computer_batch', 'windows', 'ui_elements', 'open_application', 'switch_display',
    'ego_click', 'ego_cdp', 'ego_cli', 'ego_download', 'ego_drag', 'ego_fill', 'ego_hover', 'ego_js',
    'ego_key', 'ego_navigate', 'ego_navigate_back', 'ego_script', 'ego_scroll', 'ego_select',
    'ego_upload', 'ego_verify', 'ego_tabs']
    .every(tool => mod.describeRequest(tool, {}, defaults).owner !== 'other'))
check('classifyTool 只返回 owner（兼容旧导出）', mod.classifyTool('computer', { action: 'left_click' }, defaults), 'pixel')
check('classifyTool 无配置也能工作', mod.classifyTool('ego_click', {}), 'page')

const overridden = mod.resolveConfig({
  capabilities: [{ tool: '^windows$', owner: 'native', effect: 'act' }],
}, { baseDir: TMP })
check('用户行优先于内置行', mod.describeRequest('windows', { action: 'focus', hwnd: 1 }, overridden).effect, 'act')
check('用户行只覆盖命中的工具', mod.describeRequest('ego_click', {}, overridden).owner, 'page')

/* -------------------------------------------------- 2b. 未声明请求：只问「要动哪个」
 * 调度器不判断「这是不是自动化工具」——那是工具自己的知识。它只问两件事：这次请求要动
 * 哪个资源、以什么方式。没说出目标就无从仲裁，如实记账。 */
console.log('\n## 2b. 未声明请求：只仲裁「说出了目标」的')
const describe = (name, args) => mod.describeRequest(name, args, defaults)
const shape = (name, args) => [describe(name, args).owner, describe(name, args).effect ?? null, describe(name, args).arbitrable]
check('声明行仍然是权威：focus 只指过去', shape('windows', { action: 'focus', hwnd: 9 }), ['native', 'select', true])
check('声明行仍然是权威：list 只读', shape('windows', { action: 'list' }), ['native', 'observe', true])
check('未声明但指名了窗口 → 按 native 仲裁', shape('acme_win', { hwnd: 42 }), ['native', 'act', true])
check('未声明但指名了元素 → 按 page 仲裁', shape('acme_dom', { selector: '#go' }), ['page', 'act', true])
check('未声明但指名了点 → 按 pixel 仲裁', shape('acme_tap', { x: 5, y: 6 }), ['pixel', 'act', true])
check('未声明且没给目标 → 无从仲裁（不猜它是什么）', shape('acme_act', { action: 'click' }), ['other', null, false])
check('url 不是目标（取内容与导航无法区分）', shape('web_fetch', { url: 'https://a.com' }), ['other', null, false])
check('文件路径不是目标', shape('acme_file', { file_path: 'x' }), ['other', null, false])
check('纯文本不是目标', shape('acme_note', { text: 'hi' }), ['other', null, false])

const unknownAct = makeEnv({ claims: { conflict: 'deny' } })
await unknownAct.call('u1', 'acme_tap', { x: 5, y: 5 })
check('未声明请求按目标占位', (await unknownAct.call('u1', 'windows', { action: 'maximize', hwnd: 9 })).kind, 'deny')
ok('审计标明是「凭目标而非声明」入账', lastRow(unknownAct, row => row.tool === 'acme_tap' && row.decision === 'claim')?.inferred === true)

const unarbitrableEnv = makeEnv({}, 'unarbitrable-env')
await unarbitrableEnv.call('u2', 'acme_note', { text: 'hi' })
await unarbitrableEnv.call('u2', 'acme_note', { text: 'again' })
check('没目标、没声明的请求只记一次 unarbitrable', unarbitrableEnv.rows().filter(row => row.decision === 'unarbitrable').length, 1)
check('unarbitrable 记录请求工具名', lastRow(unarbitrableEnv, row => row.decision === 'unarbitrable')?.tool, 'acme_note')
check('无从仲裁的请求不占位', (await unarbitrableEnv.call('u2', 'computer', { action: 'left_click', coordinate: [1, 1] })).kind, 'allow')

const urlSuspect = makeEnv({}, 'url-suspect-env')
await urlSuspect.call('u5', 'acme_fetch', { url: 'https://example.com' })
const suspectRow = lastRow(urlSuspect, row => row.decision === 'unarbitrable')
check('取过 url 的请求标 suspect=url', suspectRow?.suspect, 'url')
ok('理由说明它是浏览器嫌疑', (suspectRow?.reason ?? '').includes('browser'), String(suspectRow?.reason).slice(0, 60))

/* 排除矩阵是「面会重叠」这个事实的闭包，不是手写清单 */
console.log('\n## 2c. 排除矩阵来自面的重叠关系')
ok('app/page/native/pixel 两两互斥（6 组）', mod.DEFAULT_GROUPS.length === 6)
ok('system 不与任何面互斥（它不是屏幕表面）', !mod.DEFAULT_GROUPS.some(group => group.includes('system')))
check('出厂配置直接用这份推导结果', defaults.groups.length, mod.DEFAULT_GROUPS.length)

/* ------------------------------------------------- 3. effect decides ownership *//* ------------------------------------------------- 3. effect decides ownership */
console.log('\n## 3. effect 决定是否占用（事故根因修复）')
/* The incident: `windows focus` claimed the window as `native`, and every later pixel or
 * page call on it was denied for the rest of the turn. Focus only points at a surface. */
const incident = makeEnv()
const focus = await incident.call('i1', 'windows', { action: 'focus', hwnd: 1050872 })
check('windows focus 放行', focus.kind, 'allow')
ok('windows focus 按 select 入账（mode 仍是 act）', (() => {
  const row = lastRow(incident, entry => entry.tool === 'windows')
  return row?.effect === 'select' && row?.mode === 'act'
})())
check('事故回归：focus 之后 computer 点击放行', (await incident.call('i1', 'computer', { action: 'left_click', coordinate: [10, 10] })).kind, 'allow')
ok('事故回归：focus 之后没有任何 native 占用', !incident.rows().some(row => row.decision === 'claim' && row.owner === 'native'))

const selectTools = [
  ['windows', { action: 'focus', hwnd: 7 }],
  ['windows', { action: 'restore', hwnd: 7 }],
  ['open_application', { name: 'Notepad' }],
  ['switch_display', {}],
  ['ego_tabs', { action: 'switch' }],
]
for (const [tool, args] of selectTools) {
  const env = makeEnv({}, `select-${tool}-${args.action ?? 'x'}`)
  await env.call('s1', tool, args)
  check(`select ${tool} ${args.action ?? ''} 不占位`, (await env.call('s1', 'computer', { action: 'left_click', coordinate: [1, 1] })).kind, 'allow')
}

const observeTools = [
  ['computer', { action: 'screenshot' }],
  ['computer', { action: 'wait' }],
  ['computer_batch', { actions: [{ action: 'screenshot' }, { action: 'zoom' }] }],
  ['windows', { action: 'list' }],
  ['ui_elements', {}],
  ['ego_snapshot', {}],
  ['ego_tabs', { action: 'list' }],
  ['read_image', { file_path: 'x.png' }],
]
for (const [tool, args] of observeTools) {
  const env = makeEnv({}, `observe-${tool}-${args.action ?? 'batch'}`)
  await env.call('o1', tool, args)
  check(`observe ${tool} ${args.action ?? ''} 不占位`, (await env.call('o1', 'computer', { action: 'left_click', coordinate: [1, 1] })).kind, 'allow')
  ok(`observe ${tool} 仍入账`, env.rows().some(row => row.tool === tool && row.decision === 'allow'))
}

/* A claim must block the *other* class, never its own: the probe is always a different
 * family than the tool that acted. */
const actingProbes = [
  ['windows', { action: 'maximize', hwnd: 9 }, ['computer', { action: 'left_click', hwnd: 9 }]],
  ['windows', { action: 'minimize', hwnd: 9 }, ['computer', { action: 'left_click', hwnd: 9 }]],
  ['windows', { action: 'close', hwnd: 9 }, ['computer', { action: 'left_click', hwnd: 9 }]],
  ['ego_click', { ref: 'e1' }, ['windows', { action: 'maximize', hwnd: 9 }]],
  ['computer_batch', { actions: [{ action: 'left_click' }] }, ['windows', { action: 'maximize', hwnd: 9 }]],
]
for (const [tool, args, [probe, probeArgs]] of actingProbes) {
  const env = makeEnv({ claims: { conflict: 'deny' } }, `act-${tool}-${args.action ?? 'batch'}`)
  await env.call('a1', tool, args)
  check(`act ${tool} ${args.action ?? ''} 占住目标`, (await env.call('a1', probe, probeArgs)).kind, 'deny')
  ok(`act ${tool} 写入 claim 审计`, env.rows().some(row => row.decision === 'claim'))
  check(`act ${tool} 不阻挡同类`, (await env.call('a1', tool, args)).kind, 'allow')
}

/* ------------------------------------------------------- 4. resource identity */
console.log('\n## 4. 资源身份')
const identity = makeEnv()
await identity.call('t1', 'windows', { action: 'maximize', hwnd: 100 })
check('同一桌面族、不同句柄不互斥', (await identity.call('t1', 'computer', { action: 'left_click', hwnd: 200 })).kind, 'allow')
const byName = makeEnv()
await byName.call('t2', 'windows', { action: 'maximize', name: 'Edge' })
check('windows 的 name 也是桌面身份键', (await byName.call('t2', 'computer', { action: 'left_click', name: 'edge' })).kind, 'ask')
check('不同 name 不互斥', (await byName.call('t2', 'computer', { action: 'left_click', name: 'Notepad' })).kind, 'allow')
const pages = makeEnv()
/* Page keys cannot decide a conflict by themselves: `page` is the only owner in its
 * family, and a URL is never comparable with a window handle, so identity is asserted on
 * the decision function where it is actually computed. */
const keysOf = (url) => mod.describeRequest('ego_navigate', { url }, defaults).resource.key
check('URL 归一化：丢 query', keysOf('https://a.com/x?tab=2'), 'https://a.com/x')
check('URL 归一化：丢 hash', keysOf('https://a.com/x#top'), 'https://a.com/x')
check('URL 归一化：保留路径', keysOf('https://a.com/x/y/'), 'https://a.com/x/y')
check('URL 归一化：不同源不同键', keysOf('https://b.com/x'), 'https://b.com/x')
check('桌面身份键归一为小写', mod.describeRequest('windows', { action: 'maximize', name: 'Edge' }, defaults).resource.key, 'edge')
const pageAudit = makeEnv()
await pageAudit.call('t3', 'ego_navigate', { url: 'https://a.com/x' })
ok('page 归属方的资源键会进审计', pageAudit.rows().some(row => row.tool === 'ego_navigate' && row.resource === 'https://a.com/x'))
const families = makeEnv()
await families.call('t4', 'ego_navigate', { url: 'https://a.com/x' })
check('page 的 url 与 desktop 的 hwnd 无法证明不同 -> 同一资源', (await families.call('t4', 'computer', { action: 'left_click', hwnd: 7 })).kind, 'ask')

/* ------------------------------------------------------- 5. conflict verdicts */
console.log('\n## 5. 冲突裁决')
const askMode = makeEnv()
await askMode.call('c1', 'ego_click', { ref: 'e1' })
const asked = await askMode.call('c1', 'computer', { action: 'left_click' })
check('默认 ask', asked.kind, 'ask')
ok('ask 带双语 displayReason', Boolean(asked.displayReason?.en && asked.displayReason?.zh), asked.displayReason?.zh?.slice(0, 20))

const denyMode = makeEnv({ claims: { conflict: 'deny' } })
await denyMode.call('c2', 'ego_click', { ref: 'e1', url: 'https://a.com/x' })
const denied = await denyMode.call('c2', 'windows', { action: 'maximize', hwnd: 77 })
check('conflict=deny 直接拒绝', denied.kind, 'deny')
check('deny 带 conflict 错误码', denied.info?.code, 'capability_policy_conflict')
ok('deny 理由说明了怎么解除', denied.reason.includes('claims.conflict'))
ok('deny 理由带被占资源键', denied.reason.includes('https://a.com/x'), denied.reason.slice(0, 90))
ok('deny 理由带占用方', denied.reason.includes('page:ego_click'))
/* A refusal has to explain the judgement, not just state it: when the two sides cannot be
 * proven different, say so and say how to make it provable. */
ok('不可证同面时给出可操作提示', denied.reason.includes('name the target explicitly'))

const provable = makeEnv({ claims: { conflict: 'deny' } })
await provable.call('c2b', 'windows', { action: 'maximize', hwnd: 100 })
const sameSurface = await provable.call('c2b', 'computer', { action: 'left_click', hwnd: 100 })
check('可证同面时照样拒绝', sameSurface.kind, 'deny')
ok('可证同面时不出现「无法证明」的提示', !sameSurface.reason.includes('cannot prove'))

/* The hint must point at the side that is actually missing identity: telling a caller that
 * already named its hwnd to "name the target" is advice that cannot work. */
const holderKeyless = makeEnv({ claims: { conflict: 'deny' } })
await holderKeyless.call('c2c', 'computer', { action: 'left_click', coordinate: [1, 1] })
const namedCaller = await holderKeyless.call('c2c', 'windows', { action: 'maximize', hwnd: 200 })
ok('占用方用坐标时，提示指向占用方而不是调用方', namedCaller.reason.includes('acted without naming this target'), namedCaller.reason.slice(-120))

const callerKeyless = makeEnv({ claims: { conflict: 'deny' } })
await callerKeyless.call('c2d', 'ego_navigate', { url: 'https://a.com/x' })
const unnamedCaller = await callerKeyless.call('c2d', 'computer', { action: 'left_click', coordinate: [1, 1] })
ok('调用方没给目标时，提示指向调用方', unnamedCaller.reason.includes('Name your target explicitly'), unnamedCaller.reason.slice(-90))

const allowMode = makeEnv({ claims: { conflict: 'allow' } })
await allowMode.call('c3', 'ego_click', { ref: 'e1' })
check('conflict=allow 放行', (await allowMode.call('c3', 'computer', { action: 'left_click' })).kind, 'allow')
ok('allow 仍记冲突账', allowMode.rows().some(row => row.source === 'claims' && row.decision === 'allow'))

/* An approved conflict must end with the new class owning the surface. It used to be asked,
 * approved, and then dispatched with no claim at all, so the next call was asked again. */
const approved = makeEnv()
await approved.call('c4', 'ego_click', { ref: 'e1' })
const approvedCall = await approved.call('c4', 'computer', { action: 'left_click' }, { approve: true })
check('冲突先问', approvedCall.kind, 'ask')
check('批准后同类再调用不再被拦（占用已建立）', (await approved.call('c4', 'computer', { action: 'left_click' })).kind, 'allow')
check('批准路径只写一条 claim', approved.rows().filter(row => row.decision === 'claim' && row.owner === 'pixel').length, 1)

/* Two classes overlap in allow mode: the newcomer takes over, and the handover is explicit
 * rather than a silent overwrite, so the ledger can still say who lost the surface. */
const overlap = makeEnv({ claims: { conflict: 'allow' } })
await overlap.call('o1', 'ego_click', { ref: 'e1' })
const beforeTakeover = await overlap.peek('o1', 'windows', { action: 'maximize', hwnd: 5 })
check('allow 模式下别的类仍能看到占用', beforeTakeover.kind, 'allow')
check('接管前占用方是 page', lastRow(overlap, row => row.tool === 'windows' && row.source === 'claims')?.holder, 'page:ego_click')
await overlap.call('o1', 'computer', { action: 'left_click' })
ok('接管写一条 transfer 释放', overlap.rows().some(row => row.decision === 'release' && row.source === 'transfer' && row.owner === 'page'))
await overlap.peek('o1', 'windows', { action: 'maximize', hwnd: 5 })
check('接管后占用方变成 pixel', lastRow(overlap, row => row.tool === 'windows' && row.source === 'claims')?.holder, 'pixel:computer')

/* --------------------------------------------------------- 6. failure release */
console.log('\n## 6. 失败释放')
const rel = makeEnv()
await rel.call('f1', 'ego_click', { ref: 'e1' })
check('先由 page 占住', (await rel.call('f1', 'computer', { action: 'left_click' })).kind, 'ask')
rel.fail('f1', 'ego_click', { ref: 'e1' })
check('失败后降级到 pixel 被放行', (await rel.call('f1', 'computer', { action: 'left_click', coordinate: [1, 1] })).kind, 'allow')
ok('审计含 release 行', rel.rows().some(row => row.decision === 'release' && row.source === 'failure'))
ok('release 行带占用方与工具名', (() => {
  const row = lastRow(rel, entry => entry.decision === 'release')
  return row?.owner === 'page' && row?.tool === 'ego_click'
})())

const wrongTool = makeEnv()
await wrongTool.call('f2', 'ego_click', { ref: 'e1' })
wrongTool.fail('f2', 'ego_js', { expression: '1' })
check('同类别的另一个工具失败不释放占用', (await wrongTool.call('f2', 'computer', { action: 'left_click' })).kind, 'ask')

/* Same tool name, different kind of call: a failed screenshot must not hand back the click. */
const shotFail = makeEnv({ claims: { conflict: 'deny' } })
await shotFail.call('f3', 'computer', { action: 'left_click', coordinate: [1, 1] })
shotFail.fail('f3', 'computer', { action: 'screenshot' })
check('截图失败不释放点击的占用', (await shotFail.call('f3', 'windows', { action: 'maximize' })).kind, 'deny')
ok('截图失败不写 release 行', !shotFail.rows().some(row => row.decision === 'release'))

const okResult = makeEnv()
await okResult.call('f4', 'ego_click', { ref: 'e1' })
okResult.succeed('f4', 'ego_click', { ref: 'e1' })
check('成功结果不释放占用', (await okResult.call('f4', 'computer', { action: 'left_click' })).kind, 'ask')

/* ------------------------------------------------------ 7. the attempt ledger */
console.log('\n## 7. 重试账本')
const limited = makeEnv()
await limited.call('g1', 'ego_click', { ref: 'e1' })
limited.fail('g1', 'ego_click', { ref: 'e1' })
await limited.call('g1', 'ego_click', { ref: 'e1' })
limited.fail('g1', 'ego_click', { ref: 'e1' })
await limited.call('g1', 'ego_click', { ref: 'e1' })
const exhausted = await limited.call('g1', 'computer', { action: 'left_click' })
check('两次失败后再换类被拒绝', exhausted.kind, 'deny')
check('拒绝带 exhausted 错误码', exhausted.info?.code, 'capability_policy_exhausted')
ok('升级文案要求停手或问用户', exhausted.reason.includes('end the turn') && exhausted.reason.includes('ask the user'))

/* Pure conflicts spend the budget too: the incident hit the wall six times and every row
 * still said `attempts 0`, because only the failure path ever counted. */
const conflictBudget = makeEnv({ claims: { conflict: 'deny' } })
await conflictBudget.call('g2', 'windows', { action: 'maximize', hwnd: 100 })
await conflictBudget.call('g2', 'windows', { action: 'maximize', hwnd: 101 })
const hit1 = await conflictBudget.call('g2', 'computer', { action: 'left_click', hwnd: 100 })
const hit2 = await conflictBudget.call('g2', 'computer', { action: 'left_click', hwnd: 100 })
const hit3 = await conflictBudget.call('g2', 'computer', { action: 'left_click', hwnd: 100 })
check('第一次冲突不升级', hit1.info?.code, 'capability_policy_conflict')
check('第二次冲突不升级', hit2.info?.code, 'capability_policy_conflict')
check('第三次纯冲突升级（不再恒为 attempts 0）', hit3.info?.code, 'capability_policy_exhausted')
check('冲突审计带尝试计数', lastRow(conflictBudget, row => row.source === 'claims')?.attempts, 3)

/* The budget belongs to one target: work on hwnd 100 must not exhaust hwnd 101. */
const perTarget = await conflictBudget.call('g2', 'computer', { action: 'left_click', hwnd: 101 })
check('另一目标的预算未被同一会话的失败吃掉', perTarget.info?.code, 'capability_policy_conflict')

/* The budget must not be resettable by renaming the target: a page holder is only ever an
 * "unprovable" counterpart for the desktop class, so navigating to a fresh URL between
 * attempts must not hand the caller a fresh count. */
const churn = makeEnv({ claims: { conflict: 'deny' } })
await churn.call('g5', 'ego_navigate', { url: 'https://a.com/1' })
const churn1 = await churn.call('g5', 'computer', { action: 'left_click' })
await churn.call('g5', 'ego_navigate', { url: 'https://a.com/2' })
const churn2 = await churn.call('g5', 'computer', { action: 'left_click' })
await churn.call('g5', 'ego_navigate', { url: 'https://a.com/3' })
const churn3 = await churn.call('g5', 'computer', { action: 'left_click' })
check('换 URL 后第一次仍只是冲突', churn1.info?.code, 'capability_policy_conflict')
check('换 URL 后第二次仍只是冲突', churn2.info?.code, 'capability_policy_conflict')
check('换 URL 不能重置预算（第三次升级）', churn3.info?.code, 'capability_policy_exhausted')
ok('不可证同面时预算记在会话作用域', lastRow(churn, row => row.source === 'claims')?.scope === 'u',
  String(lastRow(churn, row => row.source === 'claims')?.scope))
ok('可证同面时预算记在面作用域', (() => {
  const row = lastRow(conflictBudget, entry => entry.source === 'claims')
  return typeof row?.scope === 'string' && row.scope.startsWith('s:desktop:')
})(), String(lastRow(conflictBudget, row => row.source === 'claims')?.scope))

/* An approval is the user's decision, not the caller retrying: it must refund the attempt
 * it was charged, or a single "yes" would lock out the next switch under maxAttempts=1. */
const refunded = makeEnv({ claims: { conflict: 'ask', maxAttempts: 1 } })
await refunded.call('g6', 'ego_click', { ref: 'e1' })
check('冲突被询问', (await refunded.call('g6', 'computer', { action: 'left_click' }, { approve: true })).kind, 'ask')
check('批准后不消耗预算（下一次仍是询问而不是耗尽）', (await refunded.peek('g6', 'windows', { action: 'maximize', hwnd: 5 })).kind, 'ask')
ok('退款记在 claim 行里', refunded.rows().some(row => row.decision === 'claim' && row.refunded === true))

const rejected = makeEnv({ claims: { conflict: 'ask', maxAttempts: 1 } })
await rejected.call('g7', 'ego_click', { ref: 'e1' })
check('冲突被询问（未批准）', (await rejected.call('g7', 'computer', { action: 'left_click' })).kind, 'ask')
check('未批准的询问要计预算（下一次升级为拒绝）', (await rejected.peek('g7', 'windows', { action: 'maximize', hwnd: 5 })).kind, 'deny')

const unlimited = makeEnv({ claims: { maxAttempts: 0 } })
await unlimited.call('g3', 'ego_click', { ref: 'e1' })
unlimited.fail('g3', 'ego_click', { ref: 'e1' })
await unlimited.call('g3', 'ego_click', { ref: 'e1' })
unlimited.fail('g3', 'ego_click', { ref: 'e1' })
await unlimited.call('g3', 'ego_click', { ref: 'e1' })
check('maxAttempts=0 时只问不拒', (await unlimited.call('g3', 'computer', { action: 'left_click' })).kind, 'ask')

const allowAttempts = makeEnv({ claims: { conflict: 'allow', maxAttempts: 2 } })
await allowAttempts.call('g4', 'ego_click', { ref: 'e1' })
for (let index = 0; index < 4; index++) await allowAttempts.call('g4', 'computer', { action: 'left_click' })
check('allow 模式不受 maxAttempts 限制', (await allowAttempts.call('g4', 'computer', { action: 'left_click' })).kind, 'allow')
ok('allow 模式不消耗尝试', !allowAttempts.rows().some(row => row.source === 'claims' && row.decision === 'allow' && typeof row.attempts === 'number' && row.attempts > 0))

/* ------------------------------------------------------------ 8. cross-agent */
console.log('\n## 8. 跨会话与未归属调用')
const agents = makeEnv()
await agents.call('sub-1', 'windows', { action: 'maximize', hwnd: 42 })
check('同一窗口跨会话互斥', (await agents.call('lead', 'computer', { action: 'left_click', hwnd: 42 })).kind, 'ask')
check('不同窗口跨会话不互斥', (await agents.call('lead', 'computer', { action: 'left_click', hwnd: 43 })).kind, 'allow')
const unknownAgents = makeEnv()
await unknownAgents.call('sub-2', 'ego_click', { ref: 'e1' })
check('双方目标未知时也互斥：子会话不能自顾自驱动同一个面', (await unknownAgents.call('lead', 'computer', { action: 'left_click' })).kind, 'ask')
const crossFamily = makeEnv()
await crossFamily.call('sub-3', 'ego_navigate', { url: 'https://a.com/x' })
check('跨空间无法证明同一目标时，跨会话同样互斥', (await crossFamily.call('lead', 'computer', { action: 'left_click' })).kind, 'ask')

/* `exec.agent` is optional in ToolExecution. The gate must still run. */
const unattributed = makeEnv({ claims: { conflict: 'deny' } })
await unattributed.call(null, 'ego_navigate', { url: 'https://a.com/p' })
check('无 agent 的调用仍然占位', (await unattributed.call('someone', 'windows', { action: 'maximize', hwnd: 5 })).kind, 'deny')
ok('无 agent 时审计用哨兵身份', unattributed.rows().some(row => row.agent === mod.UNATTRIBUTED), mod.UNATTRIBUTED)

/* A call with no agent has no turn to belong to, so its ownership ends with the call. The
 * alternative — waiting for the TTL — leaves a phantom owner denying real sessions. */
const orphan = makeEnv({ claims: { conflict: 'deny' } })
await orphan.call(null, 'windows', { action: 'maximize', hwnd: 77 })
orphan.succeed(null, 'windows', { action: 'maximize', hwnd: 77 })
check('未归属调用的占用不跨调用存活', (await orphan.call('real', 'computer', { action: 'left_click', hwnd: 77 })).kind, 'allow')
ok('未归属释放按 call 作用域留痕', orphan.rows().some(row => row.decision === 'release' && row.source === 'call'))

/* Same-tick concurrency: check-and-take is one synchronous step with no await in between,
 * so two contending calls scheduled before either returns cannot both pass. */
const race = makeEnv({ claims: { conflict: 'deny' } })
const [firstIn, secondIn] = await Promise.all([
  race.peek('x', 'ego_click', { ref: 'e1' }),
  race.peek('x', 'computer', { action: 'left_click' }),
])
check('同一 tick 并发：先到者放行', firstIn.kind, 'allow')
check('同一 tick 并发：后到者被拦', secondIn.kind, 'deny')

/* ------------------------------------------------------------ 9. lifecycle */
console.log('\n## 9. 生命周期与审计')
const turns = makeEnv()
await turns.call('h1', 'ego_click', { ref: 'e1' })
turns.stop('h1')
check('回合结束清空占用', (await turns.call('h1', 'computer', { action: 'left_click' })).kind, 'allow')
const turnRow = lastRow(turns, row => row.decision === 'release')
ok('回合释放写审计', turnRow?.source === 'turn' && turnRow?.owner === 'page' && turnRow?.tool === 'ego_click')

/* The ledger is per turn, so it has to say where one turn ended: otherwise a reader cannot
 * tell whether two rows shared a turn — the first question asked of any denial. */
const turnMarker = lastRow(turns, row => row.decision === 'turn-end')
check('回合结束写 turn-end 标记', turnMarker?.turn, 1)
check('turn-end 记下释放数量', turnMarker?.released, 1)
ok('turn-end 带可读摘要', typeof turnMarker?.reason === 'string' && turnMarker.reason.includes('turn 1'), String(turnMarker?.reason))
const idleTurn = makeEnv({}, 'idle-turn-env')
idleTurn.stop('nobody')
ok('没有任何审计活动的回合不写标记', !idleTurn.rows().some(row => row.decision === 'turn-end'))

/* A turn whose only activity was an out-of-scope tool still has to be delimited. */
const outOfScopeTurn = makeEnv({}, 'out-of-scope-turn')
await outOfScopeTurn.call('t9', 'acme_note', { text: 'x' })
outOfScopeTurn.stop('t9')
ok('只有 unmanaged 活动的回合也写 turn-end', outOfScopeTurn.rows().some(row => row.decision === 'turn-end'))

const disposed = makeEnv()
await disposed.call('h2', 'ego_click', { ref: 'e1' })
disposed.dispose('h2')
ok('agent/disposed 也释放（被中止的回合不会留占用）', disposed.rows().some(row => row.decision === 'release' && row.source === 'dispose'))
check('dispose 之后放行', (await disposed.call('h2', 'computer', { action: 'left_click' })).kind, 'allow')

let fake = 1_000_000
const ttl = makeEnv({ claims: { ttlMinutes: 30 } }, 'ttl-env', { clock: () => fake })
await ttl.call('h3', 'ego_click', { ref: 'e1' })
fake += 31 * 60 * 1000
check('TTL 过期后占用自动失效', (await ttl.call('h3', 'computer', { action: 'left_click' })).kind, 'allow')
const ttlRow = ttl.rows().find(row => row.source === 'ttl')
check('TTL 删除聚合成一行', ttlRow?.count, 1)
ok('TTL 行带资源键', Array.isArray(ttlRow?.resources) && ttlRow.resources.length === 1, JSON.stringify(ttlRow?.resources))

const startupEnv = makeEnv({}, 'startup-env')
const startupRow = startupEnv.rows()[0]
check('首行是 startup', startupRow?.decision, 'startup')
check('startup 记录账本落点', startupRow?.ledger, startupEnv.auditFile)
ok('startup 记录规则来源与摘要', typeof startupRow?.rules === 'string' && /^[0-9a-f]{16}$/.test(startupRow?.rulesDigest ?? ''), startupRow?.rulesDigest)
check('startup 记录分类表规模', startupRow?.capabilities, defaults.capabilities.length)
check('startup 记录冲突模式', startupRow?.conflict, 'ask')

const claimOnce = makeEnv()
await claimOnce.call('j1', 'ego_click', { ref: 'e1' })
await claimOnce.call('j1', 'ego_click', { ref: 'e2' })
check('同一 owner 连续动手只写一条 claim', claimOnce.rows().filter(row => row.decision === 'claim').length, 1)

const rotated = makeEnv({ audit: { maxBytes: 400 } }, 'rotate-env')
for (let index = 0; index < 12; index++) await rotated.call('j2', 'ego_click', { ref: `e${index}` })
ok('审计超过上限后轮转出 .1', existsSync(`${rotated.auditFile}.1`))

const silent = makeEnv({ audit: { enabled: false } }, 'silent-env')
await silent.call('j3', 'ego_click', { ref: 'e1' })
ok('audit.enabled=false 不写盘', !existsSync(silent.auditFile))

/* -------------------------------------------------------- 10. static policies */
console.log('\n## 10. deny / ask / 白名单（单一实现）')
const policy = makeEnv({
  deny: [{ tool: '^forbidden_', reason: 'blocked for test' }],
  ask: [{ tool: '^danger_', reason: 'needs confirmation' }],
  agents: [{ id: 's-restricted', allow: ['^read$'], deny: [] }, { prefix: 'locked-', deny: ['^ego_'] }],
})
const waterfallDeny = await policy.call('p1', 'forbidden_write', {})
check('瀑布 deny 带错误码', waterfallDeny.info?.code, 'capability_policy_denied')
check('guard 与瀑布给出同一理由', policy.guard({ name: 'forbidden_write', arguments: {}, agent: { id: 'p1' } }), waterfallDeny.reason)
check('白名单内工具放行', (await policy.call('s-restricted', 'read', {})).kind, 'allow')
check('白名单外工具拒绝', (await policy.call('s-restricted', 'ego_js', {})).kind, 'deny')
check('前缀规则按会话生效', (await policy.call('locked-7', 'ego_click', {})).kind, 'deny')
check('guard 也执行会话黑名单', typeof policy.guard({ name: 'ego_click', arguments: {}, agent: { id: 'locked-7' } }), 'string')
const askedRule = await policy.call('p2', 'danger_publish', {})
check('ask 规则返回 ask', askedRule.kind, 'ask')
ok('ask 规则两种语言都给', Boolean(askedRule.displayReason?.en && askedRule.displayReason?.zh))
check('guard 不处理 ask（同步路径只能拒绝）', policy.guard({ name: 'danger_publish', arguments: {}, agent: { id: 'p2' } }), undefined)
ok('deny-rule 审计有 owner', policy.rows().some(row => row.source === 'deny-rule' && row.owner === 'other'))

/* ------------------------------------------------------------- 11. config */
console.log('\n## 11. 配置校验')
const empty = mod.resolveConfig({}, { baseDir: TMP })
check('空配置用出厂分类表', empty.capabilities.length, mod.DEFAULT_CAPABILITIES.length)
check('空配置回落到出厂互斥组', empty.groups.length, 6)
check('空配置默认启用占用', empty.claimsEnabled, true)
check('冲突裁决默认 ask', empty.conflictMode, 'ask')
check('默认 TTL 30 分钟', empty.ttlMs, 30 * 60 * 1000)
ok('返回的配置被冻结（没有共享可变状态）', Object.isFrozen(empty) && Object.isFrozen(empty.automationOwners) && Object.isFrozen(empty.groups))

function throwsWith (label, fn, fragment) {
  try {
    fn()
    ok(label, false, '没有抛错')
  } catch (error) {
    ok(label, error.message.includes(fragment), error.message.split('\n')[0])
  }
}
throwsWith('未知冲突模式被拒绝', () => mod.resolveConfig({ claims: { conflict: 'maybe' } }), 'claims.conflict')
throwsWith('坏正则被拒绝', () => mod.resolveConfig({ deny: [{ tool: '^computer_(' }] }), 'deny[0].tool')
throwsWith('未知类别被拒绝', () => mod.resolveConfig({ claims: { groups: [['page', 'pixle']] } }), '未知类别')
throwsWith('非对象被拒绝', () => mod.resolveConfig([]), 'JSON 对象')
throwsWith('单组被拒绝', () => mod.resolveConfig({ claims: { groups: [['page']] } }), '至少两个类别')
throwsWith('未知顶层键被拒绝（拼错不能静默忽略）', () => mod.resolveConfig({ capabilties: [] }), '未知配置项')
throwsWith('1.x 的 owners 被拒绝并给出迁移提示', () => mod.resolveConfig({ owners: { page: ['^p_'] } }), 'capabilities')
throwsWith('1.x 的 claims.readOnly 被拒绝', () => mod.resolveConfig({ claims: { readOnly: [] } }), 'effect: "observe"')
throwsWith('1.x 的 claims.exempt 被拒绝', () => mod.resolveConfig({ claims: { exempt: [] } }), 'effect: "select"')
throwsWith('1.x 的 selection 被拒绝', () => mod.resolveConfig({ selection: { mode: 'gates' } }), 'selection')
throwsWith('空互斥组会让占用失效，直接报错', () => mod.resolveConfig({ claims: { groups: [] } }), 'claims.groups 为空')
throwsWith('互斥组里不能有 capture', () => mod.resolveConfig({ claims: { groups: [['page', 'capture']] } }), 'capture')
throwsWith('capabilities 行必须是对象', () => mod.resolveConfig({ capabilities: ['x'] }), 'capabilities[0]')
throwsWith('capabilities 的 owner 不能是 other', () => mod.resolveConfig({ capabilities: [{ tool: '^x$', owner: 'other' }] }), 'owner')
throwsWith('capabilities 的 effect 必须合法', () => mod.resolveConfig({ capabilities: [{ tool: '^x$', owner: 'page', effect: 'read' }] }), 'effect')
throwsWith('capture 只能是 observe', () => mod.resolveConfig({ capabilities: [{ tool: '^shot$', owner: 'capture', effect: 'act' }] }), 'capture 类只能是 observe')
throwsWith('case 的未知条件键被拒绝', () => mod.resolveConfig({ capabilities: [{ tool: '^x$', owner: 'page', cases: [{ when: { actons: ['a'] }, effect: 'observe' }] }] }), '未知条件')
throwsWith('case 的坏正则被拒绝', () => mod.resolveConfig({ capabilities: [{ tool: '^x$', owner: 'page', cases: [{ when: { tool: '^(' }, effect: 'observe' }] }] }), 'when.tool')
throwsWith('同源重复的分类行被拒绝', () => mod.resolveConfig({ capabilities: [{ tool: '^x$', owner: 'page' }, { tool: '^x$', owner: 'native' }] }), '出现 2 次')
ok('用户行可以覆盖内置行（同一条正则不算错误）',
  mod.resolveConfig({ capabilities: [{ tool: '^windows$', owner: 'native', effect: 'act' }] }, { baseDir: TMP }).capabilities.length === mod.DEFAULT_CAPABILITIES.length + 1)
throwsWith('maxAttempts 必须是整数', () => mod.resolveConfig({ claims: { maxAttempts: 1.5 } }), 'maxAttempts')
throwsWith('ttlMinutes 必须为正', () => mod.resolveConfig({ claims: { ttlMinutes: 0 } }), 'ttlMinutes')
throwsWith('audit.file 类型错误被拒绝', () => mod.resolveConfig({ audit: { file: 5 } }), 'audit.file')

const rulesFile = join(TMP, 'broken.json')
writeFileSync(rulesFile, '{ "deny": [] ,, }', 'utf8')
throwsWith('rules.json 语法错误被拒绝', () => mod.loadConfig({ file: rulesFile }), '不是合法 JSON')
const goodFile = join(TMP, 'good.json')
writeFileSync(goodFile, JSON.stringify({ audit: { file: 'audit-x.jsonl' } }), 'utf8')
const goodConfig = mod.loadConfig({ file: goodFile })
ok('规则文件里的摘要被记录', /^[0-9a-f]{16}$/.test(goodConfig.rulesDigest ?? ''), goodConfig.rulesDigest)

const profilePath = withEnv({ DSH_PROFILE_DIR: TMP }, () => mod.resolveConfig({}, { baseDir: join(TMP, 'plain') }).audit.file)
ok('审计路径优先 profile 目录', profilePath === join(TMP, 'capability-policy', 'audit.jsonl'), profilePath)
const localPath = withEnv({ LOCALAPPDATA: TMP }, () => mod.resolveConfig({}, { baseDir: join(TMP, 'plain') }).audit.file)
ok('没有 profile 变量时落到 LOCALAPPDATA', localPath === join(TMP, 'dsh-capability-policy', 'audit.jsonl'), localPath)
const homePath = withEnv({ USERPROFILE: TMP }, () => mod.resolveConfig({}, { baseDir: join(TMP, 'plain') }).audit.file)
ok('再退一层用 HOME', homePath === join(TMP, '.dsh-capability-policy', 'audit.jsonl'), homePath)
const relPath = withEnv({ LOCALAPPDATA: TMP }, () => mod.resolveConfig({ audit: { file: 'audit-x.jsonl' } }, { baseDir: join(TMP, 'plain') }).audit.file)
ok('相对审计路径落在状态目录，不落在包目录', relPath === join(TMP, 'dsh-capability-policy', 'audit-x.jsonl'), relPath)

/* --------------------------------------------------------- 12. rules hot reload */
console.log('\n## 12. 规则热重载（改配置不必重载 profile）')
const rulesPath = join(TMP, 'live-rules.json')
const liveAudit = join(TMP, 'live-audit.jsonl')
writeFileSync(rulesPath, JSON.stringify({ audit: { file: liveAudit }, claims: { conflict: 'deny' } }), 'utf8')
const live = makeEnv({}, 'live-env', { rulesFile: rulesPath, auditFile: liveAudit })
await live.call('lr1', 'ego_click', { ref: 'e1' })
check('文件配置初始生效', (await live.call('lr1', 'computer', { action: 'left_click' })).kind, 'deny')
check('文件配置的 rulesFile 写进审计', live.rows()[0]?.rules, rulesPath)

writeFileSync(rulesPath, JSON.stringify({ audit: { file: liveAudit }, claims: { conflict: 'allow' } }), 'utf8')
ok('规则改动被发现并重载', await waitFor(() => live.rows().some(row => row.decision === 'config-reloaded')))
check('重载后新配置立即生效', (await live.call('lr1', 'windows', { action: 'maximize', hwnd: 5 })).kind, 'allow')
const reloadRow = live.rows().find(row => row.decision === 'config-reloaded')
ok('重载行记录新摘要', /^[0-9a-f]{16}$/.test(reloadRow?.rulesDigest ?? ''), reloadRow?.rulesDigest)

writeFileSync(rulesPath, '{ "claims": { "conflict": "maybe" } }', 'utf8')
ok('写坏的规则被拒绝并留痕', await waitFor(() => live.rows().some(row => row.decision === 'config-rejected')))
ok('拒绝理由列出具体问题', (live.rows().find(row => row.decision === 'config-rejected')?.reason ?? '').includes('claims.conflict'))
check('写坏之后继续用上一份好配置（不静默降级为空策略）', (await live.call('lr1', 'windows', { action: 'maximize', hwnd: 6 })).kind, 'allow')
live.teardown()

const noWatchPath = join(TMP, 'nowatch-rules.json')
const noWatchAudit = join(TMP, 'nowatch-audit.jsonl')
writeFileSync(noWatchPath, JSON.stringify({ watch: false, audit: { file: noWatchAudit }, claims: { conflict: 'deny' } }), 'utf8')
const noWatch = makeEnv({}, 'nowatch-env', { rulesFile: noWatchPath, auditFile: noWatchAudit })
await noWatch.call('nw1', 'ego_click', { ref: 'e1' })
writeFileSync(noWatchPath, JSON.stringify({ watch: false, audit: { file: noWatchAudit }, claims: { conflict: 'allow' } }), 'utf8')
await new Promise(resolve => setTimeout(resolve, 250))
ok('watch=false 时不会自动重载', !noWatch.rows().some(row => row.decision === 'config-reloaded'))
noWatch.teardown()

/* ------------------------------------------------- 12. 跨会话只有一个驱动方 */
console.log('\n## 12. 跨会话也只有一个驱动方')
const crossAgent = makeEnv({ claims: { conflict: 'deny' } }, 'cross-agent-env')
await crossAgent.call('lead', 'computer', { action: 'left_click', coordinate: [10, 10] })
check('子会话不能自顾自驱动父会话正占着的面', (await crossAgent.call('sub', 'windows', { action: 'maximize', hwnd: 7 })).kind, 'deny')
const twoAgents = makeEnv({ claims: { conflict: 'deny' } }, 'two-agents-env')
await twoAgents.call('lead', 'windows', { action: 'maximize', hwnd: 11 })
const sameSpace = makeEnv({ claims: { conflict: 'deny' } }, 'same-space-agents-env')
await sameSpace.call('lead', 'computer', { action: 'left_click', coordinate: [10, 10] })
const sameSpaceVerdict = await sameSpace.call('sub', 'computer', { action: 'left_click', coordinate: [20, 20] })
check('同类驱动、不同会话、面不可证不同 → 仍互斥', sameSpaceVerdict.kind, 'deny')
ok('拒绝理由标明是另一个会话', String(sameSpaceVerdict.reason).includes('another session'), String(sameSpaceVerdict.reason).slice(0, 90))
const repeated = await sameSpace.call('lead', 'computer', { action: 'left_click', coordinate: [30, 30] })
check('同一会话自己连续驱动不自我互斥', repeated.kind, 'allow')
check('同空间不同窗口，跨会话仍可并行', (await twoAgents.call('sub', 'windows', { action: 'maximize', hwnd: 12 })).kind, 'allow')

/* ---------------------------------------------- 12b. 现场占用写进提示词 */
console.log('\n## 12b. 提示词里的现场占用')
const livePrompt = makeEnv({ claims: { conflict: 'deny' } }, 'live-prompt-env')
ok('没有占用时不追加现场行', !livePrompt.sectionText().includes('Held right now'), String(livePrompt.sectionText()).slice(-24))
await livePrompt.call('u1', 'windows', { action: 'maximize', hwnd: 88 })
const digest = livePrompt.sectionText()
ok('有占用时报出被占的面', digest.includes('desktop:88'), digest.slice(-80))
ok('现场行带工具名与空间', digest.includes('windows') && digest.includes('(native)'), digest.slice(-80))
livePrompt.stop('u1')
ok('占用释放后现场行消失', !livePrompt.sectionText().includes('Held right now'), String(livePrompt.sectionText()).slice(-24))
const manyClaims = makeEnv({ claims: { conflict: 'deny' } }, 'many-claims-env')
for (const hwnd of [1, 2, 3, 4, 5]) await manyClaims.call('u1', 'windows', { action: 'maximize', hwnd })
ok('最多列三条，其余折叠', manyClaims.sectionText().includes('(+2 more)'), manyClaims.sectionText().slice(-90))

/* ------------------------------------------------------------ 13. budget */
rmSync(TMP, { recursive: true, force: true })
console.log('\n## 13. 提示词预算')
console.log(`PROMPT: ${mod.PROMPT.length} chars, 约 ${Math.round(mod.PROMPT.length / 3.6)} token`)
console.log(failures === 0 ? `\nALL PASS (${checks} checks)` : `\n${failures} FAILURE(S) of ${checks} checks`)
process.exitCode = failures === 0 ? 0 : 1

