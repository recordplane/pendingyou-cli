// Calls to Pending You with the command line's sign-in: a fresh access token (refreshed under the credentials lock,
// so a hold and a hook never spend the same refresh token), one retry after a 401, and plain errors.
//
// Hooks never refresh in their own process. A hook has a hard deadline (main.ts), and a refresh cut off halfway can
// end the sign-in: the server rotates the refresh token as it answers, and keeps exactly one earlier token valid
// (@cloudflare/workers-oauth-provider's previousRefreshTokenId). A refresh abandoned before its answer arrives is
// harmless on its own (the stored token is that earlier one, and still works), but if the server finishes it after a
// later refresh has stored a newer token, that newer token stops working and the next refresh gets invalid_grant. So
// a hook that needs a new token starts `pendingyou refresh` detached (background), which runs to the end under the
// lock whatever happens to the hook, and waits for it only briefly; until it lands the hook uses the token it has, or
// gives up and prints its plain fallback.
//
// Since 0.11.0 each app has its own sign-in (credentials.ts), and every call names the app it's for: its sign-in is
// the one used, and a session's request names it as `source` (routing by sender, 2026-10-04), so Pending You returns
// only that app's cards, never one Codex posted from the same folder to a Claude Code session there. `watch` names no
// app: it hands answers to a script, not a session, with Claude Code's sign-in as before.
import { type AppId, DEFAULT_APP } from './apps/ids.ts'
import {
  type Credential,
  credentialsPath,
  readCredential,
  updateCredential,
} from './credentials.ts'
import { isLocked } from './files.ts'
import type { Io } from './io.ts'
import { OAuthError, refresh } from './oauth.ts'

/** Refresh this long before the access token runs out. */
const EARLY_MS = 60_000
/** A hook starts a background refresh this long before the access token runs out, and goes on with the old one. */
export const SOON_MS = 5 * 60_000
/** How long a hook waits for a background refresh when its token runs out within seconds. */
export const REFRESH_WAIT_MS = 1200
/**
 * A hook's hard deadline, from the moment this process started: Claude Code gives a hook 10 seconds (init's
 * `timeout`), npx (hooks from before 0.7.0) takes about half a second before this process starts, and a normal hook
 * is done in well under one.
 * When it's reached, the hook prints its plain fallback (the hand-off's one-line reminder; nothing for pickup and
 * stopcheck) unless it already printed, and exits 0, whatever it was still waiting on (main.ts).
 */
export const HOOK_DEADLINE_MS = 3000
/**
 * What a patient hook (pickup, handoff) leaves before its deadline for the answers request, when its token has
 * already run out and it waits for the background refresh until then (0.26.0). A session idle past the token's 15
 * minutes waited only REFRESH_WAIT_MS, and gave up just before a refresh that took about 1.5 seconds landed
 * (2026-10-06): the answer waiting for it went unannounced.
 */
export const ANSWERS_ROOM_MS = 900
/** An access token with less than this left isn't worth sending. */
const USABLE_MS = 10_000

/** Not signed in on this computer (for this origin), or the sign-in ended: the person runs `pendingyou login`. */
export class SignInNeeded extends Error {
  override name = 'SignInNeeded'
  readonly ended: boolean
  constructor(ended: boolean) {
    super(ended ? 'The sign-in has ended.' : 'Not signed in.')
    this.ended = ended
  }
}

/** Pending You couldn't be reached, or had a problem: worth trying again later. */
export class Unavailable extends Error {
  override name = 'Unavailable'
  /** Seconds the server asked to wait, when it said. */
  readonly retryAfter: number | undefined
  constructor(message: string, retryAfter?: number) {
    super(message)
    this.retryAfter = retryAfter
  }
}

export type ApiIo = Pick<Io, 'env' | 'home' | 'fetch' | 'now' | 'sleep'>
type HookApiIo = ApiIo & Pick<Io, 'background'>

