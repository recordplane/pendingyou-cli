// OpenCode (0.12.0): what `pendingyou init` sets up for it, `status`'s section and `uninstall`. Facts from OpenCode's own
// source and docs (1.18.34, 2026-10-04; docs/assistants/opencode.md has the details):
//
// - Its config is JSON with comments in ~/.config/opencode ($XDG_CONFIG_HOME/opencode): config.json, opencode.json and
//   opencode.jsonc, merged in that order (a project's own config on top). init edits one of them in place, everything
//   else kept (jsonc.ts): the file that holds a `pendingyou` server already, else the one OpenCode writes its own
//   settings to (opencode.jsonc, opencode.json, config.json), else a new opencode.json with OpenCode's `$schema` (it
//   adds one to a file without it, rewriting the file). A file it can't read is left alone, with what to add by hand.
// - Its MCP server: OpenCode can't give a remote server a header from a command, so it runs the stdio bridge as a
//   local server (bridge.ts), `"pendingyou": {"type": "local", "command": ["<config>/bin/pendingyou-mcp", "--app",
//   "opencode"]}`, signed in through this computer's own connection ("OpenCode on build-01"). With `--oauth`, or a remote
//   server the person keeps, it's `{"type": "remote", "url": "<origin>/mcp"}`, which signs in by itself (`opencode mcp
//   auth pendingyou`: a second sign-in, in a browser on this computer). `opencode mcp add` (1.17.0) writes either, but
//   nothing takes one away, so init edits the file itself both ways.
// - Its tools are `pendingyou_<tool>` and run without asking unless the config's `permission` says otherwise: a plain
//   "ask" or "deny" becomes {"*": <it>, "pendingyou_*": "allow"}, and a catch-all rule gets "pendingyou_*": "allow"
//   after it (the last rule that matches wins). A rule of the person's that names Pending You is theirs to keep.
// - Its skill: OpenCode reads ~/.claude/skills and ~/.agents/skills too, so a stub Claude Code's or Codex's init saved
//   there is enough (a second copy is a duplicate it warns about); otherwise the stub goes in
//   ~/.config/opencode/skills/pendingyou/SKILL.md.
// - Its plugin: ~/.config/opencode/plugins/pendingyou.js, one line re-exporting the plugin from this version's private
//   copy (apps/opencode-plugin.ts). OpenCode loads every file there at startup and calls every export. The plugin hands
//   answers over, runs the Stop check and wakes a session, all through the hooks' shim.

