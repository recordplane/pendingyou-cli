// Told mid-task, in Codex (0.43.3, 2026-11-17). `codex queue` can't reach a thread in the middle of a turn: the
// wake waits for the turn to end, and a long browser-automation turn learned of three answers only by its own
// get_request, 10 to 13 minutes late, each then followed by a stale wake. So the hooks keep each thread's turn on disk,
// and while one runs the listener leaves its wakes here instead of queueing them; the thread's next tool call (Codex's
// PostToolUse, which fires for calls made from inside `functions.exec` too, under their own names) carries one line
// of added context naming them, once. A turn that ends with something still untold has it queued, as before.
//
// - The turn (`codex-turns/<thread>.json`, `{"turn": "<turn_id>"}`): begun by the next-message hook (UserPromptSubmit)
//   or the first tool call of a turn, kept fresh by each tool call (the file's time), ended by the Stop hook. One not
//   kept fresh for TURN_FOR_MS counts as over by itself, so a turn Codex never ended (it crashed, its Stop hook didn't
//   run) holds wakes at most that long: Codex's own tool calls (an exec cell, a wait) come back within minutes.
// - The wakes waiting (`codex-heard/<thread>.json`): each card's line for mid-task and its wake for idle, by request id;
//   ids, titles and names only, never an answer or a note (the listener's wakes never carry them).
// - PostToolUse with nothing waiting: a stat of each file and a touch of the turn's, no network, nothing printed.
// - A call from another turn than the one on disk (another loop in the thread, if Codex gives its calls their own
//   turn id) never takes the thread's line, unless that turn is over.
// - The thread's own get_request of a waiting card: it read it, so its line is dropped.
// - The line is a hint, said once (`told`): only the thread's own read counts as heard, so what it hasn't read when the
//   turn ends is queued as before, its wake ending that it may have been told while working and hasn't read it
//   (UNREAD_NOTE).
import { readFile, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { configDir, readJson, withLock, writeWhole } from '../files.ts'
import { isHandedWake } from '../format.ts'
import type { Io } from '../io.ts'
import { type MidTurnItem, midTurnText } from '../midturn.ts'

type Json = Record<string, unknown>

/**
 * What every wake `codex queue` carries ends with (0.43.3): a queued wake can't be taken back, and one for an answer
 * the thread read meanwhile (told mid-task, or by its own get_request) arrives as a turn of its own; this way it costs
 * a turn's start and no more.
 */
export const STALE_WAKE =
  ' If you already read it with get_request and acted on it, end this turn with no message.'

/** A turn not kept fresh by a tool call this long counts as over (a crashed turn holds wakes at most this long). */
export const TURN_FOR_MS = 5 * 60_000
/** A thread's id, as Codex gives it: also its files' names. */
const THREAD = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/

/** One card's waiting word: its line for mid-task, its wake for idle, and the moment it's for. */
export interface Waiting {
  requestId: string
  moment: string
  item: MidTurnItem
  wake: string
  /** Said mid-task already (once): kept until the thread reads it, and queued if it hasn't when the turn ends. */
  told?: true
}

/**
 * How a wake ends for what the thread was told mid-task and hasn't read (0.43.3): at the end, so it starts as every
 * wake does (the hooks and the Stop check know a wake by its start). "May have been": the hook printed the line, but
 * nothing says Codex gave it to the model (a build that ignores PostToolUse's context wouldn't), so it doesn't claim
 * more; the Claude Code mod, which knows, says "You were told of this while working and haven’t read it."
 */
export const UNREAD_NOTE = 'You may have been told of this while working, and haven’t read it.'

/** A wake's words, ending with UNREAD_NOTE. */
export const unreadWake = (text: string) =>
  text.includes('\n') ? `${text}\n${UNREAD_NOTE}` : `${text} ${UNREAD_NOTE}`

const turnPath = (io: Pick<Io, 'env' | 'home'>, thread: string) =>
  join(configDir(io), 'codex-turns', `${thread}.json`)
const heardPath = (io: Pick<Io, 'env' | 'home'>, thread: string) =>
  join(configDir(io), 'codex-heard', `${thread}.json`)

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** When the thread's turn was last kept fresh, and its id; null for none. */
async function turnOf(
  io: Pick<Io, 'env' | 'home'>,
  thread: string,
): Promise<{ turn: string | null; at: number } | null> {
  try {
    const path = turnPath(io, thread)
    const at = (await stat(path)).mtimeMs
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    const turn = isObject(parsed) && typeof parsed.turn === 'string' ? parsed.turn : null
    return { turn, at }
  } catch {
    return null
  }
}

/** A turn began (the next-message hook): it's this one now. Never throws. */
export async function turnBegan(
  io: Pick<Io, 'env' | 'home'>,
  thread: string,
  turn: string | null,
): Promise<void> {
  try {
    if (!THREAD.test(thread)) return
    await writeWhole(turnPath(io, thread), `${JSON.stringify({ turn })}\n`, { secret: true })
  } catch {}
}

/** The turn ended (the Stop hook): whatever waits goes to `codex queue` from now on. Never throws. */
export async function turnEnded(
  io: Pick<Io, 'env' | 'home'>,
  thread: string,
  turn: string | null,
): Promise<void> {
  try {
    if (!THREAD.test(thread)) return
    const on = await turnOf(io, thread)
    if (on && turn && on.turn && on.turn !== turn) return
    await rm(turnPath(io, thread), { force: true })
  } catch {}
}

/** Whether the thread is in the middle of a turn now: one began, and a tool call kept it fresh within TURN_FOR_MS. */
export async function midTurn(
  io: Pick<Io, 'env' | 'home' | 'now'>,
  thread: string,
): Promise<boolean> {
  if (!THREAD.test(thread)) return false
  try {
    return io.now() - (await stat(turnPath(io, thread))).mtimeMs < TURN_FOR_MS
  } catch {
    return false
  }
}

/** The waiting words, by request id. */
async function readHeard(io: Pick<Io, 'env' | 'home'>, thread: string): Promise<Waiting[]> {
  const file = await readJson<{ items?: unknown }>(heardPath(io, thread)).catch(() => null)
  const items = isObject(file?.items) ? Object.values(file.items) : []
  return items.filter(
    (each): each is Waiting =>
      isObject(each) &&
      typeof each.requestId === 'string' &&
      typeof each.moment === 'string' &&
      typeof each.wake === 'string' &&
      isObject(each.item),
  )
}

async function writeHeard(io: Pick<Io, 'env' | 'home'>, thread: string, list: readonly Waiting[]) {
  const path = heardPath(io, thread)
  if (list.length === 0) await rm(path, { force: true })
  else
    await writeWhole(
      path,
      `${JSON.stringify({ version: 1, items: Object.fromEntries(list.map((each) => [each.requestId, each])) })}\n`,
      { secret: true },
    )
}

/** Leaves these for the thread's next tool call (the listener, mid-turn): a card's newer moment replaces its older. */
export async function holdHeard(
  io: Pick<Io, 'env' | 'home' | 'now' | 'sleep'>,
  thread: string,
  list: readonly Waiting[],
): Promise<void> {
  if (!THREAD.test(thread) || list.length === 0) return
  await withLock(heardPath(io, thread), io, async () => {
    const kept = (await readHeard(io, thread)).filter(
      (each) => !list.some((added) => added.requestId === each.requestId),
    )
    await writeHeard(io, thread, [...kept, ...list])
  })
}

/** Whether anything waits for the thread. */
export async function hasHeard(io: Pick<Io, 'env' | 'home'>, thread: string): Promise<boolean> {
  if (!THREAD.test(thread)) return false
  try {
    await stat(heardPath(io, thread))
    return true
  } catch {
    return false
  }
}

/** What waits, taken (the listener, once the turn is over): the wakes to queue. */
export async function takeHeard(
  io: Pick<Io, 'env' | 'home' | 'now' | 'sleep'>,
  thread: string,
): Promise<string[]> {
  if (!(await hasHeard(io, thread))) return []
  return withLock(heardPath(io, thread), io, async () => {
    const list = await readHeard(io, thread)
    await writeHeard(io, thread, [])
    return list.map((each) => (each.told ? unreadWake(each.wake) : each.wake))
  })
}

/**
 * The messages to queue for what waited: the wakes for the thread's own cards in one, and each handed question's on
 * its own, so it starts with the handed words, which the next-message hook and the Stop check know a handed turn by.
 */
export function queuedWakes(wakes: readonly string[]): string[] {
  const own = wakes.filter((wake) => !isHandedWake(wake))
  return [...(own.length ? [own.join('\n\n')] : []), ...wakes.filter(isHandedWake)]
}

/** The thread read this card itself (its get_request): nothing to tell it of. Never throws. */
export async function heardRead(
  io: Pick<Io, 'env' | 'home' | 'now' | 'sleep'>,
  thread: string,
  requestId: string,
): Promise<void> {
  try {
    if (!(await hasHeard(io, thread))) return
    await withLock(heardPath(io, thread), io, async () => {
      const list = await readHeard(io, thread)
      const kept = list.filter((each) => each.requestId !== requestId)
      if (kept.length !== list.length) await writeHeard(io, thread, kept)
    })
  } catch {}
}

/**
 * A tool call of the thread's (PostToolUse): keeps its turn fresh, and when something waits for it, takes it and gives
 * the line to print, `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":…}}` (Codex 0.169 adds
 * only that to the conversation, after the call). Null with nothing waiting, or for a call of another live turn.
 * Never throws.
 */
export async function tellHeard(
  io: Pick<Io, 'env' | 'home' | 'now' | 'sleep'>,
  input: Json,
): Promise<string | null> {
  try {
    const thread = typeof input.session_id === 'string' ? input.session_id : ''
    const turn = typeof input.turn_id === 'string' && input.turn_id ? input.turn_id : null
    if (!THREAD.test(thread)) return null
    const now = io.now()
    // The turn: a call of the one on disk keeps it fresh; one of a new turn (the last ended without its Stop) takes
    // over once that one is over; one of another live turn changes nothing.
    const on = await turnOf(io, thread)
    const ours = !on || !turn || !on.turn || on.turn === turn
    if (ours && on) {
      const at = new Date(now)
      await utimes(turnPath(io, thread), at, at)
    } else if (!on || now - on.at >= TURN_FOR_MS) await turnBegan(io, thread, turn)
    else return null
    if (!(await hasHeard(io, thread))) return null
    // Said once, and kept: only the thread's own read (heardRead) takes it off; the turn's end queues the rest.
    const list = await withLock(heardPath(io, thread), io, async () => {
      const all = await readHeard(io, thread)
      const fresh = all.filter((each) => !each.told)
      if (fresh.length)
        await writeHeard(
          io,
          thread,
          all.map((each) => ({ ...each, told: true as const })),
        )
      return fresh
    })
    if (list.length === 0) return null
    const text = midTurnText(list.map((each) => each.item))
    return text
      ? `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } })}\n`
      : null
  } catch {
    return null
  }
}

/** `pendingyou heard --app codex`: Codex's PostToolUse hook on every call; prints the line, or nothing. Exits 0. */
export async function heardHook(io: Io): Promise<number> {
  try {
    // A tool's whole result rides along (an exec cell's output can be large), as the permission hooks read it.
    const input: unknown = JSON.parse(await io.readStdin(1000, 8_000_000))
    if (!isObject(input) || input.hook_event_name !== 'PostToolUse') return 0
    const told = await tellHeard(io, input)
    if (told) io.out(told)
  } catch {}
  return 0
}
