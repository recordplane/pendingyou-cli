// Presence (0.15.0): telling Pending You which of the person's agent sessions are open right now, so it can say so
// (and offer an open session a question). Each app sends, with its own connection here:
//
//   POST <origin>/mcp/cli/presence  { "source": "<app>", "name": "<agent name>|null", "sessionId": "<id>",
//                                     "cwd": "~/…"|null, "state": "live"|"closed" }  → 204
//
// A session counts live for 15 minutes after its last "live", so an open session says so every 5 minutes
// (PRESENCE_EVERY_MS), with no model involved:
// - Claude Code: its SessionStart hook (pickup) says live, and the wake mod says live as the session starts and every 5
//   minutes while it's open; its SessionEnd hook (`presence`, through the shim) says closed. Without the mod (an older
//   Claude Code) the next-message hook says live again when it's been 4 minutes.
// - Codex: its SessionStart and next-message hooks make sure the thread has a keeper (`presence --keep`, detached, a
//   lease of its own), which says live every 5 minutes while the Codex process the hooks ran under (Codex CLI, or the
//   Codex app's own codex) is running, and closed once it's gone; its SessionEnd hook (Codex fires it when a
//   conversation is archived or closed, or after 30 idle minutes) says closed and lets the keeper go.
// - OpenCode's plugin and Pi's extension say live as a session starts and every 5 minutes in their own process, and
//   closed on their shutdown events, through `presence --state …` (this file's command, run by the shim).
//
// Never in anyone's way: a hook only starts the send in the background, a send gives up after 3 seconds, and a server
// from before presence answers 404, which is taken quietly. Only an app's own connection here sends (a sign-in that
// only hears isn't an assistant). The name is the one the session goes by with Pending You (Claude Code's from its
// transcript, the others' from what their hooks remember), else null; the folder only as `~/…`, else null.
//
// Herdr (0.17.0, herdr.ts) rides on the same heartbeats: in a Herdr pane, Codex's keeper and OpenCode's and Pi's sends
// write the pane's badges again with each live (and its keeper starts in Herdr even without a connection here, for
// them alone), and take them off as the session closes; a SessionEnd hook takes them off in the background.
//
// Which terminal (0.18.0): in a Herdr pane every report also says where the session runs, `"terminal": { "app":
// "herdr", "paneId": "w2:p1", "server": "<16 hex>" }` (herdr.ts's herdrTerminal), and Pending You lists it with the
// agent's sessions running now. Anywhere else the report is as before, with no `terminal` at all (Pending You keeps
// what it had). A Pending You from before it refuses the field (400): the same report goes again without it.
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { postJson, SignInNeeded } from './api.ts'
import { reportThreads, threadNames } from './apps/codex-wake.ts'
import type { AppId } from './apps/ids.ts'
import { DEFAULT_ORIGIN } from './args.ts'
import { readCredential } from './credentials.ts'
import { configDir, readJson, withLock, writeWhole } from './files.ts'
import { herdrTarget, herdrTerminal, reportCommand } from './herdr.ts'
import type { Io } from './io.ts'
import { endPrompts, sessionName } from './permission.ts'

type Json = Record<string, unknown>

export const PRESENCE_PATH = '/mcp/cli/presence'
/** How often an open session says it's live: well inside the 15 minutes Pending You counts one live. */
export const PRESENCE_EVERY_MS = 5 * 60_000
/** How soon the next-message hook says live again (Claude Code without the wake mod). */
export const LIVE_AGAIN_MS = 4 * 60_000
/** How long one send may take, at most. */
export const SEND_MS = 3000
/** A keeper's lease untouched this long belongs to one that died. */
const LEASE_STALE_MS = 3 * 60_000
/** The longest one sleep of a keeper, so its lease stays fresh. */
const NAP_MS = 60_000
/** How long a keeper runs at most; the next session start or message starts another. */
const KEEP_MAX_MS = 7 * 24 * 60 * 60_000
/** A "live" this soon after a "closed" for the same session (a reload) waits a little, so it arrives last. */
const REOPEN_MS = 5000
const REOPEN_PAUSE_MS = 1500
/** A session's record untouched this long is forgotten. */
const FORGET_MS = 2 * 24 * 60 * 60_000
/** A session's id, as the apps give it: also part of a lease's file name. */
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/
/** How far up its ancestors a Codex hook looks for the Codex process it runs under. */
const ANCESTORS = 6

