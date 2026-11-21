/**
 * JSONL ledger: one line per state transition, best effort, never on the dispatch path
 * when it fails.
 *
 * Vocabulary (a row says exactly one thing happened):
 * - `decision: "allow" | "deny" | "ask"` — the pre-dispatch verdict, `source` names why;
 * - `decision: "claim"` — ownership was taken or transferred;
 * - `decision: "release"` — ownership ended, `source` says how (failure/turn/dispose/ttl);
 * - `decision: "startup"` — the writer and the loaded rules, written once per load.
 *
 * `mode` stays a coarse `read`/`act` view so older greps keep working; `effect` carries the
 * exact observe/select/act classification.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

export function createAuditWriter ({ enabled = true, file, maxBytes }) {
  if (!enabled || typeof file !== 'string' || file === '') {
    return { enabled: false, file, write () {}, bytes: () => 0 }
  }

  let bytes = -1

  const write = (entry) => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      if (bytes < 0) bytes = existsSync(file) ? statSync(file).size : 0
      const line = `${JSON.stringify(entry)}\n`
      const size = Buffer.byteLength(line)
      if (bytes > 0 && bytes + size > maxBytes) {
        try {
          renameSync(file, `${file}.1`)
        } catch {
          /* rotation is best effort; appending beats losing the row */
        }
        bytes = 0
      }
      appendFileSync(file, line, 'utf8')
      bytes += size
    } catch {
      /* a policy plugin must never block dispatch because a log is unwritable */
    }
  }

  return { enabled: true, file, write, bytes: () => bytes }
}
