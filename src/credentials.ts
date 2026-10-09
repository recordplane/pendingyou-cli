// This computer's sign-ins, one per app per Pending You address (production, staging, a local server), in
// ~/.config/pendingyou/credentials.json: readable only by you (0600, in a 0700 folder with a .gitignore of `*`, so a
// dotfiles repository never takes it), written whole, never printed and never logged. A file someone loosened is
// tightened again on the next read.
//
// Since 0.11.0 each app has its own (Codex's beside Claude Code's): each is that app's own connection on Pending You
// ("Codex on build-01"), or, for an app whose MCP server signs in by itself, a sign-in that only hears its answers.
// Claude Code's stays under the address itself, where 0.10.0 kept the only one; every other app's is under
// `<address>#<app>`. A 0.10.0 command line still running (a hold, a refresh it started) rewrites the file with the
// entries it read, so it keeps the others as they are.
import { chmod, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { type AppId, DEFAULT_APP, isAppId } from './apps/ids.ts'
import { configDir, readJson, readText, withLock, writeWhole } from './files.ts'
import type { Io } from './io.ts'

export interface Credential {
  /** The OAuth client this computer registered (dynamic client registration). */
  clientId: string
  accessToken: string
  refreshToken: string
  /** When the access token stops working, in milliseconds. */
  expiresAt: number
  signedInAt: string
  /**
   * What the sign-in is (0.10.0). `connection`: this computer's own connection for the app ("Claude Code on build-01"),
   * signed in with a code; the app's MCP server uses it through `pendingyou mcp-headers` (remote.ts), and its hooks use
   * it too. Absent: a sign-in that only hears answers (Pending You's /mcp refuses it), for an app whose MCP server
   * signs in by itself.
   */
  kind?: 'connection'
}

interface CredentialsFile {
  version: 1
  origins: Record<string, Credential>
}

export const credentialsPath = (io: Pick<Io, 'env' | 'home'>) =>
  join(configDir(io), 'credentials.json')

/** Where an app's sign-in for `origin` is kept: Claude Code's under the address itself, another app's beside it. */
export const slotOf = (origin: string, app: AppId = DEFAULT_APP) =>
  app === DEFAULT_APP ? origin : `${origin}#${app}`

/** The address and app a key of the file is for; null for a key no app of this version knows. */
export function slotParts(key: string): { origin: string; app: AppId } | null {
  const at = key.indexOf('#')
  if (at < 0) return { origin: key, app: DEFAULT_APP }
  const app = key.slice(at + 1)
  return isAppId(app) && app !== DEFAULT_APP ? { origin: key.slice(0, at), app } : null
}

/**
 * Keeps the config folder out of version control: a `.gitignore` of `*`, for anyone whose dotfiles repository holds
 * ~/.config. Written once; a file of the person's own there is left as it is.
 */
export async function ignoreFolder(io: Pick<Io, 'env' | 'home'>): Promise<void> {
  const path = join(configDir(io), '.gitignore')
  if ((await readText(path).catch(() => null)) !== null) return
  await writeWhole(path, '# Pending You keeps sign-ins here: never commit them.\n*\n', {
    mode: 0o600,
  })
}

function valid(value: unknown): value is Credential {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.clientId === 'string' &&
    typeof entry.accessToken === 'string' &&
    typeof entry.refreshToken === 'string' &&
    typeof entry.expiresAt === 'number'
  )
}

async function readAll(io: Pick<Io, 'env' | 'home'>): Promise<CredentialsFile> {
  const path = credentialsPath(io)
  let file: CredentialsFile | null
  try {
    file = await readJson<CredentialsFile>(path)
  } catch {
    // Not JSON any more: treat it as signed out; the next sign-in writes a good one.
    return { version: 1, origins: {} }
  }
  if (!file || typeof file.origins !== 'object' || file.origins === null)
    return { version: 1, origins: {} }
  const mode = await stat(path).then((info) => info.mode & 0o777)
  if (mode & 0o077) await chmod(path, 0o600)
  return file
}

/** An app's sign-in for `origin` (Claude Code's when none is named). */
export async function readCredential(
  io: Pick<Io, 'env' | 'home'>,
  origin: string,
  app: AppId = DEFAULT_APP,
): Promise<Credential | null> {
  const entry = (await readAll(io)).origins[slotOf(origin, app)]
  return valid(entry) ? entry : null
}