import { mkdir, rm, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
import { cliPackage } from '../install.ts'
import type { Io } from '../io.ts'
import { JsoncError, jsonOf, type Node, nodeAt, parse, removeAt, setAt } from '../jsonc.ts'
import { removePresenceFiles } from '../presence.ts'
import { foundBy, headlessReason } from '../remote.ts'
import { connectionTitle, FINISH_SAY, setupOf, setupStatus } from '../setup.ts'
import { VERSION } from '../version.ts'
import { threadFiles } from './codex-wake.ts'
import { APP_NAMES } from './ids.ts'
import { switches } from './switch.ts'
import type {
  AppContext,
  AppModule,
  AppStatus,
  InstallContext,
  Prepared,
  StatusContext,
  Step,
} from './types.ts'

type Json = Record<string, unknown>
const NAME = APP_NAMES.opencode
/** OpenCode's own `$schema`: a file without one, OpenCode rewrites to add it. */
const SCHEMA = 'https://opencode.ai/config.json'
/** The oldest OpenCode init sets up: `opencode mcp add` (1.17.0) and the plugin hooks the plugin uses. */
export const OPENCODE_MIN = '1.17.0'
/** What restarting OpenCode means, in init's last lines. */
const RESTART =
  'restart OpenCode here (/exit, then opencode --continue), or start it in the folder you work in'
/** A Pending You tool's name, as OpenCode's permissions see it. */
const TOOL = 'pendingyou_post_request'
/** The rule init adds so Pending You's tools run without asking. */
const ALLOW_KEY = 'pendingyou_*'

/** OpenCode's own folder: $XDG_CONFIG_HOME/opencode or ~/.config/opencode (xdg-basedir's, on a Mac too). */
export const opencodeDir = (io: Pick<Io, 'env' | 'home'>) =>
  join(io.env.XDG_CONFIG_HOME || join(io.home, '.config'), 'opencode')
/** Its global config files, in the order it merges them: the last one's value wins. */
const FILES = ['config.json', 'opencode.json', 'opencode.jsonc']
/** The file OpenCode writes its own settings to: the first of these that's there. */
const OWN = ['opencode.jsonc', 'opencode.json', 'config.json']
export const opencodePluginPath = (io: Pick<Io, 'env' | 'home'>) =>
  join(opencodeDir(io), 'plugins', 'pendingyou.js')
export const opencodeSkillPath = (io: Pick<Io, 'env' | 'home'>) =>
  join(opencodeDir(io), 'skills', 'pendingyou', 'SKILL.md')
const manifestPath = (io: Pick<Io, 'env' | 'home'>) => join(configDir(io), 'opencode.json')
/** The plugin in a copy of this package (its folder in node_modules). */
export const pluginModule = (packageRoot: string) =>
  join(packageRoot, 'dist', 'apps', 'opencode-plugin.js')

export interface OpenCodeManifest {
  version: 1
  origin: string
  /** OpenCode's config folder init edited. */
  configDir: string
  /** The config file that holds the pendingyou server, and whether init wrote that entry (uninstall takes it out). */
  file: string | null
  mcpAdded: boolean
  /** init made the file. */
  created?: boolean
  /** How its server signs in: through the bridge, or by itself (OpenCode's OAuth). */
  mode: 'bridge' | 'oauth'
  /** The bridge's command in the entry; null when it signs in by itself. */
  bridge: string[] | null
  /** What init changed in `permission`: the rule it added, or the plain value it made into rules. */
  permission?: { file: string; added: string } | { file: string; was: string } | null
  skill: { path: string; sha256: string } | null
  /** The plugin file init wrote. */
  plugin: string | null
  setup?: { since: string }
}

export const readOpenCodeManifest = (io: Pick<Io, 'env' | 'home'>) =>
  readJson<OpenCodeManifest>(manifestPath(io)).catch(() => null)

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** One of OpenCode's config files: its text and what's in it (`root` null when it's empty). */
interface ConfigFile {
  path: string
  text: string
  root: Node | null
}

/** OpenCode's global config, as init reads it: never written to by reading. */
interface Config {
  files: ConfigFile[]
  /** A file init can't read or edit safely, and why: init leaves it alone (OpenCode skips a file it can't read too). */
  broken: { path: string; why: string } | null
  /** The pendingyou server OpenCode uses: the last file's that has one. */
  server: { file: ConfigFile; value: unknown } | null
  /** The `permission` OpenCode uses: the last file's that has one. */
  permission: { file: ConfigFile; value: unknown } | null
}

async function readConfig(io: Pick<Io, 'env' | 'home'>): Promise<Config> {
  const config: Config = { files: [], broken: null, server: null, permission: null }
  for (const name of FILES) {
    const path = join(opencodeDir(io), name)
    const text = await readText(path).catch(() => null)
    if (text === null) continue
    try {
      const root = text.trim() ? parse(text) : null
      if (root && root.type !== 'object') throw new JsoncError('it isn’t an object')
      const file = { path, text, root }
      config.files.push(file)
      const server = root ? nodeAt(root, ['mcp', 'pendingyou']) : null
      if (server) config.server = { file, value: jsonOf(server) }
      const permission = root ? nodeAt(root, ['permission']) : null
      if (permission) config.permission = { file, value: jsonOf(permission) }
    } catch (error) {
      config.broken ??= {
        path,
        why: error instanceof JsoncError ? error.message : 'it can’t be read',
      }
    }
  }
  return config
}

/** The file init writes the server into: the one that has it, else the one OpenCode writes to, else a new one. */
function targetOf(io: Pick<Io, 'env' | 'home'>, config: Config): ConfigFile | { path: string } {
  if (config.server) return config.server.file
  for (const name of OWN) {
    const found = config.files.find((file) => basename(file.path) === name)
    if (found) return found
  }
  return { path: join(opencodeDir(io), 'opencode.json') }
}

/** A pendingyou server, as init sees it: ours (the bridge), one that signs in by itself, or something else. */
type Server =
  | { kind: 'bridge'; origin: string; command: string[] }
  | { kind: 'remote'; url: string }
  | { kind: 'other'; what: string }

function classify(value: unknown): Server {
  if (isObject(value)) {
    if (value.type === 'local' && isOurBridge(value.command))
      return { kind: 'bridge', origin: bridgeOrigin(value.command), command: value.command }
    if (value.type === 'remote' && typeof value.url === 'string')
      return { kind: 'remote', url: value.url }
    if (
      Array.isArray(value.command) &&
      value.command.every((part: unknown) => typeof part === 'string')
    )
      return { kind: 'other', what: (value.command as string[]).join(' ') }
  }
  return { kind: 'other', what: JSON.stringify(value)?.slice(0, 120) ?? 'nothing' }
}

/** The pendingyou server a config file's text holds; null when there's none, or the text can't be read. */
function serverIn(text: string): Server | null {
  try {
    const node = text.trim() ? nodeAt(parse(text), ['mcp', 'pendingyou']) : null
    return node ? classify(jsonOf(node)) : null
  } catch {
    return null
  }
}

/** OpenCode's pendingyou server's address (the hooks compare it with theirs: environment.ts); null when there's none. */
export async function opencodeServer(io: Pick<Io, 'env' | 'home'>): Promise<string | null> {
  const config = await readConfig(io)
  const server = config.server ? classify(config.server.value) : null
  return server?.kind === 'bridge'
    ? `${server.origin}/mcp`
    : server?.kind === 'remote'
      ? server.url
      : null
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')
const sameCommand = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((part, index) => part === b[index])

/** The entry init writes, keeping what the person set on the one that's there (on, off, a timeout, its environment). */
function entryOf(
  mode: 'bridge' | 'oauth',
  bridge: string[] | null,
  url: string,
  before: unknown,
): Json {
  const kept: Json = {}
  if (isObject(before)) {
    if (typeof before.enabled === 'boolean') kept.enabled = before.enabled
    if (typeof before.timeout === 'number') kept.timeout = before.timeout
    if (mode === 'bridge' && before.type === 'local' && isObject(before.environment))
      kept.environment = before.environment
  }
  return mode === 'bridge'
    ? { type: 'local', command: bridge, ...kept }
    : { type: 'remote', url, ...kept }
}

/** A permission pattern, as OpenCode matches one: `*` any run of characters, `?` one, the rest as it is. */
const wildcard = (text: string, pattern: string) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
    's',
  ).test(text)

/**
 * What OpenCode does before a Pending You tool runs, from the config's `permission`, and the rule that decides it: the
 * last that matches wins (OpenCode's own default lets every MCP tool run).
 */
export function toolPermission(value: unknown): { action: string; key: string | null } {
  if (typeof value === 'string') return { action: value, key: null }
  let found: { action: string; key: string | null } = { action: 'allow', key: null }
  if (!isObject(value)) return found
  for (const [key, rule] of Object.entries(value)) {
    if (!wildcard(TOOL, key)) continue
    if (typeof rule === 'string') found = { action: rule, key }
    else if (isObject(rule))
      for (const [pattern, action] of Object.entries(rule))
        if (typeof action === 'string' && wildcard('*', pattern)) found = { action, key }
  }
  return found
}

/** The one-line plugin file: Pending You's plugin from this version's private copy, re-exported as it is. */
export function pluginFile(module: string): string {
  return `// Pending You for OpenCode: hands it your answers, wakes a session when you answer, and asks it to put what it
// leaves you in chat on a card. Written by npx pendingyou init (pendingyou ${VERSION}); run that again to repair it.
export { PendingYou } from ${JSON.stringify(pathToFileURL(module).href)}
`
}

/** The module a plugin file of ours points at; null for a file that isn't ours. */
export function pluginTarget(text: string): string | null {
  const found =
    /^export \{ PendingYou \} from "(file:\/\/[^"]+\/node_modules\/pendingyou\/dist\/apps\/opencode-plugin\.js)"$/m.exec(
      text,
    )
  if (!found) return null
  try {
    return fileURLToPath(found[1] as string)
  } catch {
    return null
  }
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