export type PresenceState = 'live' | 'closed'

/** What `pendingyou presence` was asked: the hook form reads stdin (no `state`); the others are given it all. */
export interface PresenceCommand {
  origin: string
  app: AppId
  state?: PresenceState
  session?: string
  cwd?: string
  name?: string
  transcript?: string
  /** Codex: keep saying live while `pid` runs (the keeper). */
  keep?: boolean
  pid?: number
  /** When the event happened (ms): an older event never overrides a newer one. */
  at?: number
}

/** The folder as presence carries it: under ~ (`~/work/app`), or null for anywhere else. */
export function presenceCwd(cwd: string | null | undefined, home: string): string | null {
  if (!cwd) return null
  const base = home.replace(/\/+$/, '')
  if (!base) return null
  if (cwd === base) return '~'
  if (cwd.startsWith(`${base}/`)) {
    const shown = `~${cwd.slice(base.length)}`
    return shown.length <= CWD_MAX ? shown : null
  }
  return null
}

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null)

/** The name the session goes by with Pending You: given, else from its transcript (Claude Code), else its hooks'. */
async function nameFor(io: Io, command: PresenceCommand): Promise<string | null> {
  const given = presenceName(command.name)
  if (given) return given
  if (command.app === 'claude-code') return (await sessionName(command.transcript)) ?? null
  if (!command.session) return null
  const names = await threadNames(io, command.app, command.session).catch(() => [])
  return presenceName(names.at(-1))
}

/**
 * What a send came to (product-contract.md §6m): `sent` (204); `absent` (404: a server from before presence, or this
 * sign-in was removed); `refused` (400 `invalid`, 403 `not_a_connection`, a 401 that a refresh didn't cure: nothing
 * sent again will do better); `skipped` (no connection of the app's own here); `failed` (unreachable, 5xx, or still
 * rate limited after waiting its retry-after once).
 */
export type PresenceOutcome = 'sent' | 'absent' | 'refused' | 'skipped' | 'failed'

/** The longest a send waits on a 429's retry-after (Pending You says 60) before trying once more. */
const RETRY_AFTER_MAX_S = 120
/** The most of the name and the folder Pending You keeps (§6m: a name kept to 60, a folder at most 300). */
export const NAME_MAX = 60
export const CWD_MAX = 300

/** The name as Pending You keeps it: one line, trimmed, at most NAME_MAX characters; null when nothing's left. */
export function presenceName(name: string | null | undefined): string | null {
  const plain = (name ?? '').replace(/\s+/g, ' ').trim()
  if (!plain) return null
  return [...plain].slice(0, NAME_MAX).join('').trim() || null
}

/**
 * Sends one presence, quietly: a 401 is tried once more after a refresh in the background, a 429 once more after its
 * retry-after (when `patient`: a background send, never a hook). In a Herdr pane it says which (0.18.0), and a 400 is
 * tried once more without it: a Pending You from before `terminal` refuses what it doesn't know. Never throws; each
 * try gives up after `timeoutMs`.
 */
export async function sendPresence(
  io: Io,
  origin: string,
  presence: {
    app: AppId
    session: string
    state: PresenceState
    cwd: string | null
    name: string | null
  },
  timeoutMs = SEND_MS,
  options: { patient?: boolean } = {},
): Promise<PresenceOutcome> {
  try {
    if ((await readCredential(io, origin, presence.app))?.kind !== 'connection') return 'skipped'
    const plain = {
      source: presence.app,
      name: presenceName(presence.name),
      sessionId: presence.session,
      cwd: presence.cwd && presence.cwd.length <= CWD_MAX ? presence.cwd : null,
      state: presence.state,
    }
    // Where it runs, only when that's a Herdr pane: anywhere else the report says nothing of it.
    const terminal = herdrTerminal(io.env, io.host)
    let body: Json = terminal ? { ...plain, terminal } : plain
    const send = (force: boolean) =>
      postJson(io, origin, PRESENCE_PATH, body, timeoutMs, {
        app: presence.app,
        signal: AbortSignal.timeout(timeoutMs + 2000),
        force,
      })
    let answer = await send(false)
    if (answer.status === 401) answer = await send(true)
    if (answer.status === 400 && terminal) {
      body = plain
      answer = await send(false)
    }
    if (answer.status === 429 && options.patient) {
      await io.sleep(Math.min(answer.retryAfter ?? 60, RETRY_AFTER_MAX_S) * 1000, io.signal)
      answer = await send(false)
    }
    const { status } = answer
    if (status >= 200 && status < 300) return 'sent'
    if (status === 404) return 'absent'
    if (status === 400 || status === 401 || status === 403) return 'refused'
    return 'failed'
  } catch (error) {
    return error instanceof SignInNeeded ? 'skipped' : 'failed'
  }
}

