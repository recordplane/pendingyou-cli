// Herdr's socket API, for the plugin's own commands (herdr/command.ts): one JSON request a line over the Unix socket
// Herdr names in HERDR_SOCKET_PATH, answered on the same line's `id`; and a subscription, which keeps its connection
// open and streams events after `subscription_started`. Linux and macOS only, as the plugin is. The agents' writers use
// Herdr's command line instead (herdr.ts).
import { createConnection } from 'node:net'
import { PlainError } from '../errors.ts'

/** How long one request may take. */
export const REQUEST_MS = 5000
/** The most a subscription's unread buffer may hold before it's given up. */
const BUFFER_MAX = 16 * 1024 * 1024

/** What went wrong with Herdr, in words safe to print as they are (Herdr's own messages carry no secrets). */
export class HerdrError extends PlainError {
  override name = 'HerdrError'
  /** Herdr's error code (`pane_not_found`, `plugin_not_found`, `ui_busy`…), or ours: unreachable, closed, timeout. */
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

let sent = 0
const nextId = () => `pendingyou-${process.pid}-${++sent}`

/** Herdr's error on a line, as HerdrError. */
function errorOf(message: Json): HerdrError {
  const error = isObject(message.error) ? message.error : {}
  return new HerdrError(
    typeof error.code === 'string' ? error.code : 'error',
    typeof error.message === 'string' ? error.message : 'Herdr refused it.',
  )
}

/** Sends one request on a connection of its own and resolves with its result; rejects with a HerdrError. */
export function herdrRequest<T = Json>(
  socketPath: string,
  method: string,
  params: Json = {},
  timeoutMs = REQUEST_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = nextId()
    let buffer = ''
    let settled = false
    const socket = createConnection(socketPath)
    const finish = (error: HerdrError | null, value?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(value as T)
    }
    const timer = setTimeout(
      () => finish(new HerdrError('timeout', `Herdr didn’t answer ${method} in time.`)),
      timeoutMs,
    )
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        let message: unknown
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        // Ours, or an error Herdr couldn't tie to a request (an empty id).
        if (!isObject(message) || (message.id !== id && message.id !== '')) continue
        if (message.error !== undefined) return finish(errorOf(message))
        return finish(null, message.result)
      }
      if (buffer.length > BUFFER_MAX)
        finish(new HerdrError('too_large', 'Herdr’s answer was too big.'))
    })
    socket.on('error', (error: NodeJS.ErrnoException) =>
      finish(
        new HerdrError('unreachable', `Herdr isn’t reachable here (${error.code ?? 'error'}).`),
      ),
    )
    socket.on('close', () => finish(new HerdrError('closed', 'Herdr closed the connection.')))
  })
}

/** One event from a subscription: its kind (`pane_updated`…) and its data. */
export interface HerdrEvent {
  event: string
  data: Json
}

/**
 * A subscription to Herdr's events: `started` once Herdr says so, `onEvent` for each, and `done` with how it ended:
 * `lost` (Herdr's events_lost: it fell behind, so read everything again and subscribe again), `closed` (Herdr went),
 * `refused` (Herdr said no), or `stopped`.
 */
export interface HerdrSubscription {
  started: Promise<void>
  done: Promise<'lost' | 'closed' | 'refused' | 'stopped'>
  stop(): void
}

export function herdrSubscribe(
  socketPath: string,
  subscriptions: readonly Json[],
  onEvent: (event: HerdrEvent) => void,
): HerdrSubscription {
  type Ending = 'lost' | 'closed' | 'refused' | 'stopped'
  const id = nextId()
  const socket = createConnection(socketPath)
  let buffer = ''
  let ended = false
  let start: () => void = () => {}
  let failStart: (error: Error) => void = () => {}
  const started = new Promise<void>((resolve, reject) => {
    start = resolve
    failStart = reject
  })
  started.catch(() => {})
  let finish: (how: Ending) => void = () => {}
  const done = new Promise<Ending>((resolve) => {
    finish = resolve
  })
  const end = (how: Ending) => {
    if (ended) return
    ended = true
    failStart(new HerdrError(how, 'The subscription ended before it started.'))
    socket.destroy()
    finish(how)
  }
  socket.setEncoding('utf8')
  socket.on('connect', () =>
    socket.write(
      `${JSON.stringify({ id, method: 'events.subscribe', params: { subscriptions } })}\n`,
    ),
  )
  socket.on('data', (chunk: string) => {
    buffer += chunk
    for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (!isObject(message)) continue
      if (message.id === id || message.id === '') {
        if (message.error !== undefined)
          return end(errorOf(message).code === 'events_lost' ? 'lost' : 'refused')
        start()
        continue
      }
      if (typeof message.event === 'string' && isObject(message.data))
        try {
          onEvent({ event: message.event, data: message.data })
        } catch {}
    }
    if (buffer.length > BUFFER_MAX) end('lost')
  })
  socket.on('error', () => end('closed'))
  socket.on('close', () => end('closed'))
  return { started, done, stop: () => end('stopped') }
}
