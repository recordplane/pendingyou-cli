// Signing this computer's apps in (0.11.0): one sign-in per app per computer, and one approval for all of them.
//
// Each app init sets up gets its own sign-in (credentials.ts): its own connection on Pending You ("Codex on build-01"),
// which its MCP server signs in with through the headers helper and its hooks hear with, or, for an app whose MCP server
// signs in by itself, a sign-in that only hears. Every one is a device sign-in (oauth.ts) with a client of the app's
// own, started together and shown as one link, /device?code=A&code=B, which Pending You turns into one consent card
// naming each app and the computer, with one Allow. On a computer with a browser the browser opens on it; over SSH the
// codes and a QR code are shown for a phone. An app already signed in the way it needs is left as it is.
//
// Since 0.18.0 each of those sign-ins also proves this computer's key (machine.ts), made on the first one: whoever
// allows it enrolls this computer, known by its key, and the connections it makes belong to it.
import { getJson, SignInNeeded } from './api.ts'
import { APP_NAMES, type AppId, DEFAULT_APP, namesOf } from './apps/ids.ts'
import type { HeardFor, SignInCheck, SignInKind } from './apps/types.ts'
import {
  connectionClient,
  connectionMachine,
  readCredential,
  saveConnectionClient,
  signedInSlots,
  updateCredential,
} from './credentials.ts'
import { PlainError } from './errors.ts'
import { originArgs } from './hooks.ts'
import type { Io } from './io.ts'
import { attest, keyForSignIn, type MachineKey } from './machine.ts'
import {
  type DeviceAsk,
  type DeviceFlow,
  OAuthError,
  revoke,
  signIn,
  startDevice,
  type Tokens,
  waitForDevices,
} from './oauth.ts'
import { computerName, headlessReason, machineOf } from './remote.ts'
import { connectionTitle } from './setup.ts'

/**
 * Whether an app's sign-in works, how many connections it hears for, and which (with setup state, when it says). It
 * names the app (`source`) for every app but Claude Code, which Pending You takes by default: so a sign-in from before
 * 2026-10-04 pointed at another assistant still says which.
 */
export async function checkSignIn(
  io: Io,
  origin: string,
  app: AppId = DEFAULT_APP,
): Promise<SignInCheck> {
  try {
    const { status, body } = await getJson<{ connections?: number; for?: HeardFor }>(
      io,
      origin,
      `/mcp/cli/answers?limit=0${app === DEFAULT_APP ? '' : `&source=${app}`}`,
      15_000,
      io.signal,
      { app },
    )
    if (status !== 200) return { state: 'unreachable' }
    return {
      state: 'ok',
      connections: body.connections ?? 0,
      ...(body.for && typeof body.for.name === 'string' ? { for: body.for } : {}),
    }
  } catch (error) {
    if (error instanceof SignInNeeded) return { state: error.ended ? 'ended' : 'none' }
    return { state: 'unreachable' }
  }
}

/** What a computer's connection for an app is called: "Codex on build-01". */
export const titleOf = (app: AppId, machine: string | null | undefined) =>
  machine ? `${APP_NAMES[app]} on ${machine}` : `${APP_NAMES[app]} on this computer`

/** An app's connection's title, by the name it signed in with, else this computer's hostname. */
export const titleHere = async (io: Io, origin: string, app: AppId) =>
  titleOf(app, (await connectionMachine(io, origin, app)) ?? machineOf(io.host))

/** How to give this computer's connection another name: sign in again under it, which renames the connection. */
const renameAdvice = (origin: string, app: AppId) =>
  `To call it something friendlier, run: npx pendingyou login --name <name>${app === DEFAULT_APP ? '' : ` --app ${app}`}${originArgs(origin)}\n`

/** The sign-in one app needs now. */
export interface SignInNeed {
  app: AppId
  kind: SignInKind
}

/** How one app's sign-in went. */
export type SignedIn = 'signed-in' | 'already' | 'denied' | 'failed'

export interface SignInOptions {
  origin: string
  /** `--device` true (show the code for a phone), `--browser` false (open the browser anyway), null: by looking. */
  device: boolean | null
  /** False with `--no-browser`: never open it. */
  browser: boolean
  /** `--name`: what to call this computer. */
  machine?: string
  /** Sign in again even when the sign-in there still works (`login --force`). */
  force?: boolean
  /**
   * This computer's key (machine.ts), which every sign-in proves: init's, made before it signs anything in. Left out:
   * read or made here; null: none (it can't be read), and the sign-ins say nothing of which computer this is.
   */
  key?: MachineKey | null
}

/** Whether an app's sign-in is already the kind it needs, and still works: then there's nothing to approve. */
async function alreadySignedIn(
  io: Io,
  origin: string,
  need: SignInNeed,
  machine: string | undefined,
): Promise<boolean> {
  const current = await readCredential(io, origin, need.app)
  if (!current) return false
  // A connection hears only its own cards: an app that signs in by itself needs a sign-in that hears for all of them.
  if ((current.kind === 'connection') !== (need.kind === 'connection')) return false
  const check = await checkSignIn(io, origin, need.app)
  if (check.state !== 'ok') return false
  // Another name for this computer's connection signs in again (one approval), which renames it on Pending You.
  if (need.kind === 'connection' && machine !== undefined) {
    const known = check.for?.machine ?? (await connectionMachine(io, origin, need.app))
    if (machine !== known) return false
  }
  return true
}

