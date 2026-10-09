// Linking this computer's sign-ins to it (0.29.0; Pending You's person API plan §4.2: a computer is its key). Pending You
// names every assistant on a computer it knows by its key by that computer, and groups them there. A computer's own
// connections (the sign-ins init made) prove the key themselves (machine.ts's proveConnections). An app that signed
// itself in (Claude Code's /mcp Authenticate, or the Pending You plugin's server, whose sign-in Claude Code keeps) never
// did, so Pending You only had its agent's guess at the computer's name, and showed it as a second computer.
//
// `pendingyou machine link` finds those: in each app's own store of its MCP sign-ins on this computer, the OAuth client
// of every sign-in it holds for this Pending You's /mcp, never a token. It proves the computer's key for each client
// (an attestation for `<origin>/mcp/cli/machine/link` and that client) and sends them with any of the command line's
// sign-ins here (POST /mcp/cli/machine/link). Pending You links each client's connection to this computer, the
// person's own and on no other computer yet, and merges the app's sign-ins here into the one in use. Nothing is linked
// by a name. The stores it reads, read-only:
// - Claude Code: `mcpOAuth` in ~/.claude/.credentials.json ($CLAUDE_CONFIG_DIR), or on a Mac the login keychain's
//   "Claude Code-credentials" item, as Claude Code keeps it
// - Codex: ~/.codex/.credentials.json ($CODEX_HOME), when Codex keeps its MCP sign-ins in a file
// - OpenCode: ~/.local/share/opencode/mcp-auth.json ($XDG_DATA_HOME)
//
// init links at once; the hooks, a hold, the MCP headers helper and the wake start it in the background (`linkSoon`) at
// most every LINK_EVERY_MS, so a sign-in made after init is linked within hours with nothing to run. Quiet: whatever
// goes wrong waits for the next time.
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { sendJson } from './api.ts'
import { APP_IDS, type AppId } from './apps/ids.ts'
import { connectionMachine, readCredential } from './credentials.ts'
import { claudeDir, readJson } from './files.ts'
import type { Io } from './io.ts'
import { attest, clockOffset, type MachineKey, proveConnections, readMachine } from './machine.ts'
import { machineOf } from './remote.ts'
import { linkDue, markLinked } from './state.ts'

/** Where the command line links this computer's other sign-ins. */
export const LINK_PATH = '/mcp/cli/machine/link'
/** How often the hooks and the rest start a link in the background: a few times a day. */
export const LINK_EVERY_MS = 6 * 60 * 60 * 1000
/** The most clients one link sends (Pending You takes 8). */
const MAX_LINKS = 8
/** A client id as Pending You's provider makes them, or a URL one. */
const CLIENT_ID = /^[\x21-\x7e]{1,300}$/

