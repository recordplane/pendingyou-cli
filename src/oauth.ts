// Signing the command line in: OAuth 2.1 against Pending You's own authorization server, as a native app (RFC 8252).
// It registers itself once per computer (dynamic client registration, as "Pending You CLI"), opens your browser on the
// consent page with PKCE (S256), and hears the code back on a one-time loopback address (127.0.0.1, any free port).
// The consent page recognises the command line by that name and the loopback address, and gives it a grant that only
// hears answers to your Claude Code assistants' questions: it isn't an assistant, and can't ask or answer anything.
// On a computer with no browser it signs in with a code instead (RFC 8628, signInWithDevice), and there `init` asks
// for more: a Claude Code connection of this computer's own, whose token Claude Code's MCP server uses too (remote.ts).
// Since 0.18.0 every device sign-in it starts also proves this computer's key (`attest`, machine.ts), dated by Pending
// You's own clock (its answers' Date), so the person allowing it enrolls this computer, known by its key.
//
// Access tokens last 15 minutes and refresh on their own; refresh tokens rotate on every use. Nothing here prints or
// logs a token, a code or a verifier.
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { Io } from './io.ts'
import { qrLines } from './qr.ts'
import { VERSION } from './version.ts'

/** The name the consent page knows the command line by (apps/pendingyou/worker/oauth/authorize.ts). */
export const CLIENT_NAME = 'Pending You CLI'
export const SCOPE = 'pendingyou'
/** Registered without a port: the server accepts any port on a loopback redirect (RFC 8252 §7.3). */
export const REDIRECT_URI = 'http://127.0.0.1/callback'
const SIGN_IN_MS = 5 * 60 * 1000

export class OAuthError extends Error {
  override name = 'OAuthError'
  /** The server's error code (`invalid_grant`, …) when it gave one; never its description, which may echo input. */
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export interface ServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  revocation_endpoint?: string
  /**
   * Not Pending You's to say: how far its clock was ahead of this computer's when it answered (its answer's Date),
   * in milliseconds (0.18.0). This computer's attestations are dated by it, so a clock that's off still proves its key.
   */
  clockOffsetMs?: number
}

/** Pending You's time now, by this computer's clock and how far off it was when Pending You last said (discover). */
export const serverNow = (io: Pick<Io, 'now'>, metadata: Pick<ServerMetadata, 'clockOffsetMs'>) =>
  io.now() + (metadata.clockOffsetMs ?? 0)

export interface Tokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

const base64url = (bytes: Buffer) =>
  bytes.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

export function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/** The resource the tokens are for: Pending You's MCP server, whose /mcp/cli/* the command line calls. */
export const resourceOf = (origin: string) => `${origin}/mcp`

export async function discover(
  io: Pick<Io, 'fetch'> & Partial<Pick<Io, 'now'>>,
  origin: string,
  timeoutMs = 15_000,
): Promise<ServerMetadata> {
  const response = await io.fetch(`${origin}/.well-known/oauth-authorization-server`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok)
    throw new OAuthError(
      'discovery',
      `Pending You at ${origin} didn’t answer (${response.status}).`,
    )
  const said = Date.parse(response.headers.get('date') ?? '')
  const metadata = {
    ...((await response.json()) as ServerMetadata),
    ...(io.now && Number.isFinite(said) ? { clockOffsetMs: said - io.now() } : {}),
  }
  const sameOrigin = (url: string | undefined) => {
    try {
      return url !== undefined && new URL(url).origin === origin
    } catch {
      return false
    }
  }
  // Every endpoint must be Pending You's own, or the sign-in could be sent somewhere else.
  if (
    new URL(metadata.issuer).origin !== origin ||
    !sameOrigin(metadata.authorization_endpoint) ||
    !sameOrigin(metadata.token_endpoint) ||
    (metadata.registration_endpoint !== undefined && !sameOrigin(metadata.registration_endpoint))
  )
    throw new OAuthError('discovery', `Pending You at ${origin} sent sign-in addresses elsewhere.`)
  return metadata
}

