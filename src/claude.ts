// Claude Code's side of `pendingyou init` and `uninstall`: the Pending You MCP server (user scope), the stub skill, the
// three hooks (session-start pickup, next-message hand-off, the Stop check) and the permissions the background wait needs, in
// ~/.claude/settings.json. Settings are merged, never replaced: a file that isn't JSON is left alone, entries that
// aren't ours are never touched, and running init again changes nothing it doesn't need to. What init added is written
// down in ~/.config/pendingyou/claude-code.json, so uninstall removes exactly that.
//
// Since 0.7.0 the hooks run a private copy of this version with Node directly (install.ts), and init asks Claude Code
// itself as little as it can: `claude mcp get` and `claude mcp add` each take up to a minute or more (Claude Code checks
// its servers), so the MCP server is looked up in ~/.claude.json first (read only), and init says what it's waiting on.
//
// Since 0.10.0, on Claude Code 2.1.287 or later, settings' env.CLAUDE_CODE_PLUGIN_DIRS also loads the wake mod (mod.ts),
// so a session is woken when the person answers, with no hold running: from that private copy until 0.23.0, and since
// then from ~/.config/pendingyou/mod, a folder init updates in place, so the entry never changes with an upgrade.
//
// Since 0.11.0 the MCP server signs in through this computer's own sign-in on every computer but Windows (or with
// `--oauth`): `claude mcp add-json` with a headersHelper (remote.ts), the same connection the hooks use, so one approval
// covers both. What happens to a server that's there is decided before anyone signs in (apps/claude-code.ts); this file
// carries it out. The hooks run the shim (shim.ts) by its fixed path, so a new version never changes their lines.
import { createHash } from 'node:crypto'
import { rm, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Step } from './apps/types.ts'
import { DEFAULT_ORIGIN } from './args.ts'
import { CHANNEL, CHANNEL_CLAUDE } from './channel.ts'
import { PlainError } from './errors.ts'
import { claudeDir, configDir, readJson, readText, writeWhole } from './files.ts'
import { findHook, type HookSpec, hooksOf, mergeHooks, originArgs, removeHooks } from './hooks.ts'
import {
  cliPackage,
  type HookForm,
  hookForm,
  hookRuns,
  type Installed,
  installMod,
  shellQuote,
} from './install.ts'
import type { Io } from './io.ts'
import { removeLoadedNotes } from './loaded.ts'
import {
  atLeast,
  claudeVersion,
  isOurModDir,
  loadsMods,
  modDir,
  PLUGIN_DIRS,
  pluginDirs,
  pluginEnabled,
  separatorFor,
  stableModDir,
  withModDir,
} from './mod.ts'
import { removePermissionFiles } from './permission.ts'
import { removePresenceFiles } from './presence.ts'
import { helperPath } from './remote.ts'
import { readShim, SHIM, shimPath } from './shim.ts'
import { VERSION } from './version.ts'

export type { Step } from './apps/types.ts'
export { isOurHook } from './hooks.ts'

export const MCP_NAME = 'pendingyou'
/** The hooks, by Claude Code event, and the command each runs. */
export const HOOKS = {
  SessionStart: 'pickup',
  UserPromptSubmit: 'handoff',
  Stop: 'stopcheck',
  /** Presence (0.15.0, presence.ts): the session closed. */
  SessionEnd: 'presence',
} as const
export type HookEvent = keyof typeof HOOKS
/**
 * The same, as hooks.ts takes them. SessionStart has no matcher: pickup itself skips a compaction (setup.ts).
 * SessionEnd has no timeout of ours: Claude Code's 1.5 seconds for SessionEnd hooks stays as it was (presence only
 * starts its send there).
 */
export const CLAUDE_HOOKS: readonly HookSpec[] = (Object.keys(HOOKS) as HookEvent[]).map(
  (event) => ({ event, sub: HOOKS[event], ...(event === 'SessionEnd' ? { timeout: null } : {}) }),
)
/**
 * The permission-prompt hooks (0.13.0, permission.ts), for every tool: the prompt (PermissionRequest), the call it
 * asked about running (PostToolUse, PostToolUseFailure) and the session ending (SessionEnd, with no timeout of ours:
 * a longer one would make Claude Code wait longer for every SessionEnd hook). The next message's and the Stop hooks
 * settle a session's prompts too. Since 0.16.0 a dialog that has waited on screen (Notification, only for
 * `permission_prompt`: Claude Code runs it for no other notification), last, so an older setup's stay in their places.
 */
export const PERMISSION_HOOKS: readonly HookSpec[] = [
  { event: 'PermissionRequest', sub: 'permission' },
  { event: 'PostToolUse', sub: 'permission-done' },
  { event: 'PostToolUseFailure', sub: 'permission-done' },
  { event: 'SessionEnd', sub: 'permission-done', timeout: null },
  { event: 'Notification', sub: 'notify', matcher: 'permission_prompt' },
]
/**
 * The first Claude Code with all of them (PermissionRequest came in 2.0.45, PostToolUseFailure by 2.1.119). An older
 * one gets none: before 2.1.101, a hook event Claude Code didn't know made it ignore the whole settings file.
 */
export const PERMISSION_CLAUDE = '2.1.119'
/**
 * What Claude Code may do without stopping to ask: start the background wait, and use Pending You's own tools (ask
 * the person, read their answers). Without them, a question posted while the person is away would wait on a
 * permission prompt nobody is there to answer.
 */
export const PERMISSIONS = ['Bash(npx pendingyou hold:*)', `mcp__${MCP_NAME}`] as const

type Json = Record<string, unknown>

