// `pendingyou hold <requestId>` (D34): Claude Code runs it as a background command right after posting a question.
// It waits on Pending You (long polls of up to 25 seconds; the server looks every few seconds, and right when a held
// answer is due) until the request is the assistant's move: the answer, after its 5-second hold; a message from the
// person; a fallback that ran; or it closed. Then it prints a few lines and exits, and Claude Code, which re-invokes
// the model when a background command ends, wakes up with the answer, even if it was idle at the prompt.
//
// It lets go cleanly after --timeout (4 hours by default), on Ctrl-C or when Claude Code stops it (a background
// command's own time limit can stop it sooner). Since 0.10.0 it then says to start it again in the background, with the
// exact command: a session without the wake mod (Claude Code before 2.1.287, or no plugin and no init) has nothing
// else to wake it, and two sessions missed answers overnight when it said not to (2026-10-04). Exit codes: 0 when it
// heard something or stopped cleanly; 1 when it can't wait at all (not signed in, no such request, bad arguments).
//
// Inside Pi (0.12.0) it answers at once: Pi's shell tool waits for a command to end, so a hold would stop the session
// for hours. Pi marks the processes it starts (`AI_AGENT=pi`, `PI_CODING_AGENT=true`), and its Pending You extension
// wakes the session itself.
import { getJson, SignInNeeded, Unavailable } from './api.ts'
import { DEFAULT_APP } from './apps/ids.ts'
import { readPiManifest } from './apps/pi.ts'
import { DEFAULT_ORIGIN, DEFAULT_TIMEOUT_MS } from './args.ts'
import { readCredential } from './credentials.ts'
import { describe, type Heard } from './format.ts'
import type { Io } from './io.ts'
import { linkSoon } from './link.ts'
import { markHanded, momentOf } from './state.ts'

/** The longest one long poll asks the server to wait. */
export const LONG_POLL_SECONDS = 25
/** After this long, a pause between long polls: an answer hours later needn't arrive within seconds. */
const PATIENT_AFTER_MS = 30 * 60 * 1000
const PATIENT_PAUSE_MS = 30_000
const BACKOFF_MS = [2000, 5000, 10_000, 20_000, 30_000, 60_000]

/** A duration as `--timeout` takes it: 4h, 90m or 45s. */
export function durationText(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  return `${Math.round(ms / 1000)}s`
}

/**
 * The command that holds for this request again, as it was started: its origin and timeout when they aren't the
 * defaults (`--origin` rather than PENDINGYOU_ORIGIN=…, so init's `Bash(npx pendingyou hold:*)` still allows it).
 */
export function holdCommand(
  requestId: string,
  origin = DEFAULT_ORIGIN,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): string {
  return [
    `npx pendingyou hold ${requestId}`,
    ...(origin === DEFAULT_ORIGIN ? [] : [`--origin ${origin}`]),
    ...(timeoutMs === DEFAULT_TIMEOUT_MS ? [] : [`--timeout ${durationText(timeoutMs)}`]),
  ].join(' ')
}

const minutes = (ms: number) => {
  if (ms < 60_000) return `${Math.round(ms / 1000)} seconds`
  const total = Math.round(ms / 60_000)
  if (total < 60) return `${total} minute${total === 1 ? '' : 's'}`
  const hours = Math.round((total / 60) * 10) / 10
  return `${hours} hour${hours === 1 ? '' : 's'}`
}

/** Whether this runs inside Pi, which marks the processes it starts (and theirs) as its own. */
export const inPi = (env: Readonly<Record<string, string | undefined>>) =>
  env.AI_AGENT === 'pi' || (!env.AI_AGENT && env.PI_CODING_AGENT === 'true')

/** What a hold says inside Pi: woken by Pending You's extension when init set Pi up, else what to do instead. */
export const piHoldReply = (requestId: string, extension: boolean) =>
  extension
    ? `Pending You: no hold is needed in Pi, and Pi’s shell would wait on it. Pending You’s extension wakes this session when your person answers ${requestId}, writes to you on it, or its fallback runs, even while it’s idle. Nothing is running in the background: keep working, or end your turn.`
    : `Pending You: Pi’s shell waits for a command to end, so a hold would stop this session for hours. While you’re blocked on ${requestId}, call get_request every pollAfterSeconds; otherwise list_pending at breakpoints.`

export async function hold(
  io: Io,
  options: { origin: string; requestId: string; timeoutMs: number },
): Promise<number> {
  const { origin, requestId } = options
  if (inPi(io.env)) {
    io.out(`${piHoldReply(requestId, (await readPiManifest(io)) !== null)}\n`)
    return 0
  }
  const again = holdCommand(requestId, origin, options.timeoutMs)
  const started = io.now()
  const deadline = started + options.timeoutMs
  const print = (lines: string[]) => io.out(`${lines.join('\n')}\n`)
  const signInNeeded = (ended: boolean) => {
    print([
      ended
        ? `Pending You: this computer’s pendingyou sign-in has ended, so I can’t wait on ${requestId}.`
        : `Pending You: the pendingyou command isn’t signed in on this computer, so I can’t wait on ${requestId}.`,
      'Ask your person to run `npx pendingyou login`. Until then, call get_request at breakpoints.',
    ])
    return 1
  }
  if (!(await readCredential(io, origin))) return signInNeeded(false)
  // This computer's sign-ins linked to it by its key, every few hours, in the background (0.29.0, link.ts).
  await linkSoon(io, origin)
  let failures = 0
  for (;;) {
    if (io.signal.aborted) {
      print([
        `Pending You: stopped waiting on ${requestId}.`,
        `If you’re still waiting on their answer, start it again as a background command: ${again}`,
      ])
      return 0
    }
    const left = deadline - io.now()
    if (left <= 0) {
      print([
        `Pending You: no answer on ${requestId} after ${minutes(options.timeoutMs)}, so this hold stopped.`,
        `Start it again now as a background command, so their answer still wakes you: ${again}`,
      ])
      return 0
    }
    const wait = Math.max(1, Math.min(LONG_POLL_SECONDS, Math.floor(left / 1000)))
    let result: { status: number; body: { ok?: boolean; request?: Heard } }
    try {
      result = await getJson(
        io,
        origin,
        `/mcp/cli/requests/${encodeURIComponent(requestId)}?wait=${wait}&source=${DEFAULT_APP}`,
        (wait + 20) * 1000,
        io.signal,
      )
    } catch (error) {
      if (io.signal.aborted) continue
      if (error instanceof SignInNeeded) return signInNeeded(error.ended)
      const pause =
        error instanceof Unavailable && error.retryAfter
          ? error.retryAfter * 1000
          : (BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)] as number)
      failures++
      await io.sleep(Math.min(pause, Math.max(0, deadline - io.now())), io.signal)
      continue
    }
    failures = 0
    if (result.status === 404) {
      print([
        `Pending You: can’t find ${requestId} among your person’s Claude Code questions on ${origin}.`,
        'Check the id from post_request. If this Claude Code signed in to Pending You as someone else, use get_request instead.',
      ])
      return 1
    }
    const heard = result.body.request
    if (result.status !== 200 || !heard) {
      await io.sleep(BACKOFF_MS[1] as number, io.signal)
      continue
    }
    if (heard.ready) {
      print(describe(heard, `run \`${again}\` in the background again`))
      await markHanded(io, origin, [{ requestId, moment: momentOf(heard) }]).catch(() => {})
      return 0
    }
    if (io.now() - started > PATIENT_AFTER_MS)
      await io.sleep(Math.min(PATIENT_PAUSE_MS, Math.max(0, deadline - io.now())), io.signal)
  }
}
