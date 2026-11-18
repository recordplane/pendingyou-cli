// Pending You's plugin for OpenCode (0.12.0). `pendingyou init` writes a one-line file in OpenCode's plugins folder,
// ~/.config/opencode/plugins/pendingyou.js, which re-exports this file's default export from its private copy (0.44.0;
// `PendingYou` before): one `{ id, server, setup }` that OpenCode 1.x loads by `server` and 2.x by `setup`, the same
// core under both (`core`, below). OpenCode 2.x (2.0.0, 2026-09-11) loads only V2 plugins, a default `{ id, setup }`,
// and logs "failed to load plugin" for anything else, so through 0.43.x no 2.x session was ever woken.
//
// It's thin on purpose. What to say and when is the command line's, run through the hooks' shim
// (`~/.config/pendingyou/bin/pendingyou-hook <command> --app opencode`, JSON on stdin, its stdout read back), where it's
// tested in Node; the plugin only does what needs OpenCode itself:
// - `chat.message`: each message of the person's carries what the next-message hook says (`handoff`: the reminder,
//   this folder's open cards, an answer waiting) and, on a session's first since OpenCode started, what a session start
//   says (the setup line while setup isn't finished), as a part with `synthetic: true`, which the model reads and the
//   TUI doesn't show.
// - `tool.execute.after` on Pending You's card tools (`pendingyou_post_request` …): `posted` remembers the cards the
//   session waits on. Then one listener per session with cards (`listen`, the plugin's own child) long-polls Pending
//   You, and when one is the agent's move hands back the wake's words, which the plugin sends into the session
//   (client.session.promptAsync: a turn now when it's idle, joining the one under way when it isn't), in the words the
//   Claude Code wake mod uses. Never the answer itself: the agent reads it with get_request. Since 0.14.0 a session
//   that used Pending You's card tools keeps its listener for 12 hours after (each message starts it again while
//   `<config>/opencode-threads.json` says so), and the listener also wakes it for a question the person handed it from
//   another assistant (D21); `answer_delegated` and `hand_back` count among the card tools, with the session's folder.
//   Since 0.42.0 a session that said its name without a card (`pendingyou_whoami`, `_list_pending` or `_get_request`
//   with a `name`) is told to `posted` too, which knows it by that name and folder (never as a card of its own, nor the
//   turn's), and keeps its listener the same way: a question handed to it wakes it. Since 0.43.2 a session open in this
//   OpenCode (its presence heartbeat) keeps it however long since it used Pending You, as Pending You shows it running:
//   each heartbeat starts its listener again when it's gone (it stops by itself after 8 hours).
// - a session going idle (`session.status` idle): the Stop check on its last turn (`stopcheck`), which asks it to go on
//   once a turn at most, never for a turn the plugin started to ask, one the person stopped, or a subagent's session;
//   the plugin starts that turn and shows a toast saying why.
// - presence (0.15.0, presence.ts): a session's first message (or its creation) says it's live, every 5 minutes after
//   while OpenCode runs, and closed when it's deleted or OpenCode goes (`dispose`), through `presence --state …`,
//   started detached so a closing OpenCode never waits on it.
// Its own prompts carry `metadata.pendingyou`, so the hand-off leaves them alone. Nothing here throws into OpenCode.
// It may be older than the command line the shim runs (init for another app upgrades the shim, not this file's line),
// so what it sends each command stays what a later command line reads.
//
// OpenCode's plugin API, 1.x (1.18.34): `chat.message` gets the message and its parts before they're saved; `event`
// every bus event; `tool.execute.after` an MCP tool's CallToolResult; `client` is OpenCode's SDK, which reaches its
// server in process even with no network port. 2.x (2.3.2): `setup(ctx)` registers each hook on its domain
// (`pendingYouV2` has the map). A plugin can't call MCP tools itself in either.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

type Json = Record<string, unknown>

/** The plugin's input from OpenCode: what it uses of it. */
export interface PluginInput {
  client: Client
  /** The folder OpenCode runs in: the hooks' `cwd`. */
  directory: string
}

/** What it uses of OpenCode's SDK client (`@opencode-ai/sdk`, v1): every call answers `{ data, error }`. */
export interface Client {
  session: {
    get(options: { path: { id: string } }): Promise<{ data?: unknown; error?: unknown }>
    messages(options: {
      path: { id: string }
      query?: { limit?: number }
    }): Promise<{ data?: unknown; error?: unknown }>
    promptAsync(options: { path: { id: string }; body: Json }): Promise<{ error?: unknown }>
  }
  tui: { showToast(options: { body: Json }): Promise<unknown> }
}

/** One of OpenCode's bus events, as the `event` hook hands it over. */
interface BusEvent {
  type: string
  properties?: Json
}

export interface Hooks {
  event(input: { event: BusEvent }): Promise<void>
  'chat.message'(
    input: { sessionID: string; agent?: string; model?: Json; variant?: string },
    output: { message: Json; parts: Json[] },
  ): Promise<void>
  'tool.execute.after'(
    input: { tool: string; sessionID: string; callID?: string; args?: unknown },
    output: unknown,
  ): Promise<void>
  dispose(): Promise<void>
}

/** A session's listener: the wakes it hands over, one JSON line each, and the plugin's answer to each. */
export interface Listener {
  lines: AsyncIterable<string>
  reply(line: string): void
  stop(): void
}

