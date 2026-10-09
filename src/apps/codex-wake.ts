// Codex hearing answers (0.11.0), and OpenCode and Pi the same way (0.12.0): what an app's hooks remember about the
// cards a thread (OpenCode, Pi: a session) posted, and the listener that wakes the thread when one is answered.
//
// - `pendingyou posted --app codex` is Codex's PostToolUse hook for Pending You's card tools (post_request,
//   update_request, reply_in_thread, cancel_request; Codex runs it only for a call that didn't fail). It records that
//   the turn put something in front of the person (with the card's words, for the Stop check: stopcheck.ts), and which
//   thread is waiting on which card (`session_id` is the thread's id), then makes sure that thread has a listener.
//   OpenCode's plugin runs it from `tool.execute.after` (apps/opencode-plugin.ts), and Pi's extension from Pi's
//   `tool_result` (apps/pi-extension.ts), with the same fields.
// - `pendingyou listen --app codex --thread <id>` is that listener: one per thread (a lease file), detached, holding no
//   hook's output (Codex would wait for it otherwise). It long-polls Pending You with the app's own connection, as
//   `watch` does, and when one of the thread's cards is the agent's move (an answer, a message, a fallback that ran) it
//   runs `codex queue --thread <id> --message "Pending You: your person answered …"`, in the words the Claude Code wake
//   mod uses. Never the answer itself: a program's arguments are there for any other program on the computer to read,
//   so the agent reads the answer with get_request, as the message says. Codex starts a turn at once when the thread is
//   loaded and idle, after the current one when it's working, or when it's next resumed. It stops when the thread has
//   no card left waiting, or after 8 hours; the next session start or message starts it again while one is (pickup.ts).
// - OpenCode's listener is the plugin's child, not detached, since only the plugin can start a turn
//   (client.session.promptAsync): it writes each wake as one JSON line on stdout, `{"wake": "<the words>",
//   "requests": ["req_…"]}`, and the plugin answers on its stdin, `{"delivered": true}` once the turn is started (or
//   false). Only then is it marked handed over. It stops when its stdin closes (OpenCode went), as well as when Codex's
//   would. Pi's listener is its extension's child in just the same way (`pi.sendMessage` starts the turn).
//
// Since 0.14.0 a session is also woken for a question the person hands it from another assistant (D21, Delegate), not
// only for the cards it posted: handed.ts says which session hears one. So the hooks remember each session's names and
// folder too, and a session that used Pending You's card tools keeps listening for 12 hours after (HANDED_FOR_MS), as
// long as Pending You offers its task as running, with no card of its own waiting. OpenCode's and Pi's listener (one per
// session) takes a handed question when it's for its own session; Codex's are one listener's for the whole app
// (`listen --app codex --handed`), which `codex queue`s each into the thread it's for. `answer_delegated` and
// `hand_back` count as the turn's card calls (for the Stop check), and never make a card the session's own.
//
// Since 0.17.0 a thread also remembers the Herdr pane it runs in, while it's open there, and how pressing each of its
// cards is (urgency, blocking, asked in the conversation too): a pane's badges are the cards its sessions wait on
// (reportThreads, herdr.ts), written again by `posted`, the listener, Codex's keeper and OpenCode's and Pi's presence.
//
// Ids, names, folders, titles and pane ids only, in ~/.config/pendingyou/<app>-threads.json: never an answer or a note.

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getJson, SignInNeeded, Unavailable } from '../api.ts'
import { DEFAULT_ORIGIN } from '../args.ts'
import { connectionMachine, readCredential } from '../credentials.ts'
import { configDir, readJson, withLock, writeWhole } from '../files.ts'
import {
  APPROVED_DRAFT_NOTICE,
  approvesDraft,
  clip,
  delegatedOf,
  type Heard,
  handledOf,
  isClosed,
  noticeOf,
} from '../format.ts'
import {
  type Candidate,
  chooseThread,
  goesBy,
  HANDED_FOR_MS,
  type HandedCard,
  handedCard,
  handedMessage,
  namesAnotherComputer,
} from '../handed.ts'
import {
  clearHerdr,
  type HerdrOutcome,
  herdrTarget,
  isUrgency,
  PANE_ID,
  reportCommand,
  type Urgency,
  type WaitingCard,
  writeHerdr,
} from '../herdr.ts'
import type { Io } from '../io.ts'
import { linkSoon } from '../link.ts'
import { macName, tailscaleName } from '../remote.ts'
import { claimHanded, markHanded, momentOf, releaseHanded, wasHanded } from '../state.ts'
import { findCodex } from './codex-app.ts'
import { APP_IDS, type AppId } from './ids.ts'

type Json = Record<string, unknown>

/**
 * One card a thread is waiting on: who asked it (the agent's name), its title, when it was posted or changed, and
 * (0.17.0, for Herdr's badges) how pressing it is and whether it was asked in the conversation too.
 */
interface ThreadCard {
  name?: string
  title?: string
  at: number
  urgency?: Urgency
  blocking?: boolean
  askedFirst?: boolean
}

/** One Codex thread (or OpenCode or Pi session) the hooks know. */
interface Thread {
  origin: string
  /** Its cards still in front of the person, by request id. */
  cards: Record<string, ThreadCard>
  /** When it last used Pending You's card tools, or (0.14.0) heard from the person. */
  at: number
  /** The names it went by on Pending You's card tools, newest last (0.14.0): a question handed to one is its. */
  names?: string[]
  /** Its folder, as its hooks gave it (0.14.0). */
  cwd?: string
  /** The Herdr pane it runs in (0.17.0, herdr.ts), while it's open there: its cards are that pane's badges. */
  herdr?: string
}

