// `pendingyou watch -- <command> [args…]`: for an always-on script on an assistant's own machine (a Muse job, a cron
// box, a home server). It waits on Pending You for any of the sign-in's requests to become the assistant's move, and
// runs the command once for each: the answer after its 5-second hold, a message from the person, or a fallback that
// came due. It watches the person's Claude Code assistants: signing in offers no choice of assistant since 2026-10-04,
// and a sign-in pointed at one assistant before then ("Hear answers for: Only Muse") keeps watching that one.
//
// The command runs without a shell, one at a time, with its output passed through. It gets the request on stdin as
// JSON (the same fields as /mcp/cli/answers: id, title, status, the answer in words, new messages, fallback) and, in
// the environment, PENDINGYOU_REQUEST_ID, PENDINGYOU_EVENT (answer_ready, message_ready or fallback_due),
// PENDINGYOU_VERSION (for ack_answer's expectedVersion) and PENDINGYOU_ORIGIN. Nothing about the answer goes in the
// environment or the arguments, where other programs could see it. The script then acts through its own assistant
// (get_request, ack_answer): watch only reads. Since 0.14.0 a question the person handed the assistant from another
// one (D21) comes the same way, as `delegated_ready`, with `delegated` (who asked, how its answer travels, their note)
// on stdin: the assistant reads it with get_request, then answer_delegated or hand_back.
//
// A command that fails (a non-zero exit, or 5 minutes without finishing) is tried twice more, 5 and 15 seconds
// apart, then left: watch says so and moves on, so one bad answer can't wedge it. A command that can't be started at
// all stops watch (exit 127) without handing anything over. What was handed over is remembered
// (state.json), so a restart doesn't run anything twice. --once exits after the first, with the command's exit code.
import { getJson, SignInNeeded, Unavailable } from './api.ts'
import { readCredential } from './credentials.ts'
import { delegatedOf, type Heard } from './format.ts'
import type { Io } from './io.ts'
import { markHanded, momentOf, wasHanded } from './state.ts'

const LONG_POLL_SECONDS = 25
const COMMAND_MS = 5 * 60 * 1000
const RETRY_MS = [5000, 15_000]
const PATIENT_AFTER_MS = 30 * 60 * 1000
const PATIENT_PAUSE_MS = 30_000
const BACKOFF_MS = [2000, 5000, 10_000, 20_000, 30_000, 60_000]

export function eventOf(
  heard: Pick<Heard, 'status' | 'delegated'>,
): 'answer_ready' | 'message_ready' | 'fallback_due' | 'delegated_ready' {
  // A question the person handed this assistant from another one (D21): it reads it with get_request, then
  // answer_delegated or hand_back.
  if (delegatedOf(heard)) return 'delegated_ready'
  if (heard.status === 'answered') return 'answer_ready'
  if (heard.status === 'expired') return 'fallback_due'
  return 'message_ready'
}

export async function watch(
  io: Io,
  options: { origin: string; command: string[]; once: boolean },
): Promise<number> {
  const { origin } = options
  const [program, ...args] = options.command as [string, ...string[]]
  const say = (text: string) => io.err(`pendingyou watch: ${text}\n`)
  if (!(await readCredential(io, origin))) {
    say(
      'this computer isn’t signed in. Run `npx pendingyou login` (or `login --device` without a browser).',
    )
    return 1
  }
  say(`watching ${origin}. Ctrl-C stops.`)
  let since: string | undefined
  let quietSince = io.now()
  let failures = 0
  for (;;) {
    if (io.signal.aborted) {
      say('stopped.')
      return 0
    }
    const query = new URLSearchParams({ limit: '20', wait: String(LONG_POLL_SECONDS) })
    if (since) query.set('since', since)
    let result: { status: number; body: { requests?: Heard[] } }
    try {
      result = await getJson(
        io,
        origin,
        `/mcp/cli/answers?${query}`,
        (LONG_POLL_SECONDS + 20) * 1000,
        io.signal,
      )
    } catch (error) {
      if (io.signal.aborted) continue
      if (error instanceof SignInNeeded) {
        say(
          error.ended
            ? 'the sign-in has ended. Run `npx pendingyou login` again.'
            : 'this computer isn’t signed in. Run `npx pendingyou login`.',
        )
        return 1
      }
      const pause =
        error instanceof Unavailable && error.retryAfter
          ? error.retryAfter * 1000
          : (BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)] as number)
      failures++
      await io.sleep(pause, io.signal)
      continue
    }
    failures = 0
    const heard = Array.isArray(result.body.requests) ? result.body.requests : []
    if (result.status !== 200) {
      await io.sleep(BACKOFF_MS[1] as number, io.signal)
      continue
    }
    for (const request of heard) if (!since || request.changedAt > since) since = request.changedAt
    // Oldest first, and only what this computer hasn't handed over yet.
    const fresh: Heard[] = []
    for (const request of [...heard].sort((a, b) => a.changedAt.localeCompare(b.changedAt)))
      if (!(await wasHanded(io, origin, request.requestId, momentOf(request)))) fresh.push(request)
    for (const request of fresh) {
      if (io.signal.aborted) break
      const code = await runFor(io, program, args, origin, request, say)
      // A command that can't even start is a mistake in the command line: stop, and hand nothing over.
      if (code === 127) return 127
      await markHanded(io, origin, [{ requestId: request.requestId, moment: momentOf(request) }])
      if (options.once) return code
    }
    if (fresh.length > 0) quietSince = io.now()
    else if (io.now() - quietSince > PATIENT_AFTER_MS) await io.sleep(PATIENT_PAUSE_MS, io.signal)
  }
}

/** Runs the command for one request, trying twice more if it fails. Returns its last exit code. */
async function runFor(
  io: Io,
  program: string,
  args: string[],
  origin: string,
  request: Heard,
  say: (text: string) => void,
): Promise<number> {
  const env = {
    PENDINGYOU_REQUEST_ID: request.requestId,
    PENDINGYOU_EVENT: eventOf(request),
    PENDINGYOU_VERSION: String(request.version),
    PENDINGYOU_ORIGIN: origin,
  }
  const stdin = `${JSON.stringify(request)}\n`
  let code = 0
  for (let attempt = 0; attempt <= RETRY_MS.length; attempt++) {
    if (attempt > 0) await io.sleep(RETRY_MS[attempt - 1] as number, io.signal)
    if (io.signal.aborted) return code
    code = await io.exec(program, args, { env, stdin, timeoutMs: COMMAND_MS, signal: io.signal })
    if (code === 0) return 0
    if (code === 127) {
      say(`couldn’t start ${program}. Check the command after --. Stopping.`)
      return code
    }
  }
  say(`the command failed for ${request.requestId} (exit ${code}) three times; moving on.`)
  return code
}
