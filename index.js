/**
 * A dispatcher for DeepSeek Harness: it arbitrates **who may drive which surface in one
 * turn**, and it does not try to be an automation plugin itself.
 *
 * One persistent prompt section plus four thin hooks over one decision function. The layers
 * are separate on purpose:
 *
 *   lib/paths.js       where per-profile state lives
 *   lib/rules.js       raw rules -> frozen config (validation, static deny/ask/allowlist)
 *   lib/capability.js  the request model: which space a request names, what mode it asks
 *                      for, resource identity, the exclusion relation
 *   lib/ledger.js      leases and retry budgets, no policy, no I/O
 *   lib/audit.js       JSONL ledger
 *   index.js           wiring only
 *
 * Every tool call is read as a *request*: `{ target?, mode }`. Only `drive` (act) takes a
 * lease; `observe` and `select` never do. A request that names no target has nothing to
 * grant, so it is recorded (`unarbitrable`) rather than guessed at — the dispatcher's
 * completeness comes from the target vocabulary, not from recognising tools.
 *
 * Leases are taken in `tools/pre-execute` (so two calls in one step cannot both pass the
 * check) and again in `tools/execute` for calls that were allowed only after the user
 * approved a contention — that path used to proceed unleased, so an approved handover never
 * took effect.
 */
import { existsSync, unwatchFile, watchFile } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAuditWriter } from './lib/audit.js'
import {
  DEFAULT_CAPABILITIES,
  DEFAULT_GROUPS,
  EFFECTS,
  OWNERS,
  UNATTRIBUTED,
  classifyTool,
  conflictScope,
  describeRequest,
  failureScopes,
  findConflict,
  findConflicts,
  relation,
  resourceKey,
} from './lib/capability.js'
import { createLedger } from './lib/ledger.js'
import { legacyLedgerFile } from './lib/paths.js'
import { DEFAULTS, evaluateStaticRules, loadConfig, resolveConfig } from './lib/rules.js'
import { isPlainObject } from './lib/util.js'

export const inject = ['systemPrompt', 'tools']

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Settings-page fields. `schemastery` is a DSH peer that is hoisted into the profile, but a
 * strict install may not expose it to a plugin, so the require is guarded: without it the
 * plugin simply has no schema and the default below applies.
 *
 * The schema holds one thing only: *where the rules live*. Everything about the policy —
 * including whether that file hot-reloads — stays inside the file, so there is never a
 * second place that can disagree with it.
 */
let Config
try {
  const required = createRequire(import.meta.url)('schemastery')
  const Schema = required?.default ?? required?.Schema ?? required
  if (typeof Schema?.object === 'function') {
    Config = Schema.object({
      rulesFile: Schema.string().description('规则文件路径；留空则用 <profile>/capability-policy/rules.json，其次包内 rules.json'),
    })
  }
} catch {
  /* no schema available: still fully functional, just not editable from the settings page */
}

const PROMPT = `## Capability ownership and dispatch
One driver per surface per turn: never let two acting spaces drive one target in one task — if they would, ask instead of guessing.

A call is a request: the target it names (handle, page element, screen point) and what it does with it. Pointing at a surface (focus, foreground, restore) takes no ownership; only driving it does. capture (screenshots, OCR, frames, read_image) is read-only: it never owns a target and never replaces a surface that can be read directly. Most specific space first: app > page > native > pixel > system; a lower one is a fallback.

Gates in order, first survivor wins:
0 target — name the instance (handle, URL or element, point); if you cannot name it, it cannot be arbitrated.
1 qualification (hard) — it must be able to finish on that target now (surface, tool, permission, dependency); half-covered is not enough.
2 layer (hard) — keep only the most specific space present.
3 authorization — write, send, delete or system state needs explicit authorization for this exact action; prefer a reversible path.
4 state — drop this target's failed candidates; prefer verified, then untried over known-failed; no retry without new evidence.
5 cost — cheapest evidence: text before image, one capture before many, reuse what you already have.

Escalate only on structured evidence (named error, unreadable surface, unnamed control, permission denial), one space per attempt and two at most. A blocked or failed attempt counts against its target; once spent, the gate refuses further handovers, so state the evidence or ask the user.`

/** `mode` keeps the coarse read/act view the earlier ledger used; `effect` is exact.
 *  A request that names no target has no effect at all, and claiming one is a lie. */
const modeOf = (effect) => {
  if (effect === undefined) return undefined
  return effect === 'observe' ? 'read' : 'act'
}