/** What an app's hooks remember (codex-threads.json, opencode-threads.json, pi-threads.json). */
interface ThreadState {
  version: 1
  /**
   * Each thread with cards still in front of the person, or (0.14.0) that used the card tools in the last
   * HANDED_FOR_MS, by thread id.
   */
  threads: Record<string, Thread>
  /** Each turn that posted, changed or replied on a card, by turn id: the words of each (the Stop check's). */
  turns: Record<string, { at: number; cards: string[]; nudged?: boolean; delegated?: boolean }>
}

/** How long a turn's record, and a thread untouched, are kept. */
const KEEP_TURN_MS = 24 * 60 * 60_000
const KEEP_THREAD_MS = 7 * 24 * 60 * 60_000
/** The most of one card's words a turn keeps, to match an ask against (stopcheck.ts). */
const CARD_WORDS = 20_000
/** How long a listener waits on one thread, at most, and how often it renews its lease. */
export const LISTEN_MS = 8 * 60 * 60_000
const LONG_POLL_SECONDS = 25
/** A lease untouched for this long belongs to a listener that died. */
const LEASE_STALE_MS = 90_000
const PATIENT_AFTER_MS = 30 * 60_000
const PATIENT_PAUSE_MS = 30_000
const BACKOFF_MS = [2000, 5000, 10_000, 20_000, 30_000, 60_000]
/** How long OpenCode's listener waits for the plugin to say whether it started the turn. */
const REPLY_MS = 60_000
const REQUEST_ID = /^req_[A-Za-z0-9-]{1,40}$/
/** A thread's id: Codex's (a UUID) or an OpenCode session's (`ses_…`). */
export const THREAD = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/
/** The lease of Codex's one listener for handed questions (0.14.0): no thread's id starts with `_`. */
const HANDED = '_handed'
/** The most names a thread remembers. */
const NAMES = 5
/**
 * Pending You's card tools as Codex and Pi name them: `mcp__pendingyou__post_request`. Since 0.14.0 also the two that
 * answer a question handed to the session (D21), which Pi's extension reports; Codex's hook is trusted by its exact
 * matcher (codex.ts), which names only the four.
 */
const MCP_CARD_TOOL =
  /^mcp__([A-Za-z0-9_]*pendingyou[A-Za-z0-9_]*)__(post_request|update_request|reply_in_thread|cancel_request|answer_delegated|hand_back)$/i
/**
 * The card calls the hook reads, on a Pending You server: Codex and Pi name a tool `mcp__pendingyou__post_request`,
 * OpenCode `pendingyou_post_request` (the server's name, `_`, the tool's).
 */
const CARD_TOOLS: Partial<Record<AppId, RegExp>> = {
  codex: MCP_CARD_TOOL,
  opencode:
    /^([A-Za-z0-9_-]*pendingyou[A-Za-z0-9_-]*)_(post_request|update_request|reply_in_thread|cancel_request|answer_delegated|hand_back)$/i,
  pi: MCP_CARD_TOOL,
}
/** The calls that answer a question handed to the session (D21): never a card of its own. */
const HELPER_CALLS = new Set(['answer_delegated', 'hand_back'])

/** The card tool a call was, for an app whose hooks read them; null for any other tool. */
export function cardTool(app: AppId, name: unknown): string | null {
  const pattern = CARD_TOOLS[app]
  return pattern && typeof name === 'string' ? (pattern.exec(name)?.[2] ?? null) : null
}

const statePath = (io: Pick<Io, 'env' | 'home'>, app: AppId) =>
  join(configDir(io), `${app}-threads.json`)
const leasePath = (io: Pick<Io, 'env' | 'home'>, app: AppId, thread: string) =>
  join(configDir(io), `${app}-listen`, `${thread}.lease`)

/** What uninstall takes away for an app: its threads' record and its listeners' leases. */
export const threadFiles = (io: Pick<Io, 'env' | 'home'>, app: AppId) => [
  statePath(io, app),
  join(configDir(io), `${app}-listen`),
]

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A thread as the file holds it, or null when it doesn't read as one. */
function threadOf(value: unknown): Thread | null {
  if (!isObject(value) || typeof value.at !== 'number' || !Number.isFinite(value.at)) return null
  const names = Array.isArray(value.names)
    ? value.names.filter((name): name is string => typeof name === 'string' && name.trim() !== '')
    : []
  return {
    origin: typeof value.origin === 'string' ? value.origin : DEFAULT_ORIGIN,
    cards: isObject(value.cards) ? (value.cards as Thread['cards']) : {},
    at: value.at,
    ...(names.length ? { names: names.slice(-NAMES) } : {}),
    ...(typeof value.cwd === 'string' && value.cwd ? { cwd: value.cwd } : {}),
    ...(typeof value.herdr === 'string' && PANE_ID.test(value.herdr) ? { herdr: value.herdr } : {}),
  }
}

async function load(io: Pick<Io, 'env' | 'home'>, app: AppId): Promise<ThreadState> {
  const file = await readJson<Partial<ThreadState>>(statePath(io, app)).catch(() => null)
  const threads: ThreadState['threads'] = {}
  if (isObject(file?.threads))
    for (const [id, value] of Object.entries(file.threads)) {
      const thread = threadOf(value)
      if (thread) threads[id] = thread
    }
  return {
    version: 1,
    threads,
    turns: isObject(file?.turns) ? (file.turns as ThreadState['turns']) : {},
  }
}

/**
 * Whether a thread with no card waiting may still be handed a question (0.14.0): it went by a name on the card tools
 * within HANDED_FOR_MS, while Pending You offers its task to the person.
 */
const mayBeHanded = (thread: Thread, now: number) =>
  Boolean(thread.names?.length) && now - thread.at < HANDED_FOR_MS

/** Whether a thread is worth a listener: cards waiting, or a question that may be handed to it. */
const listenable = (thread: Thread | undefined, now: number) =>
  thread !== undefined && (Object.keys(thread.cards).length > 0 || mayBeHanded(thread, now))