/** What the plugin does outside OpenCode, which tests replace. */
export interface Deps {
  /** Runs one of the command line's hook commands with `input` as JSON on stdin: its stdout, or '' on any failure. */
  run(sub: 'handoff' | 'posted' | 'stopcheck', input: Json): Promise<string>
  /** Starts the listener for a session (`listen`); null when it can't. */
  listen(session: string): Listener | null
  /** A new part's id, after every part OpenCode made so far: OpenCode keeps parts in the order of their ids. */
  partId(): string
  /**
   * Whether a session is worth a listener (0.14.0): cards of its own waiting, or a question that may be handed to it,
   * as `<config>/opencode-threads.json` says. Absent: only as before (a card call, a session's first message).
   */
  wanted?(session: string): boolean
  /** Says a session is live or closed (0.15.0, `presence`), in the background: never waited on. */
  presence?(session: string, state: 'live' | 'closed'): void
  /** Runs `run` every `ms` until the returned stop is called (the presence heartbeat). */
  every?(ms: number, run: () => void): () => void
}

/** How often a session OpenCode has open says it's live: the command line's PRESENCE_EVERY_MS. */
export const PRESENCE_EVERY_MS = 5 * 60_000

/** The production server's address (args.ts's): the hooks need --origin for any other. */
const PRODUCTION = 'https://www.pendingyou.com'
/** How long a hook may take, past the command line's own 3-second deadline (main.ts), before it's given up. */
const HOOK_MS = 5000
/** The most messages a turn's Stop check reads, and of each text part. */
const TURN_MESSAGES = 200
const TEXT_CHARS = 100_000
/**
 * Pending You's card tools, under its server's name (`pendingyou_post_request`), (0.14.0) the two that answer a
 * question the person handed the session, or give it back, and (0.36.0) an answer of the agent's own (post_answer).
 */
const CARD_TOOL =
  /^[A-Za-z0-9_-]*pendingyou[A-Za-z0-9_-]*_(post_request|post_answer|update_request|reply_in_thread|cancel_request|answer_delegated|hand_back)$/i
/**
 * The calls by which a session says its name without a card (0.42.0): `posted` knows it by that name and folder, for a
 * question the person may hand it. Only with a `name`.
 */
const NAMED_TOOL = /^[A-Za-z0-9_-]*pendingyou[A-Za-z0-9_-]*_(whoami|list_pending|get_request)$/i
/**
 * How long a session that used Pending You (the card tools; 0.42.0, a call with its name) may be handed a question: the
 * command line's HANDED_FOR_MS.
 */
export const HANDED_FOR_MS = 12 * 60 * 60_000
/**
 * How long after it last said live a session counts as open (0.43.2): the command line's OPEN_FOR_MS, Pending You's
 * window for showing it running. While it is, a session with a name may be handed a question however long it's been
 * quiet (`liveAt` in the hooks' record, which each live writes).
 */
export const OPEN_FOR_MS = 15 * 60_000
/** What the toast says when the Stop check asks a session to go on. */
const NUDGED = 'Asked OpenCode to put what it needs from you on a card.'

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The plugin's mark on a part it made: what it's for (`handoff`, `stopcheck`, `wake`), or null for anyone else's. */
const ourMark = (part: unknown): string | null => {
  const mark = isObject(part) && isObject(part.metadata) ? part.metadata.pendingyou : null
  return typeof mark === 'string' ? mark : null
}

/**
 * The command line's folder (~/.config/pendingyou): where this file is in its private copy
 * (`<config>/cli/<version>/node_modules/pendingyou/dist/apps/`), else as the command line finds it.
 */
function configFolder(): string {
  const here = /^(.*)\/cli\/[^/]+\/node_modules\/pendingyou\/dist\/apps\/[^/]+$/.exec(
    fileURLToPath(import.meta.url),
  )?.[1]
  if (here) return here
  if (process.env.PENDINGYOU_CONFIG_DIR) return process.env.PENDINGYOU_CONFIG_DIR
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'pendingyou')
}

/**
 * Whether the hooks' record of a session (`<app>-threads.json`, codex-wake.ts) says it's worth a listener: cards waiting,
 * or a name it went by on the card tools (0.42.0: or said with whoami, list_pending, get_request) within HANDED_FOR_MS,
 * or (0.43.2) while it's open. False for anything it can't read.
 */