/**
 * Signs in every app that needs it, with one approval: one device sign-in each (a connection, `assistant=<app>`, with
 * the client the app's connection used before; or one that only hears), shown as one link. An app whose sign-in is
 * already what it needs is left alone (`already`). Each sign-in it replaces is revoked, so one is live per app. Says
 * what each became. Throws when nobody approved anything (Cancel, or the codes ran out): nothing is changed then.
 */
export async function signInApps(
  io: Io,
  needs: readonly SignInNeed[],
  options: SignInOptions,
): Promise<Map<AppId, SignedIn>> {
  const { origin } = options
  const result = new Map<AppId, SignedIn>()
  const todo: SignInNeed[] = []
  for (const need of needs)
    if (!options.force && (await alreadySignedIn(io, origin, need, options.machine)))
      result.set(need.app, 'already')
    else todo.push(need)
  if (todo.length === 0) {
    io.out(`Already signed in to Pending You at ${origin}.\n`)
    return result
  }
  // What the phone and the Assistants page call this computer: --name, the Mac's own name, Tailscale's, the hostname.
  const named = await computerName(io, options.machine)
  // This computer's key, vouching for each sign-in: for the client it signs in with, under the name it gives.
  const key = options.key === undefined ? await keyForSignIn(io) : options.key
  const vouch = key
    ? (clientId: string, now: number) =>
        attest(
          key,
          { aud: `${origin}/oauth/device`, client_id: clientId, name: named.name },
          now,
        ).catch(() => null)
    : undefined
  const started: { need: SignInNeed; flow: DeviceFlow }[] = []
  for (const need of todo) {
    try {
      const flow = await startDevice(io, {
        origin,
        machine: named.name,
        ...(vouch ? { attest: vouch } : {}),
        ...(need.kind === 'connection'
          ? { assistant: need.app, clientId: await connectionClient(io, origin, need.app) }
          : {}),
      })
      started.push({ need, flow })
    } catch (error) {
      result.set(need.app, 'failed')
      // A Pending You from before this app could connect by code refuses it: say so, and set up the others.
      io.err(
        error instanceof OAuthError && error.code === 'invalid_request'
          ? `pendingyou: Pending You at ${origin} doesn’t connect ${APP_NAMES[need.app]} this way yet, so it isn’t set up. Try again once it’s updated.\n`
          : `pendingyou: ${error instanceof OAuthError || error instanceof PlainError ? error.message : 'Pending You couldn’t be reached.'} ${APP_NAMES[need.app]} isn’t signed in.\n`,
      )
    }
  }
  if (started.length === 0) throw new PlainError('Nothing could be signed in.')
  const headless = headlessReason(io)
  const open =
    options.browser && (options.device === false || (options.device === null && !headless))
  const asks: DeviceAsk[] = started.map(({ need, flow }) => ({
    flow,
    label: need.kind === 'connection' ? APP_NAMES[need.app] : `${APP_NAMES[need.app]}’s answers`,
  }))
  const outcomes = await waitForDevices(io, origin, asks, { open })
  let approved = 0
  let refusal: OAuthError | null = null
  for (const [index, { need }] of started.entries()) {
    const outcome = outcomes[index]
    if (!outcome?.ok) {
      result.set(need.app, outcome?.error.code === 'access_denied' ? 'denied' : 'failed')
      refusal ??= outcome?.error ?? null
      continue
    }
    approved++
    result.set(
      need.app,
      await keepSignIn(io, origin, need, outcome.clientId, outcome.tokens, named.name),
    )
  }
  if (approved === 0) throw refusal ?? new PlainError('Nothing was signed in.')
  for (const [app, how] of result)
    if (how === 'denied')
      io.err(`pendingyou: You pressed Cancel for ${APP_NAMES[app]}, so it isn’t set up.\n`)
  const connected = todo.filter(
    (need) => need.kind === 'connection' && result.get(need.app) === 'signed-in',
  )
  if (connected.length)
    io.out(
      `Signed in: ${connected.length === 1 ? titleOf((connected[0] as SignInNeed).app, named.name) : `${namesOf(connected.map((need) => need.app))} on ${named.name}`} can ask you questions and hear your answers${headless ? ', with no browser here' : ''}.\n`,
    )
  const hearing = todo.filter(
    (need) => need.kind === 'hear' && result.get(need.app) === 'signed-in',
  )
  if (hearing.length)
    io.out(
      hearing.length === 1 && hearing[0]?.app === DEFAULT_APP
        ? 'Signed in. Claude Code on this computer can now hear your answers from Pending You, even while it’s idle.\n'
        : `Signed in. ${namesOf(hearing.map((need) => need.app))} on this computer can now hear your answers from Pending You.\n`,
    )
  // A cloud's own name ("ip-10-42-1-252"): kept, since there's nothing better, with how to change it.
  if (connected.length && named.unfriendly)
    io.out(
      `It’s named after this computer’s hostname. ${renameAdvice(origin, (connected[0] as SignInNeed).app)}`,
    )
  return result
}