/** Changes the state under its lock, dropping what's old. */
async function change(
  io: Pick<Io, 'env' | 'home' | 'now' | 'sleep'>,
  app: AppId,
  edit: (state: ThreadState) => void,
): Promise<ThreadState> {
  const path = statePath(io, app)
  return withLock(path, io, async () => {
    const state = await load(io, app)
    edit(state)
    const now = io.now()
    for (const [id, turn] of Object.entries(state.turns))
      if (!(now - turn.at < KEEP_TURN_MS)) delete state.turns[id]
    for (const [id, thread] of Object.entries(state.threads))
      if (!(now - thread.at < KEEP_THREAD_MS) || !listenable(thread, now)) delete state.threads[id]
    await writeWhole(path, `${JSON.stringify(state, null, 2)}\n`, { secret: true })
    return state
  })
}

/** A tool's answer as Codex hands it to PostToolUse (a CallToolResult): its JSON object, or null. */
export function resultOf(response: unknown): Json | null {
  if (!isObject(response) || response.isError === true) return null
  if (isObject(response.structuredContent)) return response.structuredContent
  const blocks = Array.isArray(response.content) ? response.content : []
  for (const block of blocks) {
    if (!isObject(block) || typeof block.text !== 'string') continue
    try {
      const parsed: unknown = JSON.parse(block.text)
      if (isObject(parsed)) return parsed
    } catch {}
  }
  return null
}

/** Every string a call carried (a card's title, summary, steps…), up to `max` characters: what a card says. */
export function wordsIn(value: unknown, max = CARD_WORDS): string {
  const found: string[] = []
  let left = max
  const walk = (item: unknown, depth: number) => {
    if (left <= 0 || depth > 8) return
    if (typeof item === 'string') {
      found.push(item.slice(0, left))
      left -= item.length
    } else if (Array.isArray(item)) for (const each of item) walk(each, depth + 1)
    else if (isObject(item)) for (const each of Object.values(item)) walk(each, depth + 1)
  }
  walk(value, 0)
  return found.join('\n')
}

const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined

/** The agent's name on a call: `name`, or post_request's `session.label`. */
function nameOf(input: Json): string | undefined {
  const session = isObject(input.session) ? input.session : null
  return text(input.name, 120) ?? text(session?.label, 120)
}

/** The thread with this name last among its names (newest last, at most NAMES, one of each). */
function withName(thread: Thread, name: string | undefined): Thread {
  if (!name) return thread
  const names = (thread.names ?? []).filter((each) => !goesBy([each], name))
  return { ...thread, names: [...names, name].slice(-NAMES) }
}

/**
 * `pendingyou posted --app <app>`: Codex's PostToolUse hook, and what OpenCode's plugin runs after a card call.
 * Remembers what the turn put in front of the person and which cards the thread waits on, then (Codex) makes sure the
 * thread has a listener; OpenCode's plugin starts its own. Since 0.14.0 also the names it goes by and its folder, for a
 * question the person may hand it; `answer_delegated` and `hand_back` count for the turn, and the card stays the
 * asker's. Since 0.17.0, in a Herdr pane, the thread is that pane's and its card's urgency is kept, and the pane's
 * badges are written again in the background (herdr.ts). Prints nothing (Codex ignores it anyway); never fails.
 */
export async function posted(io: Io, options: { origin: string; app: AppId }): Promise<number> {
  const { app } = options
  try {
    const input = JSON.parse(await io.readStdin(1000)) as Json
    if (!isObject(input)) return 0
    const call = cardTool(app, input.tool_name)
    const thread = typeof input.session_id === 'string' ? input.session_id : null
    const turn = typeof input.turn_id === 'string' ? input.turn_id : null
    if (!call || !thread) return 0
    const args = isObject(input.tool_input) ? input.tool_input : {}
    const output = resultOf(input.tool_response)
    const requestId = [output?.requestId, args.requestId].find(
      (id): id is string => typeof id === 'string' && REQUEST_ID.test(id),
    )
    const cwd = text(input.cwd, 1000)
    const now = io.now()
    const pane = await herdrTarget(io)
    await change(io, app, (state) => {
      if (turn && call !== 'cancel_request') {
        const record = state.turns[turn] ?? { at: now, cards: [] }
        record.cards = [...record.cards, wordsIn(args)].slice(-10)
        record.at = now
        state.turns[turn] = record
      }
      const waiting = withName(
        state.threads[thread] ?? { origin: options.origin, cards: {}, at: now },
        nameOf(args),
      )
      // A question handed to it (D21) is the asker's card: the helper never waits on it.
      if (requestId && !HELPER_CALLS.has(call)) {
        const reopen = isObject(args.reopen) ? args.reopen : null
        if (call === 'cancel_request') delete waiting.cards[requestId]
        // A reply that leaves it the agent's turn (an answer to their message) isn't waiting on them.
        else if (call !== 'reply_in_thread' || reopen || output?.turn === 'you') {
          const before = waiting.cards[requestId]
          const name = nameOf(args) ?? before?.name
          const title = text(args.title, 400) ?? text(reopen?.title, 400) ?? before?.title
          // How pressing it is (0.17.0): as posted, or as an update changed it.
          const urgency = isUrgency(args.urgency) ? args.urgency : before?.urgency
          const blocking = typeof args.blocking === 'boolean' ? args.blocking : before?.blocking
          const askedFirst = call === 'post_request' ? askedIn(args) : before?.askedFirst
          waiting.cards[requestId] = {
            ...(name ? { name } : {}),
            ...(title ? { title } : {}),
            at: now,
            ...(urgency ? { urgency } : {}),
            ...(blocking ? { blocking } : {}),
            ...(askedFirst ? { askedFirst } : {}),
          }
        }
      }
      if (cwd) waiting.cwd = cwd
      if (pane) waiting.herdr = pane.pane
      waiting.origin = options.origin
      waiting.at = now
      state.threads[thread] = waiting
    })
    // The pane's badges, in the background: Codex waits for this hook, and nothing here waits on Herdr.
    if (pane) io.background(reportCommand(app, { session: thread, at: now }))
    if (app === 'codex') await keepListening(io, options.origin, thread)
    return 0
  } catch {
    return 0
  }
}