export function wantsListener(file: unknown, session: string, now = Date.now()): boolean {
  const threads = isObject(file) && isObject(file.threads) ? file.threads : {}
  const thread = threads[session]
  if (!isObject(thread)) return false
  if (isObject(thread.cards) && Object.keys(thread.cards).length > 0) return true
  if (!Array.isArray(thread.names) || thread.names.length === 0) return false
  // Open (0.43.2): its app said so in the last OPEN_FOR_MS, however long since it used Pending You.
  if (typeof thread.liveAt === 'number' && now - thread.liveAt < OPEN_FOR_MS) return true
  return typeof thread.at === 'number' && now - thread.at < HANDED_FOR_MS
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * An id as OpenCode makes a part's (`prt_`, the time in 12 hex digits, 14 random letters), with the time's counter at
 * its last value, so it sorts after any part OpenCode made in the same millisecond or before.
 */
export function partId(now = Date.now()): string {
  const time = (BigInt(now) * 4096n + 4095n).toString(16).padStart(12, '0').slice(-12)
  const random = [...randomBytes(14)].map((byte) => BASE62[byte % 62]).join('')
  return `prt_${time}${random}`
}

/** The command line, through the hooks' shim: what OpenCode's plugin runs outside itself. */
function viaShim(config: string, origin: string, directory: string): Deps {
  const shim = join(config, 'bin', 'pendingyou-hook')
  const args = (sub: string) => [
    sub,
    '--app',
    'opencode',
    ...(origin === PRODUCTION ? [] : ['--origin', origin]),
  ]
  return {
    run: (sub, input) =>
      new Promise((resolve) => {
        let out = ''
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const done = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(out)
        }
        let child: ReturnType<typeof spawn>
        try {
          child = spawn(shim, args(sub), { stdio: ['pipe', 'pipe', 'ignore'] })
        } catch {
          resolve('')
          return
        }
        // Given up past the command line's own deadline: nothing it says by then is used.
        timer = setTimeout(() => {
          child.kill('SIGKILL')
          out = ''
          done()
        }, HOOK_MS)
        if (!child.stdout || !child.stdin) return done()
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (chunk: string) => {
          if (out.length < 1_000_000) out += chunk
        })
        child.on('error', () => {
          out = ''
          done()
        })
        child.on('close', done)
        child.stdin.on('error', () => {})
        child.stdin.end(JSON.stringify(input))
      }),
    listen: (session) => {
      try {
        const child = spawn(shim, [...args('listen'), '--thread', session], {
          stdio: ['pipe', 'pipe', 'ignore'],
        })
        child.on('error', () => {})
        child.stdin.on('error', () => {})
        return {
          lines: createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY }),
          reply: (line) => {
            if (child.stdin.writable) child.stdin.write(`${line}\n`)
          },
          stop: () => child.stdin.end(),
        }
      } catch {
        return null
      }
    },
    partId: () => partId(),
    presence: (session, state) => {
      try {
        const child = spawn(
          shim,
          [
            ...args('presence'),
            '--state',
            state,
            '--session',
            session,
            '--cwd',
            directory,
            '--at',
            String(Date.now()),
          ],
          { detached: true, stdio: 'ignore' },
        )
        child.on('error', () => {})
        child.unref()
      } catch {}
    },
    every: (ms, run) => {
      const timer = setInterval(run, ms)
      timer.unref?.()
      return () => clearInterval(timer)
    },
    wanted: (session) => {
      try {
        return wantsListener(
          JSON.parse(readFileSync(join(config, 'opencode-threads.json'), 'utf8')),
          session,
        )
      } catch {
        return false
      }
    },
  }
}

/** The manifest's origin, with the command line's deps for it: null when Pending You isn't set up for OpenCode here. */
function setUp(directory: string): Deps | null {
  const config = configFolder()
  const manifest = JSON.parse(readFileSync(join(config, 'opencode.json'), 'utf8')) as unknown
  const origin = isObject(manifest) && typeof manifest.origin === 'string' ? manifest.origin : null
  return origin ? viaShim(config, origin, directory) : null
}

/**
 * The plugin as OpenCode 1.x loads it (1.17.0 and later): Pending You's hooks for this OpenCode, or none when Pending
 * You isn't set up for it here (no manifest: init never ran, or uninstall did).
 */
export const PendingYou = async (input: PluginInput): Promise<Partial<Hooks>> => {
  try {
    const deps = setUp(input.directory)
    return deps ? pendingYou(input, deps) : {}
  } catch {
    return {}
  }
}

/**
 * The plugin as OpenCode 2.x loads it (2.0.0 and later: its V2 plugins, `setup(ctx)` registering each hook), or nothing
 * when Pending You isn't set up for it here. Since 0.44.0.
 */
export const setupV2 = async (ctx: V2Context): Promise<(() => Promise<void>) | undefined> => {
  try {
    const directory = ctx.location?.directory ?? process.cwd()
    const deps = setUp(directory)
    return deps ? await pendingYouV2(ctx, deps, directory) : undefined
  } catch {
    return undefined
  }
}

/**
 * The one default export the one-line file re-exports (0.44.0), which both OpenCodes accept: 2.x needs a default
 * `{ id, setup }` and calls `setup` (packages/core/src/plugin/module.ts: "Plugin must export a default definition with
 * an id and an effect or setup function"), and 1.x (1.17.0 to 1.19) takes a default `{ id, server }` and calls
 * `server` (packages/opencode/src/plugin/shared.ts, readV1Plugin), each ignoring the other's key. Before 0.44.0 the
 * line re-exported `PendingYou` alone, which 2.x refuses to load.
 */
const plugin = { id: 'pendingyou', server: PendingYou, setup: setupV2 }
export default plugin

/** What the plugin knows of a session. */
interface Session {
  /** The session it belongs to when it's a subagent's (its `parentID`): its cards wake that one. */
  parent?: string | null
  /** Made since this OpenCode started (`session.created`): its first message is a session start. */
  fresh?: boolean
  /** A message of the person's has gone through since this OpenCode started. */
  spoken?: boolean
  /** The message that started its turn now: the turn's id for the Stop check and the cards it posts. */
  turn?: string
  /** The agent, model and variant its last message used: the plugin's own prompts keep them (1.x). */
  using?: Json
  /** A Stop check under way. */
  checking?: boolean
  listener?: Listener
  /** A listener was asked for while one was ending: start another once it has. */
  again?: boolean
  /** Deleted, or OpenCode is going: no listener again. */
  gone?: boolean
}

