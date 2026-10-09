// `pendingyou app login | logout | status [<app>]` (0.21.0; the person API plan §3.3, §4, PR 13): signs in an app that
// acts as you, on this computer. The command line itself never answers anything: this only signs the app in, and the
// app answers with its own sign-in and its own key, only when you press something in it. The first is the Pending You
// plugin for Herdr (`herdr`, Pending You's own, by its slug), whose popup is this package's `herdr open`; any other
// registered app signs in by its client (`--client-id`).
//
// - login: a device sign-in (RFC 8628) through the SDK (src/sdk/, a copy of packages/sdk). The SDK makes a new key for
//   the app's grant (DPoP: its tokens are useless without it), and this computer's key (machine.ts) vouches for the
//   sign-in with an attestation naming the app, the computer and the new key's thumbprint, dated by Pending You's
//   clock. Whoever allows it sees the app and this computer by the name their account knows it by; a computer whose key
//   their account doesn't know is refused there, so `init` must have run here first. The sign-in and its private key go
//   in ~/.config/pendingyou/apps/<app>.json, in the SDK's own fileStore format (0600 in a 0700 folder, written whole,
//   locked for each refresh), which no agent's code path here reads: not the hooks, the helper, the bridge or `hold`.
//   Signing in again on this computer replaces the last sign-in (one per app and computer, on Pending You's side).
// - logout: ends the sign-in at Pending You (RFC 7009), then removes the file, whether or not Pending You was reached.
// - status: what each sign-in may do and for how long, as Pending You says it (`GET /v1/me`).
// Never prints a token or a key.
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppCommand } from './args.ts'
import { ignoreFolder } from './credentials.ts'
import { PlainError } from './errors.ts'
import { configDir } from './files.ts'
import { originArgs } from './hooks.ts'
import type { Io } from './io.ts'
import { attest, clockOffset, readMachine } from './machine.ts'
import { showDevices } from './oauth.ts'
import { computerName, headlessReason } from './remote.ts'
import {
  ApiError,
  type Client,
  type Credentials,
  createClient,
  deviceSignIn,
  type Me,
  SignedOutError,
  SignInError,
  signOut,
} from './sdk/index.ts'
import { fileStore } from './sdk/node.ts'
import { memoryStore, type Store } from './sdk/store.ts'

/** The person API's scopes, in its catalogue's order (packages/domain's V1_SCOPES). */
export const APP_SCOPES = [
  'cards:read',
  'cards:read:all',
  'cards:answer',
  'cards:reply',
  'cards:later',
  'cards:delegate',
  'assistants:read',
  'presence:desk',
] as const

/** Pending You's own apps that sign in here, by slug: their name, and what they ask for. */
export const FIRST_PARTY_APPS: Record<string, { name: string; scopes: readonly string[] }> = {
  // Everything: `cards:read:all` only puts the tick on the card, off unless the person ticks it.
  herdr: { name: 'Herdr', scopes: APP_SCOPES },
}

/** What a sign-in asks for when an app registered by its client says nothing. */
export const DEFAULT_SCOPES = ['cards:read'] as const

/** An app's name here: its file's (apps/<app>.json). */
export const APP_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/

/** A sign-in this close to its end is said to need renewing (the plan's §3.5: 3 days before). */
export const RENEW_WITHIN_MS = 3 * 24 * 60 * 60 * 1000

export const appsDir = (io: Pick<Io, 'env' | 'home'>) => join(configDir(io), 'apps')
export const appPath = (io: Pick<Io, 'env' | 'home'>, app: string) =>
  join(appsDir(io), `${app}.json`)

/** Where an app's sign-in is kept: the SDK's fileStore. */
export const appStore = (io: Pick<Io, 'env' | 'home'>, app: string): Store =>
  fileStore(appPath(io, app))

/** The app's name as people know it: Pending You's own by name, any other as it was signed in. */
export const appLabel = (app: string) => FIRST_PARTY_APPS[app]?.name ?? app

/** The app's sign-in here, or null when it has none. One that can't be read is a PlainError: never replaced quietly. */
export async function readAppSignIn(
  io: Pick<Io, 'env' | 'home'>,
  app: string,
): Promise<Credentials | null> {
  try {
    return await appStore(io, app).load()
  } catch {
    throw new PlainError(
      `${appLabel(app)}’s sign-in (${appPath(io, app)}) can’t be read. Sign in again to replace it: npx pendingyou app login ${app}`,
    )
  }
}