/** Whether a post_request was also asked in the conversation (its askedFirst, an object or the same as JSON text). */
function askedIn(args: Json): boolean {
  let asked: unknown = args.askedFirst
  if (typeof asked === 'string')
    try {
      asked = JSON.parse(asked)
    } catch {
      return false
    }
  return isObject(asked)
}

/**
 * Herdr's badges for the app's sessions in this process's pane (0.17.0, herdr.ts): the cards each session marked as
 * running here waits on, under the newest one's name, written onto the pane. `session` marks that one as running here
 * (with `closed`, no longer); once none of the app's sessions is left here, the pane's badges come off. Several sessions
 * share a pane where one app runs more than one (OpenCode). Off outside Herdr. Never throws.
 */
export async function reportThreads(
  io: Io,
  app: AppId,
  options: { session?: string | null; closed?: boolean; at: number },
): Promise<HerdrOutcome> {
  try {
    const pane = await herdrTarget(io)
    if (!pane) return 'off'
    const session = options.session && THREAD.test(options.session) ? options.session : null
    let state = await load(io, app)
    const known = session ? state.threads[session] : undefined
    if (session && known) {
      const wanted = options.closed
        ? known.herdr === pane.pane
          ? undefined
          : known.herdr
        : pane.pane
      if (wanted !== known.herdr)
        state = await change(io, app, (next) => {
          const thread = next.threads[session]
          if (!thread) return
          if (wanted) thread.herdr = wanted
          else delete thread.herdr
        })
    }
    const here = Object.values(state.threads).filter((thread) => thread.herdr === pane.pane)
    if (here.length === 0 && options.closed) return await clearHerdr(io, options.at, pane)
    const newest = [...here].sort((a, b) => b.at - a.at)[0]
    const cards: WaitingCard[] = here.flatMap((thread) =>
      Object.entries(thread.cards).map(([requestId, card]) => ({
        requestId,
        ...(typeof card.title === 'string' ? { title: card.title } : {}),
        ...(isUrgency(card.urgency) ? { urgency: card.urgency } : {}),
        ...(card.blocking === true ? { blocking: true } : {}),
        ...(card.askedFirst === true ? { askedFirst: true } : {}),
        at: typeof card.at === 'number' ? card.at : 0,
      })),
    )
    return await writeHerdr(
      io,
      { app, agent: newest?.names?.at(-1) ?? null, cards, at: options.at },
      pane,
    )
  } catch {
    return 'failed'
  }
}

/**
 * A session start or a message in a thread the hooks know (0.14.0): it's active now, in this folder. One the hooks
 * don't know (it never used the card tools) stays unknown. Never throws.
 */
export async function touchThread(
  io: Pick<Io, 'env' | 'home' | 'now' | 'sleep'>,
  app: AppId,
  thread: string,
  cwd: string | null,
): Promise<void> {
  try {
    if (!THREAD.test(thread) || !(await load(io, app)).threads[thread]) return
    const now = io.now()
    await change(io, app, (state) => {
      const known = state.threads[thread]
      if (!known) return
      known.at = now
      if (cwd) known.cwd = cwd
    })
  } catch {}
}

/** The names a thread went by on the card tools (0.14.0), newest last; none for a thread the hooks don't know. */
export async function threadNames(
  io: Pick<Io, 'env' | 'home'>,
  app: AppId,
  thread: string | null,
): Promise<string[]> {
  if (!thread) return []
  return (await load(io, app).catch(() => null))?.threads[thread]?.names ?? []
}

/**
 * The cards a thread (OpenCode, Pi: a session) still waits on, by request id, as its hooks remember them (0.25.0): its
 * own, whatever name it asked under. Not every card it ever posted (one is forgotten once its answer is heard), so
 * never all of them.
 */
export async function threadCards(
  io: Pick<Io, 'env' | 'home'>,
  app: AppId,
  thread: string | null,
): Promise<string[]> {
  if (!thread) return []
  const cards = (await load(io, app).catch(() => null))?.threads[thread]?.cards ?? {}
  return Object.keys(cards).filter((id) => REQUEST_ID.test(id))
}

/**
 * Remembers that a turn started with a question the person handed the session (0.14.0): its Stop check doesn't ask it
 * to post its words as a card of its own (stopcheck.ts).
 */
export async function markHandedTurn(
  io: Pick<Io, 'env' | 'home' | 'now' | 'sleep'>,
  turn: string,
  app: AppId,
): Promise<void> {
  const now = io.now()
  await change(io, app, (state) => {
    state.turns[turn] = { ...(state.turns[turn] ?? { cards: [] }), at: now, delegated: true }
  })
}

/**
 * The app's sessions on this computer that may hear a handed question: each the hooks know, with whether it can be
 * woken now. A Codex thread always can (`codex queue` keeps the message until it's opened); an OpenCode or Pi session
 * while its listener runs (the app is open).
 */
async function candidates(io: Pick<Io, 'env' | 'home' | 'now'>, app: AppId): Promise<Candidate[]> {
  const now = io.now()
  const found: Candidate[] = []
  for (const [thread, record] of Object.entries((await load(io, app)).threads)) {
    if (!listenable(record, now)) continue
    found.push({
      thread,
      names: record.names ?? [],
      ...(record.cwd ? { cwd: record.cwd } : {}),
      at: record.at,
      live: app === 'codex' || (await listening(io, app, thread)),
    })
  }
  return found
}

/**
 * Whether the app's sign-in here only hears (`--oauth`: no `kind`), so it hears every computer's questions, not only
 * this computer's connection's (handed.ts).
 */