/**
 * A pendingyou skill OpenCode reads already, saved for Claude Code or Codex (~/.claude/skills, ~/.agents/skills),
 * unless the environment turns those folders off for OpenCode.
 */
async function sharedSkill(io: Pick<Io, 'env' | 'home'>): Promise<string | null> {
  const on = (name: string) => !['1', 'true'].includes((io.env[name] ?? '').toLowerCase())
  const places = [
    ...(on('OPENCODE_DISABLE_EXTERNAL_SKILLS') &&
    on('OPENCODE_DISABLE_CLAUDE_CODE') &&
    on('OPENCODE_DISABLE_CLAUDE_CODE_SKILLS')
      ? [join(io.home, '.claude', 'skills', 'pendingyou', 'SKILL.md')]
      : []),
    ...(on('OPENCODE_DISABLE_EXTERNAL_SKILLS')
      ? [join(io.home, '.agents', 'skills', 'pendingyou', 'SKILL.md')]
      : []),
  ]
  for (const place of places) if (await exists(place)) return place
  return null
}

const switchesFor = (io: Io, ctx: AppContext) =>
  switches(io, ctx, {
    name: 'OpenCode',
    what: 'OpenCode signs in to Pending You by itself here (opencode mcp auth).',
    uses: 'its plugin uses',
    headless: true,
  })

