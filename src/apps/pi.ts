// Pi (0.12.0): what `pendingyou init` sets up for it, `status`'s section and `uninstall`. Pi is the terminal coding
// agent at pi.dev (Earendil; npm @earendil-works/pi-coding-agent, the `pi` command). Facts from Pi 1.0.2's code and
// docs, 2026-10-04 (docs/assistants/pi.md has the details):
//
// - Its MCP servers for every project are `mcpServers` in ~/.pi/agent/mcp.json (or $PI_CODING_AGENT_DIR's), strict
//   JSON, which init edits in place (json.ts): the `pendingyou` member and nothing else. Its MCP client (0.99.0) runs
//   stdio servers, so Pi reaches Pending You through the command line's bridge (bridge.ts: `bridged`, and the command
//   init hands `install`), signed in with this computer's own connection ("Pi on build-01"): one sign-in for the server
//   and the extension. With `--oauth` the server is Pending You's address and Pi signs in by itself (`pi mcp login
//   pendingyou`; from 1.0.1 with its client metadata document on pi.dev, `oauth.clientRegistration: "cimd"`). Either
//   way `exposure: "direct"`: Pi's default leaves an MCP server's tools to codemode scripts. A header's `!command`
//   isn't used: Pi runs it only when it reconnects, never after a 401.
// - Its skill is ~/.pi/agent/skills/pendingyou/SKILL.md, unless the same stub is already in ~/.agents/skills, which Pi
//   reads too (two skills of one name make Pi warn as it starts).
// - It has no hooks: init writes an extension, ~/.config/pendingyou/pi/pendingyou.js (pi-extension.ts, compiled, with
//   this computer's paths), into settings.json's `extensions`. It runs the hooks' shim for the session start, each
//   message, Pending You's card tools and the end of a run, and the listener that wakes the session (codex-wake.ts,
//   as OpenCode's plugin does).
// - Pi asks nobody before it runs a tool, so there's nothing to allow.

import { rm, rmdir } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import {
  bridgeCommand,
  bridgeOrigin,
  bridgePath,
  checkBridge,
  isOurBridge,
  probeBridge,
} from '../bridge.ts'
import { removeSkill, saveSkill } from '../claude.ts'
import { readCredential } from '../credentials.ts'
import { configDir, readJson, readText, writeWhole } from '../files.ts'
import { originArgs } from '../hooks.ts'
import { cliPackage, type Installed } from '../install.ts'
import type { Io } from '../io.ts'
import { editJson, isObject, readObject } from '../json.ts'
import { atLeast } from '../mod.ts'
import { removePresenceFiles } from '../presence.ts'
import { foundBy, headlessReason } from '../remote.ts'
import { connectionTitle, FINISH_SAY, setupOf, setupStatus } from '../setup.ts'
import { shimPath } from '../shim.ts'
import { VERSION } from '../version.ts'
import { threadFiles } from './codex-wake.ts'
import { APP_NAMES } from './ids.ts'
import type { PiSetup } from './pi-extension.ts'
import { switches } from './switch.ts'
import type { AppContext, AppModule, AppStatus, Prepared, StatusContext, Step } from './types.ts'

type Json = Record<string, unknown>
const NAME = APP_NAMES.pi

/** The oldest Pi init sets up: its MCP client came in 0.99.0. */
export const PI_MIN = '0.99.0'
/** From here Pi signs in to a server with its client metadata document on pi.dev (`--oauth`). */
export const PI_CIMD = '1.0.1'
/** The server's name in mcp.json: its tools are mcp__pendingyou__…, which the extension and the hooks know. */
const SERVER = 'pendingyou'
/** What the server offers, in a sentence: Pi's tool search ranks its tools by it. */
const DESCRIPTION =
  'Ask your person through Pending You when a decision, fact or step is theirs, and hear their answers.'
/** Keys of a server that say how Pi reaches it and signs in: init sets them, and keeps the rest. */
const REACH_KEYS = new Set([
  'type',
  'command',
  'args',
  'env',
  'cwd',
  'url',
  'headers',
  'oauth',
  'auth',
])