export async function hearsOnly(io: Pick<Io, 'env' | 'home'>, origin: string, app: AppId) {
  const credential = await readCredential(io, origin, app).catch(() => null)
  return credential !== null && credential.kind !== 'connection'
}

/**
 * This computer's names, as a handed question's `machine` may give them (0.14.0): its hostname, the names its own
 * sign-ins by code were given (clients.json), a Mac's own name, and (`tailscale`; never in a hook, where it could take a
 * second) Tailscale's name for it.
 */
export async function computerNames(
  io: Pick<Io, 'env' | 'home' | 'host' | 'run'> & Partial<Pick<Io, 'platform'>>,
  origin: string,
  options: { tailscale: boolean },
): Promise<string[]> {
  const names = [io.host]
  for (const app of APP_IDS) {
    const machine = await connectionMachine(io, origin, app).catch(() => null)
    if (machine) names.push(machine)
  }
  const mac = await macName({ run: io.run, platform: io.platform ?? 'linux' }).catch(() => null)
  if (mac) names.push(mac)
  if (options.tailscale) {
    const tailscale = await tailscaleName(io).catch(() => null)
    if (tailscale) names.push(tailscale)
  }
  return names
}

/**
 * What a listener leaves as another computer's (0.14.0): with a sign-in that only hears, a handed question whose
 * `machine` names another computer than this one; with this computer's own connection, none (it hears only its own).
 */
export async function elsewhereFor(
  io: Io,
  origin: string,
  app: AppId,
): Promise<(heard: Pick<Heard, 'machine'>) => boolean> {
  if (!(await hearsOnly(io, origin, app))) return () => false
  const names = await computerNames(io, origin, { tailscale: true })
  return (heard) => namesAnotherComputer(heard.machine, names)
}

/**
 * The session a handed question is for (handed.ts), or null. Exported for the hooks (pickup.ts), which hand it to their
 * own session only when it is, or after HANDED_GRACE_MS.
 */
export async function sessionFor(
  io: Pick<Io, 'env' | 'home' | 'now'>,
  app: AppId,
  heard: Pick<Heard, 'sessionLabel' | 'cwd' | 'delegated'>,
): Promise<string | null> {
  return chooseThread(heard, await candidates(io, app), { home: io.home })
}

/**
 * Whether this turn put something in front of the person, the words of each card, whether it was nudged, and (0.14.0)
 * whether a question the person handed the session started it.
 */
export async function turnRecord(
  io: Pick<Io, 'env' | 'home'>,
  turn: string,
  app: AppId = 'codex',
): Promise<{ cards: string[]; nudged: boolean; delegated: boolean } | null> {
  const record = (await load(io, app)).turns[turn]
  return record
    ? {
        cards: Array.isArray(record.cards) ? record.cards : [],
        nudged: record.nudged === true,
        delegated: record.delegated === true,
      }
    : null
}

/** Remembers that the Stop check asked this turn to go on: at most once a turn. */
export async function markNudged(
  io: Pick<Io, 'env' | 'home' | 'now' | 'sleep'>,
  turn: string,
  app: AppId = 'codex',
): Promise<void> {
  const now = io.now()
  await change(io, app, (state) => {
    state.turns[turn] = { ...(state.turns[turn] ?? { cards: [] }), at: now, nudged: true }
  })
}

/** Whether a listener holds this thread now: its lease, touched within LEASE_STALE_MS. */
async function listening(
  io: Pick<Io, 'env' | 'home'>,
  app: AppId,
  thread: string,
): Promise<boolean> {
  return stat(leasePath(io, app, thread)).then(
    (info) => Date.now() - info.mtimeMs < LEASE_STALE_MS,
    () => false,
  )
}

/**
 * Makes sure a Codex thread with cards waiting on the person has a listener, and (0.14.0) that Codex's one listener
 * for handed questions runs while any thread may be handed one: starts each, detached, unless one is there or Codex
 * isn't signed in. Quick (a few small reads) and never throws: the session-start and next-message hooks call it too.
 */
export async function keepListening(io: Io, origin: string, thread: string): Promise<void> {
  try {
    if (!THREAD.test(thread)) return
    const { threads } = await load(io, 'codex')
    const now = io.now()
    const own = Object.keys(threads[thread]?.cards ?? {}).length > 0
    const handed = Object.values(threads).some((each) => mayBeHanded(each, now))
    if (!own && !handed) return
    if (!(await readCredential(io, origin, 'codex'))) return
    const at = origin === DEFAULT_ORIGIN ? [] : ['--origin', origin]
    if (own && !(await listening(io, 'codex', thread)))
      io.background(['listen', '--app', 'codex', '--thread', thread, ...at])
    if (handed && !(await listening(io, 'codex', HANDED)))
      io.background(['listen', '--app', 'codex', '--handed', ...at])
  } catch {}
}