/** What this computer last said, or was asked to say, for each session of an app: `<config>/presence/<app>.json`. */
export interface Said {
  state: PresenceState
  at: number
  /**
   * When this computer first heard of the session (0.23.0), when Claude Code's wake mod last said it's live (`mod`: it
   * runs in the session, as only the mod sends one with no transcript), and the folder (`~/…`) and name it last gave.
   * A record from before 0.23.0 has none of them.
   */
  since?: number
  mod?: number
  cwd?: string
  name?: string
}
const recordPath = (io: Pick<Io, 'env' | 'home'>, app: AppId) =>
  join(configDir(io), 'presence', `${app}.json`)
const leasePath = (io: Pick<Io, 'env' | 'home'>, app: AppId, session: string) =>
  join(configDir(io), 'presence', `${app}-${session}.lease`)

const numberOr = (value: unknown) => (typeof value === 'number' ? value : undefined)

/** What this computer last heard of each of an app's sessions (presence/<app>.json), by session id. */
export async function readSaid(
  io: Pick<Io, 'env' | 'home'>,
  app: AppId,
): Promise<Record<string, Said>> {
  const file = await readJson<{ sessions?: unknown }>(recordPath(io, app)).catch(() => null)
  const sessions: Record<string, Said> = {}
  if (isObject(file?.sessions))
    for (const [id, value] of Object.entries(file.sessions))
      if (
        isObject(value) &&
        (value.state === 'live' || value.state === 'closed') &&
        typeof value.at === 'number'
      ) {
        const since = numberOr(value.since)
        const mod = numberOr(value.mod)
        const cwd = text(value.cwd)
        const name = text(value.name)
        sessions[id] = {
          state: value.state,
          at: value.at,
          ...(since !== undefined ? { since } : {}),
          ...(mod !== undefined ? { mod } : {}),
          ...(cwd ? { cwd } : {}),
          ...(name ? { name } : {}),
        }
      }
  return sessions
}

/**
 * Writes down an event for a session unless a newer one is there already: what it was before, or `newer` when this
 * one came too late to count.
 */
async function noteSaid(
  io: Io,
  app: AppId,
  session: string,
  said: Said,
): Promise<{ newer: boolean; before: Said | null }> {
  const path = recordPath(io, app)
  return withLock(path, io, async () => {
    const sessions = await readSaid(io, app)
    const before = sessions[session] ?? null
    if (before && before.at > said.at) return { newer: true, before }
    // What it said before stays unless this says otherwise: when it was first heard of, the mod, its folder and name.
    sessions[session] = {
      ...before,
      ...said,
      // One heard of before 0.23.0 noted no `since`: 0, long enough ago.
      since: before ? Math.min(before.since ?? 0, said.at) : said.at,
      ...(said.mod !== undefined || before?.mod !== undefined
        ? { mod: Math.max(said.mod ?? 0, before?.mod ?? 0) }
        : {}),
    }
    const now = io.now()
    for (const [id, each] of Object.entries(sessions))
      if (now - each.at > FORGET_MS) delete sessions[id]
    await writeWhole(path, `${JSON.stringify({ version: 1, sessions }, null, 2)}\n`, {
      secret: true,
    })
    return { newer: false, before }
  })
}

