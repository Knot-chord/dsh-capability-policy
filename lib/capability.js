/**
 * The request model: which resource a call asks for, and how it wants it.
 *
 * The dispatcher answers two questions and nothing else:
 *
 * - `owner` / space (app / page / native / pixel / capture / system) — **where** the
 *   resource lives. It is a property of the target, not of the tool: `page`, `native` and
 *   `pixel` are three ways of naming the same physical surface.
 * - `effect` / mode (observe / select / act) — whether the call takes the lease.
 *
 * Only `act` takes a lease. `observe` reads without changing anything; `select` points at a
 * surface (focus, foreground, restore, switch tab) without driving it. That split is the
 * whole design: 1.x had one list of read-only tools and a second list of "changes state but
 * does not drive a surface" exemptions, matched by tool name, so `open_application` was
 * exempt while `windows focus` — which does exactly the same thing — claimed the window for
 * the whole turn.
 *
 * Declarations are ordered, first match wins, and user rows are prepended by `rules.json`.
 * They supply the *mode* for known request shapes; the *target* is read from the arguments
 * by `targetOf`, for declared and undeclared requests alike.
 */
import { isPlainObject } from './util.js'

export const OWNERS = ['app', 'page', 'native', 'pixel', 'capture', 'system', 'other']

/** observe = reads; select = points at a surface; act = drives it. */
export const EFFECTS = ['observe', 'select', 'act']

/** A call arriving without `exec.agent` still has to be gated; it gets this identity. */
export const UNATTRIBUTED = '@unattributed'

/** Resource identity per acting family. Families are never compared across each other. */
const FAMILY = { app: 'app', page: 'page', native: 'desktop', pixel: 'desktop', system: 'system' }

const KEY_SPACE = {
  app: [],
  page: ['url', 'href', 'pageUrl'],
  desktop: ['hwnd', 'handle', 'windowId', 'title', 'name'],
  system: ['item', 'setting', 'name'],
}

/**
 * Shipped table. Order is the contract:
 * 1. capture first — a `*_screenshot` tool belongs to the surface that produced it, not
 *    to the family whose name it carries;
 * 2. acting families, each closed under its own prefix so a newly released tool of a known
 *    family defaults to `act` (fail closed) instead of escaping as `other`.
 */
export const DEFAULT_CAPABILITIES = Object.freeze([
  {
    /* capture = reads or produces a visual artifact. `^video_` was too wide: it also caught
     * `video_search`, which is a web search, not a capture — found by running the table over
     * every tool schema this profile actually has. */
    tool: 'screenshot|^read_image$|^video_(?!search)|storyboard|^ocr|^capture|^record',
    owner: 'capture',
    effect: 'observe',
  },
  {
    tool: '^wechat|^qq_|^wecom|^notion|^email_',
    owner: 'app',
    effect: 'act',
  },
  {
    tool: '^ego_',
    owner: 'page',
    effect: 'act',
    cases: [
      { when: { tool: '^ego_wait' }, effect: 'observe' },
      { when: { tool: '^ego_(help|doctor|status|page_info|read_element|snapshot|captcha)$' }, effect: 'observe' },
      { when: { tool: '^ego_tabs$', actions: ['list'] }, effect: 'observe' },
      { when: { tool: '^ego_tabs$', actions: ['switch', 'open'] }, effect: 'select' },
    ],
  },
  {
    tool: '^browser_|playwright|\\bcdp\\b|^chrome_|^page_|^tab_|^dom_',
    owner: 'page',
    effect: 'act',
  },
  {
    tool: '^ui_elements$',
    owner: 'native',
    effect: 'observe',
  },
  {
    tool: '^windows$',
    owner: 'native',
    effect: 'act',
    cases: [
      { when: { actions: ['list'] }, effect: 'observe' },
      /* Focus and restore only bring a surface forward: that is what the next class
       * needs, so it must not cost the surface. Minimize/maximize/close change it. */
      { when: { actions: ['focus', 'restore'] }, effect: 'select' },
    ],
  },
  {
    tool: '^open_application$',
    owner: 'native',
    effect: 'select',
  },
  {
    tool: '^computer(_batch)?$',
    owner: 'pixel',
    effect: 'act',
    cases: [
      /* A batch is as strong as its strongest element. */
      { when: { actions: ['screenshot', 'zoom', 'cursor_position', 'wait'] }, effect: 'observe' },
    ],
  },
  {
    /* Handles the pre-multiplexed per-action tool names some releases expose. */
    tool: '^computer_',
    owner: 'pixel',
    effect: 'act',
  },
  {
    /* Changing the display frame silently invalidates every coordinate. */
    tool: '^switch_display$',
    owner: 'pixel',
    effect: 'act',
    cases: [{ when: { absent: ['index'] }, effect: 'observe' }],
  },
  {
    tool: '^screen_|^mouse_|^keyboard_',
    owner: 'pixel',
    effect: 'act',
  },
  {
    tool: '^system_|^service_|^registry|^power_',
    owner: 'system',
    effect: 'act',
  },
])

