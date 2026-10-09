// What the command line remembers between runs, in ~/.config/pendingyou/state.json (0600): which answers it already
// handed to an agent, so a hook never repeats one, and (0.11.0) how many session starts have reminded an unfinished
// setup (setup.ts). Ids and counts only: never a title or an answer. Until 0.10.0 it also kept which requests a hold
// was waiting on, because the next-message hook only looked for answers then; it looks every time now, and a file from
// before is rewritten without them.
import { join } from 'node:path'
import { configDir, readJson, withLock, writeWhole } from './files.ts'
import type { Io } from './io.ts'

interface StateFile {
  version: 1
  /** `<origin> <requestId>` → the moment it was handed over (`<version>:<last message id>`). */
  handed: Record<string, string>
  /**
   * `<origin> <app>` → the setup it reminded (init's `setup.since`), how many session starts did, and when the last one
   * did (0.12.0).
   */
  reminded?: Record<string, { since: string; times: number; at?: number }>
  /** Claude Code sessions told they can't be woken (0.23.0, loaded.ts): session id → when. Each is told once. */
  unwoken?: Record<string, number>
  /** When this computer last linked its sign-ins at an address (0.29.0, link.ts): origin → when. */
  linked?: Record<string, number>
}

const KEEP_HANDED = 300
const KEEP_UNWOKEN = 100

type StateIo = Pick<Io, 'env' | 'home' | 'now' | 'sleep'>

const statePath = (io: Pick<Io, 'env' | 'home'>) => join(configDir(io), 'state.json')
const key = (origin: string, requestId: string) => `${origin} ${requestId}`

/** The moment of a heard request: a new answer version or a new message is a new moment. */
export const momentOf = (heard: { version: number; messages: { id: string }[] }) =>
  `${heard.version}:${heard.messages.at(-1)?.id ?? ''}`

async function load(io: Pick<Io, 'env' | 'home'>): Promise<StateFile> {
  const file = await readJson<StateFile>(statePath(io)).catch(() => null)
  return {
    version: 1,
    handed: file?.handed && typeof file.handed === 'object' ? file.handed : {},
    ...(file?.reminded && typeof file.reminded === 'object' ? { reminded: file.reminded } : {}),
    ...(file?.unwoken && typeof file.unwoken === 'object' ? { unwoken: file.unwoken } : {}),
    ...(file?.linked && typeof file.linked === 'object' ? { linked: file.linked } : {}),
  }
}

async function change(io: StateIo, edit: (state: StateFile) => void): Promise<void> {
  const path = statePath(io)
  await withLock(path, io, async () => {
    const state = await load(io)
    edit(state)
    const handed = Object.entries(state.handed)
    if (handed.length > KEEP_HANDED) state.handed = Object.fromEntries(handed.slice(-KEEP_HANDED))
    const unwoken = Object.entries(state.unwoken ?? {})
    if (unwoken.length > KEEP_UNWOKEN)
      state.unwoken = Object.fromEntries(unwoken.slice(-KEEP_UNWOKEN))
    await writeWhole(path, `${JSON.stringify(state, null, 2)}\n`, { secret: true })
  })
}

export async function wasHanded(
  io: Pick<Io, 'env' | 'home'>,
  origin: string,
  requestId: string,
  moment: string,
): Promise<boolean> {
  return (await load(io)).handed[key(origin, requestId)] === moment
}

/**
 * Takes a moment for one session before it's told (0.14.0): true when nobody had it, false when it was handed over
 * already. A question the person handed this assistant (D21) goes to one session only, so it's claimed first, under
 * the lock, and given back (`releaseHanded`) if the session couldn't be told after all.
 */
export async function claimHanded(
  io: StateIo,
  origin: string,
  requestId: string,
  moment: string,
): Promise<boolean> {
  let claimed = false
  await change(io, (state) => {
    const name = key(origin, requestId)
    if (state.handed[name] === moment) return
    delete state.handed[name]
    state.handed[name] = moment
    claimed = true
  })
  return claimed
}

/** Gives a claimed moment back: the session it was for couldn't be told, so another may take it. */
export function releaseHanded(
  io: StateIo,
  origin: string,
  requestId: string,
  moment: string,
): Promise<void> {
  return change(io, (state) => {
    const name = key(origin, requestId)
    if (state.handed[name] === moment) delete state.handed[name]
  })
}

/** Records answers as handed over. */
export function markHanded(
  io: StateIo,
  origin: string,
  heard: readonly { requestId: string; moment: string }[],
): Promise<void> {
  return change(io, (state) => {
    for (const { requestId, moment } of heard) {
      const name = key(origin, requestId)
      delete state.handed[name]
      state.handed[name] = moment
    }
  })
}

/** How many session starts have reminded this setup (`since`: when init set it up); 0 for a newer setup. */
export async function remindedTimes(
  io: Pick<Io, 'env' | 'home'>,
  origin: string,
  app: string,
  since: string,
): Promise<number> {
  const entry = (await load(io)).reminded?.[`${origin} ${app}`]
  return entry?.since === since && Number.isInteger(entry.times) ? entry.times : 0
}

/** When a session start last reminded this setup; null when none has. */
export async function remindedAt(
  io: Pick<Io, 'env' | 'home'>,
  origin: string,
  app: string,
  since: string,
): Promise<number | null> {
  const entry = (await load(io)).reminded?.[`${origin} ${app}`]
  return entry?.since === since && typeof entry.at === 'number' ? entry.at : null
}

/** Counts one more reminder of this setup, now. */
export function markReminded(
  io: StateIo,
  origin: string,
  app: string,
  since: string,
): Promise<void> {
  return change(io, (state) => {
    const name = `${origin} ${app}`
    const entry = state.reminded?.[name]
    const times = entry?.since === since ? entry.times + 1 : 1
    state.reminded = { ...state.reminded, [name]: { since, times, at: io.now() } }
  })
}

/**
 * Marks a Claude Code session told it can't be woken (0.23.0): true when it hadn't been, so it's told now; false when it
 * was told already.
 */
export async function claimUnwoken(io: StateIo, session: string): Promise<boolean> {
  let claimed = false
  await change(io, (state) => {
    if (state.unwoken?.[session] !== undefined) return
    state.unwoken = { ...state.unwoken, [session]: io.now() }
    claimed = true
  })
  return claimed
}

/** Whether this computer's sign-ins at `origin` are due to be linked again (0.29.0, link.ts): never, or `every` ago. */
export async function linkDue(
  io: Pick<Io, 'env' | 'home' | 'now'>,
  origin: string,
  every: number,
): Promise<boolean> {
  const at = (await load(io)).linked?.[origin]
  return typeof at !== 'number' || io.now() - at >= every || at > io.now()
}

/** Records that this computer's sign-ins at `origin` were linked just now. */
export function markLinked(io: StateIo, origin: string): Promise<void> {
  return change(io, (state) => {
    state.linked = { ...state.linked, [origin]: io.now() }
  })
}