/** A session's last turn as the Stop check reads it (stopcheck.ts's opencodeTurn): its first message's id, and each. */
interface Turn {
  id: string
  messages: Json[]
}

/** What the plugin's core needs of an OpenCode, 1.x's SDK client or 2.x's plugin context. */
interface Surface {
  /** The session it works for, when it's a subagent's; null when it isn't, or OpenCode can't say. */
  parentOf(id: string): Promise<string | null>
  /** Its last turn, from the message that started it; null when there's none. */
  turnOf(id: string): Promise<Turn | null>
  /**
   * Starts a turn (or joins the one under way) with the plugin's own words: a `wake` the person sees, or a `stopcheck`
   * asking it to go on, which says why. Whether it went.
   */
  send(id: string, session: Session, kind: 'wake' | 'stopcheck', text: string): Promise<boolean>
  /**
   * The id of the turn running in the session now, as the Stop check will read it (2.x): a message typed while a turn
   * runs moves `turn` at once, but may wait in OpenCode's inbox until the turn ends, so a card the turn posts after it
   * belongs to the turn under way. Null when it can't tell (then `turn`).
   */
  turnNow?(id: string): Promise<string | null>
}

/** The plugin's core, the same in both OpenCodes: what each adapter calls from OpenCode's hooks and events. */
function core(surface: Surface, deps: Deps, directory: string) {
  const sessions = new Map<string, Session>()
  /** The sessions said live in this OpenCode (0.15.0), and the heartbeat that says so again. */
  const present = new Set<string>()
  let stopBeat: (() => void) | null = null
  const live = (id: string) => {
    if (present.has(id) || !deps.presence) return
    present.add(id)
    deps.presence(id, 'live')
    stopBeat ??=
      deps.every?.(PRESENCE_EVERY_MS, () => {
        for (const each of present) {
          deps.presence?.(each, 'live')
          // Open, with a name (0.43.2): its listener runs, however long it's been quiet (it stops after 8 hours).
          const session = sessions.get(each)
          if (session && !session.listener && !session.parent && deps.wanted?.(each))
            listenFor(each, session)
        }
      }) ?? null
  }
  const closed = (id: string) => {
    if (!present.delete(id)) return
    deps.presence?.(id, 'closed')
  }

  /** What it knows of a session, asking OpenCode once for one made before it started (a subagent's or not). */
  const known = async (id: string): Promise<Session> => {
    const found = sessions.get(id)
    if (found && found.parent !== undefined) return found
    const session = found ?? {}
    sessions.set(id, session)
    try {
      session.parent = await surface.parentOf(id)
    } catch {
      session.parent = null
    }
    return session
  }

  /** Keeps one listener for a session that has cards (the listener goes away by itself when none's left). */
  const listenFor = (id: string, session: Session) => {
    if (session.gone) return
    // One may be on its way out (it found nothing to listen for a moment ago): start another once it's gone.
    if (session.listener) {
      session.again = true
      return
    }
    session.again = false
    const listener = deps.listen(id)
    if (!listener) return
    session.listener = listener
    void (async () => {
      try {
        for await (const line of listener.lines) {
          let wake: unknown
          try {
            wake = JSON.parse(line)
          } catch {
            continue
          }
          if (!isObject(wake) || typeof wake.wake !== 'string') continue
          const delivered = await surface.send(id, session, 'wake', wake.wake).catch(() => false)
          listener.reply(JSON.stringify({ delivered }))
        }
      } catch {}
      if (session.listener === listener) session.listener = undefined
      if (session.again) listenFor(id, session)
    })()
  }

  return {
    /** OpenCode made a session (`session.created`). */
    created(id: string, parent: string | null) {
      const session = sessions.get(id) ?? {}
      session.fresh = true
      session.parent = parent
      sessions.set(id, session)
      if (!session.parent) live(id)
    },
    /** OpenCode deleted one. */
    deleted(id: string) {
      const session = sessions.get(id)
      if (session) session.gone = true
      session?.listener?.stop()
      sessions.delete(id)
      closed(id)
    },
    /**
     * A message of the person's (one of the plugin's own never comes here): what to add for the model (the hand-off's
     * lines, '' for nothing), and a listener when the session wants one. `using` is what the message used (1.x).
     */
    async message(id: string, turn: string | undefined, using?: Json): Promise<string> {
      const session = await known(id)
      if (session.parent) return ''
      live(id)
      if (turn) session.turn = turn
      if (using) session.using = using
      const first = !session.spoken
      session.spoken = true
      const said = (
        await deps.run('handoff', {
          cwd: directory,
          session_id: id,
          ...(first ? { source: session.fresh ? 'startup' : 'resume' } : {}),
        })
      ).trim()
      // A session resumed with cards still waiting is woken when they're answered, as one that posts them; and one
      // that may be handed a question keeps its listener (it stops by itself after 8 hours).
      if (first || deps.wanted?.(id)) listenFor(id, session)
      return said
    },
    /**
     * A session this OpenCode has open that the plugin hasn't seen this time (2.x, after it reloaded the plugin, or
     * started): live again when it was (`live`), and its listener when it wants one.
     */
    async reopen(id: string, isLive: boolean) {
      const session = await known(id)
      if (session.parent || session.gone) return
      if (isLive) live(id)
      if (!session.listener && deps.wanted?.(id)) listenFor(id, session)
    },
    /** The sessions said live now: what a 2.x plugin hands the one OpenCode loads after it. */
    present: () => [...present],
    /** One of the plugin's own prompts started a turn: it's the turn's message (and the session is live). */
    async ours(id: string, turn: string) {
      const session = await known(id)
      if (session.parent) return
      live(id)
      session.turn = turn
    },
    /** A tool call that didn't fail: Pending You's card tools, or one that says the session's name, go to `posted`. */
    async tool(tool: string, sessionID: string, args: unknown, response: unknown) {
      // A call that says its name (0.42.0): only with one, since that's what a question is handed to.
      const named = NAMED_TOOL.test(tool)
      if (named && !(isObject(args) && typeof args.name === 'string')) return
      if (!named && !CARD_TOOL.test(tool)) return
      const session = await known(sessionID)
      // A subagent's card wakes the session it works for.
      const id = session.parent ?? sessionID
      const owner = session.parent ? await known(id) : session
      const turn = (await surface.turnNow?.(id).catch(() => null)) ?? owner.turn
      await deps.run('posted', {
        session_id: id,
        ...(turn ? { turn_id: turn } : {}),
        cwd: directory,
        tool_name: tool,
        tool_input: args ?? {},
        tool_response: response,
      })
      listenFor(id, owner)
    },
    /** A session gone idle: the Stop check on its last turn, and the turn it asks for when it asks. */
    async idle(id: string) {
      const session = await known(id)
      if (session.parent || session.checking) return
      session.checking = true
      try {
        const turn = await surface.turnOf(id)
        if (!turn) return
        const said = await deps.run('stopcheck', {
          session_id: id,
          turn_id: turn.id,
          cwd: directory,
          messages: turn.messages,
        })
        let decision: unknown
        try {
          decision = JSON.parse(said)
        } catch {
          return
        }
        if (!isObject(decision) || decision.decision !== 'block') return
        if (typeof decision.reason !== 'string') return
        await surface.send(id, session, 'stopcheck', decision.reason)
      } finally {
        session.checking = false
      }
    },
    dispose() {
      for (const session of sessions.values()) {
        session.gone = true
        session.listener?.stop()
      }
      stopBeat?.()
      stopBeat = null
      for (const id of [...present]) closed(id)
    },
  }
}