export async function register(io: Pick<Io, 'fetch'>, metadata: ServerMetadata): Promise<string> {
  if (!metadata.registration_endpoint)
    throw new OAuthError('registration', 'Pending You doesn’t take new sign-ins from here.')
  const response = await io.fetch(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      software_id: 'pendingyou-cli',
      software_version: VERSION,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = (await response.json().catch(() => ({}))) as { client_id?: unknown; error?: unknown }
  if (response.status !== 201 || typeof body.client_id !== 'string')
    throw new OAuthError(
      String(body.error ?? 'registration'),
      `Pending You didn’t register this computer (${response.status}).`,
    )
  return body.client_id
}

/** One sign-in's loopback listener: the redirect address, and the code once the browser comes back. */
interface Loopback {
  redirectUri: string
  code: Promise<{ code: string; iss: string | null }>
  close(): void
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px;color:#171b1f;background:#fff}@media (prefers-color-scheme:dark){body{color:#f0f1f3;background:#111214}}main{max-width:420px}h1{font-weight:500;font-size:24px}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`

async function listen(state: string, signal: AbortSignal): Promise<Loopback> {
  let settle: {
    resolve: (value: { code: string; iss: string | null }) => void
    reject: (error: Error) => void
  }
  const code = new Promise<{ code: string; iss: string | null }>((resolve, reject) => {
    settle = { resolve, reject }
  })
  // The browser can come back before anything awaits the code; the rejection is read when it's awaited.
  code.catch(() => {})
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/callback') {
      response.writeHead(404).end()
      return
    }
    const send = (status: number, title: string, body: string) => {
      response.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      })
      response.end(PAGE(title, body))
    }
    if (url.searchParams.get('state') !== state) {
      send(400, 'This sign-in didn’t match', 'Go back to the terminal and run the command again.')
      return
    }
    const error = url.searchParams.get('error')
    const given = url.searchParams.get('code')
    if (error || !given) {
      send(200, 'Not signed in', 'You can close this tab. The terminal says what happened.')
      settle.reject(
        new OAuthError(
          error ?? 'no_code',
          error === 'access_denied'
            ? 'You pressed Cancel, so the command line isn’t signed in.'
            : 'Pending You didn’t sign the command line in.',
        ),
      )
      return
    }
    send(200, 'You’re signed in', 'You can close this tab and go back to the terminal.')
    settle.resolve({ code: given, iss: url.searchParams.get('iss') })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const timer = setTimeout(
    () => settle.reject(new OAuthError('timeout', 'Nobody finished signing in within 5 minutes.')),
    SIGN_IN_MS,
  )
  const abort = () => settle.reject(new OAuthError('interrupted', 'Signing in was stopped.'))
  signal.addEventListener('abort', abort, { once: true })
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    code,
    close() {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      server.closeAllConnections?.()
      server.close()
    },
  }
}

/**
 * A DPoP proof (RFC 9449) for one request by this computer's key (machine.ts, machineProver), with the server's nonce
 * when it asked for one; null when none can be made.
 */
export type Prover = (request: {
  method: string
  url: string
  nonce?: string
  now: number
}) => Promise<string | null>

/**
 * A token request. With `prove`, it carries a proof by this computer's key (0.30.0): Pending You renews a computer's own
 * sign-in for 30 days whenever its refresh is proven so. Asked for a current nonce, it asks once more with it; asked
 * again, or when no proof can be made, it goes without one, as before: a refresh is never lost for want of a proof.
 */