/** Pi's own folder: $PI_CODING_AGENT_DIR (`~` for the home folder), or ~/.pi/agent. */
export function piAgentDir(io: Pick<Io, 'env' | 'home' | 'cwd'>): string {
  const set = io.env.PI_CODING_AGENT_DIR
  if (!set) return join(io.home, '.pi', 'agent')
  const expanded = set === '~' ? io.home : set.startsWith('~/') ? join(io.home, set.slice(2)) : set
  return isAbsolute(expanded) ? expanded : join(io.cwd, expanded)
}
type PathIo = Pick<Io, 'env' | 'home' | 'cwd'>
const mcpPath = (io: PathIo) => join(piAgentDir(io), 'mcp.json')
const settingsPath = (io: PathIo) => join(piAgentDir(io), 'settings.json')
export const piSkillPath = (io: PathIo) => join(piAgentDir(io), 'skills', 'pendingyou', 'SKILL.md')
/** The Agent Skills folder Pi reads besides its own, where Codex's skill is saved. */
const sharedSkillPath = (io: Pick<Io, 'home'>) =>
  join(io.home, '.agents', 'skills', 'pendingyou', 'SKILL.md')
/** The extension Pi loads, by a path that never changes: upgrading rewrites the file, never settings.json. */
export const extensionPath = (io: Pick<Io, 'env' | 'home'>) =>
  join(configDir(io), 'pi', 'pendingyou.js')
const manifestPath = (io: Pick<Io, 'env' | 'home'>) => join(configDir(io), 'pi.json')

export interface PiManifest {
  version: 1
  origin: string
  agentDir: string
  /** init wrote the pendingyou server in mcp.json (it wasn't there, or was replaced or switched). */
  mcpAdded: boolean
  /** How the server signs in: through the bridge (this computer's connection), or by Pi itself. */
  signsIn: 'bridge' | 'pi'
  skill: { path: string; sha256: string } | null
  /** The extension init wrote, and whether init put it in settings.json's `extensions`. */
  extension: { path: string; listed: boolean } | null
  setup?: { since: string }
}

export const readPiManifest = (io: Pick<Io, 'env' | 'home'>) =>
  readJson<PiManifest>(manifestPath(io)).catch(() => null)

/** Pi's pendingyou server, as its mcp.json has it. */
export interface PiServer {
  entry: Json
  url: string | null
  /** Its `command` and `args` as one list, as the bridge reads a command: null with no command. */
  command: string[] | null
  exposure: string | null
  /** It signs in some way of its own: an Authorization header, or a /login provider's token (`auth`). */
  ownAuth: boolean
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : null)

function serverIn(json: Json): PiServer | null {
  const entry = isObject(json.mcpServers) ? json.mcpServers[SERVER] : undefined
  if (!isObject(entry)) return null
  const headers = isObject(entry.headers) ? entry.headers : {}
  return {
    entry,
    url: text(entry.url),
    command: text(entry.command)
      ? [
          entry.command as string,
          ...(Array.isArray(entry.args)
            ? entry.args.filter((arg): arg is string => typeof arg === 'string')
            : []),
        ]
      : null,
    exposure: text(entry.exposure),
    ownAuth:
      Object.keys(headers).some((name) => name.toLowerCase() === 'authorization') ||
      entry.auth !== undefined,
  }
}

/** A JSON file of Pi's: its text and what it holds, or why it can't be edited. */
type JsonFile =
  | { path: string; text: string | null; json: Json }
  | { path: string; invalid: string }

async function readFile(path: string): Promise<JsonFile> {
  const body = await readText(path).catch(() => null)
  const read = readObject(body, path)
  return 'invalid' in read ? { path, invalid: read.invalid } : { path, text: body, json: read.json }
}

/** mcp.json, with the shape init can edit: `mcpServers` an object, and its `pendingyou` one too. */
async function readMcp(io: PathIo): Promise<JsonFile> {
  const file = await readFile(mcpPath(io))
  if ('invalid' in file) return file
  const servers = file.json.mcpServers
  if (servers !== undefined && !isObject(servers))
    return {
      path: file.path,
      invalid: `${file.path} has an “mcpServers” that isn’t an object, so I left it alone.`,
    }
  if (isObject(servers) && servers[SERVER] !== undefined && !isObject(servers[SERVER]))
    return {
      path: file.path,
      invalid: `${file.path} has a “${SERVER}” server that isn’t an object, so I left it alone.`,
    }
  return file
}