/** Sends one presence for the command, in the order the events happened. */
async function sendOnce(
  io: Io,
  command: PresenceCommand & { state: PresenceState; session: string },
): Promise<PresenceOutcome | null> {
  const at = command.at ?? io.now()
  const cwd = presenceCwd(command.cwd, io.home)
  const name = await nameFor(io, command)
  // Claude Code's wake mod says live with no transcript; its hooks always give theirs (0.23.0).
  const mod = command.app === 'claude-code' && command.state === 'live' && !command.transcript
  const noted = await noteSaid(io, command.app, command.session, {
    state: command.state,
    at,
    ...(mod ? { mod: at } : {}),
    ...(cwd ? { cwd } : {}),
    ...(name ? { name } : {}),
  })
  if (noted.newer) return null
  // A reload: the closing session's "closed" went just before; this "live" goes after it.
  if (
    command.state === 'live' &&
    noted.before?.state === 'closed' &&
    at - noted.before.at < REOPEN_MS
  )
    await io.sleep(REOPEN_PAUSE_MS, io.signal)
  return sendPresence(
    io,
    command.origin,
    {
      app: command.app,
      session: command.session,
      state: command.state,
      cwd,
      name,
    },
    SEND_MS,
    // A send runs in a process of its own, never a hook's: it may wait out a 429's retry-after.
    { patient: true },
  )
}

/** Outcomes after which a keeper stops: the sign-in can't say presence (refused, removed, or none here). */
const GIVE_UP: ReadonlySet<PresenceOutcome> = new Set(['refused', 'absent', 'skipped'])

/** The arguments of a background `presence` that sends one, or (Codex) keeps saying live. */
export function presenceArgs(
  origin: string,
  app: AppId,
  fields: {
    state: PresenceState
    session: string
    cwd?: string | null
    name?: string | null
    transcript?: string | null
    keep?: boolean
    pid?: number | null
    at?: number
  },
): string[] {
  return [
    'presence',
    '--app',
    app,
    '--state',
    fields.state,
    '--session',
    fields.session,
    ...(fields.cwd ? ['--cwd', fields.cwd] : []),
    ...(fields.name ? ['--name', fields.name] : []),
    ...(fields.transcript ? ['--transcript', fields.transcript] : []),
    ...(fields.keep ? ['--keep'] : []),
    ...(fields.pid ? ['--pid', String(fields.pid)] : []),
    ...(fields.at ? ['--at', String(fields.at)] : []),
    ...(origin === DEFAULT_ORIGIN ? [] : ['--origin', origin]),
  ]
}

/** Whether this app's sign-in here is its own connection: only that says presence. */
const connected = async (io: Io, origin: string, app: AppId) =>
  (await readCredential(io, origin, app).catch(() => null))?.kind === 'connection'

/**
 * A hook's presence, started in the background so the hook never waits on it: a session start's or a session end's,
 * or (`again`) a message's, which says live only when the last one is LIVE_AGAIN_MS old. Never throws.
 */
export async function announce(
  io: Io,
  origin: string,
  app: AppId,
  fields: {
    state: PresenceState
    session: string | null
    cwd?: string | null
    transcript?: string | null
    again?: boolean
  },
): Promise<void> {
  try {
    const { session } = fields
    if (!session || !SESSION.test(session) || io.platform === 'win32') return
    if (!(await connected(io, origin, app))) return
    if (fields.again) {
      const last = (await readSaid(io, app))[session]
      if (last?.state === 'live' && io.now() - last.at < LIVE_AGAIN_MS) return
    }
    io.background(
      presenceArgs(origin, app, {
        state: fields.state,
        session,
        ...(fields.cwd ? { cwd: fields.cwd } : {}),
        ...(fields.transcript ? { transcript: fields.transcript } : {}),
        at: io.now(),
      }),
    )
  } catch {}
}

/** One process as `ps` says it: its parent and its program. */
async function processOf(io: Io, pid: number): Promise<{ ppid: number; command: string } | null> {
  const result = await io.run('ps', ['-o', 'ppid=', '-o', 'comm=', '-p', String(pid)], 2000)
  if (result.code !== 0) return null
  const match = /^\s*(\d+)\s+(.+?)\s*$/m.exec(result.stdout)
  return match ? { ppid: Number(match[1]), command: match[2] as string } : null
}