async function tokenRequest(
  io: Pick<Io, 'fetch' | 'now'>,
  metadata: ServerMetadata,
  params: Record<string, string>,
  timeoutMs = 20_000,
  prove?: (nonce?: string) => Promise<string | null>,
): Promise<Tokens> {
  // One deadline for every try.
  const signal = AbortSignal.timeout(timeoutMs)
  const send = async (dpop: string | null) =>
    io.fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        ...(dpop ? { dpop } : {}),
      },
      body: new URLSearchParams(params).toString(),
      signal,
    })
  const proof = (nonce?: string) => (prove ? prove(nonce).catch(() => null) : null)
  let response = await send(await proof())
  let body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  for (const again of ['nonce', 'plain'] as const) {
    if (body.error !== 'use_dpop_nonce') break
    const nonce = response.headers.get('dpop-nonce')
    response = await send(again === 'nonce' && nonce ? await proof(nonce) : null)
    body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  }
  if (
    !response.ok ||
    typeof body.access_token !== 'string' ||
    typeof body.refresh_token !== 'string'
  ) {
    const code = typeof body.error === 'string' ? body.error : `http_${response.status}`
    throw new OAuthError(code, `Pending You refused the sign-in (${code}).`)
  }
  const seconds = typeof body.expires_in === 'number' ? body.expires_in : 900
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: io.now() + seconds * 1000,
  }
}

export interface SignInOptions {
  origin: string
  /** Open the browser (otherwise only print the address). */
  browser: boolean
}

/** The whole sign-in. Prints the address to open; returns the client id and tokens. */
export async function signIn(
  io: Pick<Io, 'fetch' | 'now' | 'openBrowser' | 'err' | 'signal'>,
  options: SignInOptions,
): Promise<{ clientId: string; tokens: Tokens }> {
  const metadata = await discover(io, options.origin)
  // A new registration each sign-in: sign-ins are rare, and an old client id may be one the server has forgotten.
  const clientId = await register(io, metadata)
  const state = base64url(randomBytes(16))
  const { verifier, challenge } = pkce()
  const loopback = await listen(state, io.signal)
  try {
    const authorizeUrl = (client: string) => {
      const url = new URL(metadata.authorization_endpoint)
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: client,
        redirect_uri: loopback.redirectUri,
        state,
        scope: SCOPE,
        resource: resourceOf(options.origin),
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString()
      return url.toString()
    }
    const url = authorizeUrl(clientId)
    const opened = options.browser ? await io.openBrowser(url) : false
    io.err(
      opened
        ? `Your browser is open on Pending You. Press Allow there.\nIf it didn’t open, go to:\n${url}\n`
        : `Open this address in your browser and press Allow:\n${url}\n`,
    )
    const { code, iss } = await loopback.code
    // RFC 9207: the code must come from the server we asked.
    if (iss !== null && iss !== metadata.issuer)
      throw new OAuthError('issuer', 'That sign-in came back from somewhere else.')
    const tokens = await tokenRequest(io, metadata, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: loopback.redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: resourceOf(options.origin),
    })
    return { clientId, tokens }
  } finally {
    loopback.close()
  }
}

/**
 * A new access token (and the next refresh token) from the current refresh token. At most 20 seconds in all, well
 * inside the credentials lock's 30 seconds, so no other process takes the lock over while a refresh is still running.
 */
export async function refresh(
  io: Pick<Io, 'fetch' | 'now'>,
  origin: string,
  clientId: string,
  refreshToken: string,
  prove?: Prover,
): Promise<Tokens> {
  const metadata = await discover(io, origin, 8_000)
  return tokenRequest(
    io,
    metadata,
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      resource: resourceOf(origin),
    },
    12_000,
    prove
      ? (nonce) =>
          prove({
            method: 'POST',
            url: metadata.token_endpoint,
            now: serverNow(io, metadata),
            ...(nonce ? { nonce } : {}),
          })
      : undefined,
  )
}

/** Revokes the sign-in on the server (RFC 7009). Best effort: signing out here still happens if this fails. */
export async function revoke(
  io: Pick<Io, 'fetch'>,
  origin: string,
  clientId: string,
  refreshToken: string,
): Promise<boolean> {
  try {
    const metadata = await discover(io, origin)
    const response = await io.fetch(metadata.revocation_endpoint ?? metadata.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: refreshToken,
        token_type_hint: 'refresh_token',
        client_id: clientId,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    })
    return response.ok
  } catch {
    return false
  }
}

interface DeviceStart {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval?: number
}