/** A part of a turn the Stop check reads: a text part (marked when it's the plugin's), or a tool part. */
function textPart(text: string, extra: Json = {}): Json {
  return { type: 'text', text: text.slice(0, TEXT_CHARS), ...extra }
}
function toolPart(tool: string, status: unknown, input: unknown): Json {
  return { type: 'tool', tool, status, ...(CARD_TOOL.test(tool) ? { input } : {}) }
}

/** The plugin's hooks for OpenCode 1.x, with what it runs outside OpenCode (`deps`). */
export async function pendingYou(input: PluginInput, deps: Deps): Promise<Hooks> {
  const { client, directory } = input

  /** The agent, model and variant a user message used: what a prompt of the plugin's keeps. */
  const usingOf = (info: unknown): Json | undefined => {
    if (!isObject(info)) return undefined
    const model = isObject(info.model) ? info.model : null
    return {
      ...(typeof info.agent === 'string' ? { agent: info.agent } : {}),
      ...(model && typeof model.providerID === 'string' && typeof model.modelID === 'string'
        ? { model: { providerID: model.providerID, modelID: model.modelID } }
        : {}),
      ...(typeof model?.variant === 'string' ? { variant: model.variant } : {}),
    }
  }

  /** A session's messages, newest last, as OpenCode lists them; [] when it can't. */
  const messagesOf = async (id: string, limit: number): Promise<Json[]> => {
    try {
      const { data } = await client.session.messages({ path: { id }, query: { limit } })
      return Array.isArray(data) ? data.filter(isObject) : []
    } catch {
      return []
    }
  }

  /** Starts a turn in a session with the plugin's own words, with what its last message used. */
  const prompt = async (id: string, session: Session, part: Json): Promise<boolean> => {
    try {
      let using = session.using
      if (!using) {
        const last = (await messagesOf(id, 20)).findLast(
          (message) => isObject(message.info) && message.info.role === 'user',
        )
        using = usingOf(last?.info)
      }
      const result = await client.session.promptAsync({
        path: { id },
        body: { ...using, parts: [part] },
      })
      return !result?.error
    } catch {
      return false
    }
  }

  const plugin = core(
    {
      parentOf: async (id) => {
        const { data } = await client.session.get({ path: { id } })
        return isObject(data) && typeof data.parentID === 'string' && data.parentID
          ? data.parentID
          : null
      },
      turnOf: async (id) => turnOf(await messagesOf(id, TURN_MESSAGES)),
      send: async (id, session, kind, text) => {
        if (kind === 'wake')
          return prompt(id, session, { type: 'text', text, metadata: { pendingyou: 'wake' } })
        const went = await prompt(id, session, {
          type: 'text',
          text,
          synthetic: true,
          metadata: { pendingyou: 'stopcheck' },
        })
        if (went)
          await client.tui
            .showToast({ body: { title: 'Pending You', message: NUDGED, variant: 'info' } })
            .catch(() => {})
        return went
      },
    },
    deps,
    directory,
  )

  /**
   * The session's last turn, from the message that started it, as the Stop check reads it: each message's role, the
   * error it ended with, and its text and tool parts (a card call's input, no tool's output).
   */
  const turnOf = (messages: Json[]): Turn | null => {
    const start = messages.findLastIndex(
      (message) => isObject(message.info) && message.info.role === 'user',
    )
    const first = messages[start]
    if (!first || !isObject(first.info) || typeof first.info.id !== 'string') return null
    return {
      id: first.info.id,
      messages: messages.slice(start).map((message) => {
        const info = isObject(message.info) ? message.info : {}
        const error =
          isObject(info.error) && typeof info.error.name === 'string' ? info.error.name : null
        const parts = (Array.isArray(message.parts) ? message.parts : []).filter(isObject)
        return {
          id: info.id,
          role: info.role,
          ...(error ? { error } : {}),
          parts: parts.flatMap((part): Json[] => {
            if (part.type === 'text' && typeof part.text === 'string') {
              const mark = ourMark(part)
              return [
                textPart(part.text, {
                  ...(part.synthetic === true ? { synthetic: true } : {}),
                  ...(mark ? { pendingyou: mark } : {}),
                }),
              ]
            }
            if (part.type === 'tool' && typeof part.tool === 'string') {
              const state = isObject(part.state) ? part.state : {}
              return [toolPart(part.tool, state.status, state.input)]
            }
            return []
          }),
        }
      }),
    }
  }

  return {
    async event({ event }) {
      try {
        const properties = isObject(event.properties) ? event.properties : {}
        if (event.type === 'session.created' && isObject(properties.info)) {
          const info = properties.info
          if (typeof info.id !== 'string') return
          plugin.created(
            info.id,
            typeof info.parentID === 'string' && info.parentID ? info.parentID : null,
          )
        } else if (event.type === 'session.deleted' && isObject(properties.info)) {
          const id = properties.info.id
          if (typeof id !== 'string') return
          plugin.deleted(id)
        } else if (
          event.type === 'session.status' &&
          typeof properties.sessionID === 'string' &&
          isObject(properties.status) &&
          properties.status.type === 'idle'
        )
          await plugin.idle(properties.sessionID)
      } catch {}
    },

    async 'chat.message'(input, output) {
      try {
        const id = input.sessionID
        // One of its own prompts: nothing to add.
        if (output.parts.some((part) => ourMark(part) !== null)) {
          if (typeof output.message.id === 'string') await plugin.ours(id, output.message.id)
          return
        }
        const said = await plugin.message(
          id,
          typeof output.message.id === 'string' ? output.message.id : undefined,
          {
            ...usingOf(output.message),
            ...(typeof input.agent === 'string' ? { agent: input.agent } : {}),
            ...(isObject(input.model) ? { model: input.model } : {}),
            ...(typeof input.variant === 'string' ? { variant: input.variant } : {}),
          },
        )
        if (said)
          output.parts.push({
            id: deps.partId(),
            sessionID: id,
            messageID: output.message.id,
            type: 'text',
            text: said,
            synthetic: true,
            metadata: { pendingyou: 'handoff' },
          })
      } catch {}
    },

    async 'tool.execute.after'(input, output) {
      try {
        await plugin.tool(input.tool, input.sessionID, input.args, output)
      } catch {}
    },

    async dispose() {
      plugin.dispose()
    },
  }
}