/**
 * Refreshes the sign-in under the lock unless it no longer needs it: a token with more than `earlyMs` left (or, when
 * `force`d after a 401, a refresh token another process already replaced) is used as it is.
 */
async function refreshStored(
  io: ApiIo,
  origin: string,
  stored: Credential,
  options: { force: boolean; earlyMs: number },
  app: AppId,
): Promise<Credential> {
  let ended = false
  const updated = await updateCredential(
    io,
    origin,
    async (current) => {
      if (!current) return null
      // Another process may have refreshed while this one waited for the lock.
      if (current.refreshToken !== stored.refreshToken && current.expiresAt - EARLY_MS > io.now())
        return current
      if (!options.force && current.expiresAt - options.earlyMs > io.now()) return current
      // This computer's own connection proves its key as it refreshes (0.30.0), so its sign-in lasts while it's used.
      const prove =
        current.kind === 'connection'
          ? await (await import('./machine.ts')).machineProver(io)
          : undefined
      try {
        const tokens = await refresh(io, origin, current.clientId, current.refreshToken, prove)
        return { ...current, ...tokens } satisfies Credential
      } catch (error) {
        if (
          error instanceof OAuthError &&
          (error.code === 'invalid_grant' || error.code === 'invalid_client')
        ) {
          ended = true
          return null
        }
        throw error
      }
    },
    app,
  )
  if (!updated) throw new SignInNeeded(ended)
  return updated
}

async function freshToken(io: ApiIo, origin: string, force: boolean, app: AppId): Promise<string> {
  const stored = await readCredential(io, origin, app)
  if (!stored) throw new SignInNeeded(false)
  if (!force && stored.expiresAt - EARLY_MS > io.now()) return stored.accessToken
  return (await refreshStored(io, origin, stored, { force, earlyMs: EARLY_MS }, app)).accessToken
}

/** What a process starts to refresh an app's sign-in in the background: `--app` only for an app but Claude Code. */
export const refreshArgs = (origin: string, app: AppId, force = false) => [
  'refresh',
  '--origin',
  origin,
  ...(app === DEFAULT_APP ? [] : ['--app', app]),
  ...(force ? ['--force'] : []),
]

/**
 * `pendingyou refresh`, what a hook starts in the background: refreshes the sign-in when it runs out within SOON_MS
 * (or `force`, after a 401), under the lock, to the end. Quiet; true when there's a sign-in afterwards.
 */
export async function refreshInBackground(
  io: ApiIo,
  origin: string,
  force: boolean,
  app: AppId = DEFAULT_APP,
): Promise<boolean> {
  const stored = await readCredential(io, origin, app)
  if (!stored) return false
  if (!force && stored.expiresAt - SOON_MS > io.now()) return true
  await refreshStored(io, origin, stored, { force, earlyMs: SOON_MS }, app)
  return true
}

/**
 * A hook's token: never refreshed here (see the top of this file). One that has already run out waits for the
 * background refresh `expiredWaitMs` when it's given (a patient hook: until close to its deadline), else
 * REFRESH_WAIT_MS, as one that runs out within seconds does.
 */
async function hookToken(
  io: HookApiIo,
  origin: string,
  force: boolean,
  signal: AbortSignal | undefined,
  app: AppId,
  expiredWaitMs?: number,
): Promise<string> {
  const stored = await readCredential(io, origin, app)
  if (!stored) throw new SignInNeeded(false)
  const left = stored.expiresAt - io.now()
  if (!force && left > SOON_MS) return stored.accessToken
  // One refresher at a time: a lock held now is a refresh (or a write) already under way.
  if (!(await isLocked(credentialsPath(io)))) io.background(refreshArgs(origin, app, force))
  // Still good for a few seconds: this request goes with it, the next one with the new token.
  if (!force && left > USABLE_MS) return stored.accessToken
  const wait = !force && left <= 0 && expiredWaitMs !== undefined ? expiredWaitMs : REFRESH_WAIT_MS
  const until = io.now() + wait
  while (io.now() < until && !signal?.aborted) {
    await io.sleep(50, signal)
    const current = await readCredential(io, origin, app)
    if (!current) throw new SignInNeeded(true)
    if (current.refreshToken !== stored.refreshToken) return current.accessToken
  }
  throw new Unavailable('The sign-in is being refreshed in the background.')
}