export interface Manifest {
  version: 1
  origin: string
  claudeDir: string
  /** init added the MCP server (it wasn't there before). */
  mcpAdded: boolean
  /** The stub init wrote, so it's only replaced or removed while it's still ours. */
  skill: { path: string; sha256: string } | null
  hooks: Partial<Record<HookEvent, string>>
  /** Permission rules init added (ones already there aren't ours). */
  permissions: string[]
  /** The private copy the hooks run (0.7.0); null when they run through npx. */
  cli?: { version: string; prefix: string } | null
  /** The wake mod's folder init put in CLAUDE_CODE_PLUGIN_DIRS (0.10.0); null when it didn't. */
  modDir?: string | null
  /**
   * The script Claude Code's MCP server signs in through (its headersHelper) and the command that runs it (0.10.0 on a
   * computer with no browser, everywhere but Windows since 0.11.0); null or absent when it signs in by itself.
   */
  helper?: { path: string; command: string } | null
  /**
   * When init last set Claude Code up (0.11.0): a session start reminds an unfinished setup at most 3 times from then,
   * and not after 7 days (setup.ts). Running init again starts it over.
   */
  setup?: { since: string }
  /** The Pending You plugin is Claude Code's connection here (init kept it), so init saved no skill: it carries one. */
  plugin?: boolean
  /**
   * The permission-prompt hooks init added (0.13.0), by event; null or absent when it added none. And whether the
   * person wants them: false once they ran `init --no-permission-cards`, which later runs keep until
   * `--permission-cards`.
   */
  permissionHooks?: Record<string, string> | null
  permissionCards?: boolean
  /** init registered the permission channel (0.33.0, channel.ts), so uninstall takes it out. */
  channel?: boolean
}

export const settingsPath = (io: Pick<Io, 'env' | 'home'>) => join(claudeDir(io), 'settings.json')
export const skillPath = (io: Pick<Io, 'env' | 'home'>) =>
  join(claudeDir(io), 'skills', 'pendingyou', 'SKILL.md')
export const manifestPath = (io: Pick<Io, 'env' | 'home'>) =>
  join(configDir(io), 'claude-code.json')