/** settings.json, with the shape init can edit: `extensions` a list. */
async function readSettings(io: PathIo): Promise<JsonFile> {
  const file = await readFile(settingsPath(io))
  if ('invalid' in file) return file
  if (file.json.extensions !== undefined && !Array.isArray(file.json.extensions))
    return {
      path: file.path,
      invalid: `${file.path} has an “extensions” that isn’t a list, so I left it alone.`,
    }
  return file
}

/** The Pending You a server reaches: its address's, or for the bridge its `--origin` (production without one). */
function originOf(server: PiServer): string | null {
  if (server.command && isOurBridge(server.command)) return bridgeOrigin(server.command)
  try {
    return server.url ? new URL(server.url).origin : null
  } catch {
    return null
  }
}

/** The address of the Pending You Pi's pendingyou server reaches, for the hooks' mismatch line; null when unknown. */
export async function piServerUrl(io: PathIo): Promise<string | null> {
  const file = await readMcp(io)
  const server = 'json' in file ? serverIn(file.json) : null
  const origin = server ? originOf(server) : null
  return server && origin ? (server.url ?? `${origin}/mcp`) : null
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')
const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((item, index) => item === b[index])

/**
 * The server as init writes it: how Pi reaches it (the bridge's command, as init hands it over; else Pending You's
 * address), its tools declared to the model, and the rest of what was there.
 */
function entryFor(
  bridge: readonly string[] | null,
  origin: string,
  version: string,
  before: Json | null,
): Json {
  const kept = Object.fromEntries(
    Object.entries(before ?? {}).filter(
      ([key]) => !REACH_KEYS.has(key) && key !== 'exposure' && key !== 'enabled',
    ),
  )
  const [command, ...args] = bridge ?? []
  const reach = command
    ? { command, args }
    : {
        url: `${origin}/mcp`,
        ...(atLeast(version, PI_CIMD) ? { oauth: { clientRegistration: 'cimd' } } : {}),
      }
  return {
    ...reach,
    exposure: 'direct',
    ...(typeof kept.description === 'string' ? {} : { description: DESCRIPTION }),
    ...kept,
  }
}

const switchesFor = (io: Io, ctx: AppContext) =>
  switches(io, ctx, {
    name: 'Pi',
    what: 'Pi signs in to Pending You by itself here (pi mcp login).',
    uses: 'Pending You’s extension for Pi uses',
    headless: false,
  })

/** The compiled extension, from this version's private copy, or the package init runs from. */
async function extensionSource(
  io: Pick<Io, 'script'>,
  copy: Installed | null,
): Promise<string | null> {
  const places = [
    ...(copy ? [join(cliPackage(copy.prefix), 'dist', 'apps', 'pi-extension.js')] : []),
    ...(io.script ? [join(dirname(io.script), 'apps', 'pi-extension.js')] : []),
  ]
  for (const path of places) {
    const source = await readText(path).catch(() => null)
    if (source?.includes('export function pendingYou(')) return source
  }
  return null
}

/** The file Pi loads: the compiled extension, and what it needs from this computer. */
export function extensionFile(source: string, setup: PiSetup): string {
  return `// Pending You for Pi: Pi loads this file, which is in the "extensions" of its settings.json. Written by npx
// pendingyou init (pendingyou ${VERSION}); run that again to repair it, or npx pendingyou uninstall to take it out.
${source.trimEnd()}
export default pendingYou(${JSON.stringify(setup)});
`
}

/** Whether an `extensions` entry is ours: this computer's path, or one an init with another config folder wrote. */
const isOurExtension = (io: Pick<Io, 'env' | 'home'>, entry: unknown) =>
  typeof entry === 'string' &&
  (entry === extensionPath(io) || /(^|[\\/])pendingyou[\\/]pi[\\/]pendingyou\.js$/.test(entry))

/**
 * The skill: none when the stub Pi would get is already in ~/.agents/skills (Codex's, the same file), which Pi reads;
 * else saved in Pi's own folder, as for the other apps.
 */
async function savePiSkill(
  io: Io,
  origin: string,
  before: PiManifest['skill'],
): Promise<{ step: Step; skill: PiManifest['skill'] }> {
  const shared = await readText(sharedSkillPath(io)).catch(() => null)
  if (shared !== null) {
    const stub = await io
      .fetch(`${origin}/skill-stub.md`, { signal: AbortSignal.timeout(15_000) })
      .then((response) => (response.ok ? response.text() : null))
      .catch(() => null)
    if (stub !== null && stub === shared) {
      // Two of one name make Pi warn as it starts: one saved before goes, while it's still the one init saved.
      await removeSkill(before)
      return {
        skill: null,
        step: {
          ok: true,
          text: `Pi reads the pendingyou skill already at ${sharedSkillPath(io)}.`,
        },
      }
    }
  }
  return saveSkill(io, origin, piSkillPath(io), before)
}

/** Writes a file of Pi's, or takes it away when all that's left in it is an empty `key`. */
async function writeBack(path: string, next: string, key: string): Promise<void> {
  const json = JSON.parse(next.replace(/^\uFEFF/, '')) as Json
  const keys = Object.keys(json)
  const empty =
    keys.length === 0 ||
    (keys.length === 1 &&
      keys[0] === key &&
      (Array.isArray(json[key])
        ? (json[key] as unknown[]).length === 0
        : isObject(json[key]) && Object.keys(json[key]).length === 0))
  if (empty) await rm(path, { force: true })
  else await writeWhole(path, next)
}

/** What to do next in Pi: reload the sessions that are open (Pi reloads extensions, skills and servers), or start it. */
const RELOAD = 'run /reload in each Pi session that’s open, or start pi in the folder you work in'

export const pi: AppModule = {
  id: 'pi',
  name: NAME,
  minVersion: PI_MIN,

  async detect(io) {
    const result = await io.run('pi', ['--version'], 20_000)
    if (result.code !== 0) return null
    return { version: /(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1] ?? 'installed' }
  },

  async installed(io) {
    return (await readPiManifest(io)) !== null
  },

  async usesHelper(io, origin) {
    if (io.platform === 'win32') return false
    const file = await readMcp(io)
    const server = 'json' in file ? serverIn(file.json) : null
    return Boolean(server?.command && isOurBridge(server.command) && originOf(server) === origin)
  },

  async prepare(io, ctx, detected): Promise<Prepared> {
    const url = `${ctx.origin}/mcp`
    const flag = originArgs(ctx.origin)
    const skip = (step: Step): Prepared => ({
      app: pi,
      detected,
      signIn: null,
      skipped: step,
      install: async () => [],
      next: () => null,
    })
    // The extension runs the hooks' sh script: not on Windows yet.
    if (io.platform === 'win32')
      return skip({
        ok: true,
        text: 'Pi on Windows isn’t set up by init yet: paste Pending You’s setup message for another app into it instead.',
      })
    const version = detected.version
    let how: 'bridge' | 'pi' = ctx.oauth ? 'pi' : 'bridge'
    const file = await readMcp(io)
    // The bridge as init will hand it over: what Pi's server runs, to compare one that's there with.
    const wanted = bridgeCommand(io, ctx.origin, 'pi')
    if ('invalid' in file) {
      const entry = JSON.stringify({
        [SERVER]: entryFor(how === 'bridge' ? wanted : null, ctx.origin, version, null),
      })
      return skip({
        ok: false,
        text: `${file.invalid} To set Pi up, put this in its “mcpServers” yourself, then run init again${flag ? ` with${flag}` : ''}: ${entry.slice(1, -1)}`,
      })
    }
    const server = serverIn(file.json)
    let action: 'add' | 'keep' | 'write' | 'expose' = 'add'
    let note: Step | null = null
    const reaches = server ? originOf(server) : null
    const ours = Boolean(server?.command && isOurBridge(server.command))
    if (server && (server.url || ours) && reaches !== ctx.origin) {
      // Another Pending You (staging, when production was asked for): asked before anyone signs in.
      const was = server.url ?? `${reaches ?? 'another Pending You'}/mcp`
      ctx.progress(`Pi’s pendingyou MCP server points at ${was}, not ${url}.\n`)
      const replace =
        ctx.yes ||
        (io.interactive && /^\s*y(es)?\s*$/i.test(await io.ask(`Replace it with ${url}? [y/N] `)))
      if (!replace)
        return skip({
          ok: false,
          text: `Kept Pi’s pendingyou MCP server at ${was}, so Pi isn’t set up for ${ctx.origin}. To use ${url}, run init again with --yes.`,
        })
      action = 'write'
    } else if (server?.command && !ours) {
      // A command of someone else's: theirs to change. The extension hears through a sign-in of its own.
      how = 'pi'
      action = 'keep'
      note = {
        ok: false,
        text: `Kept Pi’s pendingyou MCP server: it runs a command of its own (${server.command.join(' ')}).`,
      }
    } else if (server?.command) {
      // Our bridge, at this Pending You.
      action =
        how === 'bridge' && sameList(server.command, wanted) && server.exposure === 'direct'
          ? 'keep'
          : 'write'
    } else if (server?.url && server.ownAuth) {
      how = 'pi'
      action = 'keep'
      note = {
        ok: false,
        text: `Kept Pi’s pendingyou MCP server: it signs in some way of its own (an Authorization header, or a /login provider).`,
      }
    } else if (server?.url) {
      // Pi signs in to it by itself (pi mcp login).
      if (how === 'pi') action = server.exposure === 'direct' ? 'keep' : 'expose'
      else if (await switchesFor(io, ctx)) action = 'write'
      else {
        how = 'pi'
        action = server.exposure === 'direct' ? 'keep' : 'expose'
        note = {
          ok: true,
          text: `Kept Pi’s own sign-in to Pending You (${url}). To move it to this computer’s, run: npx -y pendingyou@latest init --app pi --yes${flag}`,
        }
      }
    } else if (server) action = 'write'

    return {
      app: pi,
      detected,
      signIn: how === 'bridge' ? 'connection' : 'hear',
      // The shared parts put the bridge's launcher in place for it (docs/apps.md, The bridge).
      bridged: how === 'bridge',
      install: async (ictx) => {
        const steps: Step[] = []
        const report = (step: Step) => {
          steps.push(step)
          ictx.report(step)
        }
        const before = await readPiManifest(io)
        // The MCP server: only the pendingyou member of mcp.json, every other byte as it was.
        let added = before?.mcpAdded ?? false
        if (note) report(note)
        if (action === 'keep') {
          if (!note)
            report({
              ok: true,
              text:
                how === 'bridge'
                  ? `The pendingyou MCP server (${url}) already runs through this computer’s bridge.`
                  : `The pendingyou MCP server (${url}) was already in Pi.`,
            })
        } else if (how === 'bridge' && !ictx.bridge)
          report({
            ok: false,
            text: 'Didn’t add Pi’s pendingyou MCP server: it runs pendingyou’s own copy through the bridge, which isn’t installed. Run init again.',
          })
        else {
          const entry =
            action === 'expose' && server
              ? { ...server.entry, exposure: 'direct' }
              : entryFor(
                  how === 'bridge' ? ictx.bridge : null,
                  ctx.origin,
                  version,
                  server?.entry ?? null,
                )
          const current = await readMcp(io)
          try {
            if ('invalid' in current) throw new Error(current.invalid)
            await writeWhole(
              current.path,
              editJson(
                current.text,
                { op: 'set', path: ['mcpServers', SERVER], value: entry },
                current.path,
              ),
            )
            added = true
            report({
              ok: true,
              text: !server
                ? how === 'bridge'
                  ? `Added the pendingyou MCP server to ${current.path}, through Pending You’s bridge: this computer’s sign-in. Its tools are declared to the model.`
                  : `Added the pendingyou MCP server (${url}) to ${current.path}. Its tools are declared to the model.`
                : action === 'expose'
                  ? `Pi’s pendingyou MCP server (${url}) signs in by itself, and its tools are now declared to the model.`
                  : (server.url || ours) && reaches !== ctx.origin
                    ? `Replaced Pi’s pendingyou MCP server (was ${server.url ?? `${reaches}/mcp`}) with ${how === 'bridge' ? `Pending You’s bridge for ${ctx.origin}` : url}.`
                    : how === 'bridge'
                      ? `Switched Pi’s pendingyou MCP server to Pending You’s bridge: this computer’s sign-in, one for it and Pending You’s extension.`
                      : `Switched Pi’s pendingyou MCP server (${url}) to Pi’s own sign-in: run pi mcp login pendingyou.`,
            })
          } catch (error) {
            report({
              ok: false,
              text: `Couldn’t write ${current.path} (${error instanceof Error ? error.message : 'it went wrong'}), so Pi has no pendingyou MCP server.`,
            })
          }
        }
        if (how === 'pi' && action !== 'keep' && !atLeast(version, PI_CIMD))
          report({
            ok: true,
            text: `Pi ${version} signs in by registering itself; from ${PI_CIMD} it signs in as pi.dev’s own client.`,
          })

        const skill = await savePiSkill(io, ictx.origin, before?.skill ?? null)
        report(skill.step)

        // The extension: the file Pi loads, and its path in settings.json's "extensions".
        let extension: PiManifest['extension'] = before?.extension ?? null
        const source = await extensionSource(io, ictx.copy)
        if (!source)
          report({
            ok: false,
            text: 'Couldn’t find Pending You’s extension for Pi in this copy of pendingyou, so Pi hears answers only while it works. Run npx -y pendingyou@latest init again.',
          })
        else {
          const path = extensionPath(io)
          const wanted = extensionFile(source, {
            shim: shimPath(io),
            origin: ictx.origin,
            configDir: configDir(io),
          })
          if ((await readText(path).catch(() => null)) !== wanted) await writeWhole(path, wanted)
          const settings = await readSettings(io)
          if ('invalid' in settings) {
            report({
              ok: false,
              text: `${settings.invalid} To load Pending You’s extension, add "${path}" to its “extensions” yourself.`,
            })
            extension = { path, listed: false }
          } else {
            const list = Array.isArray(settings.json.extensions) ? settings.json.extensions : []
            const listed = list.includes(path)
            let next = settings.text
            // An older path of ours (another config folder) goes; this one goes at the end of the list.
            if (list.some((entry) => entry !== path && isOurExtension(io, entry)))
              next = editJson(
                next,
                {
                  op: 'remove',
                  path: ['extensions'],
                  match: (entry) => entry !== path && isOurExtension(io, entry),
                },
                settings.path,
              )
            if (!listed)
              next = editJson(
                next,
                { op: 'append', path: ['extensions'], value: path },
                settings.path,
              )
            if (next !== settings.text) await writeWhole(settings.path, next ?? '')
            extension = { path, listed: true }
            report({
              ok: true,
              text: listed
                ? 'Pending You’s extension for Pi was already in place.'
                : `Added Pending You’s extension to Pi (${path}, in ${settings.path}): it hands Pi your answers as a session starts and with each message, asks it to post what it leaves you only in chat, and wakes it when you answer.`,
            })
          }
        }

        const manifest: PiManifest = {
          version: 1,
          origin: ictx.origin,
          agentDir: piAgentDir(io),
          mcpAdded: added,
          signsIn: how,
          skill: skill.skill,
          extension,
          setup: { since: new Date(io.now()).toISOString() },
        }
        await writeWhole(manifestPath(io), `${JSON.stringify(manifest, null, 2)}\n`, {
          secret: true,
        })
        return steps
      },
      next: (ictx) => {
        // Pi signing in by itself: it needs its own sign-in first, unless it kept one that works.
        const login = how === 'pi' && action !== 'keep' && !note
        if (how === 'pi')
          return {
            lines: [
              `Next: ${login ? 'run pi mcp login pendingyou (your browser opens on Pending You: press Allow), then ' : ''}${RELOAD}.`,
              'Then say this to it:',
              '',
              FINISH_SAY,
            ],
            together: `- Pi: ${login ? 'run pi mcp login pendingyou, then ' : ''}${RELOAD}, then say the line below to it.`,
            say: true,
          }
        // Not signed in yet (--no-login, or Cancel): this computer's sign-in first, which the bridge needs.
        if (!ictx.signedIn)
          return {
            lines: [
              `Next: run npx pendingyou login --app pi${flag}, then ${RELOAD}.`,
              'Then say this to it:',
              '',
              FINISH_SAY,
            ],
            together: `- Pi: run npx pendingyou login --app pi${flag}, then ${RELOAD}, then say the line below to it.`,
            say: true,
          }
        return {
          lines: [
            `Next: ${RELOAD}.`,
            'It finishes setting up by itself and sends you a test card. If it doesn’t, say this to it:',
            '',
            FINISH_SAY,
          ],
          together: `- Pi: ${RELOAD}. It finishes setting up by itself and sends you a test card.`,
          say: true,
        }
      },
    }
  },

  async uninstall(io) {
    const manifest = await readPiManifest(io)
    const steps: Step[] = []
    // The extension: out of settings.json's list, then its file.
    const settings = await readSettings(io)
    if ('json' in settings) {
      const list = Array.isArray(settings.json.extensions) ? settings.json.extensions : []
      if (list.some((entry) => isOurExtension(io, entry))) {
        await writeBack(
          settings.path,
          editJson(
            settings.text,
            { op: 'remove', path: ['extensions'], match: (entry) => isOurExtension(io, entry) },
            settings.path,
          ),
          'extensions',
        )
        steps.push({ ok: true, text: 'Removed Pending You’s extension from Pi.' })
      }
    } else if (manifest?.extension?.listed)
      steps.push({
        ok: false,
        text: `${settings.invalid} Take "${manifest.extension.path}" out of its “extensions” yourself.`,
      })
    const file = manifest?.extension?.path ?? extensionPath(io)
    await rm(file, { force: true })
    await rmdir(dirname(file)).catch(() => {})
    // The MCP server, when init put it there.
    if (manifest?.mcpAdded) {
      const mcp = await readMcp(io)
      if ('invalid' in mcp)
        steps.push({ ok: false, text: `${mcp.invalid} Take its “${SERVER}” server out yourself.` })
      else if (serverIn(mcp.json)) {
        await writeBack(
          mcp.path,
          editJson(mcp.text, { op: 'delete', path: ['mcpServers', SERVER] }, mcp.path),
          'mcpServers',
        )
        steps.push({ ok: true, text: 'Removed the pendingyou MCP server from Pi.' })
      }
    }
    const skill = await removeSkill(manifest?.skill ?? null)
    if (skill) steps.push(skill)
    for (const path of threadFiles(io, 'pi')) await rm(path, { recursive: true, force: true })
    await removePresenceFiles(io, 'pi')
    await rm(manifestPath(io), { force: true })
    return steps
  },

  async status(io, ctx: StatusContext): Promise<AppStatus> {
    const { origin, signIn } = ctx
    const flag = originArgs(origin)
    const [detected, mcp, settings, manifest, ownSkill, sharedSkill] = await Promise.all([
      pi.detect(io),
      readMcp(io),
      readSettings(io),
      readPiManifest(io),
      readText(piSkillPath(io)).catch(() => null),
      readText(sharedSkillPath(io)).catch(() => null),
    ])
    const credential = await readCredential(io, origin, 'pi')
    const url = `${origin}/mcp`
    const why = headlessReason(io)
    const mark = (ok: boolean) => (ok ? 'ok     ' : 'missing')
    const server = 'json' in mcp ? serverIn(mcp.json) : null
    const ours = Boolean(server?.command && isOurBridge(server.command))
    const bridged = Boolean(server && ours && originOf(server) === origin)
    // Through the bridge: Pi's server runs it, init set it up so, or nothing is set up yet and init would.
    const bridge = bridged || manifest?.signsIn === 'bridge' || (!server && !manifest)
    const fix = `npx pendingyou ${bridged ? 'login --app pi' : 'init --app pi'}${flag}`
    const connected = credential?.kind === 'connection'
    const signOk = signIn.state === 'ok' && (!bridge || connected)
    const title =
      signIn.state === 'ok' && signIn.for ? connectionTitle(signIn.for) : `${NAME} on this computer`
    const signText =
      signIn.state === 'ok'
        ? bridge
          ? connected
            ? `this computer’s own connection, ${title}; Pi here asks and hears through it`
            : `this computer’s sign-in for Pi only hears answers, so Pi here can’t use it; run ${fix}`
          : `hears for ${signIn.connections} Pi connection${signIn.connections === 1 ? '' : 's'}`
        : signIn.state === 'ended'
          ? `ended; run ${fix}`
          : signIn.state === 'none'
            ? `not signed in; run ${fix}`
            : 'Pending You couldn’t be reached'
    const direct = server?.exposure === 'direct'
    const mcpOk =
      'json' in mcp &&
      Boolean(server) &&
      (bridge ? bridged : Boolean(server?.url && sameUrl(server.url, url))) &&
      direct
    const mcpText = (() => {
      if ('invalid' in mcp) return mcp.invalid
      if (!server) return `not added; run npx pendingyou init --app pi${flag}`
      if (server.command && !ours)
        return `pendingyou runs a command of its own (${server.command.join(' ')})`
      if (!server.url && !server.command)
        return `pendingyou has no url or command; run npx pendingyou init --app pi${flag}`
      if (originOf(server) !== origin)
        return `points at ${server.url ?? `${originOf(server)}/mcp`}, not ${url}; run npx pendingyou init --app pi${flag} --yes to replace it`
      if (bridged)
        return `pendingyou in ${mcpPath(io)}, through the bridge (${bridgePath(io)} --app pi)${direct ? '; its tools are declared to the model' : ''}`
      return bridge
        ? `pendingyou (${server.url}) signs in by itself; run npx pendingyou init --app pi${flag} to use this computer’s sign-in`
        : `pendingyou (${server.url}), signed in by Pi itself (pi mcp login pendingyou)`
    })()
    // The bridge as Pi runs it (at its barest), and a handshake through it with Pi's sign-in.
    const check = bridge && bridged ? await checkBridge(io, origin, 'pi') : null
    const reached =
      check?.ok && signOk && signIn.state === 'ok' ? await probeBridge(io, origin, 'pi') : null
    const bridgeLine = check
      ? check.ok
        ? reached === null
          ? `${check.node} (${foundBy(check.from)}) runs pendingyou ${check.version}, and Pending You takes Pi’s sign-in`
          : `${check.node} runs pendingyou ${check.version}, but ${reached}`
        : `${check.why}; run npx pendingyou init --app pi${flag}`
      : null
    const bridgeOk = !check || (check.ok && reached === null)
    const exposureText =
      server && !direct && 'json' in mcp
        ? `; its exposure is ${server.exposure ?? 'codemode'}, so the model reaches its tools only from scripts. Run npx pendingyou init --app pi${flag}`
        : ''
    const skillOk = ownSkill !== null || sharedSkill !== null
    const skillText =
      ownSkill !== null
        ? `saved (${piSkillPath(io)})`
        : sharedSkill !== null
          ? `Pi reads ${sharedSkillPath(io)}`
          : `not saved; run npx pendingyou init --app pi${flag}`
    const path = extensionPath(io)
    const listed =
      'json' in settings &&
      Array.isArray(settings.json.extensions) &&
      settings.json.extensions.includes(path)
    const present = (await readText(path).catch(() => null)) !== null
    const extensionOk = listed && present
    const extensionText =
      'invalid' in settings
        ? settings.invalid
        : !listed
          ? `not in ${settingsPath(io)}; run npx pendingyou init --app pi${flag}`
          : !present
            ? `${path} is gone; run npx pendingyou init --app pi${flag}`
            : `${path}, in ${settingsPath(io)}: it hands Pi your answers as a session starts and with each message, asks it to post what it leaves you only in chat, and wakes it when you answer`
    const lines = [
      `Pending You for Pi · ${origin}${why ? ` · no browser here (${why})` : ''}`,
      `  ${mark(signOk)} Sign-in: ${signText}`,
      `  ${mark(detected !== null)} Pi: ${detected?.version ?? 'not found on PATH'}`,
      `  ${mark(mcpOk)} MCP server: ${mcpText}${exposureText}`,
      ...(bridgeLine ? [`  ${mark(bridgeOk)} Bridge: ${bridgeLine}`] : []),
      `  ${mark(skillOk)} Skill: ${skillText}`,
      `  ${mark(extensionOk)} Extension: ${extensionText}`,
      // Presence (0.15.0): the extension says when a session is open, with this computer's own connection.
      connected && extensionOk
        ? '  ok      Presence: tells Pending You when this session is open (the extension says so every 5 minutes while Pi runs)'
        : `          Presence: off: it needs ${connected ? 'the extension' : 'Pi signed in through this computer’s own connection'}`,
    ]
    const setup = setupStatus(NAME, signIn.state === 'ok' ? setupOf(signIn.for) : null)
    if (setup) lines.push(`  ${setup === 'finished' ? 'ok     ' : '       '} Setup: ${setup}`)
    const reaches = signOk && mcpOk && bridgeOk
    const ready = reaches && signIn.state === 'ok' && extensionOk
    lines.push(
      ready
        ? 'Ready: Pi hears answers right away (report_setup hears "instant").'
        : reaches
          ? 'Not ready: Pi hears answers only while it’s working until the lines marked missing are fixed.'
          : 'Not ready: Pi here can’t reach Pending You until the lines marked missing are fixed.',
    )
    return { lines, ready }
  },
}