const jsonOf = (value) => {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return null
  }
}

const agentKeyOf = (exec) => {
  const id = exec?.agent?.id
  return typeof id === 'string' && id !== '' ? id : UNATTRIBUTED
}

/** In-flight approvals: an approved switch refunds the attempt it cost. */
const MAX_PENDING_ASKS = 256

export function apply (ctx, rowConfig = {}) {
  const inline = isPlainObject(rowConfig?.rules) ? rowConfig.rules : undefined
  const configuredFile = typeof rowConfig?.rulesFile === 'string' && rowConfig.rulesFile.trim() !== ''
    ? rowConfig.rulesFile.trim()
    : undefined
  const initial = inline === undefined
    ? loadConfig({ baseDir: HERE, file: configuredFile })
    : resolveConfig(inline, { baseDir: HERE, inline: true })

  /* Mutable on purpose: `watch` swaps config in place, so every hook must read the current
   * one at call time instead of capturing it. */
  const runtime = { config: initial, audit: createAuditWriter(initial.audit) }
  /* `clock` is a test seam: TTL expiry is otherwise untestable without waiting. */
  const clock = typeof rowConfig?.clock === 'function' ? rowConfig.clock : Date.now
  /* Only a real file can be watched: inline rules (used by the tests and by embedding)
   * have no path, and watching a fake one would keep a poller alive forever. */
  const watcher = {
    enabled: inline === undefined && initial.watch !== false && typeof initial.rulesFile === 'string',
    interval: Number.isInteger(rowConfig?.watchInterval) && rowConfig.watchInterval > 0 ? rowConfig.watchInterval : 2000,
  }

  const ledger = createLedger({ clock })
  const pendingAsks = new Map()

  /**
   * What the model is told *before* it acts. The static contract already says one driver per
   * surface; this adds the one thing a static text cannot say — which surfaces are held right
   * now — so a turn does not have to spend a refused call to find out. Empty when nothing is
   * held, so the common case costs nothing.
   */
  const leaseDigest = () => {
    if (runtime.config.claimsEnabled === false) return ''
    const held = [...ledger.list()]
    if (held.length === 0) return ''
    const shown = held.slice(0, 3).map(claim => {
      const where = claim.resource === undefined
        ? '?'
        : `${claim.resource.family}${claim.resource.key === undefined ? ':*' : ':' + claim.resource.key}`
      return `${where} by ${claim.tool} (${claim.owner})`
    })
    const rest = held.length > shown.length ? ` (+${held.length - shown.length} more)` : ''
    return `\n\nHeld right now: ${shown.join('; ')}${rest}.`
  }

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'capability-policy:routing',
    order: 9000,
    text: () => PROMPT + leaseDigest(),
  }))

  /* ---------------------------------------------------------------- auditing */

  const auditRow = (agent, call, decision, source, extra = {}) => {
    touched.add(agent)
    runtime.audit.write({
      at: clock(),
      agent,
      tool: call.name,
      owner: call.owner,
      effect: call.effect,
      mode: modeOf(call.effect),
      decision,
      source,
      resource: call.resource?.key,
      /* An undeclared request that named a target is scheduled on the strength of that
       * target alone — worth telling apart from an authored declaration. */
      inferred: call.declared === false && call.arbitrable ? true : undefined,
      ...extra,
    })
  }

  const auditRelease = (claim, source, reason) => {
    touched.add(claim.agent)
    runtime.audit.write({
      at: clock(),
      agent: claim.agent,
      tool: claim.tool,
      owner: claim.owner,
      effect: 'act',
      mode: 'act',
      decision: 'release',
      source,
      resource: claim.resource?.key,
      reason,
    })
  }

  /** One shape for "which ledger, which rules, which dials" — written at load and on reload. */
  const auditConfig = (decision, config, source, extra = {}) => runtime.audit.write({
    at: clock(),
    agent: '-',
    tool: '-',
    owner: '-',
    effect: 'observe',
    mode: 'read',
    decision,
    source,
    ledger: runtime.audit.file ?? null,
    rules: config.rulesFile ?? null,
    rulesDigest: config.rulesDigest ?? null,
    capabilities: config.capabilities.length,
    spaces: [...config.spaces],
    groups: config.groups.length,
    claims: config.claimsEnabled,
    conflict: config.conflictMode,
    maxAttempts: config.maxAttempts,
    ttlMinutes: Math.round(config.ttlMs / 60000),
    watch: config.watch !== false,
    ...extra,
  })

  const previousLedger = legacyLedgerFile()
  auditConfig('startup', initial, 'startup', {
    previousLedger: previousLedger !== undefined && previousLedger !== runtime.audit.file && existsSync(previousLedger)
      ? previousLedger
      : undefined,
  })

  /* ------------------------------------------------------------ config reload */

  /**
   * Re-read the rules file. A rejected file keeps the running config — a half-typed regex
   * must not leave the profile with no policy — but it is recorded, so the failure is
   * visible in the ledger instead of in someone's memory.
   */
  const reload = () => {
    if (inline !== undefined) return
    const file = runtime.config.rulesFile
    if (typeof file !== 'string') return
    let next
    try {
      next = loadConfig({ baseDir: HERE, file })
    } catch (error) {
      runtime.audit.write({
        at: clock(),
        agent: '-',
        tool: '-',
        owner: '-',
        effect: 'observe',
        mode: 'read',
        decision: 'config-rejected',
        source: 'config',
        rules: file,
        reason: String(error.message).split('\n').slice(0, 8).join(' | '),
      })
      return
    }
    if (next.rulesDigest === runtime.config.rulesDigest) return
    if (next.audit.file !== runtime.audit.file) runtime.audit = createAuditWriter(next.audit)
    runtime.config = next
    auditConfig('config-reloaded', next, 'config', { reason: 'rules file changed; live claims were kept' })
    if (next.watch === false) watcher.enabled = false
  }

  ctx.effect(() => {
    if (!watcher.enabled) return undefined
    const file = runtime.config.rulesFile
    watchFile(file, { interval: watcher.interval }, (current, previous) => {
      if (!watcher.enabled) return
      if (current.mtimeMs === previous.mtimeMs) return
      reload()
    })
    return () => unwatchFile(file)
  })

  /* ---------------------------------------------------------------- lifecycle */

  const closeAgent = (agent, source) => {
    const released = ledger.releaseAgent(agent)
    for (const claim of released) auditRelease(claim, source, source === 'turn' ? 'turn boundary' : 'agent disposed')
    const budgets = ledger.dropBudgets(agent)
    for (const [callId, pending] of pendingAsks) {
      if (pending.agent === agent) pendingAsks.delete(callId)
    }
    return { released: released.length, budgets }
  }

  /* --------------------------------------------------------------- static rules */

  /* One implementation, called by both enforcement paths. The guard is always registered:
   * `watch` can add a deny rule to a running profile, and a backstop that only exists when
   * the file happened to have one at load time is not a backstop. The verdict is cheap when
   * no rule matches, and arguments are only serialised when a rule asks for them.
   *
   * The guard also *audits* its own refusals. Measured on the live runtime: `pre-execute`
   * runs first, so in the normal pipeline the waterfall is what refuses and records. The
   * guard is the backstop for dispatch paths that bypass the waterfall — and on exactly
   * those paths nothing else would write a row, so without this the ledger would claim
   * "nothing was blocked" while the rule did its job. */
  const lazyArgsText = (args) => {
    let text
    return () => {
      if (text === undefined) text = jsonOf(args)
      return text
    }
  }

  /* Guard and waterfall can both see one call; whichever runs first owns the row. */
  const deniedByGuard = new WeakSet()

  ctx.effect(() => ctx.tools.guard(execution => {
    const decision = evaluateStaticRules(runtime.config, {
      name: String(execution?.name ?? ''),
      argsText: lazyArgsText(execution?.arguments),
      agent: agentKeyOf(execution),
    })
    if (decision?.kind !== 'deny') return undefined
    if (typeof execution === 'object' && execution !== null) deniedByGuard.add(execution)
    const agent = agentKeyOf(execution)
    const call = describe(execution)
    auditRow(agent, call, 'deny', decision.source, { reason: decision.reason, via: 'guard' })
    return decision.reason
  }))

  /* ----------------------------------------------------------------- dispatch */

  /* An agent that did anything auditable in the current turn. Used to decide whether a
   * `turn-end` marker is worth writing: the ledger is per turn, but 1.x/2.0 never recorded
   * the turn at all, so a reader could not tell whether two rows belonged to one turn —
   * which is exactly the first question anyone asks of a denial. */
  const touched = new Set()

  /* Tools seen that are outside every capability row *and* address no surface. The bounded
   * question ("does this call name a window, a point or a locator?") is answered by
   * inference, so what lands here is the residue: tools that drive nothing nameable. One row
   * per tool per load, so the ledger can answer "what does the policy not cover?" without
   * turning into a per-call log. */
  const unarbitrable = new Set()
  const notesUnarbitrable = (agent, call, args) => {
    if (call.arbitrable || call.managed) return
    /* A discovery row is this turn's audit activity too: a turn that only ran out-of-scope
     * tools must still be delimited, or the ledger loses its turn structure exactly in the
     * case where nothing was gated. */
    touched.add(agent)
    if (unarbitrable.has(call.name)) return
    unarbitrable.add(call.name)
    /* A URL is not a surface primitive (`web_fetch` and `browser_goto` cannot be told
     * apart), so such a tool stays out of the gate — but the row says why it is suspect, so
     * declaring it is one grep away. */
    const suspect = isPlainObject(args) && (typeof args.url === 'string' || typeof args.href === 'string')
    runtime.audit.write({
      at: clock(),
      agent,
      tool: call.name,
      owner: 'other',
      effect: 'observe',
      mode: 'read',
      decision: 'unarbitrable',
      source: 'discovery',
      suspect: suspect ? 'url' : undefined,
      reason: suspect
        ? 'this request names no target; it took a url, so if it drives a browser, declare it in capabilities'
        : 'this request names no target (no window, locator or point), so there is nothing to arbitrate. Declare it if it does act on a surface.',
    })
  }

  const describe = (exec) => describeRequest(exec?.name, exec?.arguments, runtime.config)

  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    const config = runtime.config
    const call = describe(exec)
    const agent = agentKeyOf(exec)
    const at = clock()

    const { expired } = ledger.sweep(at, config.ttlMs)
    if (expired.length > 0) {
      runtime.audit.write({
        at,
        agent: '-',
        tool: '-',
        owner: '-',
        effect: 'act',
        mode: 'act',
        decision: 'release',
        source: 'ttl',
        count: expired.length,
        resources: expired.map(claim => resourceKey(claim.resource)),
        reason: `expired ${expired.length} claim(s)`,
      })
    }

    const staticDecision = evaluateStaticRules(config, { name: call.name, argsText: lazyArgsText(exec?.arguments), agent })
    if (staticDecision !== undefined) {
      /* The guard already recorded this refusal if it got there first. */
      if (!deniedByGuard.has(exec)) {
        auditRow(agent, call, staticDecision.kind, staticDecision.source, { reason: staticDecision.reason })
      }
      if (staticDecision.kind === 'deny') {
        return { kind: 'deny', reason: staticDecision.reason, info: { name: call.name, code: staticDecision.code } }
      }
      return { kind: 'ask', reason: staticDecision.reason, displayReason: staticDecision.displayReason }
    }

    /* Tools outside every capability row that name no surface: the gate cannot see them,
     * so the ledger has to say they exist. Only tools that actually run — a call a static
     * rule refused was not "outside the policy", it was blocked by it. */
    notesUnarbitrable(agent, call, exec?.arguments)

    /* One row per decision: the conflict branch already records the verdict, so the
     * generic allow row must not restate it. */
    let decided = false
    if (call.claims && config.claimsEnabled) {
      const conflict = findConflict({ owner: call.owner, agent, resource: call.resource }, ledger.list(), config.groups)

      if (conflict !== undefined) {
        /* The budget is spent on a scope chosen by what the gate can prove, never on the
         * caller's own idea of the target: otherwise reaching for the same surface under a
         * new name (navigate to another URL, address the window by title, drop the handle)
         * would reset the count that exists to stop exactly that. */
        const scope = conflictScope({ resource: call.resource }, conflict)
        const prior = ledger.readBudget(agent, scope)
        const exhausted = config.maxAttempts > 0 && prior >= config.maxAttempts
        const verdict = config.conflictMode === 'allow'
          ? 'allow'
          : exhausted ? 'deny' : config.conflictMode
        /* `allow` is explicitly an observation mode: it blocks nothing, so nothing is
         * spent. Every other verdict is an attempt the caller spent on this target. */
        const ticket = verdict === 'allow'
          ? undefined
          : ledger.spendBudget({ agent, scopes: [scope], now: at })
        const counted = verdict === 'allow' ? prior : prior + 1

        const where = call.resource?.key === undefined ? '' : ` on ${call.resource.key}`
        const held = conflict.resource?.key === undefined ? '' : ` on ${conflict.resource.key}`
        /* Cross-session contention reads as a bug unless the reason says whose claim it is:
         * a subagent blocked by its parent's click must not think it blocked itself. */
        const foreign = conflict.agent !== undefined && conflict.agent !== agent
        const holder = `${conflict.owner}:${conflict.tool}${held}`
        const holderLabel = foreign ? `${holder} (another session)` : holder
        /* When the two sides cannot be proven to be different surfaces, say so — and say
         * which side is missing the identity. Telling a caller that already named its target
         * to "name the target" is advice that cannot work. */
        const unprovable = relation(call.resource, conflict.resource) === 'unknown'
        const callerNamed = call.resource?.key !== undefined
        const holderNamed = conflict.resource?.key !== undefined
        const hint = !unprovable
          ? ''
          : callerNamed && !holderNamed
            ? ` ${conflict.owner} acted without naming this target (it used coordinates), so the two cannot be told apart; finish this surface through one class instead of switching.`
            : !callerNamed && holderNamed
              ? ` Name your target explicitly (${conflict.resource?.family === 'page' ? 'url' : 'hwnd'}) so it can be compared with the surface being held.`
              : ' The plugin cannot prove these are different surfaces; name the target explicitly (url, hwnd) so they can be compared.'
        const hintZh = !unprovable
          ? ''
          : callerNamed && !holderNamed
            ? ` ${conflict.owner} 类动手时没有点明目标（用的是坐标），两者无法区分；请用同一类把这个面做完，不要换类。`
            : !callerNamed && holderNamed
              ? ' 请显式给出你的目标（url / hwnd），才能和被占的面对比。'
              : ' 插件无法证明这是两个不同的面，请显式给出目标（url / hwnd）即可比较。'

        auditRow(agent, call, verdict, 'claims', {
          holder: `${conflict.owner}:${conflict.tool}`,
          held: conflict.resource?.key,
          attempts: counted,
          scope,
          reason: verdict === 'allow'
            ? `observed overlap with ${holder}`
            : `${holder} holds the target (attempts ${counted})`,
        })
        decided = true

        if (verdict === 'deny') {
          /* Same space and another agent reads as nonsense if phrased the ordinary way
           * ("pixel cannot take it: pixel holds it"), so that case names the session. */
          const blockedBy = foreign
            ? `is already being driven by another session (${holder})`
            : `cannot take this target this turn: ${holder} holds it`
          return {
            kind: 'deny',
            reason: exhausted
              ? `${call.owner}${where} is blocked by ${holderLabel}. This target has spent its ${config.maxAttempts} attempt(s) this turn, so another class switch will not be granted: end the turn and ask the user, or state the evidence that ${conflict.owner} failed.${hint}`
              : `${call.owner}${where} ${blockedBy} and claims.conflict is "${config.conflictMode}". Ask the user to authorize the switch, or set claims.conflict to ask.${hint}`,
            info: { name: call.name, code: exhausted ? 'capability_policy_exhausted' : 'capability_policy_conflict' },
          }
        }
        if (verdict === 'ask') {
          /* Remember the spend so an approval can refund it: asking the user is not the
           * caller retrying on its own, and a human "yes" must not eat the stop budget. */
          if (exec?.callId !== undefined && pendingAsks.size < MAX_PENDING_ASKS) {
            pendingAsks.set(exec.callId, { agent, ticket })
          }
          return {
            kind: 'ask',
            reason: `switching this target from ${holderLabel} to ${call.owner} needs the user's approval.${hint}`,
            displayReason: {
              en: `This turn already drives the target through ${holderLabel}; switching to ${call.owner} needs your approval.${hint}`,
              zh: `这一轮已经用 ${conflict.owner} 类工具处理同一目标（${conflict.tool}${foreign ? '，且在另一个会话' : ''}），切到 ${call.owner} 类需要你确认。${hintZh}`,
            },
          }
        }
      }

      /* Check and take happen in one synchronous step, with no `await` between them: that
       * is what stops a batch of two contending calls from both passing the check. Keep it
       * that way — an await inserted here reopens the race. */
      const { created } = ledger.acquire({ agent, owner: call.owner, tool: call.name, resource: call.resource, now: at })
      if (created) auditRow(agent, call, 'claim', 'dispatch', { reason: 'took ownership of the target' })
    }

    if (call.managed && !decided) auditRow(agent, call, 'allow', 'policy')
    return next()
  }))

  /* The call is really about to run, so this is the commit point: ownership changes here
   * and nowhere else, which is what makes an approved switch actually take effect. Two
   * things happen: every contending claim is ended as an explicit handover, the caller
   * takes the surface, and an approval refunds the attempt it was charged. */
  ctx.effect(() => ctx.on('tools/execute', async (exec, next) => {
    const config = runtime.config
    const call = describe(exec)

    const pending = exec?.callId === undefined ? undefined : pendingAsks.get(exec.callId)
    if (pending !== undefined) {
      pendingAsks.delete(exec.callId)
      ledger.refundBudget(pending.ticket)
    }

    if (call.claims && config.claimsEnabled) {
      const agent = agentKeyOf(exec)
      const contested = findConflicts({ owner: call.owner, agent, resource: call.resource }, ledger.list(), config.groups)
      if (contested.length > 0) {
        const evicted = ledger.evict(contested.map(claim => claim.id))
        for (const claim of evicted) {
          auditRelease(claim, 'transfer', `handed over to ${call.owner}:${call.name}`)
        }
      }
      const { created } = ledger.acquire({ agent, owner: call.owner, tool: call.name, resource: call.resource })
      if (created) {
        auditRow(agent, call, 'claim', 'dispatch', {
          reason: contested.length > 0 ? 'took ownership after approval' : 'took ownership of the target',
          refunded: pending !== undefined ? true : undefined,
        })
      }
    }
    return next()
  }))

  ctx.effect(() => ctx.on('tools/result', (exec, result) => {
    const config = runtime.config
    const agent = agentKeyOf(exec)

    /* A call with no agent has no turn to be owned by, so its ownership ends with the call.
     * Letting it live until the TTL would leave a phantom owner denying real sessions for
     * half an hour. */
    if (agent === UNATTRIBUTED) {
      if (exec?.callId !== undefined) pendingAsks.delete(exec.callId)
      const released = ledger.releaseAgent(agent)
      for (const claim of released) auditRelease(claim, 'call', 'unattributed call finished')
      ledger.dropBudgets(agent)
      return
    }

    if (exec?.callId !== undefined) pendingAsks.delete(exec.callId)
    if (!result?.isError) return
    if (!config.claimsEnabled) return
    const call = describe(exec)
    /* Only a call that could have owned the surface can hand it back: a failed
     * `computer` screenshot is the same tool name as a click but not the same kind of
     * call, and must never release the click's claim. */
    if (!call.claims) return
    const released = ledger.releaseOnFailure({
      agent,
      owner: call.owner,
      tool: call.name,
      resource: call.resource,
    })
    if (released.length === 0) return
    const spent = new Set()
    for (const claim of released) {
      auditRelease(claim, 'failure', 'tool reported an error; the surface is free for the fallback')
      for (const scope of failureScopes(claim)) {
        if (spent.has(scope)) continue
        spent.add(scope)
        ledger.spendBudget({ agent, scopes: [scope] })
      }
    }
  }))

  ctx.effect(() => ctx.on('agent/turn-stopping', payload => {
    /* `payload.agent.id` is the documented shape; the bare `payload.id` keeps the cleanup
     * working if an older runtime hands over the Agent itself. */
    const agent = String(payload?.agent?.id ?? payload?.id ?? '')
    if (agent === '') return
    const { released, budgets } = closeAgent(agent, 'turn')
    if (!touched.delete(agent)) return
    /* Segments the ledger by the unit the whole design is built on. Without it a reader
     * cannot tell whether two rows were one turn — which is the first question asked of a
     * denial, and the reason the 1.x ledger needed a manual replay to explain the incident. */
    const turn = Number.isInteger(payload?.turn) ? payload.turn : null
    runtime.audit.write({
      at: clock(),
      agent,
      tool: '-',
      owner: '-',
      effect: 'observe',
      mode: 'read',
      decision: 'turn-end',
      source: 'turn',
      turn,
      released,
      budgets,
      reason: `turn ${turn ?? '?'} closed: ${released} claim(s) released, ${budgets} attempt budget(s) dropped`,
    })
  }))

  /* A turn that ends by disposal (aborted, crashed child) never reaches turn-stopping;
   * without this its claims would deny other sessions until the TTL expired. */
  ctx.effect(() => ctx.on('agent/disposed', payload => {
    const agent = String(payload?.agent?.id ?? '')
    if (agent === '') return
    closeAgent(agent, 'dispose')
  }))
}

export {
  Config,
  DEFAULT_CAPABILITIES,
  DEFAULT_GROUPS,
  DEFAULTS,
  EFFECTS,
  OWNERS,
  PROMPT,
  UNATTRIBUTED,
  classifyTool,
  describeRequest,
  evaluateStaticRules,
  findConflict,
  findConflicts,
  loadConfig,
  resolveConfig,
}




