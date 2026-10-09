// The stdio bridge (0.12.0): `pendingyou mcp --app <id>`, a local MCP server for an app that can't give its MCP client a
// header from a command (Claude Code's headersHelper, Codex's http_headers_helper), so its pendingyou server signs in
// through this computer's own sign-in all the same: OpenCode, and Pi next. The app runs it as a local (stdio) server:
//
//   ~/.config/pendingyou/bin/pendingyou-mcp --app opencode [--origin <origin>]
//
// The launcher (a small sh script at that path, which never changes) finds Node as the headers helper does and runs
// this version's private copy (install.ts), so the app's config never changes when pendingyou is upgraded.
//
// It reads newline-delimited JSON-RPC from stdin and POSTs each message to `<origin>/mcp` (Streamable HTTP) with the
// app's own connection's token (credentials.ts, `<origin>#<app>`), refreshed in the background as the helper does
// (api.ts's helperToken). The answers go to stdout, one message per line: a JSON body as it is, or each event of an
// SSE stream. It keeps the server's Mcp-Session-Id, sends MCP-Protocol-Version after the handshake (and, for a
// 2026-07-28 request, mirrors its version, method and name into the headers that era asks for), starts the session
// again when the server has forgotten it (404), and after a 401 refreshes once, then answers with a JSON-RPC error that
// says to run init. Nothing but protocol messages ever goes to stdout; a few plain lines go to stderr; no token goes
// anywhere but to `origin`, and never to wherever a redirect points. docs/apps.md has the contract.
import { rm, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { helperToken, SignInNeeded } from './api.ts'
import { APP_NAMES, type AppId, DEFAULT_APP } from './apps/ids.ts'
import { DEFAULT_ORIGIN } from './args.ts'
import { readCredential } from './credentials.ts'
import { configDir } from './files.ts'
import { originArgs } from './hooks.ts'
import type { Installed } from './install.ts'
import type { Io } from './io.ts'
import {
  BARE_PATH,
  checkOutcome,
  HELPER_WAIT_MS,
  type HelperCheck,
  launcherScript,
  nodePathFile,
  USUAL_NODES,
  writeLauncher,
} from './remote.ts'
import { VERSION } from './version.ts'

type Json = Record<string, unknown>
type Id = string | number

export const BRIDGE = 'pendingyou-mcp'
/** The launcher an app's MCP config runs: the same path whatever the version. */
export const bridgePath = (io: Pick<Io, 'env' | 'home'>) => join(configDir(io), 'bin', BRIDGE)

/** JSON-RPC error codes the bridge answers with itself: its sign-in can't be used, or Pending You can't answer. */
export const SIGN_IN_ERROR = -32001
export const BRIDGE_ERROR = -32000
/** How long, once stdin has closed, the bridge waits for answers still on their way. */
const DRAIN_MS = 30_000
/** The most lines it writes to stderr: an app may never read them, and a full pipe would stall the bridge. */
const MAX_SAID = 20
const META_VERSION = 'io.modelcontextprotocol/protocolVersion'
/** Methods whose 2026-07-28 requests name their target in an Mcp-Name header, and where it is. */
const NAMED: Record<string, 'name' | 'uri'> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
}

/**
 * What an app's MCP config runs to reach Pending You through the bridge, as a program and its arguments: the launcher,
 * the app, and `--origin` off production. An app whose config takes one command line joins them with shell quoting.
 */
export function bridgeCommand(io: Pick<Io, 'env' | 'home'>, origin: string, app: AppId): string[] {
  return [bridgePath(io), '--app', app, ...(origin === DEFAULT_ORIGIN ? [] : ['--origin', origin])]
}

/**
 * Whether an MCP server's command runs our bridge: the launcher from any folder, or the command line itself
 * (`npx -y pendingyou mcp …`, `pendingyou mcp …`).
 */