/** Every sign-in this computer has: its address and app. */
export async function signedInSlots(
  io: Pick<Io, 'env' | 'home'>,
): Promise<{ origin: string; app: AppId }[]> {
  const all = await readAll(io)
  return Object.keys(all.origins).flatMap((key) => {
    const slot = slotParts(key)
    return slot && valid(all.origins[key]) ? [slot] : []
  })
}

/** Every address with a sign-in, for any app. */
export async function signedInOrigins(io: Pick<Io, 'env' | 'home'>): Promise<string[]> {
  return [...new Set((await signedInSlots(io)).map((slot) => slot.origin))]
}

/** Changes one app's sign-in for `origin` (null removes it), under the lock, from the file as it is now. */
export async function updateCredential(
  io: Pick<Io, 'env' | 'home' | 'now' | 'sleep'>,
  origin: string,
  change: (current: Credential | null) => Credential | null | Promise<Credential | null>,
  app: AppId = DEFAULT_APP,
): Promise<Credential | null> {
  const path = credentialsPath(io)
  const key = slotOf(origin, app)
  const next = await withLock(path, io, async () => {
    const all = await readAll(io)
    const current = all.origins[key]
    const changed = await change(valid(current) ? current : null)
    if (changed) all.origins[key] = changed
    else delete all.origins[key]
    await writeWhole(path, `${JSON.stringify({ version: 1, origins: all.origins }, null, 2)}\n`, {
      secret: true,
    })
    return changed
  })
  await ignoreFolder(io).catch(() => {})
  return next
}

/**
 * The OAuth client each app's connection to a Pending You address signed in with (0.10.0; one per app since 0.11.0,
 * keyed as credentials are), and the name this computer gave it ("build-01"), in ~/.config/pendingyou/clients.json. It
 * outlives the sign-in (a logout, the 30 days running out), so signing in again names the same client, and Pending You
 * gives this computer back its connection instead of adding another (apps/pendingyou/worker/oauth/device.ts). Each app
 * needs a client of its own: Pending You links a client to one connection, and a client's new grant retires its old
 * one. A client id isn't a secret, but the file is private like the rest.
 */
interface ClientsFile {
  version: 1
  origins: Record<string, { clientId: string; machine?: string }>
}

export const clientsPath = (io: Pick<Io, 'env' | 'home'>) => join(configDir(io), 'clients.json')

async function readClients(io: Pick<Io, 'env' | 'home'>): Promise<ClientsFile> {
  const file = await readJson<ClientsFile>(clientsPath(io)).catch(() => null)
  return file && typeof file.origins === 'object' && file.origins !== null
    ? file
    : { version: 1, origins: {} }
}

/** The client this computer's connection for `origin` signed in with last, if any. */
export async function connectionClient(
  io: Pick<Io, 'env' | 'home'>,
  origin: string,
  app: AppId = DEFAULT_APP,
): Promise<string | null> {
  const entry = (await readClients(io)).origins[slotOf(origin, app)]
  return typeof entry?.clientId === 'string' ? entry.clientId : null
}

/** The name this computer's connection for `origin` signed in with ("build-01"), if it's known. */
export async function connectionMachine(
  io: Pick<Io, 'env' | 'home'>,
  origin: string,
  app: AppId = DEFAULT_APP,
): Promise<string | null> {
  const entry = (await readClients(io)).origins[slotOf(origin, app)]
  return typeof entry?.machine === 'string' && entry.machine ? entry.machine : null
}

/**
 * Remembers the client this computer's connection for `origin` signed in with, or with null forgets it (uninstall),
 * removing the file once it holds none.
 */
export async function saveConnectionClient(
  io: Pick<Io, 'env' | 'home' | 'now' | 'sleep'>,
  origin: string,
  clientId: string | null,
  machine?: string,
  app: AppId = DEFAULT_APP,
): Promise<void> {
  const path = clientsPath(io)
  const key = slotOf(origin, app)
  if (!clientId && !(await connectionClient(io, origin, app))) return
  await withLock(path, io, async () => {
    const file = await readClients(io)
    if (clientId) file.origins[key] = { clientId, ...(machine ? { machine } : {}) }
    else delete file.origins[key]
    const text = `${JSON.stringify({ version: 1, origins: file.origins }, null, 2)}\n`
    if (Object.keys(file.origins).length === 0) await rm(path, { force: true })
    else await writeWhole(path, text, { secret: true })
  })
}