/* --------------------------------------------------------------- action probing */

export function collectActions (args) {
  if (!isPlainObject(args)) return []
  const actions = []
  if (typeof args.action === 'string' && args.action !== '') actions.push(args.action)
  if (Array.isArray(args.actions)) {
    for (const entry of args.actions) {
      if (typeof entry === 'string' && entry !== '') actions.push(entry)
      else if (isPlainObject(entry) && typeof entry.action === 'string' && entry.action !== '') actions.push(entry.action)
    }
  }
  return actions
}

function present (args, key) {
  if (!isPlainObject(args)) return false
  const value = args[key]
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'number') return Number.isFinite(value)
  return true
}

function caseMatches (when, tool, args) {
  if (when === undefined) return true
  if (when.tool !== undefined && !when.tool.test(tool)) return false
  if (when.actions !== undefined) {
    const actions = collectActions(args)
    if (actions.length === 0) return false
    if (!actions.every(action => when.actions.includes(action))) return false
  }
  if (when.present !== undefined && !when.present.every(key => present(args, key))) return false
  if (when.absent !== undefined && !when.absent.every(key => !present(args, key))) return false
  return true
}

function effectOf (row, tool, args) {
  let effect = row.effect
  for (const entry of row.cases ?? []) {
    if (!caseMatches(entry.when, tool, args)) continue
    effect = entry.effect
    break
  }
  return effect
}

/* ------------------------------------------------------------------ compilation */

const asRegExp = (value, where) => {
  if (value instanceof RegExp) return value
  try {
    return new RegExp(String(value))
  } catch (error) {
    throw new Error(`${where}: 正则无效 "${String(value)}"（${error.message}）`)
  }
}

/**
 * Turn validated rows into matchers. Rows arrive already validated by `resolveConfig`;
 * the only thing done here is freezing them into one ordered list.
 */
export function compileCapabilities (rows = []) {
  return Object.freeze(rows.map((row, index) => Object.freeze({
    tool: asRegExp(row.tool, `capabilities[${index}].tool`),
    source: String(row.tool instanceof RegExp ? row.tool.source : row.tool),
    owner: row.owner,
    effect: row.effect ?? 'act',
    cases: Object.freeze((row.cases ?? []).map((entry, position) => Object.freeze({
      when: entry.when === undefined
        ? undefined
        : Object.freeze({
            tool: entry.when.tool === undefined ? undefined : asRegExp(entry.when.tool, `capabilities[${index}].cases[${position}].when.tool`),
            actions: entry.when.actions === undefined ? undefined : Object.freeze([...entry.when.actions]),
            present: entry.when.present === undefined ? undefined : Object.freeze([...entry.when.present]),
            absent: entry.when.absent === undefined ? undefined : Object.freeze([...entry.when.absent]),
          }),
      effect: entry.effect,
    }))),
  })))
}

let defaultTable
/** The shipped table, compiled once. `capabilities: []` in rules.json means this. */
export function defaultCapabilities () {
  if (defaultTable === undefined) defaultTable = compileCapabilities(DEFAULT_CAPABILITIES)
  return defaultTable
}

/* --------------------------------------------------------------- resource identity */

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

/** `{ family, key }`; `key` is undefined when the call names no identity. */
export function resourceOf (owner, args) {
  const family = FAMILY[owner]
  if (family === undefined) return undefined
  const keys = KEY_SPACE[family] ?? []
  if (isPlainObject(args)) {
    for (const key of keys) {
      const value = args[key]
      if (typeof value === 'string' && value.trim() !== '') return { family, key: normalizeKey(family, value) }
      if (typeof value === 'number' && Number.isFinite(value)) return { family, key: normalizeKey(family, String(value)) }
    }
  }
  return { family, key: undefined }
}

