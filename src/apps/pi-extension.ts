// Pending You's extension for Pi (0.12.0): what Pi loads to hear your answers, compiled to dist/apps/pi-extension.js
// and written by `npx pendingyou init` to ~/.config/pendingyou/pi/pendingyou.js with this computer's paths (pi.ts),
// which Pi's settings.json lists in its `extensions`. Pi has no hooks, so this is the thin part that stands in for
// them: each event runs the hooks' script, `pendingyou-hook <command> --app pi`, as Claude Code and Codex run it, with
// its input on stdin, and hands Pi what it printed.
//
// - A session starts (and on /reload, /new, /resume, /fork): `pickup` gives answers that arrived while nothing was
//   listening, for Pi's next turn. While Pending You says setup isn't finished, its line starts a turn by itself in a
//   session someone's at (Pi's terminal), as the wake mod does for Claude Code: setup finishes with nobody asking. A
//   turn an extension starts doesn't wait for Pi's MCP servers as a typed prompt does, so it waits for Pending You's
//   tools itself (up to 30 seconds), as does a wake.
// - Each message from the person: `handoff`'s line (and any answer waiting) goes with it.
// - Each of Pending You's card tools (post, update, reply, cancel): `posted` remembers the card for the session, and
//   the turn's words for the Stop check (codex-wake.ts).
// - A run that's about to settle: `stopcheck` reads its last message, and when it left the person something only in
//   chat, the run goes on once with the reason.
// - The wake: one listener per session (`listen --app pi`, the same as OpenCode's plugin runs), a child of this one
//   that waits on Pending You with Pi's own sign-in and prints `{"wake": …, "requests": […]}` when one of the
//   session's cards is the agent's move. That starts a turn when Pi is idle, or follows the current one, in the wake
//   mod's words, and the extension answers `{"delivered": true}` on the listener's stdin (only then is it handed over).
//   Never the answer itself: the agent reads it with get_request. The listener ends with Pi (its stdin closes), once
//   the session has no card left, or after its 8 hours, when the person's next message starts it again.
// - Since 0.14.0 the listener also wakes the session for a question the person handed it from another assistant (D21),
//   and runs while the session may be handed one: 12 hours after it last used the card tools, as `pi-threads.json`
//   says. `answer_delegated` and `hand_back` count among the card tools, and a run that such a question started says so
//   to the Stop check (`handed`), which then asks it to answer or hand back, never to post a card of its own.
//
// - Presence (0.15.0, presence.ts): a session that starts says it's live, every 5 minutes after while Pi runs, and
//   closed on `session_shutdown`, through `presence --state …`, started detached so Pi never waits on it.
//
// It never gets in the way: a hook that fails or takes too long gives nothing, and nothing here throws into Pi. It
// loads nothing but Node's own modules, because Pi loads it from a file of its own.
import { type ChildProcess, spawn as spawnProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** What init writes into the copy Pi loads: the hooks' script, the Pending You it's for, and the config folder. */
export interface PiSetup {
  /** ~/.config/pendingyou/bin/pendingyou-hook, which runs this version's private copy of the command line. */
  shim: string
  origin: string
  /** ~/.config/pendingyou: where the sessions' cards are remembered (pi-threads.json). */
  configDir: string
}

/** What a Pi message from the extension is: its type, its text, and whether the person sees it in the transcript. */
interface PiMessage {
  customType: string
  content: string
  display: boolean
}

/** The context Pi hands each handler (Pi 0.99 and later): the parts used here. */
export interface PiContext {
  cwd: string
  /** `tui` in Pi's terminal; `rpc`, `json` or `print` otherwise. */
  mode?: string
  sessionManager: { getSessionId(): string }
}

/** Pi's ExtensionAPI: the parts used here. */
export interface PiApi {
  on(event: string, handler: (event: never, ctx: PiContext) => unknown): unknown
  sendMessage(
    message: PiMessage,
    options?: { triggerTurn?: boolean; deliverAs?: 'steer' | 'followUp' | 'nextTurn' },
  ): void
  /** Every tool Pi has now, an MCP server's once it has connected. */
  getAllTools?(): { name: string }[]
}

/** What tests give instead of real processes and timers. */
export interface ExtensionOptions {
  spawn?: typeof spawnProcess
  setTimeout?: (run: () => void, ms: number) => unknown
  clearTimeout?: (timer: unknown) => void
}

/** The custom type of every message this extension sends. */
export const TYPE = 'pendingyou'
/** How long a hook may take, at most: each stops itself within 3 seconds of starting (the command line's deadline). */
export const HOOK_MS = 5000
/** How long after a session opens its setup turn starts: Pi has drawn its terminal and is connecting its servers. */
export const SETUP_AFTER_MS = 2000
/**
 * How often, and for how long, the setup turn waits for Pending You's tools. Pi waits for a server whose tools are
 * declared to the model before a prompt someone types (its MCP extension's before_agent_start), but a turn an
 * extension starts goes at once.
 */
export const READY_EVERY_MS = 500
export const READY_FOR_MS = 30_000
/** Pending You's whoami, the setup turn's first call, under any server name with pendingyou in it. */
const WHOAMI = /^mcp__[A-Za-z0-9_]*pendingyou[A-Za-z0-9_]*__whoami$/i
/** How long a closing session waits for its listener to let go of the session (a /reload starts the next one). */
const STOP_MS = 2000
/**
 * Pending You's card tools, under any server name with pendingyou in it (Pi names them mcp__<server>__<tool>), and
 * (0.14.0) the two that answer a question the person handed the session, or give it back.
 */
export const CARD_TOOL =
  /^mcp__[A-Za-z0-9_]*pendingyou[A-Za-z0-9_]*__(post_request|update_request|reply_in_thread|cancel_request|answer_delegated|hand_back)$/i
/** How long a session that used the card tools may be handed a question: the command line's HANDED_FOR_MS. */
export const HANDED_FOR_MS = 12 * 60 * 60_000
/** How a wake for a question the person handed the session starts: the command line's HANDED_PREFIX. */
export const HANDED_PREFIX = 'Pending You: your person handed you'
/** How a wake for a reply on one starts (0.15.0): the command line's isHandedWake. */
const HANDED_REPLY = ' on the question handed to you, '
const isHandedWake = (text: string) => {
  const first = text.trimStart().split('\n')[0] ?? ''
  return (
    first.startsWith(HANDED_PREFIX) ||
    (first.startsWith('Pending You: ') && first.includes(HANDED_REPLY))
  )
}
/** Each way a Pi session starts, as the session-start hook reads it: /new is a cleared session, /reload a new one. */
const SOURCES: Readonly<Record<string, string>> = {
  startup: 'startup',
  reload: 'startup',
  new: 'clear',
  resume: 'resume',
  fork: 'resume',
}
/**
 * What the session-start hook's setup lines say (the command line's setup.ts): these start a turn. 0.13.0's, and the
 * words before them (0.12.0's), which a shim run by an older init's copy may still print.
 */
export const SETUP_LINES = [
  ' is connected, but its setup isn’t finished. ',
  ' is connected, but setup’s test question isn’t sent yet. ',
  'Pending You: your person answered setup’s test question',
  'Pending You: this computer is connected (',
]
/** How often an open session says it's live: the command line's PRESENCE_EVERY_MS. */
export const PRESENCE_EVERY_MS = 5 * 60_000
/** The most of one string a card's call hands the hook: what a card says, to match an ask against (stopcheck.ts). */
const MAX_STRING = 20_000
const SESSION = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A tool's input with long strings (a screenshot's data, say) cut: the hook reads only a card's words. */
function clipped(value: unknown, depth = 0): unknown {
  if (typeof value === 'string')
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value
  if (depth > 8) return null
  if (Array.isArray(value)) return value.map((item) => clipped(item, depth + 1))
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clipped(item, depth + 1)]),
    )
  return value
}

