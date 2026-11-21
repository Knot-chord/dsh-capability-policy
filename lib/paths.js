/**
 * Where this plugin keeps its per-profile state.
 *
 * The Host process does not carry DSH_PROFILE_DIR (only the shells it spawns do), so
 * the profile is derived from the plugin's own location instead: a DSH profile root
 * always carries `cordis.yml`. That is the only signal which survives both a registry
 * install and a `file:` copy into `node_modules`, and it puts every artifact of one
 * profile (rules, ledger, rotation) into a single directory.
 *
 * Fallbacks stay *durable* on purpose: never write into the package, which for a
 * `link:`/`file:` install is the author's source tree.
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** A DSH profile root is the directory holding `cordis.yml`. */
const PROFILE_MARKER = 'cordis.yml'
/** `<profile>/node_modules/@scope/pkg` is four hops down; keep a margin for nesting. */
const MAX_WALK = 8
const STATE_DIR = 'capability-policy'

/**
 * Walk up from `start` looking for a profile root. `start` itself is tested last, so a
 * package that ships its own `cordis.patch.yml` is never mistaken for a profile.
 */
export function findProfileDir (start) {
  let dir = resolve(start)
  for (let depth = 0; depth <= MAX_WALK; depth++) {
    if (existsSync(join(dir, PROFILE_MARKER))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** Explicit override, then the derived profile, then the host state home. */
export function resolveStateDir (baseDir) {
  const explicit = process.env.DSH_PROFILE_DIR
  if (explicit) return resolve(explicit, STATE_DIR)
  const profile = findProfileDir(baseDir)
  if (profile) return join(profile, STATE_DIR)
  const stateHome = process.env.LOCALAPPDATA ?? process.env.XDG_STATE_HOME ?? process.env.XDG_DATA_HOME
  if (stateHome) return resolve(stateHome, `dsh-${STATE_DIR}`)
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (home) return resolve(home, `.dsh-${STATE_DIR}`)
  return resolve(baseDir, '.state')
}

/** The ledger always lives in the state directory, never beside the source. */
export function resolveLedgerFile (baseDir) {
  return join(resolveStateDir(baseDir), 'audit.jsonl')
}

/**
 * A per-profile `rules.json` wins over the one shipped in the package: the package copy
 * is replaced on upgrade, so user edits there would silently disappear.
 */
export function resolveRulesFile (baseDir) {
  const own = join(resolveStateDir(baseDir), 'rules.json')
  if (existsSync(own)) return own
  return join(resolve(baseDir), 'rules.json')
}

/** Pre-1.x ledger location, reported once so an old history is not simply lost. */
export function legacyLedgerFile () {
  const stateHome = process.env.LOCALAPPDATA ?? process.env.XDG_STATE_HOME ?? process.env.XDG_DATA_HOME
  if (!stateHome) return undefined
  return resolve(stateHome, `dsh-${STATE_DIR}`, 'audit.jsonl')
}