/**
 * What it uses of OpenCode 2.x's plugin context (`@opencode/plugin`'s Promise API, read at 2.3.2): each call answers its
 * data, or throws.
 */
export interface V2Context {
  /** Where this plugin instance loaded: the hooks' `cwd`. */
  location?: { directory?: string }
  session: {
    hook<Name extends keyof V2SessionHooks>(
      name: Name,
      callback: (event: V2SessionHooks[Name]) => Promise<void> | void,
    ): Promise<unknown>
    get(input: { sessionID: string }): Promise<unknown>
    /** The sessions, newest first with `order: 'desc'` (2.1.0 and later; absent before). */
    list?(input: { directory?: string; limit?: number; order?: 'asc' | 'desc' }): Promise<unknown>
    /** The session's messages as its model sees them, oldest first. */
    context(input: { sessionID: string }): Promise<unknown>
    /**
     * Admits a synthetic message (a turn now when the session is idle, joining the one under way when it isn't): the
     * model reads `text`, and the session shows `description` as one notice row (none: hidden).
     */
    synthetic(input: {
      sessionID: string
      text: string
      description?: string
      metadata?: Json
    }): Promise<unknown>
  }
  tool: {
    hook(
      name: 'execute.after',
      callback: (event: V2ToolAfter) => Promise<void> | void,
    ): Promise<unknown>
  }
  event: {
    subscribe(options?: { types?: string[]; signal?: AbortSignal }): AsyncIterable<unknown>
  }
}

/** The session hooks it registers, with what of each event it uses. */
export interface V2SessionHooks {
  /** A prompt of the person's, before it's admitted: `metadata` is kept with the message. */
  prompt: { sessionID: string; messageID: string; prompt: { text: string }; metadata?: Json }
  /** Just before an agent model request: `messages` may be edited for this request only. */
  context: { sessionID: string; messages: Json[] }
  /** A session about to go idle after model work (not after an interruption or a failure). */
  'experimental.idle': { sessionID: string; background: readonly unknown[] }
}