/** The text of the run's last message from the agent: what it left the person with. */
export function finalText(messages: unknown): string {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index--) {
    const message: unknown = messages[index]
    if (!isObject(message) || message.role !== 'assistant') continue
    const blocks = Array.isArray(message.content) ? message.content : []
    return blocks
      .flatMap((block: unknown) =>
        isObject(block) && block.type === 'text' && typeof block.text === 'string'
          ? [block.text]
          : [],
      )
      .join('\n')
      .trim()
  }
  return ''
}

/**
 * Whether a run started with one of the wakes this extension sent for a question the person handed the session
 * (0.14.0): the last message before the agent's is the extension's own, in exactly a wake's words (`wakes`). Pi's
 * context holds the whole session, newest last.
 */
export function startedHanded(messages: unknown, wakes: ReadonlySet<string>): boolean {
  if (!Array.isArray(messages) || wakes.size === 0) return false
  for (let index = messages.length - 1; index >= 0; index--) {
    const message: unknown = messages[index]
    if (!isObject(message)) continue
    if (message.role === 'assistant' || message.role === 'toolResult') continue
    if (message.role !== 'custom' || (message.customType ?? TYPE) !== TYPE) return false
    const content = message.content
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .map((block: unknown) =>
                isObject(block) && typeof block.text === 'string' ? block.text : '',
              )
              .join('')
          : ''
    return wakes.has(text.trim())
  }
  return false
}

