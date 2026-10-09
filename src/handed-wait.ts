// Hearing a handed question within seconds, for Claude Code (0.35.0).
//
// The wake mod (packages/claude-plugin/src/wake) used to look for questions handed to its session (D21, Delegate) on a
// timer: list_pending every minute while the session used Pending You in the last half hour, else every 3 minutes. Now
// one of the computer's Claude Code sessions (the mod's lease in its store, `handed-listener`) keeps this running
// through the hooks' shim:
//
//   pendingyou-hook listen --handed --app claude-code [--since <ISO time>] [--origin …]
//
// It long-polls Pending You with Claude Code's own sign-in here, as Codex's one listener does (codex-wake.ts's
// listenHanded), asking for handed questions alone (`/mcp/cli/answers?handed=1&wait=25`, which looks every 3 seconds
// and reads only those), and exits as soon as one changed after `since`, or after WAIT_MS. It prints one JSON line,
// ids and times only:
//
//   {"handed":["req_…"],"since":"<the newest change it saw>"}     something new (or, with no `since`, what's there)
//   {"handed":[],"since":"…"}                                      nothing new in WAIT_MS
//   {"error":"signin"} | {"error":"unavailable"}                   no sign-in here; Pending You couldn't be reached
//
// The mod then looks at once, as its timer would (list_pending, get_request, the claim, the folder), and tells every
// other session on the computer to look too (its store's `handed-signal`). So which session hears it, and that only one
// does, stay the mod's: this only says when to look. The timer stays as the fallback.
//
// Never a title, a folder, a note or anything said: the mod reads those over the session's own connection.
import { getJson, SignInNeeded } from './api.ts'
import { elsewhereFor } from './apps/codex-wake.ts'
import { delegatedOf, type Heard } from './format.ts'
import type { Io } from './io.ts'

/** How long one run waits for a handed question, at most: a few long polls, then the mod starts it again. */
export const WAIT_MS = 2 * 60_000
/** One long poll's wait, in seconds: under the 30-second idle limits between here and Pending You. */
export const POLL_SECONDS = 25
/** After a failed poll, how long before the next, within the run. */
const RETRY_MS = 5000

export interface HandedWait {
  handed?: string[]
  since?: string
  error?: 'signin' | 'unavailable'
}

/** Whether `at` (an ISO time) is after `since`, or there's no `since` yet. */
const after = (at: string, since: string | undefined) =>
  !since || Date.parse(at) > Date.parse(since)

/** Waits for a question handed to one of this computer's Claude Code assistants; prints what it found as one line. */
export async function waitHanded(
  io: Io,
  options: { origin: string; since?: string },
): Promise<number> {
  const said = await listenOnce(io, options)
  io.out(`${JSON.stringify(said)}\n`)
  return 0
}

async function listenOnce(
  io: Io,
  options: { origin: string; since?: string },
): Promise<HandedWait> {
  const { origin } = options
  let since = options.since
  const started = io.now()
  const elsewhere = await elsewhereFor(io, origin, 'claude-code')
  let failures = 0
  while (io.now() - started < WAIT_MS && !io.signal.aborted) {
    const query = new URLSearchParams({
      source: 'claude-code',
      handed: '1',
      limit: '20',
      wait: String(POLL_SECONDS),
    })
    if (since) query.set('since', since)
    let requests: Heard[]
    try {
      const { status, body } = await getJson<{ requests?: Heard[] }>(
        io,
        origin,
        `/mcp/cli/answers?${query}`,
        (POLL_SECONDS + 20) * 1000,
        io.signal,
        { app: 'claude-code' },
      )
      if (status !== 200) throw new Error(`status ${status}`)
      requests = Array.isArray(body.requests) ? body.requests : []
      failures = 0
    } catch (error) {
      if (error instanceof SignInNeeded) return { error: 'signin' }
      if (io.signal.aborted) break
      // Twice in a row: the mod backs off, and its timer carries on.
      if (++failures >= 2) return { error: 'unavailable', ...(since ? { since } : {}) }
      await io.sleep(RETRY_MS, io.signal)
      continue
    }
    // A Pending You from before `handed` sends answers too: only handed questions count, here as there.
    const handed = requests.filter(
      (heard) =>
        delegatedOf(heard) !== null &&
        heard.ready === true &&
        typeof heard.changedAt === 'string' &&
        after(heard.changedAt, since) &&
        !elsewhere(heard),
    )
    for (const heard of requests)
      if (typeof heard.changedAt === 'string' && after(heard.changedAt, since))
        since = heard.changedAt
    if (handed.length)
      return { handed: handed.map((heard) => heard.requestId), ...(since ? { since } : {}) }
  }
  return { handed: [], ...(since ? { since } : {}) }
}