/**
 * Keeps an app's new sign-in, revoking the one it replaces, and remembers a connection's client (so signing in again
 * keeps the one connection). A connection's sign-in hears for that connection, by name: a Pending You from before
 * connections by code answers with a sign-in that only hears instead, whose token /mcp refuses, so it's kept as that and
 * never handed to the app.
 */
async function keepSignIn(
  io: Io,
  origin: string,
  need: SignInNeed,
  clientId: string,
  tokens: Tokens,
  machine: string,
): Promise<SignedIn> {
  const previous = await readCredential(io, origin, need.app)
  const connection = need.kind === 'connection'
  await updateCredential(
    io,
    origin,
    () => ({
      clientId,
      ...tokens,
      signedInAt: new Date(io.now()).toISOString(),
      ...(connection ? { kind: 'connection' as const } : {}),
    }),
    need.app,
  )
  if (connection) await saveConnectionClient(io, origin, clientId, machine, need.app)
  if (previous && previous.refreshToken !== tokens.refreshToken)
    await revoke(io, origin, previous.clientId, previous.refreshToken)
  if (!connection) return 'signed-in'
  const check = await checkSignIn(io, origin, need.app)
  if (check.state === 'ok' && !check.for) {
    await updateCredential(
      io,
      origin,
      (current) => (current ? { ...current, kind: undefined } : null),
      need.app,
    )
    throw new PlainError(
      need.app === DEFAULT_APP
        ? `Pending You at ${origin} doesn’t connect Claude Code on a computer with no browser yet, so this computer is signed in only to hear answers. Try again once it’s updated.`
        : `Pending You at ${origin} doesn’t connect ${APP_NAMES[need.app]} by code yet, so this computer is signed in only to hear its answers. Try again once it’s updated.`,
    )
  }
  return 'signed-in'
}

/**
 * `pendingyou login`: signs one app in again (Claude Code's when none is named): its own connection when its MCP server
 * signs in through this computer's (`connection`), else a sign-in that only hears. One that still works is left alone,
 * unless `--force`, or `--name` gives the connection another name.
 */
export async function login(
  io: Io,
  options: SignInOptions & { app: AppId; connection: boolean },
): Promise<number> {
  const need: SignInNeed = { app: options.app, kind: options.connection ? 'connection' : 'hear' }
  if (!options.force && (await alreadySignedIn(io, options.origin, need, options.machine))) {
    io.out(
      options.app === DEFAULT_APP
        ? `Already signed in to Pending You at ${options.origin}.\n`
        : `${APP_NAMES[options.app]} is already signed in to Pending You at ${options.origin}.\n`,
    )
    return 0
  }
  // A sign-in that only hears, on a computer with its browser: the browser's own sign-in, as before 0.11.0.
  const device = options.device ?? headlessReason(io) !== null
  if (!options.connection && !device) {
    const previous = await readCredential(io, options.origin, options.app)
    const { clientId, tokens } = await signIn(io, {
      origin: options.origin,
      browser: options.browser,
    })
    await updateCredential(
      io,
      options.origin,
      () => ({ clientId, ...tokens, signedInAt: new Date(io.now()).toISOString() }),
      options.app,
    )
    if (previous) await revoke(io, options.origin, previous.clientId, previous.refreshToken)
    io.out(
      'Signed in. Claude Code on this computer can now hear your answers from Pending You, even while it’s idle.\n',
    )
    return 0
  }
  const signed = await signInApps(io, [need], { ...options, force: true })
  return signed.get(options.app) === 'signed-in' ? 0 : 1
}

/** `pendingyou logout`: one app's sign-in (Claude Code's when none is named), or every one with `--all`. */
export async function logout(
  io: Io,
  options: { origin: string; all: boolean; app?: AppId },
): Promise<number> {
  const slots = options.all
    ? await signedInSlots(io)
    : [{ origin: options.origin, app: options.app ?? DEFAULT_APP }]
  let any = false
  for (const { origin, app } of slots) {
    const stored = await readCredential(io, origin, app)
    if (!stored) continue
    any = true
    const revoked = await revoke(io, origin, stored.clientId, stored.refreshToken)
    await updateCredential(io, origin, () => null, app)
    const what = app === DEFAULT_APP ? origin : `${APP_NAMES[app]} at ${origin}`
    io.out(
      revoked
        ? `Signed out of ${what}.\n`
        : `Signed out of ${what} on this computer. Pending You couldn’t be reached to end the sign-in there; it ends within 30 days.\n`,
    )
  }
  if (!any) io.out('This computer wasn’t signed in.\n')
  return 0
}

/** "Codex on build-01", as a status line or uninstall names a connection: Pending You's name for it when it says. */
export const titleFrom = (check: SignInCheck, fallback: string) =>
  check.state === 'ok' && check.for ? connectionTitle(check.for) : fallback