/** One app's sign-in at this Pending You, as its own store on this computer keeps it: which app, and its client. */
export interface AppClient {
  app: AppId
  clientId: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

/**
 * The clients of a store's entries for `url`: each entry names its server's address (`serverUrl`, `server_url` or
 * `url`) and its client (`clientId`, `client_id`, or `clientInfo.clientId`).
 */
export function clientsIn(entries: unknown, url: string): string[] {
  if (!isRecord(entries)) return []
  const found: string[] = []
  for (const entry of Object.values(entries)) {
    if (!isRecord(entry)) continue
    const address = entry.serverUrl ?? entry.server_url ?? entry.url
    const info = isRecord(entry.clientInfo) ? entry.clientInfo : {}
    const client = entry.clientId ?? entry.client_id ?? info.clientId ?? info.client_id
    if (typeof address !== 'string' || !sameUrl(address, url)) continue
    if (typeof client === 'string' && CLIENT_ID.test(client) && !found.includes(client))
      found.push(client)
  }
  return found
}

/**
 * Claude Code's sign-ins, as it keeps them: on a Mac in the login keychain (its service named for its config folder when
 * that isn't ~/.claude), elsewhere in .credentials.json in its folder. Null when there's none to read.
 */
async function claudeCodeStore(
  io: Pick<Io, 'env' | 'home' | 'platform' | 'run'>,
): Promise<unknown> {
  if (io.platform === 'darwin') {
    const custom = io.env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? io.env.CLAUDE_CONFIG_DIR
    const suffix = custom
      ? `-${createHash('sha256').update(custom.normalize('NFC')).digest('hex').slice(0, 8)}`
      : ''
    const user = io.env.USER || io.env.LOGNAME || ''
    const account = /^[a-zA-Z0-9._-]+$/.test(user) ? user : 'claude-code-user'
    const found = await io
      .run(
        'security',
        ['find-generic-password', '-a', account, '-w', '-s', `Claude Code-credentials${suffix}`],
        5000,
      )
      .catch(() => null)
    if (found?.code === 0 && found.stdout.trim()) {
      try {
        return JSON.parse(found.stdout.trim())
      } catch {}
    }
  }
  return readJson(join(claudeDir(io), '.credentials.json')).catch(() => null)
}

/** Every app's own sign-ins at `origin`'s /mcp on this computer, by their clients. Never a token. */
export async function appClients(
  io: Pick<Io, 'env' | 'home' | 'platform' | 'run'>,
  origin: string,
): Promise<AppClient[]> {
  const url = `${origin}/mcp`
  const found: AppClient[] = []
  const add = (app: AppId, clients: string[]) => {
    for (const clientId of clients)
      if (!found.some((each) => each.clientId === clientId)) found.push({ app, clientId })
  }
  const claude = await claudeCodeStore(io)
  add('claude-code', clientsIn(isRecord(claude) ? claude.mcpOAuth : null, url))
  const codexHome = io.env.CODEX_HOME || join(io.home, '.codex')
  add(
    'codex',
    clientsIn(await readJson(join(codexHome, '.credentials.json')).catch(() => null), url),
  )
  const data = io.env.XDG_DATA_HOME || join(io.home, '.local', 'share')
  add(
    'opencode',
    clientsIn(await readJson(join(data, 'opencode', 'mcp-auth.json')).catch(() => null), url),
  )
  return found.slice(0, MAX_LINKS)
}

/** How a link went: how many sign-ins joined this computer, and how many older ones Pending You merged. */
export interface Linked {
  /** The apps' own sign-ins found here. */
  found: number
  /** Linked to this computer just now. */
  joined: number
  /** Merged into the one in use, signed out as replaced. */
  merged: number
  /** It couldn't be done now (no sign-in here, Pending You unreachable or from before links). */
  failed: boolean
}

/**
 * Links this computer's apps' own sign-ins at `origin` to it, with the key: found in their stores (appClients), proven
 * one attestation each, and sent with any of the command line's sign-ins here.
 */
export async function linkClients(io: Io, origin: string, machine: MachineKey): Promise<Linked> {
  const clients = await appClients(io, origin)
  const none: Linked = { found: clients.length, joined: 0, merged: 0, failed: false }
  if (clients.length === 0) return none
  let signedIn: AppId | null = null
  for (const app of APP_IDS)
    if (await readCredential(io, origin, app)) {
      signedIn = app
      break
    }
  if (!signedIn) return { ...none, failed: true }
  try {
    const name = (await connectionMachine(io, origin, signedIn)) ?? machineOf(io.host)
    const offset = await clockOffset(io, origin)
    const links: { clientId: string; attestation: string }[] = []
    for (const { clientId } of clients)
      links.push({
        clientId,
        attestation: await attest(
          machine,
          { aud: `${origin}${LINK_PATH}`, client_id: clientId, name },
          io.now() + offset,
        ),
      })
    const { status, body } = await sendJson<{
      links?: { connection?: unknown }[]
      merged?: unknown
    }>(io, origin, LINK_PATH, { links }, 15_000, { app: signedIn })
    if (status !== 200) return { ...none, failed: true }
    return {
      found: clients.length,
      joined: (body.links ?? []).filter((each) => each.connection === 'joined').length,
      merged: typeof body.merged === 'number' ? body.merged : 0,
      failed: false,
    }
  } catch {
    return { ...none, failed: true }
  }
}

/**
 * `pendingyou machine link`: proves this computer's key for its own connections here (as init does), then links its
 * apps' own sign-ins. `quiet` (the background's) prints nothing. Exit 1 only when it couldn't try.
 */
export async function machineLink(
  io: Io,
  command: { origin: string; quiet: boolean },
): Promise<number> {
  const say = (text: string) => {
    if (!command.quiet) io.out(text)
  }
  const machine = await readMachine(io).catch(() => null)
  if (!machine) {
    say(
      'This computer has no key yet. npx -y pendingyou@latest init makes one, and links its sign-ins.\n',
    )
    return 1
  }
  await markLinked(io, command.origin).catch(() => {})
  const own: AppId[] = []
  for (const app of APP_IDS)
    if ((await readCredential(io, command.origin, app))?.kind === 'connection') own.push(app)
  const proven = own.length
    ? await proveConnections(io, command.origin, own, machine).catch(() => new Map())
    : new Map()
  const linked = await linkClients(io, command.origin, machine)
  const joined = [...proven.values()].filter((each) => each === 'joined').length + linked.joined
  if (linked.failed && linked.found > 0)
    say(
      `Found ${linked.found === 1 ? 'a sign-in' : `${linked.found} sign-ins`} of this computer’s apps, but Pending You couldn’t be asked to link ${linked.found === 1 ? 'it' : 'them'} now. Try again later.\n`,
    )
  else if (joined === 0) say('Every sign-in on this computer is linked to it already.\n')
  else
    say(
      `Linked ${joined === 1 ? 'a sign-in' : `${joined} sign-ins`} on this computer to it${linked.merged ? `, and Pending You merged ${linked.merged === 1 ? 'an older one' : `${linked.merged} older ones`} into the one in use` : ''}.\n`,
    )
  return 0
}

/**
 * Starts `pendingyou machine link` in the background when it's due here (every LINK_EVERY_MS for an address), on a
 * computer with a key. Cheap when it isn't: one read of the state file. Never throws.
 */
export async function linkSoon(io: Io, origin: string): Promise<void> {
  try {
    if (!(await linkDue(io, origin, LINK_EVERY_MS))) return
    if (!(await readMachine(io))) return
    await markLinked(io, origin)
    io.background(['machine', 'link', '--quiet', '--origin', origin])
  } catch {}
}