/**
 * How long the helper leaves a background refresh that ended without a new token (a network still coming up as a Mac
 * wakes) before it starts another (0.27.0). Long enough for one just started to take the lock (Node starting up); a
 * refresh under way holds the lock, and none is started beside it.
 */
export const REFRESH_RETRY_MS = 1500

/**
 * The token `pendingyou mcp-headers` hands an app's MCP server (remote.ts), and the stdio bridge sends with each
 * message (bridge.ts). The app runs the helper each time it connects and gives it 10 seconds, and the bridge may be
 * stopped at any moment, so, as for a hook, a refresh is never made in this process: within 5 minutes of expiry it
 * starts `pendingyou refresh` detached and waits for its token, up to `waitMs`, starting another every
 * REFRESH_RETRY_MS while none is under way (0.27.0: one that failed on the network was waited on to the end), then uses
 * the old one while it still works. A token handed over has at least 10 seconds left; the app runs the helper again on
 * a 401. `force` (the bridge, after a 401) refreshes whatever the expiry says, and hands over only the new token.
 */
export async function helperToken(
  io: HookApiIo,
  origin: string,
  waitMs: number,
  app: AppId = DEFAULT_APP,
  force = false,
): Promise<string> {
  const stored = await readCredential(io, origin, app)
  if (!stored) throw new SignInNeeded(false)
  if (!force && stored.expiresAt - io.now() > SOON_MS) return stored.accessToken
  const lock = credentialsPath(io)
  let started = Number.NEGATIVE_INFINITY
  const start = async () => {
    if (await isLocked(lock)) return
    io.background(refreshArgs(origin, app, force))
    started = io.now()
  }
  await start()
  const until = io.now() + waitMs
  while (io.now() < until) {
    await io.sleep(100)
    const current = await readCredential(io, origin, app)
    if (!current) throw new SignInNeeded(true)
    if (current.refreshToken !== stored.refreshToken) return current.accessToken
    if (io.now() - started >= REFRESH_RETRY_MS && io.now() + REFRESH_WAIT_MS < until) await start()
  }
  if (!force && stored.expiresAt - io.now() > USABLE_MS) return stored.accessToken
  throw new Unavailable('Pending You couldn’t be reached to refresh the sign-in.')
}

/** Aborts on `signal` or after `ms`, whichever comes first (AbortSignal.any needs Node 20.3). */
function either(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  if (!signal) return timeout
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal.aborted) abort()
  signal.addEventListener('abort', abort, { once: true })
  timeout.addEventListener('abort', abort, { once: true })
  return controller.signal
}

/**
 * GETs `path` on `origin` as the command line, with an app's sign-in (Claude Code's unless `app` says), and returns the
 * JSON body with its status. 401 after a refresh means the sign-in is over (revoked, or 30 days passed). Network
 * failures and 5xx are `Unavailable`. A `patient` hook (0.26.0: pickup and handoff, whose answers matter most) whose
 * token has run out waits for the background refresh until ANSWERS_ROOM_MS before its deadline.
 */
export function getJson<T>(
  io: ApiIo & Partial<Pick<Io, 'background' | 'uptime'>>,
  origin: string,
  path: string,
  timeoutMs: number,
  signal?: AbortSignal,
  options: { hook?: boolean; patient?: boolean; app?: AppId } = {},
): Promise<{ status: number; body: T }> {
  return callJson<T>(io, origin, path, null, timeoutMs, signal, options)
}

/**
 * POSTs JSON to `path` as getJson GETs (0.18.0: `init` and `pendingyou machine`, never a hook, which uses postJson):
 * the token refreshed here when it's due, one retry after a 401, and the JSON body back with its status.
 */