/**
 * Whether `pi-threads.json` says a session is worth a listener: cards waiting, or (0.14.0) a name it went by on the
 * card tools within HANDED_FOR_MS. False for anything it can't read.
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

/** The Stop check's reason to go on, from what it printed; null when it let the run settle. */
function reasonOf(printed: string): string | null {
  try {
    const decision: unknown = JSON.parse(printed)
    return isObject(decision) &&
      decision.decision === 'block' &&
      typeof decision.reason === 'string'
      ? decision.reason
      : null
  } catch {
    return null
  }
}

/** The words a listener's line carries to start a turn with (`{"wake": …, "requests": […]}`); null for anything else. */
function wakeOf(line: string): string | null {
  try {
    const said: unknown = JSON.parse(line)
    return isObject(said) && typeof said.wake === 'string' && said.wake ? said.wake : null
  } catch {
    return null
  }
}

/** Writes a line to a child's stdin while it's open: the listener's answer to a wake. */
function tell(child: ChildProcess, line: string): void {
  try {
    if (child.stdin?.writable) child.stdin.write(`${line}\n`)
  } catch {}
}

const unref = (handle: unknown) => {
  if (isObject(handle) && typeof handle.unref === 'function') (handle.unref as () => void)()
}

/** Pi's extension for this computer: `export default pendingYou({…})` in the file init writes. */
export function pendingYou(setup: PiSetup, options: ExtensionOptions = {}) {
  const spawn = options.spawn ?? spawnProcess
  const later = options.setTimeout ?? ((run: () => void, ms: number) => setTimeout(run, ms))
  const cancel =
    options.clearTimeout ??
    ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const args = (command: string, ...more: string[]) => [
    command,
    '--app',
    'pi',
    ...more,
    '--origin',
    setup.origin,
  ]

  return function pendingYouForPi(pi: PiApi): void {
    let session = ''
    let cwd = ''
    let closed = false
    /** This run's id, for the Stop check's record of what it posted; a run lasts until Pi settles. */
    let turn: string | null = null
    let nudged = false
    let posting: Promise<unknown> = Promise.resolve()
    let listener: ChildProcess | null = null
    /** A listener was asked for while one was ending: start another once it has. */
    let again = false
    /** The wakes it sent for questions handed to the session (0.14.0), so a run they started is known. */
    const handedWakes = new Set<string>()
    /** The session this extension said live (0.15.0), and its next heartbeat. */
    let present = ''
    let beat: unknown = null

    /** Says the session is live or closed (`presence`), detached: nothing waits on it, Pi's exit included. */
    const presence = (id: string, state: 'live' | 'closed') => {
      if (!id) return
      try {
        const child = spawn(
          setup.shim,
          args(
            'presence',
            '--state',
            state,
            '--session',
            id,
            '--at',
            String(Date.now()),
            ...(cwd ? ['--cwd', cwd] : []),
          ),
          { detached: true, stdio: 'ignore' },
        )
        child.on('error', () => {})
        unref(child)
      } catch {}
    }
    /** Says live every PRESENCE_EVERY_MS while the session is open. */
    const heartbeat = () => {
      beat = later(() => {
        if (closed || !present) return
        presence(present, 'live')
        heartbeat()
      }, PRESENCE_EVERY_MS)
      unref(beat)
    }

    /** Runs one of the command line's hooks for Pi with its input on stdin: what it printed, or '' on any problem. */
    const hook = (command: string, input: Json): Promise<string> =>
      new Promise((resolve) => {
        let out = ''
        let done = false
        let timer: unknown
        const finish = (said: string) => {
          if (done) return
          done = true
          cancel(timer)
          resolve(said)
        }
        let child: ChildProcess
        try {
          child = spawn(setup.shim, args(command), { stdio: ['pipe', 'pipe', 'ignore'] })
        } catch {
          resolve('')
          return
        }
        timer = later(() => {
          child.kill()
          finish('')
        }, HOOK_MS)
        child.stdout?.setEncoding('utf8')
        child.stdout?.on('data', (chunk: string) => {
          out += chunk
        })
        child.on('error', () => finish(''))
        child.on('close', () => finish(out.trim()))
        child.stdin?.on('error', () => {})
        child.stdin?.end(JSON.stringify(input))
      })

    /** Starts a turn with the message when Pi is idle, or after the one it's running; false when it couldn't. */
    const wake = (content: string): boolean => {
      if (closed) return false
      try {
        pi.sendMessage(
          { customType: TYPE, content, display: true },
          { triggerTurn: true, deliverAs: 'followUp' },
        )
        return true
      } catch {
        return false
      }
    }

    /** Gives Pi's next turn a message to read with it. */
    const nextTurn = (content: string) => {
      if (closed) return
      try {
        pi.sendMessage({ customType: TYPE, content, display: false }, { deliverAs: 'nextTurn' })
      } catch {}
    }

    /** Whether Pending You's tools are there for a turn to use (a Pi without getAllTools: taken as there). */
    const toolsReady = (): boolean => {
      try {
        return (
          typeof pi.getAllTools !== 'function' ||
          pi.getAllTools().some((tool) => WHOAMI.test(tool.name))
        )
      } catch {
        return false
      }
    }

    /** Runs `run` once Pending You's tools are there for the turn it starts, or once it has waited READY_FOR_MS. */
    const whenReady = (run: () => void, waited = 0) => {
      if (closed) return
      if (waited >= READY_FOR_MS || toolsReady()) run()
      else later(() => whenReady(run, waited + READY_EVERY_MS), READY_EVERY_MS)
    }

    /**
     * Whether the session has cards waiting on the person, as `posted` remembered them, or (0.14.0) may be handed a
     * question.
     */
    const waiting = (): boolean => {
      try {
        return wantsListener(
          JSON.parse(readFileSync(join(setup.configDir, 'pi-threads.json'), 'utf8')),
          session,
        )
      } catch {
        return false
      }
    }

    /**
     * Makes sure a session with cards waiting, or one that may be handed a question, has its listener, a child of this
     * extension that ends with Pi: as it starts, after a card call, and with each message (a listener stops by itself
     * after 8 hours).
     */
    const listen = () => {
      if (closed || !session) return
      // One may be on its way out (it found nothing to listen for a moment ago): start another once it's gone.
      if (listener) {
        again = true
        return
      }
      again = false
      if (!waiting()) return
      let child: ChildProcess
      try {
        child = spawn(setup.shim, args('listen', '--thread', session), {
          stdio: ['pipe', 'pipe', 'ignore'],
        })
      } catch {
        return
      }
      listener = child
      let buffer = ''
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        buffer += chunk
        for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
          const message = wakeOf(buffer.slice(0, end))
          buffer = buffer.slice(end + 1)
          if (message && isHandedWake(message)) {
            if (handedWakes.size >= 20) handedWakes.clear()
            handedWakes.add(message.trim())
          }
          // The turn goes once the tools it calls are there; the listener hears whether it went.
          if (message) whenReady(() => tell(child, JSON.stringify({ delivered: wake(message) })))
        }
      })
      const gone = () => {
        if (listener !== child) return
        listener = null
        if (again) listen()
      }
      child.on('error', gone)
      child.on('exit', gone)
      child.stdin?.on('error', () => {})
      // Its stdin stays open, so it stops when Pi does; nothing of it keeps Pi from exiting.
      unref(child)
      unref(child.stdin)
      unref(child.stdout)
    }

    pi.on('session_start', async (event: { reason?: unknown }, ctx: PiContext) => {
      try {
        const id = ctx.sessionManager.getSessionId()
        session = typeof id === 'string' && SESSION.test(id) ? id : ''
      } catch {
        session = ''
      }
      cwd = ctx.cwd
      if (session && session !== present) {
        if (present) presence(present, 'closed')
        present = session
        presence(session, 'live')
        cancel(beat)
        heartbeat()
      }
      const said = await hook('pickup', {
        cwd,
        session_id: session,
        source: SOURCES[String(event.reason)] ?? 'startup',
      })
      if (said && ctx.mode === 'tui' && SETUP_LINES.some((line) => said.includes(line)))
        // Setup isn't finished: a turn of its own once Pi is ready, as the wake mod starts one.
        // If Pending You's tools never come, the line waits for the next turn instead.
        later(() => whenReady(() => (toolsReady() ? wake(said) : nextTurn(said))), SETUP_AFTER_MS)
      else if (said) nextTurn(said)
      listen()
    })

    pi.on('before_agent_start', async (_event: unknown, ctx: PiContext) => {
      listen()
      const said = await hook('handoff', { cwd: ctx.cwd || cwd, session_id: session })
      return said ? { message: { customType: TYPE, content: said, display: false } } : undefined
    })

    pi.on(
      'tool_result',
      (event: {
        toolName?: unknown
        input?: unknown
        content?: unknown
        structuredContent?: unknown
        isError?: unknown
      }) => {
        if (event.isError === true || typeof event.toolName !== 'string') return
        if (!CARD_TOOL.test(event.toolName) || !session) return
        turn ??= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
        const input = {
          session_id: session,
          turn_id: turn,
          cwd,
          tool_name: event.toolName,
          tool_input: clipped(event.input ?? {}),
          // Pi's MCP results hand scripts the whole CallToolResult as their structuredContent.
          tool_response: isObject(event.structuredContent)
            ? event.structuredContent
            : { content: event.content },
        }
        posting = posting.then(() => hook('posted', input)).then(listen)
      },
    )

    pi.on(
      'agent_before_settle',
      async (event: {
        outcome?: unknown
        entries?: unknown
        context?: { contextMessages?: unknown }
      }) => {
        if (nudged || closed || event.outcome !== 'completed' || !session) return
        const text = finalText(event.context?.contextMessages)
        if (!text) return
        turn ??= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
        // What this run posted is written down first.
        let timer: unknown
        await Promise.race([
          posting,
          new Promise((resolve) => {
            timer = later(() => resolve(null), HOOK_MS)
          }),
        ])
        cancel(timer)
        const reason = reasonOf(
          await hook('stopcheck', {
            session_id: session,
            turn_id: turn,
            cwd,
            last_assistant_message: text,
            stop_hook_active: false,
            ...(startedHanded(event.context?.contextMessages, handedWakes) ? { handed: true } : {}),
          }),
        )
        if (!reason) return
        nudged = true
        const entries = Array.isArray(event.entries) ? event.entries : []
        return {
          entries: [
            ...entries,
            { type: 'custom_message', customType: TYPE, content: reason, display: true },
          ],
          continue: true,
        }
      },
    )

    pi.on('agent_settled', () => {
      turn = null
      nudged = false
    })

    pi.on('session_shutdown', async () => {
      closed = true
      cancel(beat)
      if (present) presence(present, 'closed')
      present = ''
      const child = listener
      listener = null
      if (!child || child.exitCode !== null || child.signalCode !== null) return
      // Its stdin closing stops it, and it lets go of the session for the next one (a /reload's); else it's stopped.
      await new Promise<void>((resolve) => {
        const timer = later(() => {
          child.kill()
          resolve()
        }, STOP_MS)
        child.once('exit', () => {
          cancel(timer)
          resolve()
        })
        try {
          child.stdin?.end()
        } catch {
          child.kill()
        }
      })
    })
  }
}