/** What happened to a card and what to do, in the words the Claude Code wake mod uses (wake.ts's line). */
function line(heard: Heard, card: ThreadCard): [string, string] | null {
  const titled = `“${clip(card.title ?? heard.title, 80)
    .text.replaceAll('“', '‘')
    .replaceAll('”', '’')}” (${heard.requestId})`
  const named = card.name ?? heard.sessionLabel
  const get = `get_request (requestId ${heard.requestId}, ${named ? `name “${named}”` : 'your name'})`
  // A word on its card that's neither an answer nor the person's (0.16.0, guide 2.32).
  const notice = noticeOf(heard)
  const from = notice ? clip(notice.from, 60).text : ''
  if (notice?.kind === 'handed_over')
    return [
      `your person handed your open cards to ${from}, ${titled} among them`,
      `stop working on them: ${from} answers them and follows up; ack_answer ${heard.requestId} with its version to say you’ve stopped`,
    ]
  if (notice?.kind === 'came_back')
    return [
      `${titled} came back from ${from} to your person`,
      `call ${get} to read why (helper.ended), then ack_answer with its version to say you’ve read it; their answer reaches you as usual`,
    ]
  if (notice?.kind === 'follow_up' && heard.status !== 'answered')
    return [
      `${from} followed up on ${titled}, which it answered for your person`,
      `call ${get} to read it, act on it if it needs anything, then ack_answer with its version to mark it heard`,
    ]
  switch (heard.status) {
    case 'expired':
      return [
        `nobody answered ${titled} in time, so its fallback is due`,
        'do it now if you haven’t already; there’s nothing to acknowledge',
      ]
    case 'cancelled':
    case 'resolved':
      return null
    case 'answered':
      // “I’ll handle it” (0.20.0, guide 2.33; one meaning in 0.31.0), or a to-do's Skip. It closes it out, never acts.
      if (handledOf(heard) === 'self')
        return [
          `your person will handle ${titled} themselves`,
          `call ${get} to read it, then close it out: take no action on it, leave things as they are and don’t follow up; ack_answer with its version and an outcome like “Left to you”`,
        ]
      if (handledOf(heard) === 'leave')
        return [
          `your person won’t do ${titled}`,
          `call ${get} to read it, then close it out: don’t do it for them and don’t follow up; ack_answer with its version and an outcome like “Skipped”`,
        ]
      return [
        `your person answered ${titled}`,
        // An approved draft (0.24.0): where its exact words are. The line's own full stop ends it.
        `call ${get}, act on their words, then ack_answer with its version and a one-line outcome${approvesDraft(heard) ? `. ${APPROVED_DRAFT_NOTICE.slice(0, -1)}` : ''}`,
      ]
    default:
      return [
        `your person wrote to you on ${titled}`,
        `call ${get} to read it, then answer with reply_in_thread`,
      ]
  }
}

const capital = (sentence: string) => sentence.charAt(0).toUpperCase() + sentence.slice(1)

/** The message that wakes the thread: every card that needs it, and what to do with each; null when none does. */
export function wakeMessage(ready: readonly { heard: Heard; card: ThreadCard }[]): string | null {
  const lines = ready.flatMap(({ heard, card }) => {
    const said = line(heard, card)
    return said ? [{ heard, said }] : []
  })
  if (lines.length === 0) return null
  // Not for “I’ll handle it”: there's nothing to ask them back.
  const asked = lines.some(
    ({ heard }) =>
      heard.turn === 'agent' && heard.status !== 'expired' && !noticeOf(heard) && !handledOf(heard),
  )
  const reopen = asked
    ? ' If you need more from them, or the next step, post a new card with follows: that card’s requestId; never reopen.'
    : ''
  if (lines.length === 1) {
    const [happened, todo] = (lines[0] as { said: [string, string] }).said
    return `Pending You: ${happened}. ${capital(todo)}.${reopen}`
  }
  return [
    `Pending You: ${lines.length} of your cards need you.`,
    ...lines.map(({ said: [happened, todo] }) => `- ${capital(happened)}: ${todo}.`),
    ...(reopen ? [reopen.trim()] : []),
  ].join('\n')
}

/**
 * Takes the thread's lease, a file holding this listener's own id: null when a live listener holds it. Two listeners
 * starting at once may both write it; the one whose id isn't there at its next renewal stops.
 */
async function takeLease(
  io: Pick<Io, 'env' | 'home'>,
  app: AppId,
  thread: string,
): Promise<string | null> {
  const path = leasePath(io, app, thread)
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  if (await listening(io, app, thread)) return null
  const id = randomBytes(8).toString('hex')
  await rm(path, { recursive: true, force: true })
  try {
    await writeFile(path, id, { flag: 'wx', mode: 0o600 })
    return id
  } catch {
    return null
  }
}

/** Renews the lease while it's still this listener's (`id`); false once another listener has taken it. */
async function renew(
  io: Pick<Io, 'env' | 'home'>,
  app: AppId,
  thread: string,
  id: string,
): Promise<boolean> {
  const path = leasePath(io, app, thread)
  if ((await readFile(path, 'utf8').catch(() => null)) !== id) return false
  const now = new Date()
  await utimes(path, now, now).catch(() => {})
  return true
}

/** How a wake reaches the thread: true once the app has it (Codex took the message; the plugin started the turn). */
type Deliver = (message: string, requests: readonly string[]) => Promise<boolean>

/**
 * Codex: `codex queue`, which starts the turn itself: the codex on PATH, or the Codex app's own (0.13.0, codex-app.ts),
 * found once, when the listener first wakes the thread.
 */
function byCodexQueue(io: Io, thread: string): Deliver {
  let program: Promise<string> | null = null
  return async (message) => {
    program ??= findCodex(io).then((found) => found?.command ?? 'codex')
    const queued = await io.run(
      await program,
      ['queue', '--thread', thread, '--message', message],
      30_000,
    )
    return queued.code === 0
  }
}

/**
 * OpenCode and Pi: the plugin (Pi: the extension) that started this listener reads the wake on stdout and starts the
 * turn, then says on stdin whether it did. stdin closing means the plugin (the app) is gone: `gone` stops the listener.
 */
function byPlugin(io: Io, gone: () => void): Deliver {
  const queue: string[] = []
  let waiting: ((line: string | null) => void) | null = null
  let closed = false
  const settle = (line: string | null) => {
    const resolve = waiting
    waiting = null
    resolve?.(line)
  }
  void (async () => {
    try {
      for await (const line of io.lines()) {
        if (waiting) settle(line)
        else queue.push(line)
      }
    } catch {}
    closed = true
    gone()
    settle(null)
  })()
  const reply = (): Promise<string | null> => {
    if (queue.length) return Promise.resolve(queue.shift() as string)
    if (closed) return Promise.resolve(null)
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(null), REPLY_MS)
      timer.unref?.()
      waiting = (line) => {
        clearTimeout(timer)
        resolve(line)
      }
    })
  }
  return async (message, requests) => {
    io.out(`${JSON.stringify({ wake: message, requests })}\n`)
    const answered = await reply()
    try {
      return answered !== null && (JSON.parse(answered) as Json).delivered === true
    } catch {
      return false
    }
  }
}