/** Stable identity string for ledgers and audit rows. */
export function resourceKey (resource) {
  if (resource === undefined) return '~'
  return `${resource.family}:${resource.key ?? '*'}`
}

/* --------------------------------------------------------------- request targets */

/**
 * The three ways a request can name a target. This is the whole vocabulary — not a list of
 * tools, not a list of actions. A request that uses none of them is addressed to nothing the
 * dispatcher can grant.
 */
const WINDOW_KEYS = ['hwnd', 'windowId', 'window', 'winId', 'windowHandle']
const LOCATOR_KEYS = ['selector', 'locator', 'css', 'xpath', 'ref', 'elementId']
const POINT_KEYS = ['coordinate', 'coordinates', 'position', 'point', 'pos']

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const isFilled = (value) => (typeof value === 'string' && value.trim() !== '') || isNumber(value)

/** Which space does this request name? Mechanical reading, no semantics. */
export function targetOf (args) {
  if (!isPlainObject(args)) return undefined
  const candidates = [args]
  if (Array.isArray(args.actions)) {
    for (const entry of args.actions) if (isPlainObject(entry)) candidates.push(entry)
  }
  if (isPlainObject(args.target)) candidates.push(args.target)
  for (const object of candidates) {
    for (const key of WINDOW_KEYS) if (isFilled(object[key])) return 'native'
    if (isNumber(object.handle)) return 'native'
    for (const key of LOCATOR_KEYS) {
      if (typeof object[key] === 'string' && object[key].trim() !== '') return 'page'
    }
    for (const key of POINT_KEYS) {
      const value = object[key]
      if (Array.isArray(value) && value.length >= 2 && value.every(isNumber)) return 'pixel'
    }
    if (isNumber(object.x) && isNumber(object.y)) return 'pixel'
  }
  return undefined
}

/* ------------------------------------------------------------- exclusion matrix */

/**
 * The exclusion matrix is a **fact about spaces**, not a policy knob: a point lies inside
 * some window, a document is rendered inside some window, and an app object lives inside
 * some window — so any pair of these may be the same physical surface and must contend
 * unless it can be proven otherwise. `system` is not a screen surface at all (a registry key
 * is not a window), so it never contends with them.
 *
 * `claims.groups` therefore defaults to the closure of that fact and only exists so a
 * deployment can add a space of its own.
 */
export const SURFACE_SPACES = Object.freeze(['app', 'page', 'native', 'pixel'])

export const DEFAULT_GROUPS = Object.freeze(
  SURFACE_SPACES.flatMap((left, index) =>
    SURFACE_SPACES.slice(index + 1).map(right => Object.freeze([left, right]))),
)

/**
 * `same` = provably one surface, `distinct` = provably two, `unknown` = cannot tell.
 * Cross-family (a page URL versus a window handle) and a missing key both land in
 * `unknown`; the caller decides what that means, because the answer differs by caller.
 */
export function relation (left, right) {
  if (left === undefined || right === undefined) return 'unknown'
  if (left.family !== right.family) return 'unknown'
  if (left.key === undefined || right.key === undefined) return 'unknown'
  return left.key === right.key ? 'same' : 'distinct'
}

export function exclusive (left, right, groups) {
  return groups.some(group => group.includes(left) && group.includes(right))
}

/* ---------------------------------------------------------------- budget scopes */

/**
 * A retry budget is spent against a scope, and the scope must never be finer than what the
 * gate can prove — otherwise a caller resets its own budget by reaching for the target
 * under a different name (navigate to a new URL, address the window by title, omit the
 * handle). So there are exactly two scopes:
 *
 * - the proving case: both sides name the same surface, so the budget is per surface, which
 *   keeps two genuinely different windows from sharing one count;
 * - everything else: one bucket per caller for the turn.
 *
 * `page` lands in the second kind by construction — it is the only space in its family, and
 * a page URL can never be compared with a window handle — so its key is never load-bearing
 * for a verdict, and the escalation path does not depend on it.
 */
export const TURN_SCOPE = 'u'
export const surfaceScope = (resource) => `s:${resourceKey(resource)}`