/** The person API as this app, through the SDK: DPoP, refresh and ETags, with this command line's network and clock. */
export function appClient(
  io: Pick<Io, 'env' | 'home' | 'fetch' | 'now' | 'sleep'>,
  app: string,
): Client {
  return createClient({
    store: appStore(io, app),
    fetch: io.fetch,
    now: () => io.now(),
    sleep: (ms, signal) => io.sleep(ms, signal),
  })
}

/** What a scope lets the app do, as the person reads it. */
const MAY: Record<string, string> = {
  'cards:read': 'see your cards',
  'cards:read:all': 'see all your cards',
  'cards:answer': 'answer them',
  'cards:reply': 'write to the assistant that asked',
  'cards:later': 'put them in Later',
  'cards:delegate': 'hand them to another assistant',
  'assistants:read': 'see your assistants',
  'presence:desk': 'keep your phone quiet while you use it',
}

/** "A and B", "A, B and C". */
const listed = (items: readonly string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

/** Whose cards the sign-in reaches: "cards from build-01's agents", or "all your cards". */
export function reachWords(me: Pick<Me, 'grant'>): string {
  return me.grant.reach === 'all' || !me.grant.machine
    ? 'all your cards'
    : `cards from ${me.grant.machine.name}’s agents`
}

/** "Herdr on build-01", as Pending You names the app's answers. */
export function signedInAs(app: string, me: Pick<Me, 'grant' | 'app'> | null): string {
  const name = FIRST_PARTY_APPS[app] ? appLabel(app) : (me?.app.name ?? app)
  return me?.grant.machine ? `${name} on ${me.grant.machine.name}` : name
}

/** A sign-in's refusal at its start or end, in plain words. */
function signInWords(error: SignInError, app: string): string {
  const name = appLabel(app)
  switch (error.code) {
    case 'access_denied':
      return `You pressed Cancel, so ${name} isn’t signed in.`
    case 'expired_token':
      return 'The code ran out. Run the command again for a new one.'
    case 'invalid_client':
      return FIRST_PARTY_APPS[app]
        ? `Pending You doesn’t let ${name} sign in yet.`
        : 'Pending You doesn’t know that app, or it doesn’t sign in with a code.'
    case 'invalid_request':
      return `Pending You didn’t take this computer’s key. Run npx -y pendingyou@latest init, then try again.`
    case 'invalid_scope':
      return `Pending You doesn’t let ${name} ask for that.`
    case 'slow_down':
      return 'Too many sign-ins from here. Wait 10 minutes, then try again.'
    case 'aborted':
      return 'Signing in was stopped.'
    default:
      return error.message
  }
}

export interface AppLoginOptions {
  app: string
  origin: string
  /** A registered app's client; none for Pending You's own (by slug). */
  clientId?: string
  /** `--name`: what to call this computer. */
  machine?: string
  /** What to ask for (a first-party app's own list, else DEFAULT_SCOPES, unless given). */
  scopes?: readonly string[]
  /** Open this computer's browser on the code (it has one, and it wasn't told not to). */
  open: boolean
}

/** Signs an app in by device code. What Pending You says the new sign-in is (null when it couldn't say), or a refusal. */
export async function signInApp(
  io: Io,
  options: AppLoginOptions,
): Promise<{ ok: true; me: Me | null } | { ok: false; said: string }> {
  const { app, origin } = options
  const name = appLabel(app)
  const firstParty = FIRST_PARTY_APPS[app]
  if (!firstParty && !options.clientId)
    return {
      ok: false,
      said: `Name ${app}’s client with --client-id, or sign in Pending You’s own: ${Object.keys(FIRST_PARTY_APPS).join(', ')}.`,
    }
  const machine = await readMachine(io)
  if (!machine)
    return {
      ok: false,
      said: `This computer isn’t set up with Pending You yet: run npx -y pendingyou@latest init${originArgs(origin)} first, then sign ${name} in.`,
    }
  const computer = (await computerName(io, options.machine)).name
  const offset = await clockOffset(io, origin)
  const before = await readAppSignIn(io, app).catch(() => null)
  await ignoreFolder(io).catch(() => {})
  let started: Awaited<ReturnType<typeof deviceSignIn>>
  try {
    started = await deviceSignIn({
      origin,
      ...(options.clientId ? { clientId: options.clientId } : { app }),
      scopes: options.scopes ?? firstParty?.scopes ?? DEFAULT_SCOPES,
      machine: computer,
      attest: (request) =>
        attest(
          machine,
          {
            aud: request.audience,
            ...(request.clientId ? { client_id: request.clientId } : { app }),
            name: computer,
            cnf: { jkt: request.jkt },
          },
          io.now() + offset,
        ),
      store: appStore(io, app),
      fetch: io.fetch,
      now: () => io.now(),
      sleep: (ms, signal) => io.sleep(ms, signal),
      signal: io.signal,
    })
  } catch (error) {
    if (error instanceof SignInError) return { ok: false, said: signInWords(error, app) }
    return { ok: false, said: `Pending You at ${origin} couldn’t be reached. Try again.` }
  }
  io.err(
    `Signing ${name} in on ${computer}. Once you allow it, ${name} can answer your cards when you press a key in it; high-stakes cards still open in Pending You.\n`,
  )
  await showDevices(
    io,
    [
      {
        flow: {
          page: started.verificationUri,
          direct: started.verificationUriComplete,
          userCode: started.userCode,
        },
      },
    ],
    options.open,
  )
  try {
    await started.signedIn
  } catch (error) {
    if (error instanceof SignInError) return { ok: false, said: signInWords(error, app) }
    return { ok: false, said: `Pending You at ${origin} couldn’t be reached. Try again.` }
  }
  // A sign-in at another Pending You (staging, then production) isn't replaced there: end it.
  if (before && before.origin !== origin)
    await signOut({ store: memoryStore(before), fetch: io.fetch }).catch(() => 'unreachable')
  const me = await appClient(io, app)
    .me()
    .catch(() => null)
  return { ok: true, me }
}

/** `pendingyou app login <app>`. */
async function login(io: Io, command: AppCommand & { app: string }): Promise<number> {
  const headless = headlessReason(io)
  const open =
    command.browser && (command.device === false || (command.device === null && !headless))
  const result = await signInApp(io, {
    app: command.app,
    origin: command.origin,
    ...(command.clientId ? { clientId: command.clientId } : {}),
    ...(command.machine ? { machine: command.machine } : {}),
    ...(command.scopes ? { scopes: command.scopes } : {}),
    open,
  })
  if (!result.ok) {
    io.err(`pendingyou: ${result.said}\n`)
    return 1
  }
  io.out(`${signedInWords(io, command.app, result.me)}\n`)
  return 0
}

/** What a new sign-in can do, said once it's allowed. */
export function signedInWords(io: Pick<Io, 'env' | 'home'>, app: string, me: Me | null): string {
  const name = appLabel(app)
  const answers = me ? me.grant.scopes.includes('cards:answer') : true
  return [
    me
      ? `${signedInAs(app, me)} is signed in: it ${answers ? 'answers' : 'sees'} ${reachWords(me)}${answers ? ', only when you press a key in it' : ''}.`
      : `${name} is signed in.`,
    `Its sign-in is in ${appPath(io, app)}, with a key that never leaves this computer.`,
    `To remove it: npx pendingyou app logout ${app}, or Settings › Apps and devices in Pending You.`,
  ].join('\n')
}

/** Ends an app's sign-in here: at Pending You first, then its file. */
export async function signOutApp(
  io: Pick<Io, 'env' | 'home' | 'fetch'>,
  app: string,
): Promise<{ said: 'signed-out' | 'none' | 'unreachable' | 'unreadable'; origin: string | null }> {
  const stored = await readAppSignIn(io, app).catch(() => undefined)
  const path = appPath(io, app)
  if (!stored) {
    // A file that isn't a sign-in goes too, though there's nothing in it to end at Pending You.
    const there = await rm(path).then(
      () => true,
      () => false,
    )
    return { said: there ? 'unreadable' : 'none', origin: null }
  }
  const said = await signOut({ store: memoryStore(stored), fetch: io.fetch })
  await rm(path, { force: true })
  return { said, origin: stored.origin }
}

/** `pendingyou app logout <app>`. */
async function logout(io: Io, app: string): Promise<number> {
  const { said, origin } = await signOutApp(io, app)
  const name = appLabel(app)
  io.out(
    said === 'none'
      ? `${name} wasn’t signed in here.\n`
      : said === 'signed-out'
        ? `Signed ${name} out of Pending You${origin ? ` at ${origin}` : ''}.\n`
        : said === 'unreadable'
          ? `Removed ${name}’s sign-in here, which couldn’t be read: remove it in Settings › Apps and devices too, or it ends by itself within 30 days.\n`
          : `Signed ${name} out on this computer. Pending You couldn’t be reached to end the sign-in there: remove it in Settings › Apps and devices, or it ends by itself within 30 days.\n`,
  )
  return 0
}

/** The apps signed in here: their names, from apps/<app>.json. */
export async function signedInApps(io: Pick<Io, 'env' | 'home'>): Promise<string[]> {
  const names = await readdir(appsDir(io)).catch(() => [] as string[])
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((name) => APP_NAME.test(name))
    .sort()
}

/** One app's status: its lines, and whether it's signed in and well. */
export async function appStatusLines(
  io: Pick<Io, 'env' | 'home' | 'fetch' | 'now' | 'sleep'>,
  app: string,
): Promise<{ ok: boolean; lines: string[] }> {
  const name = appLabel(app)
  let stored: Credentials | null
  try {
    stored = await readAppSignIn(io, app)
  } catch (error) {
    return { ok: false, lines: [`${name}: ${(error as Error).message}`] }
  }
  if (!stored)
    return {
      ok: false,
      lines: [`${name}: not signed in here. To sign it in: npx pendingyou app login ${app}`],
    }
  const again = `npx pendingyou app login ${app}${originArgs(stored.origin)}`
  let me: Me
  try {
    me = await appClient(io, app).me()
  } catch (error) {
    if (error instanceof SignedOutError)
      return {
        ok: false,
        lines: [
          `${name}: signed out at ${stored.origin} (removed in Settings, replaced by another sign-in, or ended). To sign in again: ${again}`,
        ],
      }
    if (error instanceof ApiError && error.code === 'app_not_available')
      return {
        ok: false,
        lines: [`${name}: signed in at ${stored.origin}, but Pending You doesn’t let it in now.`],
      }
    return {
      ok: false,
      lines: [
        `${name}: signed in at ${stored.origin}; Pending You couldn’t be reached to say more.`,
      ],
    }
  }
  const scopes = me.grant.scopes
  const may = scopes
    .filter((scope) => scope !== 'cards:read' || !scopes.includes('cards:read:all'))
    .map((scope) => MAY[scope] ?? scope)
  const ends = Date.parse(me.grant.expiresAt)
  const left = ends - io.now()
  const days = Math.max(0, Math.ceil(left / 86_400_000))
  return {
    ok: true,
    lines: [
      `${name}: signed in at ${stored.origin} as ${signedInAs(app, me)}`,
      `  It reaches ${reachWords(me)}. It may ${listed(may)}; never a high-stakes card.`,
      left <= RENEW_WITHIN_MS
        ? `  ! It ends in ${days} day${days === 1 ? '' : 's'} (${me.grant.expiresAt.slice(0, 10)}): sign in again before then: ${again}`
        : `  It ends on ${me.grant.expiresAt.slice(0, 10)}; sign in again then.`,
      `  Kept in ${appPath(io, app)}`,
    ],
  }
}

/** `pendingyou app status [<app>]`: every app signed in here, or the one named. */
async function status(io: Io, app: string | undefined): Promise<number> {
  const apps = app ? [app] : await signedInApps(io)
  if (apps.length === 0) {
    io.out(
      'No app is signed in on this computer. The Pending You plugin for Herdr signs in from its setup, or: npx pendingyou app login herdr\n',
    )
    return 1
  }
  let ok = true
  const sections: string[] = []
  for (const each of apps) {
    const said = await appStatusLines(io, each)
    ok &&= said.ok
    sections.push(said.lines.join('\n'))
  }
  io.out(`${sections.join('\n\n')}\n`)
  return ok ? 0 : 1
}

/** `pendingyou app <login|logout|status> [<app>]`. */
export async function appCommand(io: Io, command: AppCommand): Promise<number> {
  switch (command.sub) {
    case 'login':
      return login(io, { ...command, app: command.app as string })
    case 'logout':
      return logout(io, command.app as string)
    case 'status':
      return status(io, command.app)
  }
}