export interface DeviceSignInOptions {
  origin: string
  /** This computer's name (remote.ts's computerName): Pending You's /device asks "Let build-01 hear your answers…". */
  machine?: string
  /**
   * A Claude Code connection for this computer, named for it (remote.ts), rather than the command line's own sign-in,
   * which only hears answers. /device then asks the person to connect "Claude Code on <machine>". `assistant` names
   * another app's (0.11.0).
   */
  connection?: boolean
  /** The app a connection is for (0.11.0): `codex` asks to connect "Codex on <machine>". */
  assistant?: string
  /**
   * The client this computer's connection signed in with before (credentials.ts): tried first, so Pending You gives
   * this computer its connection back instead of adding another. A new one is registered when it's forgotten.
   */
  clientId?: string | null
  /**
   * Open this computer's browser on the page, with the code filled in (0.11.0): a computer with a browser. Otherwise
   * the code is shown for a phone, with a QR code at a terminal.
   */
  open?: boolean
  /**
   * This computer's key vouching for the sign-in (0.18.0, machine.ts): an attestation for the client it signs in with,
   * dated `now` (Pending You's time, in milliseconds), sent as `machine_attestation`. Whoever allows the sign-in enrolls
   * this computer by its key. None, or null: the sign-in says nothing of which computer it is.
   */
  attest?: (clientId: string, now: number) => Promise<string | null>
}

/** One started device sign-in: the code the person approves, and how to wait for it. */
export interface DeviceFlow {
  clientId: string
  deviceCode: string
  userCode: string
  /** Pending You's /device page, and the same with this code filled in. */
  page: string
  direct: string
  /** Milliseconds between polls, as Pending You asks. */
  interval: number
  expiresAt: number
}

/**
 * Starts a device sign-in (RFC 8628): a code for one app's connection (`assistant`), or for the command line's own
 * sign-in. Nothing is shown or waited for yet: several can be approved together (waitForDevices).
 */
export async function startDevice(
  io: Pick<Io, 'fetch' | 'now'>,
  options: Omit<DeviceSignInOptions, 'open'>,
): Promise<DeviceFlow> {
  const metadata = await discover(io, options.origin)
  const assistant = options.assistant ?? (options.connection ? 'claude-code' : undefined)
  // Each start proves this computer's key afresh, for the client it names: an attestation is good once.
  const begin = async (client: string) => {
    const attestation = options.attest
      ? await options.attest(client, serverNow(io, metadata))
      : null
    return io.fetch(`${options.origin}/oauth/device`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        client_id: client,
        scope: SCOPE,
        ...(options.machine ? { machine: options.machine } : {}),
        ...(assistant ? { assistant } : {}),
        ...(attestation ? { machine_attestation: attestation } : {}),
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    })
  }
  let clientId = options.clientId || (await register(io, metadata))
  let started = await begin(clientId)
  if (started.status === 401 && options.clientId) {
    // Pending You no longer knows that client (a registration lapses after 90 days unused): register again.
    await started.body?.cancel()
    clientId = await register(io, metadata)
    started = await begin(clientId)
  }
  const start = (await started.json().catch(() => ({}))) as Partial<DeviceStart> & {
    error?: string
  }
  if (!started.ok || typeof start.device_code !== 'string' || typeof start.user_code !== 'string')
    throw new OAuthError(
      start.error ?? `http_${started.status}`,
      start.error === 'slow_down'
        ? 'Too many sign-ins from here. Wait 10 minutes, then try again.'
        : `Pending You didn’t start a device sign-in (${started.status}).`,
    )
  const page = start.verification_uri ?? `${options.origin}/device`
  if (new URL(page).origin !== options.origin)
    throw new OAuthError('discovery', 'Pending You sent the sign-in page somewhere else.')
  const direct = start.verification_uri_complete ?? `${page}?code=${start.user_code}`
  return {
    clientId,
    deviceCode: start.device_code,
    userCode: start.user_code,
    page,
    direct: new URL(direct).origin === options.origin ? direct : `${page}?code=${start.user_code}`,
    interval: Math.max(1, start.interval ?? 5) * 1000,
    expiresAt: io.now() + Math.max(60, start.expires_in ?? 600) * 1000,
  }
}