/** Writes a config file, making its folder; false when it can't. */
const writeConfig = (path: string, text: string) =>
  mkdir(dirname(path), { recursive: true })
    .then(() => writeWhole(path, text))
    .then(
      () => true,
      () => false,
    )

/** What to add by hand when init can't edit the file: the entry, as it would have written it. */
const byHand = (entry: Json) => `"pendingyou": ${JSON.stringify(entry)}`

/**
 * Sets the server's entry in the file, and makes Pending You's tools run without asking where the config would make
 * OpenCode ask: steps reported, and what init changed, for the manifest.
 */
async function writeServer(
  io: Io,
  config: Config,
  entry: Json,
  report: (step: Step) => void,
  done: string,
): Promise<{ file: string; created: boolean } | null> {
  const target = targetOf(io, config)
  const before = 'text' in target ? target.text : null
  const base = before?.trim() ? before : `{\n  "$schema": ${JSON.stringify(SCHEMA)}\n}\n`
  let next: string
  try {
    next = setAt(base, ['mcp', 'pendingyou'], entry)
  } catch (error) {
    report({
      ok: false,
      text: `Couldn’t add the pendingyou MCP server: ${target.path} has ${error instanceof JsoncError ? error.message : 'a shape I can’t edit'}, so I left it alone. Add this to its "mcp" by hand, then restart OpenCode:\n    ${byHand(entry)}`,
    })
    return null
  }
  if (!(await writeConfig(target.path, next))) {
    report({
      ok: false,
      text: `Couldn’t write ${target.path}. Add this to its "mcp" by hand, then restart OpenCode:\n    ${byHand(entry)}`,
    })
    return null
  }
  report({ ok: true, text: done.replace('<file>', target.path) })
  return { file: target.path, created: before === null }
}

/**
 * Lets Pending You's tools run without asking, where the global config would have OpenCode ask (or refuse): a plain
 * value becomes rules, a catch-all gets Pending You's rule after it. A rule that names Pending You is the person's.
 */
async function allowTools(
  io: Io,
  report: (step: Step) => void,
): Promise<OpenCodeManifest['permission']> {
  const config = await readConfig(io)
  const permission = config.permission
  if (!permission) return null
  const decided = toolPermission(permission.value)
  if (decided.action === 'allow') return null
  if (decided.key && /pendingyou/i.test(decided.key)) {
    report({
      ok: true,
      text: `OpenCode will ${decided.action === 'deny' ? 'refuse' : 'ask before'} each Pending You tool: your rule “${decided.key}” in ${permission.file.path} says so. Make it "allow" to let them run while you’re away.`,
    })
    return null
  }
  const { file } = permission
  const plain = typeof permission.value === 'string' ? permission.value : null
  let next: string
  try {
    next = plain
      ? setAt(file.text, ['permission'], { '*': plain, [ALLOW_KEY]: 'allow' })
      : setAt(file.text, ['permission', ALLOW_KEY], 'allow')
  } catch {
    report({
      ok: false,
      text: `OpenCode will ask before each Pending You tool, and I couldn’t edit "permission" in ${file.path}: add "${ALLOW_KEY}": "allow" to it by hand.`,
    })
    return null
  }
  if (!(await writeConfig(file.path, next))) {
    report({ ok: false, text: `Couldn’t write ${file.path}.` })
    return null
  }
  report({
    ok: true,
    text: `Pending You’s tools run without asking: added "${ALLOW_KEY}": "allow" to "permission" in ${file.path}.`,
  })
  return plain ? { file: file.path, was: plain } : { file: file.path, added: ALLOW_KEY }
}

/** Writes the plugin file, unless one of someone else's is there. */
async function addPlugin(
  io: Io,
  ictx: InstallContext,
  report: (step: Step) => void,
): Promise<string | null> {
  const path = opencodePluginPath(io)
  const module = ictx.copy ? pluginModule(cliPackage(ictx.copy.prefix)) : null
  if (!module || !(await exists(module))) {
    report({
      ok: false,
      text: 'Couldn’t add the plugin without the hooks’ own copy of pendingyou, so OpenCode isn’t woken when you answer. Run init again.',
    })
    return null
  }
  const existing = await readText(path).catch(() => null)
  if (existing !== null && pluginTarget(existing) === null) {
    report({
      ok: false,
      text: `Kept ${path}: it isn’t the plugin init writes. Move it, then run init again.`,
    })
    return null
  }
  const text = pluginFile(module)
  if (existing === text) {
    report({ ok: true, text: 'The plugin was already in OpenCode.' })
    return path
  }
  try {
    await writeWhole(path, text)
  } catch {
    report({ ok: false, text: `Couldn’t write ${path}. Run init again.` })
    return null
  }
  report({
    ok: true,
    text: `Added the plugin to ${path}: it hands OpenCode your answers, wakes a session when you answer, and asks it to put what it leaves you in chat on a card.`,
  })
  return path
}