/**
 * The questions handed to this thread now, claimed for it (0.14.0, handed.ts): each one that's ready, not handed over
 * yet, and for this thread by the rules. Claimed first, so no other session hears it too.
 */
async function handedHere(
  io: Io,
  options: {
    origin: string
    app: AppId
    thread: string
    elsewhere: (heard: Pick<Heard, 'machine'>) => boolean
  },
  requests: readonly Heard[],
): Promise<{ heard: Heard; card: HandedCard }[]> {
  const { origin, app, thread } = options
  const ready = requests.filter(
    (heard) => heard.ready && delegatedOf(heard) && !options.elsewhere(heard),
  )
  if (ready.length === 0) return []
  const sessions = await candidates(io, app)
  const mine: { heard: Heard; card: HandedCard }[] = []
  for (const heard of ready) {
    const moment = momentOf(heard)
    if (await wasHanded(io, origin, heard.requestId, moment)) continue
    if (chooseThread(heard, sessions, { home: io.home }) !== thread) continue
    if (!(await claimHanded(io, origin, heard.requestId, moment))) continue
    mine.push({
      heard,
      card: handedCard(heard, delegatedOf(heard) as NonNullable<Heard['delegated']>),
    })
  }
  return mine
}

/** Gives back what was claimed for a session that couldn't be told: another may hear it. */
async function giveBack(io: Io, origin: string, list: readonly { heard: Heard }[]) {
  for (const { heard } of list)
    await releaseHanded(io, origin, heard.requestId, momentOf(heard)).catch(() => {})
}

/**
 * `pendingyou listen --app <app> --thread <id>`: waits on Pending You for the thread's cards, and wakes the thread
 * (Codex: `codex queue`; OpenCode and Pi: through the plugin or extension) when one is the agent's move. OpenCode's and
 * Pi's (0.14.0) also wake their session for a question the person handed it from another assistant, and keep listening
 * for one while their session may be handed one (Codex's listener for those is `listenHanded`). Quiet but for the wake
 * lines it hands a plugin; exits when the thread has nothing left to listen for, the app can't take the wake, the
 * sign-in ends, or after LISTEN_MS.
 */
export async function listen(
  io: Io,
  options: { origin: string; app: AppId; thread: string },
): Promise<number> {
  const { origin, app, thread } = options
  const lease = await takeLease(io, app, thread)
  if (!lease) return 0
  // This computer's sign-ins linked to it by its key, every few hours, in the background (0.29.0, link.ts).
  await linkSoon(io, origin)
  const controller = new AbortController()
  const stop = () => controller.abort()
  if (io.signal.aborted) stop()
  io.signal.addEventListener('abort', stop, { once: true })
  const signal = controller.signal
  const deliver = app === 'codex' ? byCodexQueue(io, thread) : byPlugin(io, stop)
  // Codex's handed questions are its one listener's, which can queue into any thread.
  const takes = app !== 'codex'
  const elsewhere = takes ? await elsewhereFor(io, origin, app) : () => false
  try {
    const started = io.now()
    let since: string | undefined
    let failures = 0
    while (io.now() - started < LISTEN_MS && !signal.aborted) {
      const record = (await load(io, app)).threads[thread]
      const cards = record?.cards ?? {}
      if (!record || (Object.keys(cards).length === 0 && !(takes && mayBeHanded(record, io.now()))))
        return 0
      if (!(await renew(io, app, thread, lease))) return 0
      const query = new URLSearchParams({
        source: app,
        limit: '20',
        wait: String(LONG_POLL_SECONDS),
      })
      if (since) query.set('since', since)
      let requests: Heard[]
      try {
        const { status, body } = await getJson<{ requests?: Heard[] }>(
          io,
          origin,
          `/mcp/cli/answers?${query}`,
          (LONG_POLL_SECONDS + 20) * 1000,
          signal,
          { app },
        )
        if (status !== 200) throw new Unavailable(`Pending You answered ${status}.`)
        requests = Array.isArray(body.requests) ? body.requests : []
        failures = 0
      } catch (error) {
        if (error instanceof SignInNeeded || signal.aborted) return 0
        // Renewed first: no pause here outlasts the lease.
        if (!(await renew(io, app, thread, lease))) return 0
        await io.sleep(BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)] as number, signal)
        continue
      }
      for (const heard of requests) if (!since || heard.changedAt > since) since = heard.changedAt
      const ready: { heard: Heard; card: ThreadCard }[] = []
      const done: string[] = []
      for (const heard of requests) {
        const card = cards[heard.requestId]
        // A question handed to someone (D21) is never its asker's to be woken for: that's the helper's line.
        if (!card || !heard.ready || delegatedOf(heard)) continue
        // Handed over already (the person wrote in the app since): nothing to wake it for.
        if (await wasHanded(io, origin, heard.requestId, momentOf(heard)))
          done.push(heard.requestId)
        else ready.push({ heard, card })
      }
      // The app doesn't know the thread (archived, gone), or can't be reached from here: the hooks hand answers over.
      // Its cards come off its Herdr pane's badges (0.17.0).
      const gone = async () => {
        await change(io, app, (state) => {
          delete state.threads[thread]
        })
        await reportThreads(io, app, { at: io.now() })
      }
      const message = wakeMessage(ready)
      if (message) {
        if (
          !(await deliver(
            message,
            ready.map(({ heard }) => heard.requestId),
          ))
        ) {
          await gone()
          return 0
        }
        await markHanded(
          io,
          origin,
          ready.map(({ heard }) => ({ requestId: heard.requestId, moment: momentOf(heard) })),
        )
      }
      // Questions the person handed this session (0.14.0): claimed for it, then the wake; given back if it didn't go.
      const handed = takes ? await handedHere(io, { origin, app, thread, elsewhere }, requests) : []
      const asked = handedMessage(handed.map(({ card }) => card))
      if (
        asked &&
        !(await deliver(
          asked,
          handed.map(({ heard }) => heard.requestId),
        ))
      ) {
        await giveBack(io, origin, handed)
        await gone()
        return 0
      }
      for (const { heard } of ready) done.push(heard.requestId)
      // Closed cards nobody needs telling about go too.
      for (const heard of requests)
        if (cards[heard.requestId] && isClosed(heard) && !done.includes(heard.requestId))
          done.push(heard.requestId)
      if (done.length) {
        await change(io, app, (state) => {
          const waiting = state.threads[thread]
          if (waiting) for (const id of done) delete waiting.cards[id]
        })
        // Answered, written to or closed: no longer waiting on the person, so off the pane's badges (0.17.0).
        await reportThreads(io, app, { at: io.now() })
      }
      if (io.now() - started > PATIENT_AFTER_MS) await io.sleep(PATIENT_PAUSE_MS, signal)
    }
    return 0
  } finally {
    io.signal.removeEventListener('abort', stop)
    // Only its own: a listener that took over keeps the thread.
    if ((await readFile(leasePath(io, app, thread), 'utf8').catch(() => null)) === lease)
      await rm(leasePath(io, app, thread), { force: true }).catch(() => {})
  }
}

