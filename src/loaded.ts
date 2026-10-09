// Whether Claude Code's wake mod runs in a session (0.23.0). Claude Code reads CLAUDE_CODE_PLUGIN_DIRS only as a session
// starts, so a session that started before `init` set the mod up never loads it: nothing wakes it when the person
// answers, and the answer waits until they type (seen 2026-10-06, 77 and 90 minutes late), with nobody told why.
//
// The command line's copy of the mod notes each session it runs in, as it starts and after /clear or /resume, in
// `~/.config/pendingyou/wake/sessions/<session id>.json` (the mod's wake.ts loadedPath). A mod from before 0.23.0 notes
// nothing, but says the session is live through the hooks' shim every 5 minutes, which presence.ts records (`mod`).
// Either one means it runs there. So:
//
// - the next-message hook (pickup.ts) tells a session with neither, once, to have its person restart it, and to
//   background a hold until then (unwokenText); never in its first LOADED_GRACE_MS, while the mod may still be starting;
// - `init` names the sessions open here that have neither (unwokenSessions), from presence/claude-code.json.
//
// Only while init has the mod in Claude Code's settings (its record's `modDir`): an older Claude Code, or the plugin's
// copy alone, isn't asked about.
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { configDir, readJson } from './files.ts'
import { holdCommand } from './hold.ts'
import type { Io } from './io.ts'
import { readSaid, type Said } from './presence.ts'
import { claimUnwoken } from './state.ts'

/** A session id as a file name (the mod's own rule). */
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/
/** How long after this computer first heard of a session the hooks leave the mod to start before saying it didn't. */
export const LOADED_GRACE_MS = 15_000
/** How long after it last said it's live a session that never said it closed is named as maybe still open. */
export const OPEN_FOR_MS = 12 * 60 * 60_000
/** How long a session's note is kept after the mod last wrote it. */
const KEEP_NOTES_MS = 7 * 24 * 60 * 60_000

const notesDir = (io: Pick<Io, 'env' | 'home'>) => join(configDir(io), 'wake', 'sessions')

/** Where the mod notes it runs in a session. */
export const loadedPath = (io: Pick<Io, 'env' | 'home'>, session: string) =>
  join(notesDir(io), `${session}.json`)

/** What the next-message hook says to a session the mod doesn't run in, once (about 70 tokens). */
export function unwokenText(origin: string): string {
  return `Pending You can’t wake this session: Claude Code started before Pending You’s wake was set up. Ask your person to restart it (/exit, then claude --continue) at a good moment. Until then, after each card, run \`${holdCommand('<requestId>', origin)}\` in the background.`
}

/** Whether init put the mod in Claude Code's settings (its record of Claude Code names the folder). */
export async function modConfigured(io: Pick<Io, 'env' | 'home'>): Promise<boolean> {
  const manifest = await readJson<{ modDir?: unknown }>(
    join(configDir(io), 'claude-code.json'),
  ).catch(() => null)
  return typeof manifest?.modDir === 'string' && manifest.modDir !== ''
}

/** Whether the mod runs in this session: its note, or (a mod from before 0.23.0) its presence. */
export async function modLoaded(
  io: Pick<Io, 'env' | 'home'>,
  session: string,
  said: Said | undefined,
): Promise<boolean> {
  if (said?.mod) return true
  if (!SESSION.test(session)) return false
  return stat(loadedPath(io, session)).then(
    () => true,
    () => false,
  )
}

/**
 * The next-message hook's line for a session the mod doesn't run in, the first time only; null for any other session,
 * or when it can't tell. `said`: what presence knew of the session before this message said it's live. Never throws.
 */
export async function unwokenLine(
  io: Pick<Io, 'env' | 'home' | 'now' | 'sleep'>,
  origin: string,
  session: string | null,
  said: Said | undefined,
): Promise<string | null> {
  try {
    if (!session || !SESSION.test(session)) return null
    if (!(await modConfigured(io))) return null
    // The mod may have said live since (presence runs on its own).
    const latest = (await readSaid(io, 'claude-code').catch(() => ({}) as Record<string, Said>))[
      session
    ]
    if ((await modLoaded(io, session, said)) || latest?.mod) return null
    // Just started: the mod may not have noted it yet.
    if (said?.since !== undefined && io.now() - said.since < LOADED_GRACE_MS) return null
    if (!(await claimUnwoken(io, session))) return null
    return unwokenText(origin)
  } catch {
    return null
  }
}

/** A Claude Code session open here that the mod doesn't run in: its id, and the folder and name it last gave. */
export interface Unwoken {
  session: string
  cwd?: string
  name?: string
}

/**
 * The Claude Code sessions that may still be open here (said live in the last OPEN_FOR_MS, and never closed) and that
 * the mod doesn't run in, most recent first: they started before it was set up.
 */
export async function unwokenSessions(io: Pick<Io, 'env' | 'home' | 'now'>): Promise<Unwoken[]> {
  const said = await readSaid(io, 'claude-code').catch(() => ({}) as Record<string, Said>)
  const found: (Unwoken & { at: number })[] = []
  for (const [session, each] of Object.entries(said)) {
    if (each.state !== 'live' || io.now() - each.at > OPEN_FOR_MS) continue
    if (await modLoaded(io, session, each)) continue
    found.push({
      session,
      at: each.at,
      ...(each.cwd ? { cwd: each.cwd } : {}),
      ...(each.name ? { name: each.name } : {}),
    })
  }
  return found.sort((a, b) => b.at - a.at).map(({ at: _, ...rest }) => rest)
}

/** One session as init names it: “recordplane-d8” in ~/code/app, a session in ~/code/app, or a session. */
const named = (each: Unwoken) =>
  `${each.name ? `“${each.name}”` : 'a session'}${each.cwd ? ` in ${each.cwd}` : ''}`

/** The most sessions init names; the rest are counted. */
const NAMED = 4

/** init's line naming them; none when there are none. */
export function unwokenLines(sessions: readonly Unwoken[]): string[] {
  if (sessions.length === 0) return []
  const shown = sessions.slice(0, NAMED).map(named)
  const more = sessions.length - shown.length
  const list = `${shown.join('; ')}${more ? `; and ${more} more` : ''}`
  return [
    sessions.length === 1
      ? `Pending You can’t wake the Claude Code session open here (${list}): it started before Pending You’s wake was set up. Restart it at a good moment: /exit, then claude --continue.`
      : `Pending You can’t wake ${sessions.length} Claude Code sessions open here (${list}): they started before Pending You’s wake was set up. Restart each at a good moment: /exit, then claude --continue.`,
  ]
}

/** Forgets the notes of sessions the mod hasn't written to in a week. */
export async function pruneLoadedNotes(io: Pick<Io, 'env' | 'home' | 'now'>): Promise<void> {
  const dir = notesDir(io)
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const path = join(dir, name)
    const info = await stat(path).catch(() => null)
    if (info && io.now() - info.mtimeMs > KEEP_NOTES_MS)
      await rm(path, { force: true }).catch(() => {})
  }
}

/** What uninstall takes away: every session's note. */
export async function removeLoadedNotes(io: Pick<Io, 'env' | 'home'>): Promise<void> {
  await rm(join(configDir(io), 'wake'), { recursive: true, force: true }).catch(() => {})
}
