/**
 * Ownership and retry state for one plugin instance.
 *
 * Pure in-memory state: it never writes files, never reads config and never decides
 * policy. It answers questions and hands every transition back to the caller as a plain
 * description, so the wiring is the only place that audits.
 *
 * Two ledgers, because they answer different questions:
 *
 * - `claims` — who currently drives which surface, keyed by (agent, owner, surface).
 * - `budgets` — how many attempts a caller has spent, keyed by an opaque *scope string*.
 *   The scope is chosen by the policy layer and comes in two kinds: a surface scope
 *   (`s:desktop:1050872`) when the plugin can prove which surface is contested, and a
 *   turn scope (`u`) for everything it cannot prove. The budget must never be finer than
 *   the identity the gate is able to prove, or "two blocked attempts" would reset itself
 *   whenever the caller renamed the target it was reaching for.
 *
 * A spend returns a ticket so an approved switch can refund exactly what it cost: asking
 * the user is not the caller's failure, and a human approval must not eat the budget that
 * exists to stop the caller from retrying on its own.
 */
import { relation, resourceKey } from './capability.js'

const SEP = '\u0000'

export function createLedger ({ clock = Date.now } = {}) {
  /** claimId -> claim */
  const claims = new Map()
  /** budgetId -> { count, at } */
  const budgets = new Map()

  const claimId = (agent, owner, resource) => `${agent}${SEP}${owner}${SEP}${resourceKey(resource)}`
  const budgetId = (agent, scope) => `${agent}${SEP}${scope}`

  /**
   * Drop entries older than the TTL. Called on every gate pass, not only when a claim is
   * about to be taken, because an expired claim must never be able to deny anything.
   */
  const sweep = (now = clock(), ttlMs) => {
    const expired = []
    for (const [id, claim] of claims) {
      if (now - claim.at <= ttlMs) continue
      claims.delete(id)
      expired.push(claim)
    }
    let droppedBudgets = 0
    for (const [id, record] of budgets) {
      if (now - record.at <= ttlMs) continue
      budgets.delete(id)
      droppedBudgets++
    }
    return { expired, droppedBudgets }
  }

  const list = () => claims.values()

  /**
   * Take (or refresh) ownership. Idempotent: the same owner re-driving the same surface
   * only moves `at`, so the TTL follows live work and the audit does not grow per click.
   */
  const acquire = ({ agent, owner, tool, resource, now = clock() }) => {
    const id = claimId(agent, owner, resource)
    const prior = claims.get(id)
    const claim = { id, agent, owner, tool, resource, at: now }
    claims.set(id, claim)
    return { claim, created: prior === undefined }
  }

  /**
   * A failed call hands the surface back so the fallback can run. Only claims of the same
   * owner *and* tool are released: a different tool of the same class is still working,
   * so the class has not failed. The resource comparison uses the claim's own identity,
   * never the failing call's, because a `computer` screenshot and a `computer` click are
   * the same tool name but not the same kind of call.
   */
  const releaseOnFailure = ({ agent, owner, tool, resource }) => {
    const released = []
    for (const [id, claim] of claims) {
      if (claim.agent !== agent) continue
      if (claim.owner !== owner) continue
      if (claim.tool !== tool) continue
      if (relation(claim.resource, resource) === 'distinct') continue
      claims.delete(id)
      released.push(claim)
    }
    return released
  }

  const releaseAgent = (agent) => {
    const released = []
    for (const [id, claim] of claims) {
      if (claim.agent !== agent) continue
      claims.delete(id)
      released.push(claim)
    }
    return released
  }

  /**
   * End claims by identity. A takeover is always explicit: the previous owner's claim is
   * removed and reported, never silently overwritten, so the ledger can answer "who lost
   * the surface, and to whom". Coexistence only survives where the claims are provably
   * about different surfaces (a page URL and a window handle cannot show that).
   */
  const evict = (ids) => {
    const released = []
    for (const id of ids) {
      const claim = claims.get(id)
      if (claim === undefined) continue
      claims.delete(id)
      released.push(claim)
    }
    return released
  }

  /** How many attempts this caller has spent in one scope. */
  const readBudget = (agent, scope) => budgets.get(budgetId(agent, scope))?.count ?? 0

  /** Spend one attempt in every given scope; the ticket refunds exactly these. */
  const spendBudget = ({ agent, scopes, now = clock() }) => {
    const ticket = { agent, scopes: [...new Set(scopes)] }
    for (const scope of ticket.scopes) {
      const id = budgetId(agent, scope)
      const prior = budgets.get(id)
      budgets.set(id, { count: (prior?.count ?? 0) + 1, at: now })
    }
    return ticket
  }

  /** Undo one spend, e.g. because the user approved the switch it was blocking. */
  const refundBudget = (ticket) => {
    if (ticket === undefined) return
    for (const scope of ticket.scopes) {
      const id = budgetId(ticket.agent, scope)
      const prior = budgets.get(id)
      if (prior === undefined) continue
      if (prior.count <= 1) budgets.delete(id)
      else budgets.set(id, { count: prior.count - 1, at: prior.at })
    }
  }

  const dropBudgets = (agent) => {
    let dropped = 0
    for (const [id] of budgets) {
      if (!id.startsWith(`${agent}${SEP}`)) continue
      budgets.delete(id)
      dropped++
    }
    return dropped
  }

  const sizes = () => ({ claims: claims.size, budgets: budgets.size })

  return {
    sweep,
    list,
    acquire,
    evict,
    releaseOnFailure,
    releaseAgent,
    readBudget,
    spendBudget,
    refundBudget,
    dropBudgets,
    sizes,
  }
}