export const opencode: AppModule = {
  id: 'opencode',
  name: NAME,
  minVersion: OPENCODE_MIN,

  async detect(io) {
    const result = await io.run('opencode', ['--version'], 20_000)
    if (result.code !== 0) return null
    return { version: /(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1] ?? 'installed' }
  },

  async installed(io) {
    return (await readOpenCodeManifest(io)) !== null
  },

  async usesHelper(io, origin) {
    if (io.platform === 'win32') return false
    const config = await readConfig(io)
    const server = config.server ? classify(config.server.value) : null
    return server?.kind === 'bridge' && server.origin === origin
  },

  async prepare(io, ctx, detected): Promise<Prepared> {
    const url = `${ctx.origin}/mcp`
    const flag = originArgs(ctx.origin)
    const skip = (step: Step): Prepared => ({
      app: opencode,
      detected,
      signIn: null,
      skipped: step,
      install: async () => [],
      next: () => null,
    })
    // The plugin and the bridge's launcher run with sh: not on Windows, where its setup message sets it up.
    if (io.platform === 'win32')
      return skip({
        ok: true,
        text: 'OpenCode on Windows isn’t set up by init yet: paste Pending You’s setup message for OpenCode into it instead.',
      })
    const config = await readConfig(io)
    const server = config.server ? classify(config.server.value) : null
    const wanted = bridgeCommand(io, ctx.origin, 'opencode')
    let mode: 'bridge' | 'oauth' = ctx.oauth ? 'oauth' : 'bridge'
    let action: 'add' | 'keep' | 'write' = 'add'
    let note: Step | null = null
    const elsewhere =
      server?.kind === 'bridge' && server.origin !== ctx.origin
        ? server.origin
        : server?.kind === 'remote' && !sameUrl(server.url, url)
          ? server.url
          : null
    if (elsewhere) {
      ctx.progress(`OpenCode’s pendingyou MCP server points at ${elsewhere}, not ${url}.\n`)
      const replace =
        ctx.yes ||
        (io.interactive && /^\s*y(es)?\s*$/i.test(await io.ask(`Replace it with ${url}? [y/N] `)))
      if (!replace)
        return skip({
          ok: false,
          text: `Kept OpenCode’s pendingyou MCP server at ${elsewhere}, so OpenCode isn’t set up for ${ctx.origin}. To use ${url}, run init again with --yes.`,
        })
      action = 'write'
    } else if (server?.kind === 'bridge')
      action = mode === 'bridge' && sameCommand(server.command, wanted) ? 'keep' : 'write'
    else if (server?.kind === 'remote') {
      // It signs in by itself (OpenCode's own OAuth): kept with --oauth, else moved as the person says.
      if (mode === 'oauth') action = 'keep'
      else if (await switchesFor(io, ctx)) action = 'write'
      else {
        mode = 'oauth'
        action = 'keep'
        note = {
          ok: true,
          text: `Kept OpenCode’s own sign-in to Pending You (${url}). To move it to this computer’s, run: npx -y pendingyou@latest init --app opencode --yes${flag}`,
        }
      }
    } else if (server?.kind === 'other') {
      // Someone's own way to reach Pending You: theirs to change. The plugin hears through a sign-in of its own.
      mode = 'oauth'
      action = 'keep'
      note = {
        ok: false,
        text: `Kept OpenCode’s pendingyou MCP server in ${config.server?.file.path}: it runs ${server.what}, not Pending You’s bridge. To use this computer’s sign-in instead, take it out and run init again.`,
      }
    }
    return {
      app: opencode,
      detected,
      signIn: mode === 'bridge' ? 'connection' : 'hear',
      bridged: mode === 'bridge',
      install: async (ictx) => {
        const steps: Step[] = []
        const report = (step: Step) => {
          steps.push(step)
          ictx.report(step)
        }
        const before = await readOpenCodeManifest(io)
        const now = await readConfig(io)
        let file = before?.file ?? now.server?.file.path ?? null
        let added = before?.mcpAdded ?? false
        let created = before?.created ?? false
        if (note) report(note)
        else if (action === 'keep')
          report({
            ok: true,
            text:
              mode === 'bridge'
                ? `The pendingyou MCP server (${url}) already runs through this computer’s bridge.`
                : `The pendingyou MCP server (${url}) was already in OpenCode.`,
          })
        else if (mode === 'bridge' && !ictx.bridge)
          report({
            ok: false,
            text: 'Didn’t add OpenCode’s pendingyou MCP server: it runs pendingyou’s own copy through the bridge, which isn’t installed. Run init again.',
          })
        else if (now.broken)
          report({
            ok: false,
            text: `Couldn’t add the pendingyou MCP server: ${now.broken.path} can’t be read (${now.broken.why}), so I left it alone; OpenCode skips it too until it’s fixed. Fix it, then run init again, or add this to its "mcp" by hand:\n    ${byHand(entryOf(mode, ictx.bridge, url, now.server?.value))}`,
          })
        else {
          const entry = entryOf(mode, ictx.bridge, url, now.server?.value)
          const written = await writeServer(
            io,
            now,
            entry,
            report,
            !server
              ? `Added the pendingyou MCP server (${url}) to <file>${mode === 'bridge' ? `, through this computer’s bridge (${bridgePath(io)}): nothing to sign in to in OpenCode` : ''}.`
              : elsewhere
                ? `Replaced OpenCode’s pendingyou MCP server (was ${elsewhere}) with ${url}, in <file>.`
                : mode === 'bridge'
                  ? `Switched OpenCode’s pendingyou MCP server (${url}) to this computer’s sign-in, through the bridge: one sign-in for it and its plugin.`
                  : `Switched OpenCode’s pendingyou MCP server (${url}) to OpenCode’s own sign-in: run opencode mcp auth pendingyou.`,
          )
          if (written) {
            file = written.file
            added = true
            created ||= written.created
          }
        }
        // A rule init added before stays init's to take out, while it's still there.
        const kept = (await readConfig(io)).permission?.value
        const permission =
          (await allowTools(io, report)) ??
          (before?.permission && isObject(kept) && kept[ALLOW_KEY] === 'allow'
            ? before.permission
            : null)
        // The skill: one OpenCode reads already is enough; a second copy is a duplicate it warns about.
        const shared = await sharedSkill(io)
        let skill: OpenCodeManifest['skill'] = null
        if (shared) {
          if (before?.skill) await removeSkill(before.skill)
          report({
            ok: true,
            text: `OpenCode reads the pendingyou skill already saved at ${shared}.`,
          })
        } else {
          const saved = await saveSkill(
            io,
            ictx.origin,
            opencodeSkillPath(io),
            before?.skill ?? null,
          )
          skill = saved.skill
          report(saved.step)
        }
        const plugin = await addPlugin(io, ictx, report)
        const manifest: OpenCodeManifest = {
          version: 1,
          origin: ictx.origin,
          configDir: opencodeDir(io),
          file,
          mcpAdded: added,
          ...(created ? { created } : {}),
          mode,
          bridge: mode === 'bridge' ? ictx.bridge : null,
          permission,
          skill,
          plugin: plugin ?? before?.plugin ?? null,
          setup: { since: new Date(io.now()).toISOString() },
        }
        await writeWhole(manifestPath(io), `${JSON.stringify(manifest, null, 2)}\n`, {
          secret: true,
        })
        return steps
      },
      next: () => {
        if (mode === 'oauth') {
          // A remote server init wrote signs in by itself: once, in the browser here.
          const first =
            action !== 'keep'
              ? 'run opencode mcp auth pendingyou (your browser opens on Pending You: press Allow), then '
              : ''
          return {
            lines: [`Next: ${first}${RESTART}.`, 'Then say this to it:', '', FINISH_SAY],
            together: `- OpenCode: ${first}${RESTART}, then say the line below to it.`,
            say: true,
          }
        }
        return {
          lines: [
            `Next: ${RESTART}.`,
            'It finishes setting up the first time you write to it, and sends you a test card. If it doesn’t, say this to it:',
            '',
            FINISH_SAY,
          ],
          together: `- OpenCode: ${RESTART}. It finishes setting up the first time you write to it.`,
          say: true,
        }
      },
    }
  },

  async uninstall(io) {
    const manifest = await readOpenCodeManifest(io)
    const steps: Step[] = []
    const config = await readConfig(io)
    // Each file's text as uninstall leaves it.
    const texts = new Map(config.files.map((file) => [file.path, file.text]))
    const edit = (path: string, change: (text: string) => string) => {
      const text = texts.get(path)
      if (text === undefined) return
      try {
        texts.set(path, change(text))
      } catch {}
    }
    if (manifest?.mcpAdded && manifest.file && texts.has(manifest.file)) {
      const path = manifest.file
      const server = serverIn(texts.get(path) as string)
      // Only while it's still the one init wrote.
      const ours =
        server?.kind === 'bridge' ||
        (server?.kind === 'remote' && sameUrl(server.url, `${manifest.origin}/mcp`))
      if (ours) {
        edit(path, (text) => {
          const without = removeAt(text, ['mcp', 'pendingyou'])
          const mcp = nodeAt(parse(without), ['mcp'])
          const empty =
            mcp?.type === 'object' &&
            mcp.members.length === 0 &&
            !without.slice(mcp.start + 1, mcp.end - 1).trim()
          return empty ? removeAt(without, ['mcp']) : without
        })
        steps.push({ ok: true, text: `Removed the pendingyou MCP server from ${path}.` })
      }
    }
    const permission = manifest?.permission
    if (permission && texts.has(permission.file)) {
      edit(permission.file, (text) => {
        const node = nodeAt(parse(text), ['permission'])
        const value = node ? jsonOf(node) : undefined
        if (!isObject(value) || value[ALLOW_KEY] !== 'allow') return text
        // Rules init made from a plain value go back to it while nobody added any since.
        if ('was' in permission && Object.keys(value).length === 2 && value['*'] === permission.was)
          return setAt(text, ['permission'], permission.was)
        return removeAt(text, ['permission', ALLOW_KEY])
      })
      steps.push({ ok: true, text: 'Took Pending You’s rule out of OpenCode’s "permission".' })
    }
    for (const file of config.files) {
      const text = texts.get(file.path) as string
      if (text === file.text) continue
      // A file init made, with nothing left in it but OpenCode's $schema, goes.
      let left: unknown = null
      try {
        left = text.trim() ? jsonOf(parse(text)) : {}
      } catch {}
      const bare =
        isObject(left) &&
        Object.keys(left).every((key) => key === '$schema') &&
        manifest?.created &&
        file.path === manifest.file
      if (bare) await rm(file.path, { force: true })
      else await writeWhole(file.path, text)
    }
    const pluginAt = manifest?.plugin ?? opencodePluginPath(io)
    const plugin = await readText(pluginAt).catch(() => null)
    if (plugin !== null && pluginTarget(plugin) !== null) {
      await rm(pluginAt, { force: true })
      await rmdir(dirname(pluginAt)).catch(() => {})
      steps.push({ ok: true, text: 'Removed the plugin from OpenCode.' })
    }
    const skill = await removeSkill(manifest?.skill ?? null)
    if (skill) steps.push(skill)
    for (const path of threadFiles(io, 'opencode')) await rm(path, { recursive: true, force: true })
    await removePresenceFiles(io, 'opencode')
    await rm(manifestPath(io), { force: true })
    if (steps.length === 0)
      steps.push({ ok: true, text: 'Nothing of Pending You’s was in OpenCode.' })
    return steps
  },

  async status(io, ctx: StatusContext): Promise<AppStatus> {
    const { origin, signIn } = ctx
    const flag = originArgs(origin)
    const [detected, config, manifest] = await Promise.all([
      opencode.detect(io),
      readConfig(io),
      readOpenCodeManifest(io),
    ])
    const credential = await readCredential(io, origin, 'opencode')
    const url = `${origin}/mcp`
    const why = headlessReason(io)
    const mark = (ok: boolean) => (ok ? 'ok     ' : 'missing')
    const init = `npx pendingyou init --app opencode${flag}`
    const server = config.server ? classify(config.server.value) : null
    const entry = isObject(config.server?.value) ? config.server.value : {}
    const bridged = server?.kind === 'bridge' && server.origin === origin
    // Through the bridge: its server runs ours, init set it up so, or nothing is set up yet and init would.
    const bridgeMode =
      bridged || manifest?.mode === 'bridge' || (!server && manifest?.mode !== 'oauth')
    const connected = credential?.kind === 'connection'
    const signOk = signIn.state === 'ok' && (!bridgeMode || connected)
    const title =
      signIn.state === 'ok' && signIn.for ? connectionTitle(signIn.for) : `${NAME} on this computer`
    const fix = `npx pendingyou ${bridged ? 'login --app opencode' : 'init --app opencode'}${flag}`
    const signText =
      signIn.state === 'ok'
        ? bridgeMode
          ? connected
            ? `this computer’s own connection, ${title}; OpenCode here asks and hears through it`
            : `this computer’s sign-in for OpenCode only hears answers, so OpenCode here can’t use it; run ${fix}`
          : `hears for ${signIn.connections} OpenCode connection${signIn.connections === 1 ? '' : 's'}`
        : signIn.state === 'ended'
          ? `ended; run ${fix}`
          : signIn.state === 'none'
            ? `not signed in; run ${fix}`
            : 'Pending You couldn’t be reached'
    const off = entry.enabled === false
    const remoteHere = server?.kind === 'remote' && sameUrl(server.url, url)
    const mcpOk = !off && (bridgeMode ? bridged : remoteHere)
    const where = config.server ? ` in ${config.server.file.path}` : ''
    const permission = toolPermission(config.permission?.value)
    const asks =
      permission.action === 'allow'
        ? '; its tools run without asking'
        : `; OpenCode ${permission.action === 'deny' ? 'refuses' : 'asks before'} each of its tools (“${permission.key ?? permission.action}” in ${config.permission?.file.path})`
    const mcpText = config.broken
      ? `${config.broken.path} can’t be read (${config.broken.why}); fix it, then run ${init}`
      : !server
        ? `not added; run ${init}`
        : off
          ? `pendingyou${where} is turned off ("enabled": false)`
          : server.kind === 'bridge'
            ? server.origin !== origin
              ? `points at ${server.origin}, not ${origin}; run ${init} --yes to replace it`
              : `pendingyou${where}, through the bridge (${bridgePath(io)} --app opencode)${asks}`
            : server.kind === 'remote'
              ? !remoteHere
                ? `points at ${server.url}, not ${url}; run ${init} --yes to replace it`
                : bridgeMode
                  ? `pendingyou (${server.url})${where} signs in by itself; run ${init} to use this computer’s sign-in`
                  : `pendingyou (${server.url})${where}, signed in by OpenCode itself (opencode mcp auth pendingyou)${asks}`
              : `pendingyou${where} runs ${server.what}, not Pending You’s bridge`
    const check = bridgeMode && bridged ? await checkBridge(io, origin, 'opencode') : null
    const reached =
      check?.ok && signOk && signIn.state === 'ok'
        ? await probeBridge(io, origin, 'opencode')
        : null
    const bridgeLine = check
      ? check.ok
        ? reached === null
          ? `${check.node} (${foundBy(check.from)}) runs pendingyou ${check.version}, and Pending You takes OpenCode’s sign-in`
          : `${check.node} runs pendingyou ${check.version}, but ${reached}`
        : `${check.why}; run ${init}`
      : null
    const bridgeOk = !check || (check.ok && reached === null)
    const pluginText = await readText(opencodePluginPath(io)).catch(() => null)
    const target = pluginText === null ? null : pluginTarget(pluginText)
    const pluginOk = target !== null && (await exists(target))
    const pluginLine =
      pluginText === null
        ? `not added; run ${init}`
        : target === null
          ? `${opencodePluginPath(io)} isn’t the one init writes; move it, then run ${init}`
          : pluginOk
            ? `${opencodePluginPath(io)}: hands OpenCode your answers, wakes a session when you answer, and asks it to put what it leaves you in chat on a card`
            : `points at a copy of pendingyou that’s gone (${target}); run ${init}`
    const shared = await sharedSkill(io)
    const own = (await readText(opencodeSkillPath(io)).catch(() => null)) !== null
    const lines = [
      `Pending You for OpenCode · ${origin}${why ? ` · no browser here (${why})` : ''}`,
      `  ${mark(signOk)} Sign-in: ${signText}`,
      `  ${mark(detected !== null)} OpenCode: ${detected?.version ?? 'not found on PATH'}`,
      `  ${mark(mcpOk)} MCP server: ${mcpText}`,
      ...(bridgeLine ? [`  ${mark(bridgeOk)} Bridge: ${bridgeLine}`] : []),
      `  ${mark(pluginOk)} Plugin: ${pluginLine}`,
      `  ${mark(own || shared !== null)} Skill: ${own ? `saved (${opencodeSkillPath(io)})` : shared ? `OpenCode reads the one at ${shared}` : `not saved; run ${init}`}`,
      // Presence (0.15.0): the plugin says when a session is open, with this computer's own connection.
      connected && pluginOk
        ? '  ok      Presence: tells Pending You when this session is open (the plugin says so every 5 minutes while OpenCode runs)'
        : `          Presence: off: it needs ${connected ? 'the plugin' : 'OpenCode signed in through this computer’s own connection'}`,
    ]
    const setup = setupStatus(NAME, signIn.state === 'ok' ? setupOf(signIn.for) : null)
    if (setup) lines.push(`  ${setup === 'finished' ? 'ok     ' : '       '} Setup: ${setup}`)
    const reaches = !bridgeMode || (signOk && mcpOk && bridgeOk)
    const ready = reaches && signIn.state === 'ok' && mcpOk && pluginOk
    lines.push(
      ready
        ? 'Ready: OpenCode hears answers right away (report_setup hears "instant").'
        : reaches && mcpOk
          ? 'Not ready: OpenCode hears answers only while it’s working until the lines marked missing are fixed.'
          : 'Not ready: OpenCode here can’t reach Pending You until the lines marked missing are fixed.',
    )
    return { lines, ready }
  },
}