export function isOurBridge(command: unknown): command is string[] {
  if (!Array.isArray(command) || !command.every((part) => typeof part === 'string')) return false
  const [program, ...args] = command as string[]
  if (program && basename(program) === BRIDGE) return true
  const at = args.indexOf('mcp')
  return at >= 0 && [program, ...args.slice(0, at)].some((part) => /pendingyou/.test(part ?? ''))
}

/** A bridge command's option (`--origin <it>` or `--origin=<it>`), when it has one. */
function optionOf(command: readonly string[], name: string): string | undefined {
  const at = command.indexOf(`--${name}`)
  if (at >= 0) return command[at + 1]
  return command.find((part) => part.startsWith(`--${name}=`))?.slice(name.length + 3)
}

/** The Pending You a bridge command is for: its `--origin`, else production. */
export function bridgeOrigin(command: readonly string[]): string {
  const value = optionOf(command, 'origin')
  try {
    return value ? new URL(value).origin : DEFAULT_ORIGIN
  } catch {
    return value ?? DEFAULT_ORIGIN
  }
}

/** The app a bridge command is for: its `--app`, else Claude Code. */
export function bridgeApp(command: readonly string[]): string {
  return optionOf(command, 'app') ?? DEFAULT_APP
}

/** The launcher's script, for this version's private copy (`cli`) and config folder. */
export function bridgeScript(
  cli: string,
  config: string,
  usual: readonly string[] = USUAL_NODES,
): string {
  return launcherScript(
    `# Pending You's stdio bridge for your agents' pendingyou MCP servers on this computer. An agent that can't sign in
# with a headers helper runs it as a local MCP server (with --app), and it passes each message on to Pending You with
# that app's own sign-in here. Written by npx pendingyou init (pendingyou ${VERSION}); run that again to repair it. It
# runs pendingyou's own copy, never npx, with the first Node it finds: on PATH, nvm's default, the one init ran with,
# or where Node usually is.`,
    'mcp',
    cli,
    config,
    usual,
  )
}

/** Writes the launcher for this version's private copy (unless it's already exactly that). Throws when it can't. */
export async function writeBridge(
  io: Pick<Io, 'env' | 'home'>,
  installed: Pick<Installed, 'script' | 'node'>,
): Promise<{ path: string; changed: boolean }> {
  return writeLauncher(io, bridgePath(io), bridgeScript(installed.script, configDir(io)), installed)
}

/** Removes the launcher, and the Node it shares with the helper (uninstall). True when there was one. */
export async function removeBridge(io: Pick<Io, 'env' | 'home'>): Promise<boolean> {
  const path = bridgePath(io)
  const there = await stat(path).then(
    () => true,
    () => false,
  )
  await rm(path, { force: true })
  await rm(nodePathFile(io), { force: true })
  await rmdir(dirname(path)).catch(() => {})
  return there
}

/**
 * Runs the launcher as an app would at its barest (PATH /usr/bin:/bin, no shell), in its check mode: it finds Node and
 * runs pendingyou's copy, which says which Node it is. Nothing is sent anywhere.
 */
export async function checkBridge(io: Io, origin: string, app: AppId): Promise<HelperCheck> {
  const [program, ...args] = bridgeCommand(io, origin, app) as [string, ...string[]]
  const exists = await stat(program).then(
    (info) => info.isFile(),
    () => false,
  )
  if (!exists) return { ok: false, why: `${program} is gone` }
  const result = await io.run(program, [...args, '--check'], 15_000, {
    env: { HOME: io.home, PATH: BARE_PATH },
  })
  return checkOutcome(result)
}

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isId = (value: unknown): value is Id =>
  typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))

/** The ids of the requests in a message (or a batch): the ones that wait for an answer. */
function requestIds(message: unknown): Id[] {
  if (Array.isArray(message)) return message.flatMap(requestIds)
  return isObject(message) && typeof message.method === 'string' && isId(message.id)
    ? [message.id]
    : []
}

const isRequest = (message: unknown, method: string): message is Json =>
  isObject(message) && message.method === method && isId(message.id)