/** One sign-in to wait for, and what it's for as the terminal names it ("Claude Code"; none for one alone). */
export interface DeviceAsk {
  flow: DeviceFlow
  label?: string
}

/** A code to show: where to approve it (one sign-in's own link, or /device), and the code itself. */
export interface ShownCode {
  flow: Pick<DeviceFlow, 'page' | 'direct' | 'userCode'>
  label?: string
}

/** How a device sign-in ended: its tokens, or why not (Cancel, the code ran out, a refusal). */
export type DeviceOutcome =
  | { ok: true; clientId: string; tokens: Tokens }
  | { ok: false; error: OAuthError }

/**
 * The page that approves every code at once: /device with each code (Pending You shows one consent card for them all,
 * with one Allow), or the one code's own link.
 */
export function deviceLink(asks: readonly ShownCode[]): string {
  const [first] = asks
  if (!first) throw new OAuthError('device', 'Nothing to sign in.')
  if (asks.length === 1) return first.flow.direct
  const url = new URL(first.flow.page)
  for (const ask of asks) url.searchParams.append('code', ask.flow.userCode)
  return url.toString()
}

/** "A and B", "A, B and C". */
const listed = (items: readonly string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

/**
 * Shows the codes: opens the browser on them where there is one, else for a phone, with a QR code at a terminal (an
 * app's own sign-in too: app-login.ts).
 */
export async function showDevices(
  io: Pick<Io, 'err' | 'openBrowser'> & Partial<Pick<Io, 'interactive' | 'env'>>,
  asks: readonly ShownCode[],
  open: boolean,
): Promise<void> {
  const link = deviceLink(asks)
  const codes = asks.map((ask) => ask.flow.userCode)
  const page = asks[0]?.flow.page ?? ''
  const labels = asks.flatMap((ask) => (ask.label ? [ask.label] : []))
  if (open && (await io.openBrowser(link))) {
    io.err(
      asks.length === 1
        ? `Your browser is open on Pending You: press Allow (code ${codes[0]}).\nIf it didn’t open, go to:\n${link}\n`
        : `Your browser is open on Pending You: press Allow once for ${listed(labels)} (codes ${listed(codes)}).\nIf it didn’t open, go to:\n${link}\n`,
    )
    return
  }
  const qr =
    io.interactive && new URL(link).origin === new URL(page).origin ? qrLines(link, io.env) : null
  if (asks.length === 1) {
    io.err(
      `On your phone or any browser, open ${page} and enter this code:\n\n    ${codes[0]}\n\n` +
        (qr
          ? `Or scan this with your phone’s camera, which opens it with the code filled in:\n\n${qr.join('\n')}\n\nOr go straight to ${link}\n`
          : `Or go straight to ${link}\n`) +
        'Waiting for you to press Allow…\n',
    )
    return
  }
  const width = Math.max(...codes.map((code) => code.length))
  io.err(
    `On your phone or any browser, open this to connect ${listed(labels)} with one Allow:\n\n    ${link}\n\n` +
      (qr ? `Or scan this with your phone’s camera:\n\n${qr.join('\n')}\n\n` : '') +
      `Or open ${page} and enter each code:\n\n${asks
        .map((ask) => `    ${ask.flow.userCode.padEnd(width)}  ${ask.label ?? ''}`.trimEnd())
        .join('\n')}\n\nWaiting for you to press Allow…\n`,
  )
}

/** One poll of a device sign-in: its tokens, still waiting (and whether to slow down), or how it ended. */
async function pollDevice(
  io: Pick<Io, 'fetch' | 'now'>,
  origin: string,
  flow: DeviceFlow,
): Promise<{ tokens: Tokens } | { waiting: 'pending' | 'slow_down' } | { error: OAuthError }> {
  const response = await io.fetch(`${origin}/oauth/device/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: flow.deviceCode,
      client_id: flow.clientId,
    }).toString(),
    signal: AbortSignal.timeout(20_000),
  })
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (
    response.ok &&
    typeof body.access_token === 'string' &&
    typeof body.refresh_token === 'string'
  ) {
    const seconds = typeof body.expires_in === 'number' ? body.expires_in : 900
    return {
      tokens: {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: io.now() + seconds * 1000,
      },
    }
  }
  const error = typeof body.error === 'string' ? body.error : `http_${response.status}`
  if (error === 'authorization_pending') return { waiting: 'pending' }
  if (error === 'slow_down') return { waiting: 'slow_down' }
  if (error === 'access_denied')
    return {
      error: new OAuthError(error, 'You pressed Cancel, so this computer isn’t signed in.'),
    }
  if (error === 'expired_token')
    return {
      error: new OAuthError(error, 'The code ran out. Run the command again for a new one.'),
    }
  return { error: new OAuthError(error, `Pending You refused the sign-in (${error}).`) }
}

/**
 * Shows every code at once (one link, which Pending You turns into one consent card with one Allow) and waits for each
 * of them: one poll each per interval, so several cost no more waiting than one. Resolves with each one's outcome, in
 * order; throws only when it's stopped (Ctrl-C). With several, says as each one lands what it's still waiting for.
 */
export async function waitForDevices(
  io: Pick<Io, 'fetch' | 'now' | 'sleep' | 'err' | 'signal' | 'openBrowser'> &
    Partial<Pick<Io, 'interactive' | 'env'>>,
  origin: string,
  asks: readonly DeviceAsk[],
  options: { open?: boolean } = {},
): Promise<DeviceOutcome[]> {
  await showDevices(io, asks, options.open ?? false)
  const outcomes: (DeviceOutcome | undefined)[] = asks.map(() => undefined)
  let interval = Math.max(...asks.map((ask) => ask.flow.interval))
  while (outcomes.some((outcome) => !outcome)) {
    await io.sleep(interval, io.signal)
    if (io.signal.aborted) throw new OAuthError('interrupted', 'Signing in was stopped.')
    for (const [index, ask] of asks.entries()) {
      if (outcomes[index]) continue
      if (io.now() > ask.flow.expiresAt) {
        outcomes[index] = {
          ok: false,
          error: new OAuthError(
            'expired_token',
            'The code ran out. Run the command again for a new one.',
          ),
        }
        continue
      }
      const polled = await pollDevice(io, origin, ask.flow)
      if ('waiting' in polled) {
        if (polled.waiting === 'slow_down') interval += 5000
        continue
      }
      outcomes[index] =
        'tokens' in polled
          ? { ok: true, clientId: ask.flow.clientId, tokens: polled.tokens }
          : { ok: false, error: polled.error }
      const left = asks.filter((_, other) => !outcomes[other])
      if (asks.length > 1 && left.length > 0 && 'tokens' in polled)
        io.err(
          `${ask.label ?? 'One'} is signed in. Still waiting for ${listed(
            left.map((each) => `${each.label ?? 'another'} (code ${each.flow.userCode})`),
          )}…\n`,
        )
    }
  }
  return outcomes as DeviceOutcome[]
}

/**
 * Device sign-in (RFC 8628) for one sign-in: shows its code (or opens the browser on it, `open`) and polls until the
 * person presses Allow (or Cancel, or the code runs out).
 */
export async function signInWithDevice(
  io: Pick<Io, 'fetch' | 'now' | 'sleep' | 'err' | 'signal'> &
    Partial<Pick<Io, 'interactive' | 'env' | 'openBrowser'>>,
  options: DeviceSignInOptions,
): Promise<{ clientId: string; tokens: Tokens }> {
  const flow = await startDevice(io, options)
  const [outcome] = await waitForDevices(
    { ...io, openBrowser: io.openBrowser ?? (async () => false) },
    options.origin,
    [{ flow }],
    { open: options.open ?? false },
  )
  if (!outcome) throw new OAuthError('device', 'Nothing to sign in.')
  if (!outcome.ok) throw outcome.error
  return { clientId: outcome.clientId, tokens: outcome.tokens }
}