/** Whether a program is a codex (Codex CLI's, or the Codex app's own): its file's name. */
const isCodex = (command: string) => /^codex/i.test(command.split('/').at(-1) ?? '')

/** The Codex process a hook runs under (Codex runs hooks through sh): the nearest codex among its ancestors. */
export async function codexProcess(io: Io): Promise<number | null> {
  let pid = io.ppid
  for (let step = 0; step < ANCESTORS && pid && pid > 1; step++) {
    const found = await processOf(io, pid)
    if (!found) return null
    if (isCodex(found.command)) return pid
    pid = found.ppid
  }
  return null
}

/** Whether that Codex process still runs. */
async function stillRuns(io: Io, pid: number): Promise<boolean> {
  const result = await io.run('ps', ['-o', 'comm=', '-p', String(pid)], 2000)
  return result.code === 0 && isCodex(result.stdout.trim())
}

/** Whether a keeper holds the session now: its lease, touched within LEASE_STALE_MS. */
async function keeping(io: Pick<Io, 'env' | 'home'>, app: AppId, session: string) {
  return stat(leasePath(io, app, session)).then(
    (info) => Date.now() - info.mtimeMs < LEASE_STALE_MS,
    () => false,
  )
}

/**
 * Codex's session start and next message: makes sure the thread has a keeper, which says live now and every 5 minutes
 * while the Codex process the hook runs under is running. One that can't find it says live once. Quick and quiet. In a
 * Herdr pane (0.17.0) the keeper also keeps the pane's badges, so it starts there even without a connection here.
 */
export async function keepPresent(
  io: Io,
  origin: string,
  session: string | null,
  cwd: string | null,
): Promise<void> {
  try {
    if (!session || !SESSION.test(session) || io.platform === 'win32') return
    if (!(await connected(io, origin, 'codex')) && !(await herdrTarget(io))) return
    if (await keeping(io, 'codex', session)) return
    const pid = await codexProcess(io)
    if (!pid) {
      await announce(io, origin, 'codex', { state: 'live', session, cwd, again: true })
      return
    }
    io.background(
      presenceArgs(origin, 'codex', { state: 'live', session, cwd, keep: true, pid, at: io.now() }),
    )
  } catch {}
}

/** Takes a session's lease for this keeper: its id, or null when a live keeper holds it. */
async function takeLease(io: Io, app: AppId, session: string): Promise<string | null> {
  const path = leasePath(io, app, session)
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  if (await keeping(io, app, session)) return null
  const id = randomBytes(8).toString('hex')
  await rm(path, { force: true })
  try {
    await writeFile(path, id, { flag: 'wx', mode: 0o600 })
    return id
  } catch {
    return null
  }
}

/** Renews the lease while it's this keeper's: `held`; `gone` once the session ended (it was let go); `taken` by another. */
async function renew(
  io: Io,
  app: AppId,
  session: string,
  id: string,
): Promise<'held' | 'gone' | 'taken'> {
  const path = leasePath(io, app, session)
  const holder = await readFile(path, 'utf8').catch(() => null)
  if (holder === null) return 'gone'
  if (holder !== id) return 'taken'
  const now = new Date()
  await utimes(path, now, now).catch(() => {})
  return 'held'
}

/** Lets a session's keeper go (its session ended): it stops at its next look. */
async function release(io: Io, app: AppId, session: string): Promise<void> {
  await rm(leasePath(io, app, session), { force: true }).catch(() => {})
}

/**
 * `presence --keep` (Codex): says live now and every PRESENCE_EVERY_MS while the Codex process runs, then closed once
 * it's gone. Stops quietly when the session ended (its SessionEnd hook took the lease away), or after KEEP_MAX_MS. In a
 * Herdr pane (0.17.0) it writes the pane's badges with each live, keeps on for them when Pending You won't take its
 * presence, and takes them off as it stops (unless another keeper took the thread over).
 */