export function sendJson<T>(
  io: ApiIo,
  origin: string,
  path: string,
  body: unknown,
  timeoutMs: number,
  options: { app?: AppId } = {},
): Promise<{ status: number; body: T }> {
  return callJson<T>(io, origin, path, { body }, timeoutMs, undefined, options)
}

/** How long a patient hook started `uptime` ago can wait for a refresh and still ask before its deadline. */
export const expiredWait = (uptime: number) =>
  Math.max(0, HOOK_DEADLINE_MS - ANSWERS_ROOM_MS - uptime)

async function callJson<T>(
  io: ApiIo & Partial<Pick<Io, 'background' | 'uptime'>>,
  origin: string,
  path: string,
  send: { body: unknown } | null,
  timeoutMs: number,
  signal?: AbortSignal,
  options: { hook?: boolean; patient?: boolean; app?: AppId } = {},
): Promise<{ status: number; body: T }> {
  const app = options.app ?? DEFAULT_APP
  for (let attempt = 0; ; attempt++) {
    let token: string
    try {
      token =
        options.hook && io.background
          ? await hookToken(
              io as HookApiIo,
              origin,
              attempt > 0,
              signal,
              app,
              options.patient && io.uptime ? expiredWait(io.uptime()) : undefined,
            )
          : await freshToken(io, origin, attempt > 0, app)
    } catch (error) {
      if (error instanceof Unavailable) throw error
      if (error instanceof SignInNeeded) throw error
      throw new Unavailable('Pending You couldn’t be reached to refresh the sign-in.')
    }
    let response: Response
    try {
      response = await io.fetch(`${origin}${path}`, {
        ...(send ? { method: 'POST', body: JSON.stringify(send.body), redirect: 'manual' } : {}),
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(send ? { 'content-type': 'application/json' } : {}),
        },
        signal: either(signal, timeoutMs),
      })
    } catch (error) {
      if (signal?.aborted) throw error
      throw new Unavailable('Pending You couldn’t be reached.')
    }
    if (response.status === 401) {
      await response.body?.cancel()
      if (attempt === 0) continue
      await updateCredential(io, origin, () => null, app)
      throw new SignInNeeded(true)
    }
    if (response.status >= 500 || response.status === 429) {
      await response.body?.cancel()
      const retry = Number(response.headers.get('retry-after'))
      throw new Unavailable(
        `Pending You had a problem (${response.status}).`,
        Number.isFinite(retry) && retry > 0 ? retry : undefined,
      )
    }
    const body = (await response.json().catch(() => ({}))) as T
    return { status: response.status, body }
  }
}

/**
 * POSTs JSON to `path` on `origin` with an app's sign-in, as a hook does (0.15.0, presence.ts): the token is never
 * refreshed in this process (a refresh starts in the background), and a 401 isn't retried or taken as the end of the
 * sign-in, so nothing here can be cut off halfway (`force`, after a 401, waits briefly for a background refresh).
 * Resolves with the status and any `retry-after` seconds; network failures are `Unavailable`.
 */
export async function postJson(
  io: HookApiIo,
  origin: string,
  path: string,
  body: unknown,
  timeoutMs: number,
  options: { app?: AppId; signal?: AbortSignal; force?: boolean } = {},
): Promise<{ status: number; retryAfter?: number }> {
  const app = options.app ?? DEFAULT_APP
  const token = await hookToken(io, origin, options.force === true, options.signal, app)
  let response: Response
  try {
    response = await io.fetch(`${origin}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: either(options.signal, timeoutMs),
      redirect: 'manual',
    })
  } catch {
    throw new Unavailable('Pending You couldn’t be reached.')
  }
  await response.body?.cancel().catch(() => {})
  const retry = Number(response.headers.get('retry-after'))
  return {
    status: response.status,
    ...(Number.isFinite(retry) && retry > 0 ? { retryAfter: retry } : {}),
  }
}
