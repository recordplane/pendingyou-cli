// Pending You's plugin for OpenCode (0.12.0). `pendingyou init` writes a one-line file in OpenCode's plugins folder,
// ~/.config/opencode/plugins/pendingyou.js, which re-exports `PendingYou` from this file in its private copy: OpenCode
// loads the folder's files at startup and calls every export of each, so that line exports nothing else.
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
// OpenCode's plugin API (1.18.34): `chat.message` gets the message and its parts before they're saved; `event` every
// bus event; `tool.execute.after` an MCP tool's CallToolResult; `client` is OpenCode's SDK, which reaches its server in
// process even with no network port. A plugin can't call MCP tools itself.
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
 * Pending You's card tools, under its server's name (`pendingyou_post_request`), and (0.14.0) the two that answer a
 * question the person handed the session, or give it back.
 */
const CARD_TOOL =
  /^[A-Za-z0-9_-]*pendingyou[A-Za-z0-9_-]*_(post_request|update_request|reply_in_thread|cancel_request|answer_delegated|hand_back)$/i
/** How long a session that used the card tools may be handed a question: the command line's HANDED_FOR_MS. */
export const HANDED_FOR_MS = 12 * 60 * 60_000
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
 * or a name it went by on the card tools within HANDED_FOR_MS. False for anything it can't read.
 */
export function wantsListener(file: unknown, session: string, now = Date.now()): boolean {
  const threads = isObject(file) && isObject(file.threads) ? file.threads : {}
  const thread = threads[session]
  if (!isObject(thread)) return false
  if (isObject(thread.cards) && Object.keys(thread.cards).length > 0) return true
  return (
    Array.isArray(thread.names) &&
    thread.names.length > 0 &&
    typeof thread.at === 'number' &&
    now - thread.at < HANDED_FOR_MS
  )
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

/**
 * The plugin OpenCode loads (through the one-line file in its plugins folder): Pending You's hooks for this OpenCode,
 * or none when Pending You isn't set up for it here (no manifest: init never ran, or uninstall did).
 */
export const PendingYou = async (input: PluginInput): Promise<Partial<Hooks>> => {
  try {
    const config = configFolder()
    const manifest = JSON.parse(readFileSync(join(config, 'opencode.json'), 'utf8')) as unknown
    const origin =
      isObject(manifest) && typeof manifest.origin === 'string' ? manifest.origin : null
    if (!origin) return {}
    return pendingYou(input, viaShim(config, origin, input.directory))
  } catch {
    return {}
  }
}

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
  /** The agent, model and variant its last message used: the plugin's own prompts keep them. */
  using?: Json
  /** A Stop check under way. */
  checking?: boolean
  listener?: Listener
  /** A listener was asked for while one was ending: start another once it has. */
  again?: boolean
  /** Deleted, or OpenCode is going: no listener again. */
  gone?: boolean
}