/**
 * `pendingyou listen --app codex --handed` (0.14.0): Codex's one listener for questions the person hands its threads
 * from other assistants (D21), started by the hooks while any thread may be handed one. Each, once its hold is over,
 * goes to the thread handed.ts picks, claimed first, by `codex queue` (which keeps it until the thread is open), in
 * the wake mod's words. A thread Codex doesn't know is forgotten and its questions given back. Quiet; exits when no
 * thread may be handed one, the sign-in ends, or after LISTEN_MS.
 */
export async function listenHanded(
  io: Io,
  options: { origin: string; app: AppId },
): Promise<number> {
  const { origin, app } = options
  if (app !== 'codex') return 0
  const lease = await takeLease(io, app, HANDED)
  if (!lease) return 0
  const controller = new AbortController()
  const stop = () => controller.abort()
  if (io.signal.aborted) stop()
  io.signal.addEventListener('abort', stop, { once: true })
  const signal = controller.signal
  let program: Promise<string> | null = null
  const queue = async (thread: string, message: string) => {
    program ??= findCodex(io).then((found) => found?.command ?? 'codex')
    const queued = await io.run(
      await program,
      ['queue', '--thread', thread, '--message', message],
      30_000,
    )
    return queued.code === 0
  }
  const elsewhere = await elsewhereFor(io, origin, app)
  try {
    const started = io.now()
    let since: string | undefined
    let failures = 0
    while (io.now() - started < LISTEN_MS && !signal.aborted) {
      const now = io.now()
      if (!Object.values((await load(io, app)).threads).some((each) => mayBeHanded(each, now)))
        return 0
      if (!(await renew(io, app, HANDED, lease))) return 0
      const query = new URLSearchParams({
        source: app,
        limit: '20',
        wait: String(LONG_POLL_SECONDS),
      })
      if (since) query.set('since', since)
      let requests: Heard[]
      try {
        const { status, body } = await getJson<{ requests?: Heard[] }>(
          io,
          origin,
          `/mcp/cli/answers?${query}`,
          (LONG_POLL_SECONDS + 20) * 1000,
          signal,
          { app },
        )
        if (status !== 200) throw new Unavailable(`Pending You answered ${status}.`)
        requests = Array.isArray(body.requests) ? body.requests : []
        failures = 0
      } catch (error) {
        if (error instanceof SignInNeeded || signal.aborted) return 0
        if (!(await renew(io, app, HANDED, lease))) return 0
        await io.sleep(BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)] as number, signal)
        continue
      }
      for (const heard of requests) if (!since || heard.changedAt > since) since = heard.changedAt
      // Each question to the thread it's for, claimed first; one message a thread.
      const sessions = requests.some((heard) => delegatedOf(heard)) ? await candidates(io, app) : []
      const byThread = new Map<string, { heard: Heard; card: HandedCard }[]>()
      for (const heard of requests) {
        const delegated = delegatedOf(heard)
        if (!delegated || !heard.ready || elsewhere(heard)) continue
        const moment = momentOf(heard)
        if (await wasHanded(io, origin, heard.requestId, moment)) continue
        const thread = chooseThread(heard, sessions, { home: io.home })
        if (!thread || !(await claimHanded(io, origin, heard.requestId, moment))) continue
        byThread.set(thread, [
          ...(byThread.get(thread) ?? []),
          { heard, card: handedCard(heard, delegated) },
        ])
      }
      for (const [thread, list] of byThread) {
        // Never the words said on the card in `codex queue`'s arguments: get_request has them.
        const message = handedMessage(
          list.map(({ card }) => card),
          { words: false },
        )
        if (message && (await queue(thread, message))) continue
        // Codex doesn't know the thread (archived, gone): its questions go back, and it's left out from now on.
        await giveBack(io, origin, list)
        await change(io, app, (state) => {
          delete state.threads[thread]
        })
        since = undefined
      }
      if (io.now() - started > PATIENT_AFTER_MS) await io.sleep(PATIENT_PAUSE_MS, signal)
    }
    return 0
  } finally {
    io.signal.removeEventListener('abort', stop)
    if ((await readFile(leasePath(io, app, HANDED), 'utf8').catch(() => null)) === lease)
      await rm(leasePath(io, app, HANDED), { force: true }).catch(() => {})
  }
}