/** A header value as MCP mirrors one: printable ASCII as it is, anything else in the base64 sentinel form. */
export function headerValue(text: string): string {
  return /^[\x20-\x7e]*$/.test(text)
    ? text
    : `=?base64?${Buffer.from(text, 'utf8').toString('base64')}?=`
}

/**
 * The headers that say which protocol a message speaks. A 2026-07-28 request carries its version in `params._meta`,
 * and the server wants it mirrored, with the method and (for a call, a prompt or a resource) its name; an earlier
 * client agrees a version in its handshake, which goes with every message after it.
 */
export function protocolHeaders(message: unknown, agreed: string | null): Record<string, string> {
  if (isObject(message) && typeof message.method === 'string') {
    const params = isObject(message.params) ? message.params : {}
    const meta = isObject(params._meta) ? params._meta : {}
    const declared = meta[META_VERSION]
    if (typeof declared === 'string') {
      const headers: Record<string, string> = {
        'mcp-protocol-version': declared,
        'mcp-method': message.method,
      }
      const field = NAMED[message.method]
      const name = field ? params[field] : undefined
      if (typeof name === 'string') headers['mcp-name'] = headerValue(name)
      return headers
    }
    if (message.method === 'initialize') return {}
  }
  return agreed ? { 'mcp-protocol-version': agreed } : {}
}