/** Which budget a conflict reads: the surface only when it is provable. */
export const conflictScope = (caller, holder) =>
  relation(caller.resource, holder.resource) === 'same' ? surfaceScope(holder.resource) : TURN_SCOPE

/**
 * A failure is provable about its own surface but silent about who else might have been
 * reaching for the same thing, so it spends both scopes: the surface (for a later provable
 * conflict) and the turn bucket (for a later unprovable one).
 */
export const failureScopes = (claim) => [surfaceScope(claim.resource), TURN_SCOPE]

/**
 * One description of a *request*.
 *
 * The plugin is a dispatcher, not an automation driver: its question is not "what does this
 * tool do" but "**which resource is this call asking for, and how does it want it**". Those
 * two answers are all an admission decision needs.
 *
 * - declared rows answer the second half for known request shapes (a `wait` observes, a
 *   `focus` only points, `ego_js` drives without naming a target);
 * - the arguments answer the first half mechanically: a request that names a window, a
 *   document element or a point is asking for that surface. Nothing is inferred about the
 *   tool's nature — an undeclared request either names a target or it does not.
 *
 * A request that names no target is not a failure of classification, it is a request the
 * dispatcher cannot arbitrate at all: there is nothing to grant.
 */
export function describeRequest (name, args, config = {}) {
  const tool = String(name ?? '')
  const capabilities = config.capabilities ?? defaultCapabilities()
  const spaces = config.spaces
  for (const row of capabilities) {
    if (!row.tool.test(tool)) continue
    const effect = effectOf(row, tool, args)
    const space = row.owner
    const managed = space !== 'other' && (spaces === undefined || spaces.includes(space))
    return {
      name: tool,
      owner: space,
      effect,
      managed,
      /* Only a drive request takes the lease. */
      claims: managed && effect === 'act',
      resource: resourceOf(space, args),
      row: row.source,
      declared: true,
      arbitrable: space !== 'other',
    }
  }

  /* Undeclared: the only bounded question left is whether the request names a target. */
  const space = targetOf(args)
  if (space !== undefined) {
    const managed = spaces === undefined || spaces.includes(space)
    return {
      name: tool,
      owner: space,
      effect: 'act',
      managed,
      claims: managed,
      resource: resourceOf(space, args),
      row: undefined,
      declared: false,
      arbitrable: true,
    }
  }

  return {
    name: tool,
    owner: 'other',
    effect: undefined,
    managed: false,
    claims: false,
    resource: undefined,
    row: undefined,
    declared: false,
    arbitrable: false,
  }
}

/** Space name only, for quick checks and reporting. */
export function classifyTool (name, args, config) {
  return describeRequest(name, args, config ?? {}).owner
}

/**
 * The conflict rule, in one place.
 *
 * Contention is a property of the **surface**, not of who is asking: two callers driving one
 * window interfere whether they are two branches of one session or two sessions. So the only
 * question is whether the two resources are provably different — everything else contends,
 * and `claims.conflict` decides what happens next (`deny` / `ask` / `allow`).
 *
 * An earlier version let callers with different ids skip the unprovable case, on the theory
 * that independent sessions work on independent windows. That is exactly wrong for the common
 * case — a subagent drives the window its parent is already driving — and it made the ledger
 * claim "one driver per surface" while two agents clicked the same window.
 */
export function permitsConflict (caller, holder) {
  return relation(caller.resource, holder.resource) !== 'distinct'
}

/** Every claim that contends with the caller, best (most specific) first. */
export function findConflicts (caller, claims, groups) {
  const found = []
  for (const claim of claims) {
    /* The same driver continuing its own work never contends with itself. A different agent
     * in the same space is a different driver, and on a surface it cannot prove distinct
     * that is the same interference as any other pair — two subagents clicking by
     * coordinates in one window collide no matter that both are `pixel`. */
    if (claim.owner === caller.owner && claim.agent === caller.agent) continue
    if (!exclusive(caller.owner, claim.owner, groups)) continue
    if (!permitsConflict(caller, claim)) continue
    found.push(claim)
  }
  return found.sort((left, right) => {
    const rank = (claim) => (claim.resource?.key === undefined ? 0 : 1)
    return rank(right) - rank(left)
  })
}

/** The conflict worth reporting: the most specific one. */
export function findConflict (caller, claims, groups) {
  return findConflicts(caller, claims, groups)[0]
}