/** A tool call just ended. */
export interface V2ToolAfter {
  tool: string
  sessionID: string
  input: unknown
  status: 'completed' | 'error'
  result?: { output?: unknown; content?: unknown }
}

/** Where the hand-off's lines for a message of the person's are kept: its metadata (2.x), for the `context` hook. */
const HANDOFF_KEY = 'pendingyouHandoff'

/** The plugin's mark on a 2.x message (its metadata's `pendingyou`), or null. */
const markOf = (message: Json): string | null =>
  isObject(message.metadata) && typeof message.metadata.pendingyou === 'string'
    ? message.metadata.pendingyou
    : null

/** What the session shows for the plugin's own turns (2.x's notice row; 1.x's toast for the Stop check). */
function descriptionOf(kind: 'wake' | 'stopcheck', text: string): string {
  if (kind === 'stopcheck') return NUDGED
  // The wake's first line, to the card it names: “Pending You: your person answered “…” (req_…).”
  const line = text.split('\n')[0] ?? ''
  const at = line.indexOf('). ')
  return (at > 0 ? line.slice(0, at + 2) : line).slice(0, 300)
}

/**
 * A 2.x session's last turn, from what started it (a message of the person's, or one of the plugin's own wakes or Stop
 * checks), as the Stop check reads it: the same shape as 1.x's (stopcheck.ts's opencodeTurn).
 */
export function turnOfV2(messages: unknown): Turn | null {
  const list = (Array.isArray(messages) ? messages : []).filter(isObject).slice(-TURN_MESSAGES)
  const start = list.findLastIndex(
    (message) =>
      message.type === 'user' ||
      (message.type === 'synthetic' && ['wake', 'stopcheck'].includes(markOf(message) ?? '')),
  )
  const first = list[start]
  if (!first || typeof first.id !== 'string') return null
  return {
    id: first.id,
    messages: list.slice(start).flatMap((message): Json[] => {
      const text = typeof message.text === 'string' ? message.text : ''
      if (message === first && message.type === 'user') {
        const handoff = isObject(message.metadata) ? message.metadata[HANDOFF_KEY] : null
        return [
          {
            id: message.id,
            role: 'user',
            parts: [
              textPart(text),
              ...(typeof handoff === 'string' && handoff
                ? [textPart(handoff, { synthetic: true, pendingyou: 'handoff' })]
                : []),
            ],
          },
        ]
      }
      if (message === first) {
        const mark = markOf(message) as string
        return [
          {
            id: message.id,
            role: 'user',
            parts: [
              textPart(text, {
                ...(mark === 'stopcheck' ? { synthetic: true } : {}),
                pendingyou: mark,
              }),
            ],
          },
        ]
      }
      if (message.type !== 'assistant') return []
      const error =
        isObject(message.error) && typeof message.error.type === 'string'
          ? message.error.type
          : null
      const content = (Array.isArray(message.content) ? message.content : []).filter(isObject)
      return [
        {
          id: message.id,
          role: 'assistant',
          ...(error ? { error } : {}),
          parts: content.flatMap((part): Json[] => {
            if (part.type === 'text' && typeof part.text === 'string') return [textPart(part.text)]
            if (part.type === 'tool' && typeof part.name === 'string') {
              const state = isObject(part.state) ? part.state : {}
              return [toolPart(part.name, state.status, state.input)]
            }
            return []
          }),
        },
      ]
    }),
  }
}

/**
 * A 2.x tool result as the command line reads a CallToolResult (codex-wake.ts's resultOf): OpenCode hands an MCP
 * tool's structured answer (or its text parsed as JSON) as `output`, and its text as `content`.
 */
export function toolResponseV2(result: unknown): Json {
  const value = isObject(result) ? result : {}
  const content =
    typeof value.content === 'string'
      ? [{ type: 'text', text: value.content }]
      : Array.isArray(value.content)
        ? value.content
        : []
  return { ...(isObject(value.output) ? { structuredContent: value.output } : {}), content }
}

/**
 * The plugin's registrations for OpenCode 2.x (0.44.0), with what it runs outside OpenCode (`deps`): what 1.x's hooks
 * did, through 2.x's own (OpenCode's "Migrate plugins from V1"):
 * - `chat.message` → the `prompt` hook keeps the hand-off's lines in the person's message's metadata, and the `context`
 *   hook adds them to that message for the model only (the session shows the person's words alone, and the title model
 *   never sees them).
 * - `tool.execute.after` → the tool's `execute.after` hook, for a call that completed.
 * - a session going idle → `experimental.idle`, which runs just before the session goes idle after model work, never
 *   after an interruption or a failure, and not while its own background work (a shell, a subagent) still runs, since
 *   that wakes it again. The Stop check's turn runs in the same execution.
 * - `client.session.promptAsync` → `session.synthetic`: a wake the session shows as one notice row (its first
 *   sentence; the model reads it all), and a Stop check's that says why (1.x's toast).
 * - `event` → a subscription to `session.created` and `session.deleted`; `dispose` → the cleanup `setup` returns.
 * Answers the cleanup.
 */
