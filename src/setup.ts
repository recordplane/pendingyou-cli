// Finishing setup by itself (0.11.0). Once `npx -y pendingyou@latest init` has connected an app, the app's first
// session does the rest (whoami, report_setup, a test card), and nobody should have to remember to ask for it:
//
// - Claude Code's wake mod (2.1.287 or later) starts that turn as the session opens (packages/claude-plugin's wake);
// - the session-start hook (pickup.ts) adds one line while Pending You says setup isn't finished (hear_answers'
//   `for.setup`, on the request the hook makes anyway: no extra request, inside its 3-second deadline). Only when a
//   session starts, resumes or clears (never on a compaction), at most 3 session starts per setup (init's
//   `setup.since`, which running init again starts over), none after 7 days, and never once it's verified, for a
//   sign-in that only hears, or against a Pending You that doesn't say;
// - Pi's extension (0.12.0) starts the turn with that line itself, in a session someone's at, so Pi's line also waits
//   10 minutes after the last (as the wake mod does): two sessions /reload-ed together don't both set it up;
// - and if neither happens, the person says FINISH_SAY to it, which init ends with and `status` repeats.
import type { AppId } from './apps/ids.ts'
import type { HeardFor, SetupState } from './apps/types.ts'
import { clip } from './format.ts'
import type { Io } from './io.ts'
import { markReminded, remindedAt, remindedTimes } from './state.ts'

/**
 * What the person says to an app to finish setting up, when it doesn't by itself. The same sentence is on Pending
 * You's setup pages (apps/pendingyou/src/data/instant.ts; a test holds them equal) and in the guide.
 */
export const FINISH_SAY = 'Finish setting up Pending You: it’s connected here already.'

/** The most session starts that remind one setup, and for how long after init. */
export const REMIND_TIMES = 3
export const REMIND_DAYS = 7
/**
 * How long after one session start's line another may give it, for an app whose session start starts the turn itself
 * (Pi's extension), as the wake mod's SETUP_QUIET_MS: two sessions opened together would both set up.
 */
export const REMIND_QUIET_MS = 10 * 60_000
const STARTS_TURN: ReadonlySet<AppId> = new Set(['pi'])

/** The session sources that remind: a new session, a resumed one, a cleared one. Never a compaction. */
const REMINDS = new Set(['startup', 'resume', 'clear'])

/** "Claude Code on build-01": the connection as Pending You names it. */
export const connectionTitle = (heard: Pick<HeardFor, 'name' | 'machine'>) =>
  heard.machine ? `${heard.name} on ${heard.machine}` : heard.name

/** How a setup stands, from hear_answers' `for.setup`; null when Pending You didn't say (or said something else). */
export function setupOf(heard: unknown): SetupState | null {
  if (typeof heard !== 'object' || heard === null) return null
  const setup = (heard as { setup?: unknown }).setup
  if (typeof setup !== 'object' || setup === null) return null
  const { reported, verified, test } = setup as Record<string, unknown>
  if (typeof reported !== 'boolean' || typeof verified !== 'boolean') return null
  const card = typeof test === 'object' && test !== null ? (test as Record<string, unknown>) : null
  const ok =
    card &&
    typeof card.requestId === 'string' &&
    /^req_[A-Za-z0-9-]{1,40}$/.test(card.requestId) &&
    (card.turn === 'you' || card.turn === 'agent')
  return {
    reported,
    verified,
    ...(ok
      ? {
          test: {
            requestId: card.requestId as string,
            turn: card.turn as 'you' | 'agent',
            ...(typeof card.name === 'string' && card.name.trim()
              ? { name: clip(card.name, 60).text }
              : {}),
          },
        }
      : {}),
  }
}

/**
 * The three calls that finish a setup, said exactly (0.13.0): Pi's first setup on a test computer spent about 20,000
 * tokens on "whoami with your name and guide true" (the whole guide, which Pi cut into a file the model then parsed)
 * and on hunting for testAreaId in whoami's answer (only report_setup's has it). `stopFirst` adds whoami's way out for
 * a setup another session finished meanwhile; a setup that has reported already says app.setUp is true, so its line
 * leaves that out. The Claude Code wake mod's setup turn says the same (packages/claude-plugin's setupPrompt).
 */