async function keep(io: Io, command: PresenceCommand & { session: string; pid: number }) {
  const { app, session, pid } = command
  const lease = await takeLease(io, app, session)
  if (!lease) return
  const started = io.now()
  const badges = (await herdrTarget(io)) !== null
  let speaking = true
  let taken = false
  try {
    let next = 0
    while (!io.signal.aborted && io.now() - started < KEEP_MAX_MS) {
      const held = await renew(io, app, session, lease)
      if (held !== 'held') {
        taken = held === 'taken'
        return
      }
      if (!(await stillRuns(io, pid))) {
        if (speaking) await sendOnce(io, { ...command, state: 'closed', at: io.now() })
        return
      }
      if (io.now() >= next) {
        if (speaking) {
          const outcome = await sendOnce(io, { ...command, state: 'live', at: io.now() })
          // Nothing this sign-in sends will be taken (an older server, a removed sign-in, a refusal): stop trying.
          if (outcome && GIVE_UP.has(outcome)) speaking = false
        }
        if (badges) await reportThreads(io, app, { session, at: io.now() })
        if (!speaking && !badges) return
        next = io.now() + PRESENCE_EVERY_MS
      }
      await io.sleep(Math.max(0, Math.min(NAP_MS, next - io.now())), io.signal)
    }
  } finally {
    if (badges && !taken) await reportThreads(io, app, { session, closed: true, at: io.now() })
    if ((await readFile(leasePath(io, app, session), 'utf8').catch(() => null)) === lease)
      await release(io, app, session)
  }
}

/**
 * The hook form (no `--state`): Claude Code's and Codex's SessionEnd hook, `presence --app <app>`, reads the hook's
 * input. A session end says closed (in the background), withdraws a permission card still up for the session
 * (permission.ts), and lets Codex's keeper go; a session start (should a hook run it there) says live. Prints nothing.
 */
async function presenceHook(io: Io, origin: string, app: AppId): Promise<void> {
  const input: unknown = JSON.parse(await io.readStdin(500))
  if (!isObject(input)) return
  const session = text(input.session_id)
  if (!session || !SESSION.test(session)) return
  const cwd = text(input.cwd)
  const transcript = text(input.transcript_path)
  if (input.hook_event_name === 'SessionEnd') {
    await endPrompts(io, session)
    if (app === 'codex') await release(io, app, session)
    await announce(io, origin, app, { state: 'closed', session, cwd, transcript })
    // Its Herdr pane's badges come off (0.17.0), in the background: SessionEnd hooks share a second and a half.
    if (await herdrTarget(io))
      io.background(reportCommand(app, { session, closed: true, at: io.now() }))
  } else if (input.hook_event_name === 'SessionStart') {
    if (app === 'codex') await keepPresent(io, origin, session, cwd)
    else await announce(io, origin, app, { state: 'live', session, cwd, transcript })
  }
}

/** `pendingyou presence`: quiet, and exits 0 whatever happens. */
export async function presence(io: Io, command: PresenceCommand): Promise<number> {
  try {
    if (!command.state) {
      await presenceHook(io, command.origin, command.app)
      return 0
    }
    const { session } = command
    if (!session || !SESSION.test(session)) return 0
    if (command.keep && command.pid && command.app === 'codex' && command.state === 'live') {
      await keep(io, { ...command, session, pid: command.pid })
      return 0
    }
    // Herdr's badges (0.17.0): OpenCode's and Pi's sessions in this pane, with each live and as one closes. Claude
    // Code's wake mod writes its own.
    if (command.app !== 'claude-code')
      await reportThreads(io, command.app, {
        session,
        closed: command.state === 'closed',
        at: command.at ?? io.now(),
      })
    await sendOnce(io, { ...command, state: command.state, session })
  } catch {}
  return 0
}

/** What uninstall takes away for an app: its presence record and its keepers' leases (they stop at their next look). */
export async function removePresenceFiles(io: Pick<Io, 'env' | 'home'>, app: AppId): Promise<void> {
  const folder = join(configDir(io), 'presence')
  const names = await readdir(folder).catch(() => [] as string[])
  for (const name of names)
    if (name === `${app}.json` || (name.startsWith(`${app}-`) && name.endsWith('.lease')))
      await rm(join(folder, name), { force: true }).catch(() => {})
  await rmdir(folder).catch(() => {})
}