/** The plugin's hooks, with what it runs outside OpenCode (`deps`). */
export async function pendingYou(input: PluginInput, deps: Deps): Promise<Hooks> {
  const { client, directory } = input
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
        for (const each of present) deps.presence?.(each, 'live')
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
      const { data } = await client.session.get({ path: { id } })
      session.parent =
        isObject(data) && typeof data.parentID === 'string' && data.parentID ? data.parentID : null
    } catch {
      session.parent = null
    }
    return session
  }

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
          const delivered = await prompt(id, session, {
            type: 'text',
            text: wake.wake,
            metadata: { pendingyou: 'wake' },
          })
          listener.reply(JSON.stringify({ delivered }))
        }
      } catch {}
      if (session.listener === listener) session.listener = undefined
      if (session.again) listenFor(id, session)
    })()
  }

  /**
   * The session's last turn, from the message that started it, as the Stop check reads it: each message's role, the
   * error it ended with, and its text and tool parts (a card call's input, no tool's output).
   */
  const turnOf = (messages: Json[]): { id: string; messages: Json[] } | null => {
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
                {
                  type: 'text',
                  text: part.text.slice(0, TEXT_CHARS),
                  ...(part.synthetic === true ? { synthetic: true } : {}),
                  ...(mark ? { pendingyou: mark } : {}),
                },
              ]
            }
            if (part.type === 'tool' && typeof part.tool === 'string') {
              const state = isObject(part.state) ? part.state : {}
              return [
                {
                  type: 'tool',
                  tool: part.tool,
                  status: state.status,
                  ...(CARD_TOOL.test(part.tool) ? { input: state.input } : {}),
                },
              ]
            }
            return []
          }),
        }
      }),
    }
  }

  /** A session gone idle: the Stop check on its last turn, and the turn it asks for when it asks. */
  const idle = async (id: string) => {
    const session = await known(id)
    if (session.parent || session.checking) return
    session.checking = true
    try {
      const turn = turnOf(await messagesOf(id, TURN_MESSAGES))
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
      const went = await prompt(id, session, {
        type: 'text',
        text: decision.reason,
        synthetic: true,
        metadata: { pendingyou: 'stopcheck' },
      })
      if (went)
        await client.tui
          .showToast({ body: { title: 'Pending You', message: NUDGED, variant: 'info' } })
          .catch(() => {})
    } finally {
      session.checking = false
    }
  }

  return {
    async event({ event }) {
      try {
        const properties = isObject(event.properties) ? event.properties : {}
        if (event.type === 'session.created' && isObject(properties.info)) {
          const info = properties.info
          if (typeof info.id !== 'string') return
          const session = sessions.get(info.id) ?? {}
          session.fresh = true
          session.parent = typeof info.parentID === 'string' && info.parentID ? info.parentID : null
          sessions.set(info.id, session)
          if (!session.parent) live(info.id)
        } else if (event.type === 'session.deleted' && isObject(properties.info)) {
          const id = properties.info.id
          if (typeof id !== 'string') return
          const deleted = sessions.get(id)
          if (deleted) deleted.gone = true
          deleted?.listener?.stop()
          sessions.delete(id)
          closed(id)
        } else if (
          event.type === 'session.status' &&
          typeof properties.sessionID === 'string' &&
          isObject(properties.status) &&
          properties.status.type === 'idle'
        )
          await idle(properties.sessionID)
      } catch {}
    },

    async 'chat.message'(input, output) {
      try {
        const id = input.sessionID
        const session = await known(id)
        if (session.parent) return
        live(id)
        if (typeof output.message.id === 'string') session.turn = output.message.id
        // One of its own prompts: nothing to add.
        if (output.parts.some((part) => ourMark(part) !== null)) return
        session.using = {
          ...usingOf(output.message),
          ...(typeof input.agent === 'string' ? { agent: input.agent } : {}),
          ...(isObject(input.model) ? { model: input.model } : {}),
          ...(typeof input.variant === 'string' ? { variant: input.variant } : {}),
        }
        const first = !session.spoken
        session.spoken = true
        const said = (
          await deps.run('handoff', {
            cwd: directory,
            session_id: id,
            ...(first ? { source: session.fresh ? 'startup' : 'resume' } : {}),
          })
        ).trim()
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
        // A session resumed with cards still waiting is woken when they're answered, as one that posts them; and one
        // that may be handed a question keeps its listener (it stops by itself after 8 hours).
        if (first || deps.wanted?.(id)) listenFor(id, session)
      } catch {}
    },

    async 'tool.execute.after'(input, output) {
      try {
        if (!CARD_TOOL.test(input.tool)) return
        const session = await known(input.sessionID)
        // A subagent's card wakes the session it works for.
        const id = session.parent ?? input.sessionID
        const owner = session.parent ? await known(id) : session
        await deps.run('posted', {
          session_id: id,
          ...(owner.turn ? { turn_id: owner.turn } : {}),
          cwd: directory,
          tool_name: input.tool,
          tool_input: input.args ?? {},
          tool_response: output,
        })
        listenFor(id, owner)
      } catch {}
    },

    async dispose() {
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