export function setupCalls(app: AppId, stopFirst: boolean): string {
  return `Three calls, nothing to install or approve: 1. whoami with your name.${stopFirst ? ' If it says app.setUp is true, another session did this: stop.' : ''} 2. report_setup with source ${app}, your name, skillSaved true, hears instant, and skillVersion set to whoami’s skill.latest. Its answer has a testAreaId. 3. post_request a short test question in that testAreaId, tell your person it’s on its way, and end your turn: you’re woken when they answer, so don’t ask them to type anything.`
}

/**
 * The session-start line for a setup that isn't finished (about 110 tokens), or null when there's nothing for the
 * session to do: verified, or its test card waiting on the person.
 */
export function setupLine(app: AppId, heard: HeardFor, setup: SetupState): string | null {
  if (setup.verified) return null
  const title = connectionTitle(heard)
  if (setup.test?.turn === 'agent') {
    const { requestId, name } = setup.test
    const pickUp = (who: string) =>
      `call get_request (requestId ${requestId}, ${who}), then ack_answer with its version and a one-line outcome: that finishes setup.`
    return name
      ? `Pending You: your person answered setup’s test question (${requestId}), asked by “${name}”. If you’re ${name}, ${pickUp(`name “${name}”`)} If you aren’t, leave it to ${name}.`
      : `Pending You: your person answered setup’s test question (${requestId}). C${pickUp('with your name').slice(1)}`
  }
  if (setup.test) return null
  if (setup.reported)
    return `Pending You: ${title} is connected, but setup’s test question isn’t sent yet. ${setupCalls(app, false)}`
  return `Pending You: ${title} is connected, but its setup isn’t finished. ${setupCalls(app, true)}`
}

/**
 * The line a session start adds for this app's unfinished setup, or null: only for a new, resumed or cleared session,
 * only for the app's own connection (a sign-in that only hears has no `for`), at most REMIND_TIMES per setup, none
 * after REMIND_DAYS, and for Pi none within REMIND_QUIET_MS of the last. `since` is init's (the app's manifest); none
 * means init didn't set this app up. Counts the reminder when it gives one. Never throws.
 */
export async function setupReminder(
  io: Pick<Io, 'env' | 'home' | 'now' | 'sleep'>,
  options: {
    origin: string
    app: AppId
    source: string | null
    since: string | null
    heard: unknown
  },
): Promise<string | null> {
  try {
    const { origin, app, source, since } = options
    if (!source || !REMINDS.has(source) || !since) return null
    const started = Date.parse(since)
    if (!Number.isFinite(started) || io.now() - started > REMIND_DAYS * 24 * 60 * 60_000)
      return null
    const heard = options.heard as Partial<HeardFor> | undefined
    if (typeof heard?.name !== 'string') return null
    const setup = setupOf(heard)
    if (!setup) return null
    const line = setupLine(app, heard as HeardFor, setup)
    if (!line) return null
    if ((await remindedTimes(io, origin, app, since)) >= REMIND_TIMES) return null
    const last = STARTS_TURN.has(app) ? await remindedAt(io, origin, app, since) : null
    if (last !== null && io.now() - last < REMIND_QUIET_MS) return null
    await markReminded(io, origin, app, since)
    return line
  } catch {
    return null
  }
}

/** Status's Setup line (never a reason it isn't Ready); null when Pending You doesn't say. */
export function setupStatus(appName: string, setup: SetupState | null): string | null {
  if (!setup) return null
  if (setup.verified) return 'finished'
  if (setup.test?.turn === 'you') return 'its test card is waiting on you in Pending You'
  if (setup.test?.turn === 'agent') return `you answered its test card; ${appName} picks it up next`
  return `waiting for its first session. Start ${appName} (or restart it); if it doesn’t finish by itself, say “${FINISH_SAY}”`
}
