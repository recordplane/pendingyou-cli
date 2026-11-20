// Antigravity: what `pendingyou init` sets up for Google's Antigravity CLI (`agy`, 1.5.12 or later), `status`'s section
// and `uninstall`. Facts from agy's own docs (its bundled agy-customizations skill: hooks, plugins, MCP servers, rules,
// skills) and a live look at 1.5.12, 2026-11-19:
//
// - Everything is one plugin, Pending You's, in a folder of its own that init writes whole:
//   ~/.gemini/config/plugins/pendingyou/ with plugin.json, mcp_config.json (its MCP server), hooks.json (at the plugin's
//   root, where agy reads it), rules/AGENTS.md (always-on rules while the plugin is on: the guide's stub, since agy never
//   puts a server's instructions in the model's prompt) and skills/pendingyou/SKILL.md (the stub as a skill). agy finds
//   it there and turns it on by itself; the person's choice is `plugins.pendingyou.enabled` in
//   ~/.gemini/config/config.json, which init never writes (status reads it). agy loads plugins as it starts, so init's
//   last lines say to restart it.
// - Its MCP server runs the command line's bridge (bridge.ts), signed in with this computer's own connection
//   ("Antigravity on build-01"): agy's remote servers take only fixed headers. With `--oauth` it's Pending You's address,
//   and agy signs in by itself. agy loads a server's tools lazily unless they're marked eager, so the ones every task
//   uses are (EAGER_TOOLS).
// - A `pendingyou` server in agy's global mcp_config.json (~/.gemini/config/mcp_config.json: the setup message for other
//   MCP apps, signed in by agy's own OAuth) would be a second one: init asks to take it out (and puts it back on
//   uninstall), or keeps it, and then the plugin brings no server of its own.
// - Its hooks (antigravity-hooks.ts) run the shim, `|| echo '{}'`: agy reads a JSON object from every hook.
// - It's woken only by a hold the agent starts in the background (`npx -y pendingyou hold <requestId>`, hold.ts): the
//   rules say so. The -y since 0.45.1: npx asks before installing in agy's terminal, and nobody answers it there. Nothing starts a turn from outside it.
// - agy asks before every MCP tool call and every shell command unless a rule in ~/.gemini/antigravity-cli/settings.json
//   (`permissions.allow`) allows it. init asks the person, at a terminal and apart from the rest, whether to add two
//   (PERMISSION_RULES); with nobody to ask, or --yes, it adds none. Uninstall takes out only the ones it added.
import { rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { bridgeOrigin, bridgePath, checkBridge, isOurBridge, probeBridge } from '../bridge.ts'
import { readCredential } from '../credentials.ts'
import { configDir, readJson, readText, writeWhole } from '../files.ts'
import { holdCommand } from '../hold.ts'
import { isOurHook, originArgs } from '../hooks.ts'
import type { Io } from '../io.ts'
import { editJson, isObject, readObject } from '../json.ts'
import { removePresenceFiles } from '../presence.ts'
import { foundBy, headlessReason } from '../remote.ts'
import { connectionTitle, FINISH_SAY, setupCalls, setupOf, setupStatus } from '../setup.ts'
import { VERSION } from '../version.ts'
import { AGY_HOOK_EVENTS, AGY_POST_TOOL_MATCHER, agyHookFiles } from './antigravity-hooks.ts'
import { threadFiles } from './codex-wake.ts'
import { APP_NAMES } from './ids.ts'
import { switches } from './switch.ts'
import type { AppContext, AppModule, AppStatus, Prepared, StatusContext, Step } from './types.ts'

type Json = Record<string, unknown>
const NAME = APP_NAMES.antigravity

/** The oldest agy init sets up: the one its plugins, hooks and eager tools were seen working in. */
export const AGY_MIN = '1.5.12'
/** The plugin's folder and the server's name: its tools are Pending You's to the hooks (antigravity-hooks.ts). */
const PLUGIN = 'pendingyou'
const SERVER = 'pendingyou'
const HOMEPAGE = 'https://www.pendingyou.com'
const DESCRIPTION =
  'Ask your person through Pending You when a decision, fact or step is theirs, and hear their answers.'
/** The tools loaded with the conversation, not looked up first: the ones every task uses. */
export const EAGER_TOOLS = [
  'whoami',
  'match_area',
  'post_request',
  'get_request',
  'list_pending',
  'ack_answer',
  'update_request',
  'cancel_request',
  'reply_in_thread',
  'post_answer',
  'answer_delegated',
  'hand_back',
  'report_setup',
] as const
/**
 * The rules that let agy run Pending You's tools and the hold without asking. A plugin's server is named
 * `<plugin folder>_<server>` to agy (seen live, 1.5.12: `pendingyou_pendingyou`, and its prompt "Allow calling this
 * tool? pendingyou_pendingyou/<tool>"), so `mcp(pendingyou_pendingyou/*)` covers its every tool. Antigravity's docs
 * (its Permissions page, read 2026-11-19) say a `command(<words>)` rule "matches command
 * prefixes word-by-word literally by default" in the CLI, so `npx -y pendingyou hold req_… --origin …` is allowed
 * too; not yet seen live. A compound command line (`cd … && npx -y pendingyou hold …`) wouldn't start with the rule's
 * words, so the guide's Antigravity section (2.63.2) says to run the hold as a command line of its own, never after
 * `cd … &&` or chained with anything, exactly as the rules give it. Until 0.45.1 the rule was
 * `command(npx pendingyou hold)`, without the -y (holdWords): init asks again for the new one, and an install's old
 * rule stays in its manifest, so uninstall still takes it out.
 */
export const PERMISSION_RULES = [
  'mcp(pendingyou_pendingyou/*)',
  'command(npx -y pendingyou hold)',
] as const
/** The plugin's files, by their path in its folder. */
const FILES = [
  'plugin.json',
  'mcp_config.json',
  'hooks.json',
  'rules/AGENTS.md',
  'skills/pendingyou/SKILL.md',
] as const
type PluginFile = (typeof FILES)[number]

type PathIo = Pick<Io, 'env' | 'home'>
const geminiConfig = (io: PathIo) => join(io.home, '.gemini', 'config')
export const pluginDir = (io: PathIo) => join(geminiConfig(io), 'plugins', PLUGIN)
const agyConfigPath = (io: PathIo) => join(geminiConfig(io), 'config.json')
const globalMcpPath = (io: PathIo) => join(geminiConfig(io), 'mcp_config.json')
export const agySettingsPath = (io: PathIo) =>
  join(io.home, '.gemini', 'antigravity-cli', 'settings.json')
const manifestPath = (io: PathIo) => join(configDir(io), 'antigravity.json')

export interface AntigravityManifest {
  version: 1
  origin: string
  plugin: string
  /** How its MCP server signs in: the bridge, agy itself (`--oauth`), or `kept`: the person's own, and none in the plugin. */
  signsIn: 'bridge' | 'antigravity' | 'kept'
  /** The plugin's files init wrote, by their path in its folder. */
  files: string[]
  /** The pendingyou server init took out of agy's global mcp_config.json (it goes back on uninstall). */
  moved?: Json
  /** The permission rules init added to agy's settings.json: only these come out again. */
  permissions: string[]
  setup?: { since: string }
}

export const readAntigravityManifest = (io: PathIo) =>
  readJson<AntigravityManifest>(manifestPath(io)).catch(() => null)

const text = (value: unknown) => (typeof value === 'string' && value ? value : null)

/** A JSON file of agy's: its text and what it holds, or why it can't be edited. */
type JsonFile =
  | { path: string; text: string | null; json: Json }
  | { path: string; invalid: string }

async function readFile(path: string): Promise<JsonFile> {
  const body = await readText(path).catch(() => null)
  const read = readObject(body, path)
  return 'invalid' in read ? { path, invalid: read.invalid } : { path, text: body, json: read.json }
}

/** A pendingyou server in an mcp_config.json: where it reaches, and how. */
interface Server {
  entry: Json
  url: string | null
  command: string[] | null
  ownAuth: boolean
}

function serverIn(json: Json): Server | null {
  const entry = isObject(json.mcpServers) ? json.mcpServers[SERVER] : undefined
  if (!isObject(entry)) return null
  const headers = isObject(entry.headers) ? entry.headers : {}
  return {
    entry,
    url: text(entry.url) ?? text(entry.serverUrl),
    command: text(entry.command)
      ? [
          entry.command as string,
          ...(Array.isArray(entry.args)
            ? entry.args.filter((arg): arg is string => typeof arg === 'string')
            : []),
        ]
      : null,
    ownAuth: Object.keys(headers).some((name) => name.toLowerCase() === 'authorization'),
  }
}

/** The Pending You a server reaches: its address's, or for the bridge its `--origin`. */
function originOf(server: Server): string | null {
  if (server.command && isOurBridge(server.command)) return bridgeOrigin(server.command)
  try {
    return server.url ? new URL(server.url).origin : null
  } catch {
    return null
  }
}

const pluginServer = async (io: PathIo) => {
  const file = await readFile(join(pluginDir(io), 'mcp_config.json'))
  return 'json' in file ? serverIn(file.json) : null
}

/**
 * The address of the Pending You Antigravity's pendingyou server reaches, for the hooks' mismatch line: the plugin's,
 * else the global one's; null when unknown.
 */
export async function antigravityServerUrl(io: PathIo): Promise<string | null> {
  const global = await readFile(globalMcpPath(io))
  for (const server of [await pluginServer(io), 'json' in global ? serverIn(global.json) : null]) {
    const origin = server ? originOf(server) : null
    if (server && origin) return server.url ?? `${origin}/mcp`
  }
  return null
}

/** Whether a folder's plugin.json is Pending You's: by its name and homepage, whatever version wrote it. */
const isOurPlugin = (json: Json | null) =>
  json !== null &&
  json.name === PLUGIN &&
  typeof json.homepage === 'string' &&
  json.homepage.startsWith(HOMEPAGE)

async function pluginJson(io: PathIo): Promise<Json | null | 'invalid'> {
  const body = await readText(join(pluginDir(io), 'plugin.json')).catch(() => null)
  if (body === null) return null
  const read = readObject(body, 'plugin.json')
  return 'invalid' in read ? 'invalid' : read.json
}

/** Whether the person turned the plugin off in agy (config.json's `plugins.pendingyou.enabled` false). */
async function turnedOff(io: PathIo): Promise<boolean> {
  const file = await readFile(agyConfigPath(io))
  if (!('json' in file)) return false
  const plugins = isObject(file.json.plugins) ? file.json.plugins : {}
  const ours = isObject(plugins[PLUGIN]) ? plugins[PLUGIN] : {}
  return ours.enabled === false
}

/** agy's settings.json, with the shape init can edit: `permissions.allow` a list of rules. */
async function readSettings(io: PathIo): Promise<JsonFile> {
  const file = await readFile(agySettingsPath(io))
  if ('invalid' in file) return file
  const permissions = file.json.permissions
  if (permissions !== undefined && !isObject(permissions))
    return {
      path: file.path,
      invalid: `${file.path} has a “permissions” that isn’t an object, so I left it alone.`,
    }
  if (isObject(permissions) && permissions.allow !== undefined && !Array.isArray(permissions.allow))
    return {
      path: file.path,
      invalid: `${file.path} has a “permissions.allow” that isn’t a list, so I left it alone.`,
    }
  return file
}

const allowedIn = (file: JsonFile): string[] => {
  if (!('json' in file) || !isObject(file.json.permissions)) return []
  const allow = file.json.permissions.allow
  return Array.isArray(allow)
    ? allow.filter((rule): rule is string => typeof rule === 'string')
    : []
}

/** Some rules as words: “mcp(pendingyou_pendingyou/*) and command(npx -y pendingyou hold)”. */
const rulesText = (rules: readonly string[]) =>
  rules.length > 1 ? `${rules.slice(0, -1).join(', ')} and ${rules.at(-1)}` : (rules[0] ?? '')

/** Writes a file of agy's, or takes it away when nothing's left in it. */
async function writeBack(path: string, next: string): Promise<void> {
  const json = JSON.parse(next.replace(/^﻿/, '')) as Json
  if (Object.keys(json).length === 0) await rm(path, { force: true })
  else await writeWhole(path, next)
}

/** The stub's words without its front matter, which agy's rules don't take. */
export const stubBody = (stub: string) => stub.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()

/**
 * The plugin's rules: the stub, how answers reach an Antigravity conversation (a hold it starts itself), and (0.45.1)
 * how to finish setup, with the same three calls a session start's line gives (setupCalls). Live on 2026-11-19 a
 * conversation continued with `agy -c` had no session start, so nothing said them: the agent asked whoami for the
 * whole guide, agy saved the long answer to a file, and the agent read its setup section with `node -e`, behind agy's
 * "Run this command?" prompt. With the calls in the rules, setup needs no guide, no file and no command.
 */
export function rulesFile(stub: string, origin: string): string {
  const body = stubBody(stub)
  return `# Pending You

${body ? `${body}\n\n` : ''}## Answers in Antigravity

An idle Antigravity conversation hears your person’s answer only through a hold you start: right after you post a card (post_request) or an answer (post_answer), run \`${holdCommand('<requestId>', origin, undefined, 'antigravity')}\` as a background command (run_command with a short WaitMsBeforeAsync), then keep working or end your turn. When it finishes it says what came: act on it as it says. Answers waiting at your person’s next message come with it.

## Finishing setup

When your person says “${FINISH_SAY}”, or asks you to finish setting up Pending You, this is all of it: don’t ask whoami for the guide, and run no command to read anything. ${setupCalls('antigravity', true)}
`
}

/** The plugin's hooks.json: one named hook, each event's command through the shim. */
export function hooksFile(line: (sub: string) => string): Json {
  const handler = (sub: string) => ({ type: 'command', command: line(sub), timeout: 10 })
  return {
    [PLUGIN]: {
      SessionStart: [handler('pickup')],
      PreInvocation: [handler('handoff')],
      PostToolUse: [{ matcher: AGY_POST_TOOL_MATCHER, hooks: [handler('posted')] }],
      Stop: [handler('stopcheck')],
    },
  }
}

/** A hook line as agy needs it: a JSON object even when the shim can't start. */
export const agyHookLine = (line: string) => line.replace(/ \|\| true$/, " || echo '{}'")

/** The plugin's MCP server: the bridge's command (else Pending You's address), its main tools loaded at once. */
export function serverEntry(bridge: readonly string[] | null, origin: string): Json {
  const [command, ...args] = bridge ?? []
  return {
    ...(command ? { command, args } : { url: `${origin}/mcp` }),
    tools: Object.fromEntries(EAGER_TOOLS.map((tool) => [tool, { eager: true }])),
  }
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

const switchesFor = (io: Io, ctx: AppContext) =>
  switches(io, ctx, {
    name: NAME,
    what: `Antigravity signs in to Pending You by itself here (its pendingyou server in ${globalMcpPath(io)}).`,
    uses: 'Pending You’s hooks for Antigravity use',
    headless: false,
  })

/** What to do next in agy: it loads plugins as it starts. */
const RESTART =
  'restart Antigravity (/exit, then agy; agy -c picks the conversation up again), or start agy in the folder you work in'

/** Whether the permission question was asked, and its answer. */
type Allowing = 'added' | 'already' | 'declined' | 'nobody' | 'unreadable'

export const antigravity: AppModule = {
  id: 'antigravity',
  name: NAME,
  minVersion: AGY_MIN,
  // A first version to try: set up only with --app antigravity until it has run for real (0.45.0).
  optIn: true,

  async detect(io) {
    const result = await io.run('agy', ['--version'], 20_000)
    if (result.code !== 0) return null
    return { version: /(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1] ?? 'installed' }
  },

  async installed(io) {
    return (await readAntigravityManifest(io)) !== null
  },

  async usesHelper(io, origin) {
    if (io.platform === 'win32') return false
    const server = await pluginServer(io)
    return Boolean(server?.command && isOurBridge(server.command) && originOf(server) === origin)
  },

  async prepare(io, ctx, detected): Promise<Prepared> {
    const url = `${ctx.origin}/mcp`
    const flag = originArgs(ctx.origin)
    const skip = (step: Step): Prepared => ({
      app: antigravity,
      detected,
      signIn: null,
      skipped: step,
      install: async () => [],
      next: () => null,
    })
    // Its hooks run the shim's sh script: not on Windows yet.
    if (io.platform === 'win32')
      return skip({
        ok: true,
        text: 'Antigravity on Windows isn’t set up by init yet: paste Pending You’s setup message for other MCP apps into it instead.',
      })
    const dir = pluginDir(io)
    const before = await readAntigravityManifest(io)
    const existing = await pluginJson(io)
    if (existing !== null && !before && (existing === 'invalid' || !isOurPlugin(existing)))
      return skip({
        ok: false,
        text: `${dir} holds a plugin that isn’t Pending You’s, so I left it alone. Move it elsewhere, then run init again${flag ? ` with${flag}` : ''}.`,
      })

    // A pendingyou server in agy's global mcp_config.json: a second one beside the plugin's.
    let how: AntigravityManifest['signsIn'] = ctx.oauth ? 'antigravity' : 'bridge'
    let move = false
    let note: Step | null = null
    const global = await readFile(globalMcpPath(io))
    const theirs = 'json' in global ? serverIn(global.json) : null
    if ('invalid' in global)
      note = {
        ok: true,
        text: `${global.invalid} If it has a pendingyou server, take it out: Pending You’s plugin brings its own.`,
      }
    else if (theirs) {
      const reaches = originOf(theirs)
      const ours = Boolean(theirs.command && isOurBridge(theirs.command))
      if (theirs.command && !ours) {
        how = 'kept'
        note = {
          ok: false,
          text: `Kept the pendingyou MCP server in ${global.path}: it runs a command of its own (${theirs.command.join(' ')}). Pending You’s plugin brings no server beside it.`,
        }
      } else if (ours && reaches === ctx.origin && !ctx.oauth) move = true
      else if (reaches !== ctx.origin) {
        const was = theirs.url ?? `${reaches ?? 'another Pending You'}/mcp`
        ctx.progress(
          `Antigravity’s pendingyou MCP server in ${global.path} points at ${was}, not ${url}.\n`,
        )
        const replace =
          ctx.yes ||
          (io.interactive &&
            /^\s*y(es)?\s*$/i.test(
              await io.ask(
                `Take it out, so Antigravity uses Pending You’s plugin for ${url}? [y/N] `,
              ),
            ))
        if (!replace)
          return skip({
            ok: false,
            text: `Kept Antigravity’s pendingyou MCP server at ${was}, so Antigravity isn’t set up for ${ctx.origin}. To use ${url}, run init again with --yes.`,
          })
        move = true
      } else if (theirs.ownAuth) {
        how = 'kept'
        note = {
          ok: false,
          text: `Kept the pendingyou MCP server in ${global.path}: it signs in some way of its own (an Authorization header). Pending You’s plugin brings no server beside it.`,
        }
      } else if (ctx.oauth) how = 'kept'
      else if (await switchesFor(io, ctx)) move = true
      else {
        how = 'kept'
        note = {
          ok: true,
          text: `Kept Antigravity’s own sign-in to Pending You (${url}, in ${global.path}). To move it to this computer’s, run: npx -y pendingyou@latest init --app antigravity --yes${flag}`,
        }
      }
    }

    // The permission rules (PERMISSION_RULES), asked apart from the rest, never with --yes.
    const settings = await readSettings(io)
    const allowed = allowedIn(settings)
    const missing = PERMISSION_RULES.filter((rule) => !allowed.includes(rule))
    let allowing: Allowing
    if ('invalid' in settings) allowing = 'unreadable'
    else if (missing.length === 0) allowing = 'already'
    else if (!io.interactive || ctx.yes) allowing = 'nobody'
    else {
      io.out(
        `Antigravity asks you before each Pending You tool call and each hold (the command that waits for your answer in the background). init can allow both in ${settings.path}: ${rulesText(missing)}.\n`,
      )
      allowing = /^\s*y(es)?\s*$/i.test(await io.ask('Allow them in Antigravity? [y/N] '))
        ? 'added'
        : 'declined'
    }

    return {
      app: antigravity,
      detected,
      signIn: how === 'bridge' ? 'connection' : 'hear',
      bridged: how === 'bridge',
      install: async (ictx) => {
        const steps: Step[] = []
        const report = (step: Step) => {
          steps.push(step)
          ictx.report(step)
        }
        const earlier = await readAntigravityManifest(io)
        if (note) report(note)
        let moved = earlier?.moved
        // The global server goes, once: the plugin's is the one now.
        if (move) {
          const current = await readFile(globalMcpPath(io))
          const server = 'json' in current ? serverIn(current.json) : null
          if ('json' in current && server) {
            try {
              await writeBack(
                current.path,
                editJson(
                  current.text,
                  { op: 'delete', path: ['mcpServers', SERVER] },
                  current.path,
                ),
              )
              moved = server.entry
              report({
                ok: true,
                text: `Took the pendingyou MCP server out of ${current.path} (it reached ${server.url ?? `${originOf(server)}/mcp`}): Pending You’s plugin brings its own. Uninstall puts it back.`,
              })
            } catch (error) {
              report({
                ok: false,
                text: `Couldn’t take the pendingyou MCP server out of ${current.path} (${error instanceof Error ? error.message : 'it went wrong'}): take it out yourself, then run init again.`,
              })
            }
          }
        }

        // The stub, for the rules and the skill.
        let stub: string | null = null
        try {
          const response = await io.fetch(`${ictx.origin}/skill-stub.md`, {
            signal: AbortSignal.timeout(15_000),
          })
          if (response.ok) stub = await response.text()
        } catch {}
        const dir = pluginDir(io)
        const read = (file: PluginFile) => readText(join(dir, file)).catch(() => null)
        if (stub === null)
          report({
            ok: (await read('rules/AGENTS.md')) !== null,
            text: `Couldn’t fetch the guide’s stub from ${ictx.origin}/skill-stub.md for the plugin’s rules and skill. Run init again later.`,
          })

        // The plugin, written whole.
        const server = how === 'kept' ? null : how === 'bridge' ? ictx.bridge : []
        if (how === 'bridge' && !ictx.bridge)
          report({
            ok: false,
            text: 'Didn’t add Antigravity’s pendingyou MCP server: it runs pendingyou’s own copy through the bridge, which isn’t installed. Run init again.',
          })
        const wanted: Partial<Record<PluginFile, string>> = {
          'plugin.json': json({
            name: PLUGIN,
            displayName: 'Pending You',
            version: VERSION,
            description: DESCRIPTION,
            homepage: HOMEPAGE,
          }),
          ...(server && (how !== 'bridge' || ictx.bridge)
            ? {
                'mcp_config.json': json({
                  mcpServers: { [SERVER]: serverEntry(server.length ? server : null, ictx.origin) },
                }),
              }
            : {}),
          'hooks.json': json(hooksFile((sub) => agyHookLine(ictx.hookLine(sub)))),
          ...(stub !== null
            ? {
                'rules/AGENTS.md': rulesFile(stub, ictx.origin),
                'skills/pendingyou/SKILL.md': stub,
              }
            : {}),
        }
        let changed = false
        let fresh = existing === null
        try {
          for (const file of FILES) {
            const want = wanted[file]
            const path = join(dir, file)
            const have = await readText(path).catch(() => null)
            if (want === undefined) {
              // One a previous init wrote that isn't wanted now (the server, once it's kept); the stub's two stay.
              if (have !== null && file === 'mcp_config.json' && earlier?.files.includes(file)) {
                await rm(path, { force: true })
                changed = true
              }
              continue
            }
            if (have !== want) {
              await writeWhole(path, want)
              changed = true
            }
          }
        } catch (error) {
          fresh = false
          report({
            ok: false,
            text: `Couldn’t write Pending You’s plugin in ${dir} (${error instanceof Error ? error.message : 'it went wrong'}). Run init again.`,
          })
        }
        const serverWords =
          how === 'bridge'
            ? 'its pendingyou MCP server through Pending You’s bridge (this computer’s sign-in), its main tools loaded with each conversation'
            : how === 'antigravity'
              ? `its pendingyou MCP server (${url}), which Antigravity signs in to by itself`
              : 'no MCP server of its own (Antigravity keeps the one you have)'
        report({
          ok: true,
          text: !changed
            ? `Pending You’s plugin for Antigravity was already in place (${dir}).`
            : `${fresh ? 'Added' : 'Updated'} Pending You’s plugin for Antigravity in ${dir}: ${serverWords}; rules and a skill that say when to ask you; and hooks that hand it your answers as a conversation starts and with each message, and ask it to post what it leaves you only in chat.`,
        })
        if (await turnedOff(io))
          report({
            ok: false,
            text: `Pending You’s plugin is turned off in Antigravity (${agyConfigPath(io)}). To turn it on: agy plugin enable ${PLUGIN}`,
          })

        // The permission rules, as the person said: only the missing ones are added, and only those are init's.
        const now = await readSettings(io)
        const there = allowedIn(now)
        const ours = (earlier?.permissions ?? []).filter((rule) => there.includes(rule))
        const where = now.path
        const again = `To allow them, run npx pendingyou init --app antigravity${flag} again at a terminal.`
        if (allowing === 'added' && 'json' in now) {
          const adding = PERMISSION_RULES.filter((rule) => !there.includes(rule))
          try {
            let next = now.text
            for (const rule of adding)
              next = editJson(
                next,
                { op: 'append', path: ['permissions', 'allow'], value: rule },
                where,
              )
            if (next !== now.text) await writeWhole(where, next ?? '')
            ours.push(...adding)
            report({
              ok: true,
              text: `Allowed Pending You’s tools and its hold in Antigravity (${where}: ${rulesText(adding)}), so it runs them without asking each time.`,
            })
          } catch (error) {
            report({
              ok: false,
              text: `Couldn’t add Antigravity’s permission rules to ${where} (${error instanceof Error ? error.message : 'it went wrong'}), so it asks before each Pending You tool call and each hold. Add ${rulesText(adding)} to its “permissions.allow” yourself.`,
            })
          }
        } else if (
          allowing === 'already' ||
          (allowing !== 'unreadable' && PERMISSION_RULES.every((rule) => there.includes(rule)))
        )
          report({
            ok: true,
            text: `Antigravity already runs Pending You’s tools and its hold without asking (${where}).`,
          })
        else if (allowing === 'declined')
          report({
            ok: true,
            text: `Left Antigravity’s permissions as they were, as you said: it asks before each Pending You tool call and each hold. ${again}`,
          })
        else if (allowing === 'nobody')
          report({
            ok: true,
            text: `Didn’t change Antigravity’s permissions (${ctx.yes ? '--yes never does' : 'nobody to ask here'}): it asks before each Pending You tool call and each hold. ${again}`,
          })
        else
          report({
            ok: true,
            text: `${'invalid' in now ? now.invalid : `${where} can’t be read`} Antigravity asks before each Pending You tool call and each hold.`,
          })

        const manifest: AntigravityManifest = {
          version: 1,
          origin: ictx.origin,
          plugin: dir,
          signsIn: how,
          files: FILES.filter(
            (file) =>
              wanted[file] !== undefined ||
              (file !== 'mcp_config.json' && earlier?.files.includes(file)),
          ),
          ...(moved ? { moved } : {}),
          permissions: [...new Set(ours)],
          setup: { since: new Date(io.now()).toISOString() },
        }
        await writeWhole(manifestPath(io), json(manifest), { secret: true })
        return steps
      },
      next: (ictx) => {
        // Signing in by itself (--oauth): in its /mcp, once it has started with the plugin.
        const login = how === 'antigravity' ? ', then type /mcp, choose pendingyou and sign in' : ''
        const first =
          !ictx.signedIn && how === 'bridge'
            ? `run npx pendingyou login --app antigravity${flag}, then `
            : ''
        return {
          lines: [`Next: ${first}${RESTART}${login}.`, 'Then say this to it:', '', FINISH_SAY],
          together: `- Antigravity: ${first}${RESTART}${login}, then say the line below to it.`,
          say: true,
        }
      },
    }
  },

  async uninstall(io) {
    const manifest = await readAntigravityManifest(io)
    const steps: Step[] = []
    // The plugin: its files, then its folders once they're empty. One with a plugin.json not ours stays.
    const dir = manifest?.plugin ?? pluginDir(io)
    const existing = await pluginJson(io)
    if (manifest || (existing !== null && existing !== 'invalid' && isOurPlugin(existing))) {
      let removed = false
      for (const file of FILES) {
        const path = join(dir, file)
        if ((await readText(path).catch(() => null)) === null) continue
        await rm(path, { force: true })
        removed = true
      }
      for (const folder of ['skills/pendingyou', 'skills', 'rules', ''])
        await rmdir(join(dir, folder)).catch(() => {})
      if (removed) steps.push({ ok: true, text: 'Removed Pending You’s plugin from Antigravity.' })
    }
    // The global server init took out goes back, unless there's one there now.
    if (manifest?.moved) {
      const global = await readFile(globalMcpPath(io))
      if ('invalid' in global)
        steps.push({
          ok: false,
          text: `${global.invalid} To put your pendingyou MCP server back, add it to its “mcpServers” yourself: ${JSON.stringify({ [SERVER]: manifest.moved })}`,
        })
      else if (!serverIn(global.json)) {
        await writeWhole(
          global.path,
          editJson(
            global.text,
            { op: 'set', path: ['mcpServers', SERVER], value: manifest.moved },
            global.path,
          ),
        )
        steps.push({ ok: true, text: `Put your pendingyou MCP server back in ${global.path}.` })
      }
    }
    // The permission rules init added, and nothing else of the person's.
    const added = manifest?.permissions ?? []
    if (added.length) {
      const settings = await readSettings(io)
      if ('invalid' in settings)
        steps.push({
          ok: false,
          text: `${settings.invalid} Take ${rulesText(added)} out of its “permissions.allow” yourself.`,
        })
      else if (allowedIn(settings).some((rule) => added.includes(rule))) {
        let next = editJson(
          settings.text,
          {
            op: 'remove',
            path: ['permissions', 'allow'],
            match: (rule) => typeof rule === 'string' && added.includes(rule),
          },
          settings.path,
        )
        // What init made to hold them goes too, when nothing else is in it.
        const after = JSON.parse(next.replace(/^﻿/, '')) as Json
        const permissions = isObject(after.permissions) ? after.permissions : null
        if (permissions && Array.isArray(permissions.allow) && permissions.allow.length === 0)
          next = editJson(next, { op: 'delete', path: ['permissions', 'allow'] }, settings.path)
        const left = JSON.parse(next.replace(/^﻿/, '')) as Json
        if (isObject(left.permissions) && Object.keys(left.permissions).length === 0)
          next = editJson(next, { op: 'delete', path: ['permissions'] }, settings.path)
        await writeBack(settings.path, next)
        steps.push({
          ok: true,
          text: `Took Pending You’s rules out of Antigravity’s permissions (${settings.path}).`,
        })
      }
    }
    for (const path of [...threadFiles(io, 'antigravity'), ...agyHookFiles(io)])
      await rm(path, { recursive: true, force: true })
    await removePresenceFiles(io, 'antigravity')
    await rm(manifestPath(io), { force: true })
    return steps
  },

  async status(io, ctx: StatusContext): Promise<AppStatus> {
    const { origin, signIn } = ctx
    const flag = originArgs(origin)
    const dir = pluginDir(io)
    const [detected, manifest, plugin, off, settings, global] = await Promise.all([
      antigravity.detect(io),
      readAntigravityManifest(io),
      pluginJson(io),
      turnedOff(io),
      readSettings(io),
      readFile(globalMcpPath(io)),
    ])
    const credential = await readCredential(io, origin, 'antigravity')
    const url = `${origin}/mcp`
    const why = headlessReason(io)
    const mark = (ok: boolean) => (ok ? 'ok     ' : 'missing')
    const fix = `npx pendingyou init --app antigravity${flag}`
    const mcp = await readFile(join(dir, 'mcp_config.json'))
    const server = 'json' in mcp ? serverIn(mcp.json) : null
    const theirs = 'json' in global ? serverIn(global.json) : null
    const bridged = Boolean(
      server?.command && isOurBridge(server.command) && originOf(server) === origin,
    )
    // Through the bridge: the plugin's server runs it, init set it up so, or nothing is set up yet and init would.
    const bridge = bridged || manifest?.signsIn === 'bridge' || (!server && !manifest && !theirs)
    const connected = credential?.kind === 'connection'
    const signOk = signIn.state === 'ok' && (!bridge || connected)
    const title =
      signIn.state === 'ok' && signIn.for ? connectionTitle(signIn.for) : `${NAME} on this computer`
    const signText =
      signIn.state === 'ok'
        ? bridge
          ? connected
            ? `this computer’s own connection, ${title}; Antigravity here asks and hears through it`
            : `this computer’s sign-in for Antigravity only hears answers, so Antigravity here can’t use it; run npx pendingyou login --app antigravity${flag}`
          : `hears for ${signIn.connections} Antigravity connection${signIn.connections === 1 ? '' : 's'}`
        : signIn.state === 'ended'
          ? `ended; run npx pendingyou login --app antigravity${flag}`
          : signIn.state === 'none'
            ? `not signed in; run ${bridged ? `npx pendingyou login --app antigravity${flag}` : fix}`
            : 'Pending You couldn’t be reached'
    const ours = plugin !== null && plugin !== 'invalid' && isOurPlugin(plugin)
    const pluginOk = ours && !off
    const pluginText = !ours
      ? plugin === null
        ? `not installed; run ${fix}`
        : `${dir} holds a plugin that isn’t Pending You’s`
      : off
        ? `${dir}, turned off in Antigravity; run agy plugin enable ${PLUGIN}`
        : `${dir}, on`
    // Its server: the plugin's, or (kept) the person's own in the global mcp_config.json.
    const kept = !server && manifest?.signsIn === 'kept' && theirs !== null
    const reaches = server ? originOf(server) : theirs ? originOf(theirs) : null
    const mcpOk = kept
      ? reaches === origin
      : Boolean(server) && reaches === origin && (!bridge || bridged)
    const mcpText = (() => {
      if ('invalid' in mcp) return mcp.invalid
      if (kept && theirs)
        return reaches === origin
          ? `pendingyou in ${globalMcpPath(io)}, your own (Antigravity signs in to it by itself)`
          : `pendingyou in ${globalMcpPath(io)} points at ${theirs.url ?? `${reaches}/mcp`}, not ${url}; run ${fix} --yes`
      if (!server) return `not added; run ${fix}`
      if (reaches !== origin)
        return `points at ${server.url ?? `${reaches}/mcp`}, not ${url}; run ${fix}`
      if (bridged)
        return `pendingyou in ${mcp.path}, through the bridge (${bridgePath(io)} --app antigravity); its main tools load with each conversation`
      return bridge
        ? `pendingyou (${server.url}) signs in by itself; run ${fix} to use this computer’s sign-in`
        : `pendingyou (${server.url}), signed in by Antigravity itself (its /mcp)`
    })()
    const check = bridge && bridged ? await checkBridge(io, origin, 'antigravity') : null
    const reached =
      check?.ok && signOk && signIn.state === 'ok'
        ? await probeBridge(io, origin, 'antigravity')
        : null
    const bridgeLine = check
      ? check.ok
        ? reached === null
          ? `${check.node} (${foundBy(check.from)}) runs pendingyou ${check.version}, and Pending You takes Antigravity’s sign-in`
          : `${check.node} runs pendingyou ${check.version}, but ${reached}`
        : `${check.why}; run ${fix}`
      : null
    const bridgeOk = !check || (check.ok && reached === null)
    const rules = (await readText(join(dir, 'rules', 'AGENTS.md')).catch(() => null)) !== null
    const skill =
      (await readText(join(dir, 'skills', 'pendingyou', 'SKILL.md')).catch(() => null)) !== null
    const rulesOk = rules && skill
    const rulesText_ = rulesOk
      ? `${join(dir, 'rules', 'AGENTS.md')} (always on) and the pendingyou skill`
      : `${rules ? 'the skill' : 'the rules'} ${rules || skill ? 'is' : 'are'} missing; run ${fix}`
    const hooks = await readFile(join(dir, 'hooks.json'))
    const named =
      'json' in hooks && isObject(hooks.json[PLUGIN]) ? (hooks.json[PLUGIN] as Json) : {}
    const has = (event: string, sub: string) =>
      Array.isArray(named[event]) &&
      (named[event] as unknown[]).some(
        (entry) =>
          isObject(entry) &&
          (isOurHook(entry.command, sub) ||
            (Array.isArray(entry.hooks) &&
              entry.hooks.some((hook) => isObject(hook) && isOurHook(hook.command, sub)))),
      )
    const events = Object.entries(AGY_HOOK_EVENTS)
    const hooksOk = events.every(([sub, event]) => has(event, sub))
    const hooksText = hooksOk
      ? `${events.map(([, event]) => event).join(', ')}, in ${hooks.path}`
      : `not installed; run ${fix}`
    const allowed = allowedIn(settings)
    const permitted = PERMISSION_RULES.every((rule) => allowed.includes(rule))
    const permissionText =
      'invalid' in settings
        ? settings.invalid
        : permitted
          ? `Antigravity runs Pending You’s tools and its hold without asking (${settings.path})`
          : `Antigravity asks before each Pending You tool call and each hold; to allow them, run ${fix} at a terminal`
    const lines = [
      `Pending You for Antigravity · ${origin}${why ? ` · no browser here (${why})` : ''}`,
      `  ${mark(signOk)} Sign-in: ${signText}`,
      `  ${mark(detected !== null)} Antigravity: ${detected?.version ?? 'agy not found on PATH'}`,
      `  ${mark(pluginOk)} Plugin: ${pluginText}`,
      `  ${mark(mcpOk)} MCP server: ${mcpText}`,
      ...(bridgeLine ? [`  ${mark(bridgeOk)} Bridge: ${bridgeLine}`] : []),
      `  ${mark(rulesOk)} Rules and skill: ${rulesText_}`,
      `  ${mark(hooksOk)} Hooks: ${hooksText}`,
      `  ${permitted ? 'ok     ' : '       '} Permissions: ${permissionText}`,
      connected && hooksOk
        ? '  ok      Presence: tells Pending You when a conversation is open (its keeper says so every 5 minutes while agy runs)'
        : `          Presence: off: it needs ${connected ? 'the hooks' : 'Antigravity signed in through this computer’s own connection'}`,
      `          Wake: an idle conversation hears your answer through the hold it starts in the background (${holdCommand('<requestId>', origin, undefined, 'antigravity')}); otherwise with your next message`,
    ]
    const setup = setupStatus(NAME, signIn.state === 'ok' ? setupOf(signIn.for) : null)
    if (setup) lines.push(`  ${setup === 'finished' ? 'ok     ' : '       '} Setup: ${setup}`)
    const reachable = signOk && mcpOk && bridgeOk && pluginOk
    const ready = reachable && signIn.state === 'ok' && hooksOk && rulesOk
    lines.push(
      ready
        ? 'Ready: Antigravity hears answers with your next message, and while it waits on a hold it started.'
        : reachable
          ? 'Not ready: Antigravity hears answers only while it’s working until the lines marked missing are fixed.'
          : 'Not ready: Antigravity here can’t reach Pending You until the lines marked missing are fixed.',
    )
    return { lines, ready }
  },
}