/** Why the bridge answers a request itself: a JSON-RPC error code and words for the person. */
class BridgeError extends Error {
  override name = 'BridgeError'
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

/** One app's bridge to one Pending You, and the session it keeps there. */
interface Relay {
  io: Io
  origin: string
  app: AppId
  session: {
    /** Mcp-Session-Id, once the server gave one. */
    id: string | null
    /** The version the client's handshake agreed, sent as MCP-Protocol-Version after it. */
    agreed: string | null
    /** The client's initialize, as it sent it: sent again when the server has forgotten the session. */
    initialize: string | null
    /** A new session being started, which every message that found the old one gone waits for. */
    reopening: Promise<void> | null
  }
  signal: AbortSignal
  write(message: unknown): void
  say(text: string): void
}

const initAgain = (origin: string) => `npx -y pendingyou@latest init${originArgs(origin)}`
const words = {
  notSignedIn: (relay: Relay) =>
    `${APP_NAMES[relay.app]} on this computer isn’t signed in to Pending You (${relay.origin}). Run: ${initAgain(relay.origin)}`,
  hearsOnly: (relay: Relay) =>
    `${APP_NAMES[relay.app]}’s sign-in on this computer only hears answers, so it can’t ask through Pending You. Run: ${initAgain(relay.origin)}`,
  ended: (relay: Relay) =>
    `${APP_NAMES[relay.app]}’s sign-in to Pending You (${relay.origin}) has ended. Run: ${initAgain(relay.origin)}`,
  unreachable: (relay: Relay) =>
    `Pending You (${relay.origin}) couldn’t be reached. Check this computer’s connection, then try again.`,
  problem: (status: number) => `Pending You had a problem (${status}). Try again in a minute.`,
  redirect: (relay: Relay, status: number) =>
    `Pending You at ${relay.origin} answered with a redirect (${status}), which the bridge doesn’t follow with your sign-in. Set it up for the address Pending You is at: npx -y pendingyou@latest init --origin <that address>`,
  cutOff: 'Pending You’s answer was cut off before it finished. Try again.',
  noAnswer: 'Pending You didn’t answer that. Try again.',
}

/** The app's token for this message: its connection's, refreshed first when it's due (or `force`d after a 401). */
async function tokenFor(relay: Relay, force: boolean): Promise<string> {
  const { io, origin, app } = relay
  const stored = await readCredential(io, origin, app)
  if (!stored) throw new BridgeError(SIGN_IN_ERROR, words.notSignedIn(relay))
  if (stored.kind !== 'connection') throw new BridgeError(SIGN_IN_ERROR, words.hearsOnly(relay))
  try {
    return await helperToken(io, origin, HELPER_WAIT_MS, app, force)
  } catch (error) {
    if (error instanceof SignInNeeded)
      throw new BridgeError(
        SIGN_IN_ERROR,
        error.ended ? words.ended(relay) : words.notSignedIn(relay),
      )
    throw new BridgeError(BRIDGE_ERROR, words.unreachable(relay))
  }
}

const drain = (response: Response) => response.body?.cancel().catch(() => {})

/**
 * POSTs one message to `<origin>/mcp` with the app's token, once more with a fresh token after a 401. A redirect is
 * never followed: it would take the token somewhere else.
 */
async function post(
  relay: Relay,
  body: string,
  headers: Record<string, string>,
): Promise<Response> {
  const attempt = async (force: boolean) => {
    const token = await tokenFor(relay, force)
    try {
      return await relay.io.fetch(`${relay.origin}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          ...(relay.session.id ? { 'mcp-session-id': relay.session.id } : {}),
          ...headers,
        },
        body,
        redirect: 'manual',
        signal: relay.signal,
      })
    } catch (error) {
      if (relay.signal.aborted) throw error
      throw new BridgeError(BRIDGE_ERROR, words.unreachable(relay))
    }
  }
  let response = await attempt(false)
  if (response.status === 401) {
    await drain(response)
    response = await attempt(true)
    if (response.status === 401) {
      await drain(response)
      throw new BridgeError(SIGN_IN_ERROR, words.ended(relay))
    }
  }
  if (response.status >= 300 && response.status < 400) {
    await drain(response)
    throw new BridgeError(BRIDGE_ERROR, words.redirect(relay, response.status))
  }
  return response
}

const mediaType = (header: string | null) =>
  (header ?? '').split(';')[0]?.trim().toLowerCase() ?? ''

/**
 * Reads an SSE stream to its end, handing each event's data (a JSON-RPC message) to `emit`. Event names, ids and
 * retry hints are let go: the bridge asks for no stream again (Last-Event-ID).
 */
async function events(
  response: Response,
  emit: (message: unknown) => void,
  say: (text: string) => void,
): Promise<void> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  const dispatch = () => {
    if (data.length === 0) return
    const text = data.join('\n')
    data = []
    try {
      emit(JSON.parse(text))
    } catch {
      say('Pending You sent an event that isn’t JSON; skipped it.')
    }
  }
  const take = (line: string) => {
    if (line === '') return dispatch()
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data.push(value)
  }
  for (;;) {
    const { value, done } = await reader.read()
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
    for (;;) {
      const end = buffer.search(/\r\n|\r|\n/)
      // A lone \r at the end may be the first half of \r\n: wait for the rest.
      if (end < 0 || (!done && end === buffer.length - 1 && buffer[end] === '\r')) break
      take(buffer.slice(0, end))
      buffer = buffer.slice(end + (buffer.startsWith('\r\n', end) ? 2 : 1))
    }
    if (done) break
  }
  if (buffer) take(buffer)
  dispatch()
}

/**
 * Hands the answer to one message to the app: each JSON-RPC message in it, on a line of its own. A request it doesn't
 * answer gets the bridge's own error, so the app never waits on an answer that won't come.
 */
async function answer(
  relay: Relay,
  response: Response,
  ids: readonly Id[],
  handshake: Id | undefined,
): Promise<void> {
  const answered = new Set<Id>()
  const emit = (message: unknown) => {
    relay.write(message)
    for (const each of Array.isArray(message) ? message : [message]) {
      if (!isObject(each) || 'method' in each || !isId(each.id)) continue
      answered.add(each.id)
      const result = isObject(each.result) ? each.result : null
      if (each.id === handshake && typeof result?.protocolVersion === 'string')
        relay.session.agreed = result.protocolVersion
    }
  }
  /** The bridge's own answer to each request the server didn't answer; for a message with none, a line on stderr. */
  const rest = (code: number, text: string) => {
    for (const id of ids)
      if (!answered.has(id)) relay.write({ jsonrpc: '2.0', id, error: { code, message: text } })
    if (ids.length === 0) relay.say(text)
  }
  const problem = words.problem(response.status)
  if (response.ok && mediaType(response.headers.get('content-type')) === 'text/event-stream') {
    try {
      await events(response, emit, relay.say)
    } catch (error) {
      if (relay.signal.aborted) throw error
      if (ids.length === 0) relay.say(words.cutOff)
    }
    if (ids.some((id) => !answered.has(id))) rest(BRIDGE_ERROR, words.cutOff)
    return
  }
  const body = await response.text().catch(() => '')
  let parsed: unknown
  try {
    parsed = body.trim() ? JSON.parse(body) : undefined
  } catch {}
  const error = isObject(parsed) && isObject(parsed.error) ? parsed.error : null
  const said = typeof error?.message === 'string' ? error.message : problem
  // A message that wanted no answer: the server's refusal goes to stderr, never to the app as an answer.
  if (ids.length === 0) {
    if (!response.ok) rest(BRIDGE_ERROR, said)
    else if (isObject(parsed) || Array.isArray(parsed)) emit(parsed)
    return
  }
  // An error the server couldn't tie to a request (a body it refused outright) is the error of each request in it.
  if (error && !isId((parsed as Json).id)) {
    rest(typeof error.code === 'number' ? error.code : BRIDGE_ERROR, said)
    return
  }
  if (isObject(parsed) || Array.isArray(parsed)) emit(parsed)
  if (ids.some((id) => !answered.has(id)))
    rest(BRIDGE_ERROR, response.ok ? words.noAnswer : problem)
}

/** Starts the session again after the server forgot it (404): the client's own initialize, then initialized. */
async function reopen(relay: Relay): Promise<void> {
  relay.session.id = null
  const initialize = relay.session.initialize
  if (!initialize) return
  const response = await post(relay, initialize, {})
  relay.session.id = response.headers.get('mcp-session-id') || null
  await response.text().catch(() => '')
  if (!response.ok) throw new BridgeError(BRIDGE_ERROR, words.problem(response.status))
  const initialized = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  await drain(await post(relay, initialized, protocolHeaders({}, relay.session.agreed)))
}

/** Passes one message from the app to Pending You, and its answer back. Never throws. */
async function relayOne(relay: Relay, text: string, message: unknown): Promise<void> {
  const ids = requestIds(message)
  const handshake = isRequest(message, 'initialize') ? (message.id as Id) : undefined
  try {
    if (handshake !== undefined) {
      relay.session.initialize = text
      relay.session.id = null
    }
    const used = relay.session.id
    let response = await post(relay, text, protocolHeaders(message, relay.session.agreed))
    if (response.status === 404 && used && handshake === undefined) {
      await drain(response)
      // Another message may have started the new session already.
      if (relay.session.id === used) {
        relay.session.reopening ??= reopen(relay).finally(() => {
          relay.session.reopening = null
        })
      }
      await relay.session.reopening
      response = await post(relay, text, protocolHeaders(message, relay.session.agreed))
    }
    if (handshake !== undefined) relay.session.id = response.headers.get('mcp-session-id') || null
    await answer(relay, response, ids, handshake)
  } catch (error) {
    if (relay.signal.aborted) return
    const failure =
      error instanceof BridgeError ? error : new BridgeError(BRIDGE_ERROR, words.unreachable(relay))
    for (const id of ids)
      relay.write({ jsonrpc: '2.0', id, error: { code: failure.code, message: failure.message } })
    if (ids.length === 0) relay.say(failure.message)
  }
}

/** Ends the session on the server when it gave one (DELETE), as the spec asks of a client that's done. Best effort. */
async function endSession(relay: Relay): Promise<void> {
  if (!relay.session.id) return
  try {
    const token = await tokenFor(relay, false)
    const response = await relay.io.fetch(`${relay.origin}/mcp`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${token}`,
        'mcp-session-id': relay.session.id,
        ...protocolHeaders({}, relay.session.agreed),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    })
    await drain(response)
  } catch {}
}

/** Waits for every message under way, `ms` at most (a real timer: nothing else is left to move a test's clock). */
function settle(running: ReadonlySet<Promise<void>>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    Promise.allSettled([...running]).then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function relayFor(
  io: Io,
  origin: string,
  app: AppId,
  signal: AbortSignal,
  write: (message: unknown) => void,
  say: (text: string) => void,
): Relay {
  return {
    io,
    origin,
    app,
    session: { id: null, agreed: null, initialize: null, reopening: null },
    signal,
    write,
    say,
  }
}

/**
 * `pendingyou mcp --app <id>`: the bridge, until stdin closes (it answers what's under way first, then exits 0) or
 * it's stopped. `--check` says which Node runs it instead, as the headers helper's does.
 */
export async function bridge(
  io: Io,
  options: { origin: string; app?: AppId; check?: boolean },
): Promise<number> {
  const app = options.app ?? DEFAULT_APP
  if (options.check) {
    io.out(
      `node ${io.execPath} (${io.env.PENDINGYOU_NODE_FROM || 'PATH'}), pendingyou ${VERSION}\n`,
    )
    return 0
  }
  const controller = new AbortController()
  const stop = () => controller.abort()
  if (io.signal.aborted) stop()
  io.signal.addEventListener('abort', stop, { once: true })
  let said = 0
  const relay = relayFor(
    io,
    options.origin,
    app,
    controller.signal,
    (message) => io.out(`${JSON.stringify(message)}\n`),
    (text) => {
      said++
      if (said <= MAX_SAID) io.err(`pendingyou mcp: ${text}\n`)
      else if (said === MAX_SAID + 1) io.err('pendingyou mcp: (saying nothing more here)\n')
    },
  )
  // Said once at the start when it can't work yet; each request's answer says it too, and init fixes it meanwhile.
  const stored = await readCredential(io, options.origin, app)
  if (!stored) relay.say(words.notSignedIn(relay))
  else if (stored.kind !== 'connection') relay.say(words.hearsOnly(relay))
  const running = new Set<Promise<void>>()
  // What comes after the handshake waits for its answer (the session and the version it agreed go with it), and what
  // comes after a message that wants no answer (a notification, a reply) waits for it to be taken: a server may need
  // `notifications/initialized` before anything else. Requests themselves run side by side.
  let opened: Promise<void> = Promise.resolve()
  const lines = io.lines()[Symbol.asyncIterator]()
  const stopped = new Promise<IteratorResult<string>>((resolve) => {
    const done = () => resolve({ done: true, value: undefined })
    if (controller.signal.aborted) done()
    else controller.signal.addEventListener('abort', done, { once: true })
  })
  try {
    for (;;) {
      const next = await Promise.race([lines.next(), stopped])
      if (next.done) break
      const text = next.value.trim()
      if (!text) continue
      let message: unknown
      try {
        message = JSON.parse(text)
      } catch {
        relay.write({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error: a line on stdin wasn’t JSON.' },
        })
        continue
      }
      const after = opened
      const task = after.then(() => relayOne(relay, text, message)).catch(() => {})
      if (isRequest(message, 'initialize') || requestIds(message).length === 0) opened = task
      running.add(task)
      task.then(() => running.delete(task))
    }
    await settle(running, DRAIN_MS)
  } finally {
    controller.abort()
    io.signal.removeEventListener('abort', stop)
    // Lets go of stdin (not waited for: a read under way may never finish).
    lines.return?.().catch(() => undefined)
  }
  await endSession(relay)
  await io.flush()
  return 0
}

/** A tool call Pending You refused, in its own words: a card that's closed, or changed since it was last read. */
export class ToolRefused extends Error {
  override name = 'ToolRefused'
}

/** Pending You couldn't be asked: the sign-in (SIGN_IN_ERROR: init has to run again) or the network (BRIDGE_ERROR). */
export class McpFailure extends Error {
  override name = 'McpFailure'
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

/** Pending You's tools, for a process of the command line's own: one call at a time, each answered or refused. */
export interface McpClient {
  /** A tool's structured result; ToolRefused when Pending You said no, McpFailure when it couldn't be asked. */
  call(name: string, args: Json): Promise<Json>
  /** Ends the session Pending You gave, if it gave one. */
  close(): Promise<void>
}

/** A tool's answer as Pending You gives it (worker/mcp/server.ts): its structured content, or its text as JSON. */
function resultOf(result: Json): Json {
  if (isObject(result.structuredContent)) return result.structuredContent
  const blocks = Array.isArray(result.content) ? result.content : []
  for (const block of blocks) {
    if (!isObject(block) || typeof block.text !== 'string') continue
    try {
      const parsed: unknown = JSON.parse(block.text)
      if (isObject(parsed)) return parsed
    } catch {}
  }
  return {}
}

/** The words of a refused tool call (its text content), cut short. */
function refusalOf(result: Json): string {
  const blocks = Array.isArray(result.content) ? result.content : []
  const text = blocks.find(
    (block): block is Json => isObject(block) && typeof block.text === 'string',
  )
  return typeof text?.text === 'string' ? text.text.slice(0, 300) : 'Pending You refused that.'
}

/**
 * A small MCP client over the bridge's own relay (0.13.0): what the permission-prompt cards' worker (permission.ts)
 * asks Pending You with. The handshake, then one tools/call at a time, each given up after `callMs`, with the app's
 * own connection (its token refreshed in the background, never a redirect followed), exactly as the bridge sends an
 * app's messages. Throws McpFailure when the handshake can't be made.
 */
export async function mcpClient(
  io: Io,
  origin: string,
  app: AppId,
  callMs = 15_000,
): Promise<McpClient> {
  const replies = new Map<Id, Json>()
  const relay = relayFor(
    io,
    origin,
    app,
    AbortSignal.timeout(callMs),
    (message) => {
      for (const each of Array.isArray(message) ? message : [message])
        if (isObject(each) && !('method' in each) && isId(each.id)) replies.set(each.id, each)
    },
    () => {},
  )
  let next = 0
  const send = async (message: Json) => {
    // Each message gets its own time limit; the session it keeps carries over.
    relay.signal = AbortSignal.timeout(callMs)
    await relayOne(relay, JSON.stringify(message), message)
  }
  const request = async (method: string, params: Json): Promise<Json> => {
    const id = `pendingyou-${++next}`
    await send({ jsonrpc: '2.0', id, method, params })
    const reply = replies.get(id)
    replies.delete(id)
    if (!reply) throw new McpFailure(BRIDGE_ERROR, words.noAnswer)
    if (isObject(reply.error))
      throw new McpFailure(
        typeof reply.error.code === 'number' ? reply.error.code : BRIDGE_ERROR,
        typeof reply.error.message === 'string' ? reply.error.message : words.noAnswer,
      )
    return isObject(reply.result) ? reply.result : {}
  }
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'pendingyou', version: VERSION },
  })
  await send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return {
    async call(name, args) {
      const result = await request('tools/call', { name, arguments: args })
      if (result.isError === true) throw new ToolRefused(refusalOf(result))
      return resultOf(result)
    },
    close: () => endSession(relay),
  }
}

/**
 * Whether the app's MCP server would reach Pending You through the bridge now (status): the handshake, sent as the
 * bridge sends it, with the app's sign-in. Null when it answered; else why not, in the words the bridge would use.
 */
export async function probeBridge(io: Io, origin: string, app: AppId): Promise<string | null> {
  const written: unknown[] = []
  const said: string[] = []
  const relay = relayFor(
    io,
    origin,
    app,
    AbortSignal.timeout(20_000),
    (message) => written.push(message),
    (text) => said.push(text),
  )
  const id = 'pendingyou-status'
  const message = {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'pendingyou status', version: VERSION },
    },
  }
  await relayOne(relay, JSON.stringify(message), message)
  await endSession(relay)
  const reply = written.find((each) => isObject(each) && each.id === id)
  if (isObject(reply) && isObject(reply.result)) return null
  if (isObject(reply) && isObject(reply.error) && typeof reply.error.message === 'string')
    return reply.error.message
  return said.at(-1) ?? 'Pending You didn’t answer.'
}