export async function pendingYouV2(
  ctx: V2Context,
  deps: Deps,
  directory: string,
): Promise<() => Promise<void>> {
  const plugin = core(
    {
      parentOf: async (id) => {
        const info = await ctx.session.get({ sessionID: id })
        return isObject(info) && typeof info.parentID === 'string' && info.parentID
          ? info.parentID
          : null
      },
      turnOf: async (id) => turnOfV2(await ctx.session.context({ sessionID: id })),
      turnNow: async (id) => turnOfV2(await ctx.session.context({ sessionID: id }))?.id ?? null,
      send: async (id, _session, kind, text) => {
        try {
          const admitted = await ctx.session.synthetic({
            sessionID: id,
            text,
            description: descriptionOf(kind, text),
            metadata: { pendingyou: kind },
          })
          if (isObject(admitted) && typeof admitted.id === 'string')
            await plugin.ours(id, admitted.id)
          return true
        } catch {
          return false
        }
      },
    },
    deps,
    directory,
  )

  // Each registration on its own: one OpenCode renamed leaves the others working.
  const register = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch {}
  }
  await register(() =>
    ctx.session.hook('prompt', async (event) => {
      try {
        // One of its own (they're synthetic, so none should come here): nothing to add.
        if (isObject(event.metadata) && typeof event.metadata.pendingyou === 'string') return
        const said = await plugin.message(event.sessionID, event.messageID)
        if (said) event.metadata = { ...(event.metadata ?? {}), [HANDOFF_KEY]: said }
      } catch {}
    }),
  )
  await register(() =>
    ctx.session.hook('context', (event) => {
      try {
        event.messages.forEach((message, index) => {
          const said = isObject(message.metadata) ? message.metadata[HANDOFF_KEY] : null
          if (message.role !== 'user' || typeof said !== 'string' || !said) return
          const content = Array.isArray(message.content) ? message.content : []
          const last = content.at(-1)
          if (isObject(last) && last.text === said) return
          event.messages[index] = {
            ...message,
            content: [...content, { type: 'text', text: said }],
          }
        })
      } catch {}
    }),
  )
  await register(() =>
    ctx.session.hook('experimental.idle', async (event) => {
      try {
        // Its own shell or subagent still running wakes it again when it ends: check then.
        if (event.background.some((work) => isObject(work) && work.sessionID === event.sessionID))
          return
        await plugin.idle(event.sessionID)
      } catch {}
    }),
  )
  await register(() =>
    ctx.tool.hook('execute.after', async (event) => {
      try {
        if (event.status !== 'completed') return
        await plugin.tool(event.tool, event.sessionID, event.input, toolResponseV2(event.result))
      } catch {}
    }),
  )

  const stop = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({
        types: ['session.created', 'session.deleted'],
        signal: stop.signal,
      })) {
        if (!isObject(event) || !isObject(event.data)) continue
        const id = event.data.sessionID
        if (typeof id !== 'string') continue
        const parent = event.data.parentID
        if (event.type === 'session.created')
          plugin.created(id, typeof parent === 'string' && parent ? parent : null)
        else if (event.type === 'session.deleted') plugin.deleted(id)
      }
    } catch {}
  })()

  // Sessions open before this setup (0.44.0): 2.x reloads the plugin whenever its file changes (an init, an upgrade),
  // and the last one's cleanup said every session closed. The one before leaves which were live (HANDOVER, in the same
  // OpenCode process: a restart takes it away); and this folder's recent sessions get their listeners back when their
  // record wants one (cards waiting, or a question that may be handed to them).
  const handovers = handoverOf()
  const handed = handovers.get(directory)
  handovers.delete(directory)
  const wasLive =
    handed && Date.now() - handed.at < HANDOVER_MS
      ? handed.ids.filter((id): id is string => typeof id === 'string')
      : []
  void (async () => {
    try {
      for (const id of wasLive) await plugin.reopen(id, true)
      if (!ctx.session.list) return
      const listed = await ctx.session.list({ directory, limit: RECENT_SESSIONS, order: 'desc' })
      const infos = Array.isArray(listed) ? listed : isObject(listed) ? listed.data : null
      for (const info of Array.isArray(infos) ? infos.filter(isObject) : [])
        if (typeof info.id === 'string' && !info.parentID && !wasLive.includes(info.id))
          await plugin.reopen(info.id, false)
    } catch {}
  })()

  return async () => {
    stop.abort()
    handoverOf().set(directory, { at: Date.now(), ids: plugin.present() })
    plugin.dispose()
  }
}

/** Where a 2.x plugin leaves the sessions it had live for the one OpenCode loads next, and for how long. */
const HANDOVER = Symbol.for('pendingyou.opencode.live')
const HANDOVER_MS = 60_000
/** The handover, one per folder OpenCode loaded the plugin for (2.x loads it once per location). */
function handoverOf(): Map<string, { at: number; ids: unknown[] }> {
  const store = globalThis as Record<symbol, unknown>
  const found = store[HANDOVER]
  if (found instanceof Map) return found as Map<string, { at: number; ids: unknown[] }>
  const made = new Map<string, { at: number; ids: unknown[] }>()
  store[HANDOVER] = made
  return made
}
/** How many of the folder's newest sessions a 2.x plugin looks at as it starts, for their listeners. */
const RECENT_SESSIONS = 20