export const readManifest = (io: Pick<Io, 'env' | 'home'>) =>
  readJson<Manifest>(manifestPath(io)).catch(() => null)

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const quote = (text: string) =>
  /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`

/**
 * How a hook runs this command line: through npx when that's how it was started (pinned to this version, from npx's
 * cache), the installed `pendingyou` when it's installed, or this very file.
 */
export function selfCommand(io: Pick<Io, 'env' | 'script'>): string {
  const script = io.script.replaceAll('\\', '/')
  return io.env.PENDINGYOU_SELF
    ? io.env.PENDINGYOU_SELF
    : !script || script.includes('/_npx/')
      ? `npx -y --prefer-offline pendingyou@${VERSION}`
      : script.includes('/node_modules/pendingyou/')
        ? 'pendingyou'
        : `node ${quote(io.script)}`
}

/**
 * A hook's command line without the shim (Windows, where Claude Code's hooks run no sh script of ours, as before
 * 0.11.0): the private copy run by Node directly when there is one (`"<node>" "<…/cli.js>"`, both quoted), otherwise
 * selfCommand; the command first, then `--origin` only when it isn't the default. `|| true` keeps the hook from ever
 * blocking the person, even when npx can't fetch the package or the command fails before it starts.
 */
export function hookCommand(
  io: Pick<Io, 'env' | 'script'>,
  origin: string,
  sub: string,
  direct?: Pick<Installed, 'node' | 'script'> | null,
): string {
  const flag = origin === DEFAULT_ORIGIN ? '' : ` --origin ${quote(origin)}`
  const self = direct ? `${shellQuote(direct.node)} ${shellQuote(direct.script)}` : selfCommand(io)
  return `${self} ${sub}${flag} || true`
}

/** Reads settings.json: {} when it isn't there; an error (and no changes) when it isn't a JSON object. */
export async function readSettings(io: Pick<Io, 'env' | 'home'>): Promise<Json> {
  const path = settingsPath(io)
  const text = await readText(path)
  if (text === null || text.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new PlainError(
      `${path} isn’t valid JSON, so I left it alone. Fix it, then run init again.`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new PlainError(`${path} isn’t a JSON object, so I left it alone.`)
  return parsed as Json
}

const objectAt = (parent: Json, key: string): Json | null => {
  const value = parent[key]
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null
}

/**
 * Adds our hooks and permissions, or updates our hooks in place (a new version, or a line an older version wrote, like
 * 0.2.0's `… --origin <url> handoff`, which 0.2.0 itself can't read). Returns the permissions it added.
 * `permission` (0.13.0): the permission-prompt hooks' lines, by event, to add or update; null takes ours out (the
 * person turned them off, or this Claude Code can't run them); left out, they're left as they are.
 */
export function mergeSettings(
  settings: Json,
  commands: Record<HookEvent, string>,
  permission?: Record<string, string> | null,
): {
  settings: Json
  permissionsAdded: string[]
  changed: boolean
  hooksChanged: boolean
  permissionChanged: boolean
} {
  const next = structuredClone(settings)
  const merged = mergeHooks(
    hooksOf(next, 'Claude Code’s settings'),
    CLAUDE_HOOKS,
    commands,
    'Claude Code',
  )
  let hooks = merged.hooks
  let permissionChanged = false
  if (permission !== undefined) {
    const prompts = permission
      ? mergeHooks(hooks, PERMISSION_HOOKS, permission, 'Claude Code')
      : removeHooks(hooks, PERMISSION_HOOKS)
    hooks = prompts.hooks
    permissionChanged = prompts.changed
  }
  let changed = merged.changed || permissionChanged
  next.hooks = hooks

  const permissions = objectAt(next, 'permissions') ?? {}
  if (next.permissions !== undefined && objectAt(next, 'permissions') === null)
    throw new PlainError(
      'Claude Code’s “permissions” isn’t an object, so I left the settings alone.',
    )
  const allow = Array.isArray(permissions.allow) ? (permissions.allow as unknown[]) : []
  const permissionsAdded = PERMISSIONS.filter((rule) => !allow.includes(rule))
  if (permissionsAdded.length) {
    permissions.allow = [...allow, ...permissionsAdded]
    next.permissions = permissions
    changed = true
  }
  return {
    settings: next,
    permissionsAdded,
    changed,
    hooksChanged: merged.changed,
    permissionChanged,
  }
}

/** Removes our hooks, and the permissions init added; leaves everything else as it was. */
export function unmergeSettings(
  settings: Json,
  permissionsAdded: readonly string[],
): { settings: Json; changed: boolean } {
  const next = structuredClone(settings)
  let changed = false
  const hooks = objectAt(next, 'hooks')
  if (hooks) {
    const removed = removeHooks(hooks, [...CLAUDE_HOOKS, ...PERMISSION_HOOKS])
    changed = removed.changed
    if (Object.keys(removed.hooks).length === 0) delete next.hooks
    else next.hooks = removed.hooks
  }
  const permissions = objectAt(next, 'permissions')
  if (permissions && Array.isArray(permissions.allow)) {
    const kept = (permissions.allow as unknown[]).filter(
      (rule) => typeof rule !== 'string' || !permissionsAdded.includes(rule),
    )
    if (kept.length !== permissions.allow.length) {
      changed = true
      if (kept.length) permissions.allow = kept
      else delete permissions.allow
      if (Object.keys(permissions).length === 0) delete next.permissions
    }
  }
  return { settings: next, changed }
}

const writeSettings = (io: Pick<Io, 'env' | 'home'>, settings: Json) =>
  writeWhole(settingsPath(io), `${JSON.stringify(settings, null, 2)}\n`)

/** How long Claude Code may take to look up, add or remove an MCP server (it checks each server it has). */
const MCP_TIMEOUT_MS = 180_000

/** Claude Code's own state file: ~/.claude.json, or .claude.json in $CLAUDE_CONFIG_DIR. */
export const claudeJsonPath = (io: Pick<Io, 'env' | 'home'>) =>
  io.env.CLAUDE_CONFIG_DIR
    ? join(io.env.CLAUDE_CONFIG_DIR, '.claude.json')
    : join(io.home, '.claude.json')

/** A pendingyou MCP server Claude Code has: where it points (null when it can't be told), and its scope. */
export interface McpServer {
  url: string | null
  scope: 'user' | 'local' | 'project' | null
  /** The command that gives it its headers instead of OAuth (a headersHelper); null when it has none, or can't be told. */
  helper?: string | null
}

/**
 * The user-scope pendingyou MCP server, read from ~/.claude.json without asking Claude Code (which takes a minute):
 * the server, null when there isn't one, or 'unknown' when the file isn't there or isn't the shape expected. Only
 * mcpServers.pendingyou is looked at; nothing is written.
 */
export async function mcpFromFile(
  io: Pick<Io, 'env' | 'home'>,
): Promise<McpServer | null | 'unknown'> {
  let parsed: unknown
  try {
    const text = await readText(claudeJsonPath(io))
    if (text === null) return 'unknown'
    parsed = JSON.parse(text)
  } catch {
    return 'unknown'
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'unknown'
  const servers = (parsed as Json).mcpServers
  if (servers === undefined) return null
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return 'unknown'
  const server = (servers as Json)[MCP_NAME]
  if (server === undefined) return null
  if (typeof server !== 'object' || server === null) return 'unknown'
  const url = (server as Json).url
  const helper = (server as Json).headersHelper
  return {
    url: typeof url === 'string' ? url : null,
    scope: 'user',
    helper: typeof helper === 'string' ? helper : null,
  }
}

/** `claude mcp get pendingyou`'s answer: the server, null when there isn't one, 'timeout' when it took too long. */
export async function mcpFromClaude(io: Io): Promise<McpServer | null | 'timeout'> {
  const result = await io.run('claude', ['mcp', 'get', MCP_NAME], MCP_TIMEOUT_MS)
  if (result.code === 124) return 'timeout'
  if (result.code !== 0) return null
  const url = /^\s*URL:\s*(\S+)/m.exec(result.stdout)?.[1] ?? null
  const scope = /^\s*Scope:\s*(\w+)/m.exec(result.stdout)?.[1]?.toLowerCase()
  return {
    url,
    scope: scope === 'user' || scope === 'local' || scope === 'project' ? scope : null,
  }
}

export const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

export const addCommand = (url: string) =>
  `claude mcp add --scope user --transport http ${MCP_NAME} ${url}`
export const removeCommand = (scope: McpServer['scope']) =>
  `claude mcp remove${scope ? ` --scope ${scope}` : ''} ${MCP_NAME}`

/** `claude mcp add-json`'s arguments for the server signed in through the helper, and the same as a command to type. */
export function helperServer(url: string, command: string) {
  const json = JSON.stringify({ type: 'http', url, headersHelper: command })
  return {
    args: ['mcp', 'add-json', '--scope', 'user', MCP_NAME, json],
    text: `claude mcp add-json --scope user ${MCP_NAME} ${quote(json)}`,
  }
}

/**
 * The permission channel's entry in Claude Code's MCP servers (0.33.0, channel.ts): the hooks' shim, whose path never
 * changes, so an upgrade never changes it; `--origin` off production.
 */
export function channelEntry(io: Pick<Io, 'env' | 'home'>, origin: string) {
  return {
    type: 'stdio',
    command: shimPath(io),
    args: [
      'channel',
      '--app',
      'claude-code',
      ...(origin === DEFAULT_ORIGIN ? [] : ['--origin', origin]),
    ],
  }
}

/**
 * The permission channel as ~/.claude.json has it (read only, as mcpFromFile): its entry, null when there's none, or
 * 'unknown' when the file can't say.
 */
export async function channelFromFile(
  io: Pick<Io, 'env' | 'home'>,
): Promise<Json | null | 'unknown'> {
  let parsed: unknown
  try {
    const text = await readText(claudeJsonPath(io))
    if (text === null) return 'unknown'
    parsed = JSON.parse(text)
  } catch {
    return 'unknown'
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'unknown'
  const servers = objectAt(parsed as Json, 'mcpServers')
  return servers ? objectAt(servers, CHANNEL) : null
}

/** Whether a channel entry runs exactly what `wanted` does. */
const sameEntry = (entry: Json, wanted: ReturnType<typeof channelEntry>) =>
  entry.command === wanted.command && JSON.stringify(entry.args) === JSON.stringify(wanted.args)

/**
 * The permission channel in Claude Code (0.33.0): registered at user scope (`claude mcp add-json`) when `wanted`, one
 * that runs something else replaced; taken out when not wanted and init had registered it. Its step, or null when there
 * was nothing to say; and whether it's registered now.
 */
async function applyChannel(
  io: Io,
  origin: string,
  wanted: boolean,
  before: Manifest | null,
  progress: (text: string) => void,
): Promise<{ step: Step | null; registered: boolean }> {
  const entry = channelEntry(io, origin)
  const now = await channelFromFile(io)
  const remove = () =>
    io.run('claude', ['mcp', 'remove', '--scope', 'user', CHANNEL], MCP_TIMEOUT_MS)
  if (!wanted) {
    if (!before?.channel || now === null) return { step: null, registered: false }
    progress('Removing the permission channel from Claude Code (this can take a minute)…\n')
    const removed = await remove()
    return removed.code === 0
      ? {
          step: { ok: true, text: `Took out the permission channel (${CHANNEL}).` },
          registered: false,
        }
      : {
          step: {
            ok: false,
            text: `Couldn’t take out the permission channel. Run: claude mcp remove --scope user ${CHANNEL}`,
          },
          registered: true,
        }
  }
  if (now !== null && now !== 'unknown' && sameEntry(now, entry))
    return {
      step: { ok: true, text: 'The permission channel was already registered.' },
      registered: true,
    }
  const json = JSON.stringify(entry)
  const add = `claude mcp add-json --scope user ${CHANNEL} ${quote(json)}`
  if (now !== null && now !== 'unknown') {
    progress('Updating the permission channel in Claude Code (this can take a minute)…\n')
    if ((await remove()).code !== 0)
      return {
        step: {
          ok: false,
          text: `Couldn’t update the permission channel. Run:\n  claude mcp remove --scope user ${CHANNEL}\n    ${add}`,
        },
        registered: false,
      }
  } else progress('Adding the permission channel to Claude Code (this can take a minute)…\n')
  const added = await io.run(
    'claude',
    ['mcp', 'add-json', '--scope', 'user', CHANNEL, json],
    MCP_TIMEOUT_MS,
  )
  if (added.code !== 0)
    return {
      step: { ok: false, text: `Claude Code didn’t add the permission channel. Run: ${add}` },
      registered: false,
    }
  return {
    step: {
      ok: true,
      text: `Added the permission channel (${CHANNEL}): start Claude Code with npx pendingyou claude and a prompt’s card has Allow and Deny. The first answer wins, there or in the terminal.`,
    },
    registered: true,
  }
}

/**
 * `pendingyou claude [args…]` (0.33.0, PA4): Claude Code with the permission channel loaded, its arguments after the
 * channel's flag, in this terminal, its exit code passed on. Claude Code shows its warning about development channels
 * each start until the channel is on its allowlist (the plan's §6).
 */
export async function claudeWithChannel(io: Io, args: readonly string[]): Promise<number> {
  if (!io.handOver) throw new PlainError('This can’t start Claude Code here.')
  if ((await channelFromFile(io)) === null)
    io.err(
      'pendingyou: the permission channel isn’t set up, so Claude Code’s prompts get no Allow or Deny on their cards. Run: npx pendingyou@latest init\n',
    )
  const code = await io.handOver('claude', [
    '--dangerously-load-development-channels',
    `server:${CHANNEL}`,
    ...args,
  ])
  if (code === 127) io.err('pendingyou: Claude Code isn’t installed here (no claude on PATH).\n')
  return code
}

/**
 * What init does with Claude Code's pendingyou MCP server, decided before anyone signs in (apps/claude-code.ts), and
 * carried out here:
 * - `keep`: leave it as it is (`text` says what's there, and, when `ok` is false, why that's a problem);
 * - `add`: there's none (or only the Pending You plugin's): add ours;
 * - `replace`: one at another Pending You, which the person agreed to replace (or `--yes`);
 * - `switch`: one at this Pending You that signs in the other way (its own OAuth, or ours before `--oauth`).
 */
export type McpPlan =
  | { action: 'keep'; ok: boolean; text: string }
  | { action: 'add'; plugin?: boolean }
  | { action: 'replace'; server: McpServer }
  | { action: 'switch'; server: McpServer }

/**
 * Carries out the plan: the server at user scope, signed in through the helper (`helper`, the command Claude Code runs
 * for its headers) or, with none, by Claude Code itself (OAuth). `claude mcp add-json` refuses a name that's there
 * (2.1.289), so one is removed first.
 */
async function applyMcp(
  io: Io,
  origin: string,
  plan: McpPlan,
  helper: string | null,
  progress: (text: string) => void,
): Promise<{ step: Step; added: boolean }> {
  const url = `${origin}/mcp`
  const add = helper
    ? helperServer(url, helper)
    : {
        args: ['mcp', 'add', '--scope', 'user', '--transport', 'http', MCP_NAME, url],
        text: addCommand(url),
      }
  if (plan.action === 'keep') return { added: false, step: { ok: plan.ok, text: plan.text } }
  const before = plan.action === 'add' ? null : plan.server
  if (before) {
    const commands = `  ${removeCommand(before.scope)}\n    ${add.text}`
    progress('Removing the old pendingyou MCP server (this can take a minute)…\n')
    const removed = await io.run(
      'claude',
      ['mcp', 'remove', ...(before.scope ? ['--scope', before.scope] : []), MCP_NAME],
      MCP_TIMEOUT_MS,
    )
    if (removed.code !== 0)
      return {
        added: false,
        step: {
          ok: false,
          text: `${removed.code === 124 ? 'Claude Code took more than 3 minutes to remove' : 'Claude Code didn’t remove'} the old MCP server. Run:\n  ${commands}`,
        },
      }
  }
  progress('Adding the pendingyou MCP server to Claude Code (this can take a minute)…\n')
  const added = await io.run('claude', add.args, MCP_TIMEOUT_MS)
  if (added.code !== 0)
    return {
      added: false,
      step: {
        ok: false,
        text:
          added.code === 124
            ? `Claude Code took more than 3 minutes to add the MCP server. Check with: claude mcp get ${MCP_NAME}. If it isn’t there, run: ${add.text}`
            : `Claude Code didn’t add the MCP server. Run: ${add.text}`,
      },
    }
  const how = helper
    ? ` It signs in through this computer’s sign-in (${helperPath(io)}): nothing to Authenticate.`
    : ''
  // Through the helper there's nothing to Authenticate: init's last lines say to restart.
  const restart = helper
    ? ''
    : ' Restart Claude Code, then run /mcp, choose pendingyou and Authenticate.'
  return {
    added: true,
    step: {
      ok: true,
      text:
        plan.action === 'add'
          ? plan.plugin
            ? `Added the pendingyou MCP server (${url}) for every project, signed in through this computer’s sign-in: Claude Code uses it instead of the Pending You plugin’s, and keeps the plugin’s skill. One sign-in for both.`
            : `Added the pendingyou MCP server (${url}) for every project.${how}`
          : plan.action === 'replace'
            ? `Replaced the pendingyou MCP server (was ${plan.server.url}) with ${url}.${how}${restart}`
            : helper
              ? `Switched the pendingyou MCP server (${url}) from Claude Code’s own sign-in to this computer’s: one sign-in for both.${restart}`
              : `Switched the pendingyou MCP server (${url}) from this computer’s sign-in to Claude Code’s own.${restart}`,
    },
  }
}

/** The stub skill: written when it isn't there, or refreshed while it's still the one init wrote. */
export async function saveSkill(
  io: Pick<Io, 'fetch'>,
  origin: string,
  path: string,
  before: Manifest['skill'],
): Promise<{ step: Step; skill: Manifest['skill'] }> {
  const existing = await readText(path)
  const ours = existing !== null && before?.path === path && sha256(existing) === before.sha256
  if (existing !== null && !ours)
    return {
      skill: null,
      step: { ok: true, text: `Kept the pendingyou skill already at ${path}.` },
    }
  let stub: string
  try {
    const response = await io.fetch(`${origin}/skill-stub.md`, {
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new PlainError(String(response.status))
    stub = await response.text()
  } catch {
    return {
      skill: ours ? before : null,
      step: {
        ok: ours,
        text: `Couldn’t fetch the skill from ${origin}/skill-stub.md. Run init again later.`,
      },
    }
  }
  await writeWhole(path, stub)
  return {
    skill: { path, sha256: sha256(stub) },
    step: { ok: true, text: `Saved the skill to ${path}.` },
  }
}

/** Removes a skill init saved, while it's still the one it saved. */
export async function removeSkill(skill: Manifest['skill']): Promise<Step | null> {
  if (!skill) return null
  const text = await readText(skill.path)
  if (text !== null && sha256(text) === skill.sha256) {
    await rm(skill.path, { force: true })
    await rmdir(dirname(skill.path)).catch(() => {})
    return { ok: true, text: 'Removed the pendingyou skill.' }
  }
  return text !== null ? { ok: true, text: `Kept ${skill.path}: it was changed after init.` } : null
}

/** What installClaude is told: how the server signs in, what happens to it, and the shared parts it uses. */
export interface ClaudeInstall {
  /** Claude Code's version, as init found it (`claude --version`): whether it loads the wake mod. */
  version: string
  /** The plan for the MCP server, decided before signing in. */
  mcp: McpPlan
  /** How the server signs in: through this computer's sign-in (the helper), or by itself (OAuth). */
  mode: 'helper' | 'oauth'
  /** The headersHelper command; null when there's none (no private copy for it to run). */
  helper: string | null
  /** The Pending You plugin carries the skill here, so none is saved. */
  plugin: boolean
  /** The private copy the hooks and the mod run; null when it couldn't be made. */
  copy: Installed | null
  /** Each hook's command line. */
  hookLine(sub: string): string
  report(step: Step): void
  progress(text: string): void
  /**
   * `init --permission-cards` (true) or `--no-permission-cards` (false), 0.13.0; left out, as the person chose before
   * (on unless they turned them off).
   */
  permissionCards?: boolean
}

/** Why Claude Code here can't have the permission-prompt hooks, in a line; null when it can. */
export function permissionBlocker(
  io: Pick<Io, 'platform'>,
  version: string,
  mode: ClaudeInstall['mode'],
): string | null {
  if (io.platform === 'win32') return 'not on Windows yet'
  if (mode !== 'helper')
    return 'they need Claude Code signed in through this computer’s sign-in, and here it signs in by itself'
  const found = claudeVersion(version)
  if (!found || !atLeast(found, PERMISSION_CLAUDE))
    return `they need Claude Code ${PERMISSION_CLAUDE} or later${found ? ` (this is ${found})` : ''}`
  return null
}

/**
 * Everything init does in Claude Code (not the sign-in, nor the shared parts: the copy, the shim, the helper).
 * Idempotent. Each step is reported as it's done.
 */
export async function installClaude(
  io: Io,
  origin: string,
  options: ClaudeInstall,
): Promise<Step[]> {
  const before = await readManifest(io)
  const steps: Step[] = []
  const report = (step: Step) => {
    steps.push(step)
    options.report(step)
  }

  // Through the helper, which runs the private copy: without one there's nothing for Claude Code to run.
  const helper = options.mode === 'helper' ? options.helper : null
  const mcp =
    options.mode === 'helper' && !helper && options.mcp.action !== 'keep'
      ? {
          added: false,
          step: {
            ok: false,
            text: 'Didn’t add the pendingyou MCP server: it signs in through pendingyou’s own copy, which isn’t installed. Run init again.',
          },
        }
      : await applyMcp(io, origin, options.mcp, helper, options.progress)
  report(mcp.step)
  let skill: { step: Step; skill: Manifest['skill'] }
  if (options.plugin)
    skill = {
      skill: null,
      step: {
        ok: true,
        text: 'Didn’t save the pendingyou skill: the Pending You plugin carries it.',
      },
    }
  else skill = await saveSkill(io, origin, skillPath(io), before?.skill ?? null)
  report(skill.step)

  const commands = Object.fromEntries(
    (Object.keys(HOOKS) as HookEvent[]).map((event) => [event, options.hookLine(HOOKS[event])]),
  ) as Record<HookEvent, string>
  // The permission-prompt hooks (0.13.0): on unless the person turned them off, here or before.
  const wanted = options.permissionCards ?? before?.permissionCards !== false
  const blocker = permissionBlocker(io, options.version, options.mode)
  const permissionLines =
    wanted && !blocker
      ? Object.fromEntries(PERMISSION_HOOKS.map((spec) => [spec.event, options.hookLine(spec.sub)]))
      : null
  const settings = await readSettings(io)
  // A setup from before 0.16.0: its permission-prompt hooks, without the Notification one.
  const had = hooksOf(settings, 'Claude Code’s settings')
  const upgrade =
    Boolean(findHook(had, 'PermissionRequest', 'permission')) &&
    !findHook(had, 'Notification', 'notify')
  const merged = mergeSettings(settings, commands, permissionLines)
  report({
    ok: true,
    text: merged.hooksChanged
      ? `Installed or updated the session-start pickup, next-message hand-off, Stop check and session-end hooks in ${settingsPath(io)}.`
      : 'The hooks were already installed.',
  })
  const flag = originArgs(origin)
  report({
    ok: true,
    text: permissionLines
      ? merged.permissionChanged
        ? upgrade
          ? 'Added a Notification hook to the permission-prompt hooks: a dialog in bypassPermissions mode gets a card too, and so does one the other hooks don’t see, once Claude Code says it has waited a few seconds.'
          : 'Added the permission-prompt hooks: when Claude Code waits for your OK and you don’t answer within a few seconds, a card says so (a push only after your hand-off wait), and it goes once you answer in Claude Code.'
        : 'The permission-prompt hooks were already installed.'
      : !wanted
        ? `${merged.permissionChanged ? 'Took out the permission-prompt hooks' : 'Left out the permission-prompt hooks'}, as you asked: no card when Claude Code waits for your OK. To turn them on: npx pendingyou init --permission-cards${flag}`
        : `${merged.permissionChanged ? 'Took out' : 'Left out'} the permission-prompt hooks: ${blocker}.`,
  })
  // The permission channel (0.33.0): with the permission-prompt hooks, on a Claude Code that relays prompts only to
  // channels a session opted in.
  const found = claudeVersion(options.version)
  const channel = await applyChannel(
    io,
    origin,
    Boolean(permissionLines) && found !== null && atLeast(found, CHANNEL_CLAUDE),
    before,
    options.progress,
  )
  if (channel.step) report(channel.step)
  const mod = await addMod(io, merged.settings, options.copy, options.version)
  if (mod.step) report(mod.step)
  if (merged.changed || mod.changed) await writeSettings(io, mod.settings)
  const manifest: Manifest = {
    version: 1,
    origin,
    claudeDir: claudeDir(io),
    mcpAdded: mcp.added || (before?.mcpAdded ?? false),
    skill: skill.skill,
    hooks: commands,
    permissions: [...new Set([...(before?.permissions ?? []), ...merged.permissionsAdded])],
    cli: options.copy ? { version: options.copy.version, prefix: options.copy.prefix } : null,
    modDir: mod.dir,
    // Helper mode stays recorded when this run couldn't redo it, so uninstall still takes it out.
    helper: helper
      ? { path: helperPath(io), command: helper }
      : options.mode === 'helper'
        ? (before?.helper ?? null)
        : null,
    setup: { since: new Date(io.now()).toISOString() },
    ...(options.plugin ? { plugin: true } : {}),
    permissionHooks: permissionLines,
    permissionCards: wanted,
    ...(channel.registered ? { channel: true } : {}),
  }
  await writeWhole(manifestPath(io), `${JSON.stringify(manifest, null, 2)}\n`, { secret: true })
  return steps
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

/**
 * The wake mod in Claude Code's settings (0.10.0): on Claude Code 2.1.287 or later, this version's mod copied into
 * stableModDir (0.23.0) and that folder in CLAUDE_CODE_PLUGIN_DIRS, every other entry kept and an older version's
 * replaced. Nothing, and nothing said, for an older Claude Code or none. Without the hooks' private copy there's no mod
 * to copy, so it says so. `moved`: settings named an older version's folder, which open sessions keep until they
 * restart (pruneCli leaves the newest older copy for them).
 */
async function addMod(
  io: Io,
  settings: Json,
  installed: Installed | null,
  found: string,
): Promise<{ settings: Json; changed: boolean; dir: string | null; step?: Step }> {
  const unchanged = { settings, changed: false, dir: null }
  const version = claudeVersion(found)
  if (!version || !loadsMods(version)) return unchanged
  const source = installed ? modDir(cliPackage(installed.prefix)) : null
  if (!source || !(await exists(join(source, 'hooks', 'hooks.json'))))
    return {
      ...unchanged,
      step: {
        ok: true,
        text: 'Couldn’t add the wake mod without the hooks’ own copy of pendingyou, so Claude Code hears answers through hold for now. Run init again to retry.',
      },
    }
  const dir = stableModDir(io)
  const separator = separatorFor(io.platform)
  const added = withModDir(settings, dir, separator)
  if ('invalid' in added) return { ...unchanged, step: { ok: false, text: added.invalid } }
  const copied = await installMod(source, dir).catch(() => null)
  if (!copied)
    return {
      ...unchanged,
      step: { ok: false, text: `Couldn’t copy the wake mod to ${dir}. Run init again.` },
    }
  const moved = (pluginDirs(settings, separator) ?? []).some((entry) => isOurModDir(entry))
  return {
    settings: added.settings,
    changed: added.changed,
    dir,
    step: {
      ok: true,
      text: !added.changed
        ? copied.changed
          ? `Updated the wake mod in ${dir}: open Claude Code sessions reload it by themselves.`
          : 'The wake mod was already in Claude Code’s settings.'
        : moved
          ? `Moved the wake mod to ${dir}, a folder that stays put when pendingyou updates, so an update never leaves an open session without it.`
          : `Added the wake mod to ${PLUGIN_DIRS} in ${settingsPath(io)}: Claude Code ${version} wakes a session when you answer, with no hold running.`,
    },
  }
}

/**
 * Removes what init added in Claude Code: the hooks, its permissions, the wake mod, its skill (if unchanged), its MCP
 * server. The shared parts (the copy, the shim, the helper) and the sign-in are the core's (main.ts).
 */
export async function uninstallClaude(io: Io): Promise<Step[]> {
  const manifest = await readManifest(io)
  const steps: Step[] = []
  const settings = await readSettings(io)
  const removed = unmergeSettings(settings, manifest?.permissions ?? [])
  // The wake mod's folder goes too: any copy of it in CLAUDE_CODE_PLUGIN_DIRS is ours (a private copy's, or the folder
  // that stays put, 0.23.0).
  const unmodded = withModDir(removed.settings, null, separatorFor(io.platform), [stableModDir(io)])
  const modRemoved = !('invalid' in unmodded) && unmodded.changed
  if (removed.changed || modRemoved)
    await writeSettings(io, 'invalid' in unmodded ? removed.settings : unmodded.settings)
  steps.push({
    ok: true,
    text: removed.changed
      ? 'Removed the Pending You hooks and permissions from Claude Code.'
      : 'No Pending You hooks were installed.',
  })
  if (modRemoved) steps.push({ ok: true, text: `Removed the wake mod from ${PLUGIN_DIRS}.` })
  await rm(stableModDir(io), { recursive: true, force: true }).catch(() => {})
  await removeLoadedNotes(io)
  // Sessions' permission prompts: nothing will settle them now.
  await removePermissionFiles(io)
  await removePresenceFiles(io, 'claude-code')
  const skill = await removeSkill(manifest?.skill ?? null)
  if (skill) steps.push(skill)
  // The permission channel (0.33.0), when init registered it and it's still there.
  if (manifest?.channel && (await channelFromFile(io)) !== null) {
    io.out('Removing the permission channel from Claude Code (this can take a minute)…\n')
    const result = await io.run(
      'claude',
      ['mcp', 'remove', '--scope', 'user', CHANNEL],
      MCP_TIMEOUT_MS,
    )
    steps.push(
      result.code === 0
        ? { ok: true, text: `Removed the permission channel (${CHANNEL}) from Claude Code.` }
        : {
            ok: false,
            text: `Couldn’t remove the permission channel. Run: claude mcp remove --scope user ${CHANNEL}`,
          },
    )
  }
  if (manifest?.mcpAdded) {
    io.out('Removing the pendingyou MCP server from Claude Code (this can take a minute)…\n')
    const result = await io.run(
      'claude',
      ['mcp', 'remove', '--scope', 'user', MCP_NAME],
      MCP_TIMEOUT_MS,
    )
    steps.push(
      result.code === 0
        ? { ok: true, text: 'Removed the pendingyou MCP server from Claude Code.' }
        : {
            ok: false,
            text: `Couldn’t remove the MCP server. Run: claude mcp remove --scope user ${MCP_NAME}`,
          },
    )
  }
  await rm(manifestPath(io), { force: true })
  return steps
}

/** What a hook line runs: the shim's script read back (shim.ts), or the line itself (direct, npx, other). */
async function formOf(io: Pick<Io, 'env' | 'home'>, command: string): Promise<HookForm | null> {
  const first = /^"((?:[^"\\]|\\.)*)"\s/.exec(command)?.[1]?.replace(/\\(.)/g, '$1')
  if (first && basename(first) === SHIM) {
    const shim = await readShim(io)
    return shim ?? { form: 'direct', node: '', script: first, version: null }
  }
  return hookForm(command)
}

/** What's installed, for `status`. */
export async function claudeState(io: Io): Promise<{
  claude: string | null
  /** The pendingyou MCP server: false when there isn't one, 'unknown' when Claude Code didn't say in time. */
  mcp: McpServer | false | 'unknown'
  skill: boolean
  hooks: boolean
  stopcheck: boolean
  /** The permission-prompt hook (0.13.0): a card when Claude Code waits for the person's OK. */
  permission: boolean
  /** Its Notification hook (0.16.0): a card for a dialog in bypassPermissions mode, or one the others don't see. */
  notify: boolean
  /** The session-end hook (0.15.0): presence says closed. */
  presence: boolean
  /** The permission channel (0.33.0): registered in ~/.claude.json, or 'unknown' when that can't be read. */
  channel: boolean | 'unknown'
  /** How the session-start hook runs pendingyou, and whether what it runs is still there. */
  form: (HookForm & { runs: boolean; shim: boolean }) | null
  /**
   * The wake mod (0.10.0): whether this Claude Code loads mods, the copies of ours in CLAUDE_CODE_PLUGIN_DIRS and
   * whether they're still there, and whether a Pending You plugin (which carries it) is enabled.
   */
  mod: { loads: boolean; dirs: string[]; present: boolean; plugin: boolean }
  /** The Pending You plugins enabled in Claude Code's settings (production's, staging's). */
  plugins: string[]
}> {
  const version = await io.run('claude', ['--version'], 20_000)
  const claude = version.code === 0 ? version.stdout.trim().split(/\s+/)[0] || 'installed' : null
  let mcp: McpServer | false | 'unknown' = false
  const fromFile = await mcpFromFile(io)
  if (fromFile !== 'unknown') mcp = fromFile ?? false
  else if (claude) {
    const fromClaude = await mcpFromClaude(io)
    mcp = fromClaude === 'timeout' ? 'unknown' : (fromClaude ?? false)
  }
  const skill = (await readText(skillPath(io))) !== null
  let ours = (_event: HookEvent) => undefined as ReturnType<typeof findHook>
  let permission = false
  let notify = false
  const mod = { loads: false, dirs: [] as string[], present: false, plugin: false }
  const loads = claude ? claudeVersion(claude) : null
  mod.loads = loads !== null && loadsMods(loads)
  let plugins: string[] = []
  try {
    const settings = await readSettings(io)
    mod.dirs = (pluginDirs(settings, separatorFor(io.platform)) ?? []).filter((entry) =>
      isOurModDir(entry, [stableModDir(io)]),
    )
    mod.plugin = pluginEnabled(settings)
    plugins = enabledPlugins(settings)
    const all = objectAt(settings, 'hooks') ?? {}
    ours = (event) => findHook(all, event, HOOKS[event])
    permission = Boolean(findHook(all, 'PermissionRequest', 'permission'))
    notify = Boolean(findHook(all, 'Notification', 'notify'))
  } catch {}
  const start = ours('SessionStart')
  const form = typeof start?.command === 'string' ? await formOf(io, start.command) : null
  const shim = typeof start?.command === 'string' && start.command.includes(`${SHIM}"`)
  const found = await Promise.all(mod.dirs.map((dir) => exists(join(dir, 'hooks', 'hooks.json'))))
  mod.present = found.length > 0 && found.every(Boolean)
  return {
    claude,
    mcp,
    skill,
    hooks: Boolean(start && ours('UserPromptSubmit')),
    stopcheck: Boolean(ours('Stop')),
    permission,
    notify,
    presence: Boolean(ours('SessionEnd')),
    channel: await channelFromFile(io).then((entry) =>
      entry === 'unknown' ? 'unknown' : entry !== null,
    ),
    form: form ? { ...form, runs: await hookRuns(form), shim } : null,
    mod,
    plugins,
  }
}

/** The Pending You plugins and the Pending You each connects to. */
export const PLUGIN_ORIGINS: Readonly<Record<string, string>> = {
  'pending-you@pendingyou': 'https://www.pendingyou.com',
  'pending-you-staging@pendingyou-staging': 'https://staging.pendingyou.com',
}

/** The Pending You plugins Claude Code's settings enable. */
export function enabledPlugins(settings: Json): string[] {
  const enabled = objectAt(settings, 'enabledPlugins')
  return Object.keys(PLUGIN_ORIGINS).filter((id) => enabled?.[id] === true)
}

/** Whether a Pending You plugin for `origin` is enabled: its server is Claude Code's when none was added by hand. */
export async function pluginFor(
  io: Pick<Io, 'env' | 'home'>,
  origin: string,
): Promise<string | null> {
  try {
    const settings = await readSettings(io)
    return enabledPlugins(settings).find((id) => PLUGIN_ORIGINS[id] === origin) ?? null
  } catch {
    return null
  }
}

/** The `--origin <it>` a command needs off production (hooks.ts). */
export { originArgs }
