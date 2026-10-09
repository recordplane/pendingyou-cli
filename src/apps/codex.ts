// Codex CLI (0.11.0): what `pendingyou init` sets up for it, `status`'s section and `uninstall`. Facts from Codex's own
// source (0.160.0, 2026-10-04; docs/assistants/codex.md has the details):
//
// - Its MCP server is a table in ~/.codex/config.toml (or $CODEX_HOME's), [mcp_servers.pendingyou], edited in place with
//   everything else in the file kept as it was (toml.ts). It signs in through this computer's own connection ("Codex on
//   build-01"): `http_headers_helper` runs the headers helper with `--app codex` (sh -c, a stripped environment, 10
//   seconds; stdout one JSON object of strings), which may give Authorization from Codex 0.152 (0.148–0.151 refused that
//   header). `default_tools_approval_mode = "approve"` lets Pending You's tools run without asking each time. A stored
//   OAuth token would win over the helper, so `codex mcp logout pendingyou` goes first. With `--oauth` the table has no
//   helper and the person signs Codex in with `codex mcp login pendingyou`. `codex mcp add --url` isn't used: it starts
//   an OAuth sign-in in the browser at once.
// - Its skill is ~/.agents/skills/pendingyou/SKILL.md: the guide's stub, as for Claude Code.
// - Its hooks are in ~/.codex/hooks.json, Claude Code's shape: SessionStart (pickup; startup, resume or clear),
//   UserPromptSubmit (handoff), PostToolUse on Pending You's card tools (posted: codex-wake.ts) and Stop (stopcheck),
//   each through the shim with `--app codex`. Codex runs a hook only while the person trusts its exact definition (a
//   hash of it, under [hooks.state."<file>:<event>:<group>:<handler>"] in config.toml), and skips an untrusted or
//   changed one without a word: the shim keeps definitions the same across versions, new entries go at the end (the
//   key is positional), and uninstall moves the person's own hooks' trust when theirs move up. `status` checks each.
// - Since 0.15.0 (2026-10-05) three more, at the end of their lists, with this computer's own connection only:
//   PermissionRequest (permission) and a PostToolUse for every tool (permission-done), for a card when Codex waits for
//   the person's OK (permission.ts; `--no-permission-cards` leaves them out), and SessionEnd (presence: the thread
//   closed; presence.ts), whose timeout is 3 seconds, the most Codex gives a SessionEnd hook. New hooks need trusting
//   once: init's last lines and status say so.
// - Trusting them (0.22.0, trust.ts): the one way seen working is Codex's own /hooks (a Mac, 2026-10-06, with the
//   Codex CLI the ChatGPT app brings). When init or status finds our hooks installed and not trusted, it prints the
//   command that opens a Codex here (codex on PATH, else the app's: codex-app.ts) and "type /hooks", then waits for the
//   person. It never writes trust, nor gets around it.
// - It's woken by `codex queue` (0.149; it starts a turn on an idle thread when Codex's shared background server runs,
//   which it does by itself from 0.157): codex-wake.ts.
// - Codex's /import can copy Claude Code's Pending You server (without its headersHelper, so it never signs in) and its
//   hooks (with Claude Code's app): init replaces both.
// - The Codex app for macOS (0.13.0, codex-app.ts) shares all of ~/.codex with Codex CLI, and carries its own codex:
//   with none on PATH, init, status and the listener run the app's, and the hooks are trusted in its codex's /hooks.
//   Save on pendingyou in its MCP settings writes the table again without http_headers_helper (and the approval mode):
//   init's last lines say so, status names the dropped helper, and running init again puts it back.
import { createHash } from 'node:crypto'
import { realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { removeSkill, saveSkill } from '../claude.ts'
import { readCredential } from '../credentials.ts'
import { configDir, readJson, readText, writeWhole } from '../files.ts'
import {
  type HookGroup,
  type HookSpec,
  isOurHook,
  lineKey,
  mergeHooks,
  originArgs,
  removeHooks,
  shWord,
} from '../hooks.ts'
import type { Io } from '../io.ts'
import { atLeast } from '../mod.ts'
import { removePresenceFiles } from '../presence.ts'
import {
  checkHelper,
  foundBy,
  headlessReason,
  helperCommand,
  helperPath,
  isOurHelper,
} from '../remote.ts'
import { connectionTitle, FINISH_SAY, setupOf, setupStatus } from '../setup.ts'
import {
  basicString,
  definedInline,
  headerOf,
  renameTable,
  tableSpans,
  tableValues,
  withTable,
} from '../toml.ts'
import { type CodexProgram, findCodex } from './codex-app.ts'
import { APP_NAMES } from './ids.ts'
import { switches } from './switch.ts'
import type {
  AppContext,
  AppModule,
  AppStatus,
  HookTrust,
  Prepared,
  StatusContext,
  Step,
} from './types.ts'

type Json = Record<string, unknown>
const NAME = APP_NAMES.codex
const SERVER = ['mcp_servers', 'pendingyou'] as const

/** From here its helper may give Authorization (and it runs again after a 401): the oldest Codex init sets up. */
export const CODEX_MIN = '0.152.0'
/** From here interactive Codex starts its shared background server by itself, so `codex queue` wakes an idle thread. */
export const CODEX_WAKE = '0.157.0'
/**
 * From here `codex queue` is there (0.149), which is all the Codex app needs: its own server reads the queue while the
 * app is open (codex-app.ts).
 */
export const CODEX_APP_WAKE = '0.149.0'
/** Where init found Codex when it isn't on PATH. */
const FROM_APP = 'the Codex app’s'
/** How the person trusts Codex's hooks (0.22.0): in its /hooks, the way seen working (docs/assistants/codex.md). */
const TRUST = 'type /hooks in Codex and trust'

/**
 * How to trust the hooks (0.22.0): the one command that opens Codex here, its full path quoted when it's an app's, and
 * /hooks there; with no Codex to run, how to open one.
 */
export function trustSteps(found: CodexProgram | null): string[] {
  const why = 'Codex runs Pending You’s hooks only once you trust them.'
  if (!found)
    return [
      `${why} Open Codex in a terminal (codex, or the one that comes inside the ChatGPT app), type /hooks, look over Pending You’s hooks, and trust them.`,
    ]
  const command = found.app ? `'${found.command.replaceAll("'", `'\\''`)}'` : found.command
  return [
    `${why} Open Codex in a terminal:`,
    '',
    `  ${command}`,
    '',
    'Type /hooks, look over Pending You’s hooks, and trust them.',
  ]
}
/** What undoes init in the Codex app: its MCP settings' Save writes the table again without the helper. */
const DONT_SAVE =
  'In the Codex app, don’t press Save on pendingyou in Settings › MCP: that writes it again without this computer’s sign-in (if you did, run init again to put it back).'
/** The Pending You tools whose calls the PostToolUse hook reads (codex-wake.ts). */
const CARD_TOOLS = '^mcp__pendingyou__(post_request|update_request|reply_in_thread|cancel_request)$'

/** Codex's hooks, by event: the command each runs, and its matcher. */
export const CODEX_HOOKS: readonly HookSpec[] = [
  { event: 'SessionStart', sub: 'pickup', matcher: 'startup|resume|clear' },
  { event: 'UserPromptSubmit', sub: 'handoff' },
  { event: 'PostToolUse', sub: 'posted', matcher: CARD_TOOLS },
  { event: 'Stop', sub: 'stopcheck' },
]
/**
 * The permission-prompt hooks (0.15.0, permission.ts): Codex's prompt, and every call that ran (no matcher). The next
 * message, the Stop check and the session's end settle prompts too.
 */
export const CODEX_PERMISSION_HOOKS: readonly HookSpec[] = [
  { event: 'PermissionRequest', sub: 'permission' },
  { event: 'PostToolUse', sub: 'permission-done' },
]
/** Presence (0.15.0, presence.ts): the thread closed. Codex gives a SessionEnd hook 1 second unless it says, 3 at most. */
export const CODEX_PRESENCE_HOOKS: readonly HookSpec[] = [
  { event: 'SessionEnd', sub: 'presence', timeout: 3 },
]
/** Every hook init may add to Codex, in the order they're added. */
export const ALL_CODEX_HOOKS: readonly HookSpec[] = [
  ...CODEX_HOOKS,
  ...CODEX_PERMISSION_HOOKS,
  ...CODEX_PRESENCE_HOOKS,
]
/** Each event as Codex names it in a hook's trust key. */
const EVENT_LABELS: Record<string, string> = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  PostToolUse: 'post_tool_use',
  Stop: 'stop',
  PermissionRequest: 'permission_request',
  SessionEnd: 'session_end',
}
/** What a hook's trust ignores the matcher of: events whose matcher Codex doesn't read. */
const NO_MATCHER = new Set(['UserPromptSubmit', 'Stop'])
/** Keys of the server's table that sign it in some other way: they go when it signs in through the helper. */
const SIGN_IN_KEYS = new Set([
  'bearer_token_env_var',
  'http_headers',
  'env_http_headers',
  'http_headers_helper',
  'oauth',
  'oauth_resource',
  'scopes',
])

export interface CodexManifest {
  version: 1
  origin: string
  codexHome: string
  /** init wrote the [mcp_servers.pendingyou] table (it wasn't there, or was replaced). */
  mcpAdded: boolean
  skill: { path: string; sha256: string } | null
  hooks: Record<string, string>
  /** The headers helper's command in the table; null when Codex signs in by itself (`--oauth`). */
  helper: string | null
  setup?: { since: string }
  /**
   * Whether the person wants a card when Codex waits for their OK (0.15.0): false once they ran `init
   * --no-permission-cards`, which later runs keep until `--permission-cards`.
   */
  permissionCards?: boolean
}

/** Codex's own folder: $CODEX_HOME (as Codex resolves it) or ~/.codex. */
async function codexHome(io: Pick<Io, 'env' | 'home'>): Promise<string> {
  const set = io.env.CODEX_HOME
  if (set) return realpath(set).catch(() => set)
  return join(io.home, '.codex')
}
const configPath = async (io: Pick<Io, 'env' | 'home'>) => join(await codexHome(io), 'config.toml')
const hooksPath = async (io: Pick<Io, 'env' | 'home'>) => join(await codexHome(io), 'hooks.json')
export const codexSkillPath = (io: Pick<Io, 'home'>) =>
  join(io.home, '.agents', 'skills', 'pendingyou', 'SKILL.md')
const manifestPath = (io: Pick<Io, 'env' | 'home'>) => join(configDir(io), 'codex.json')

export const readCodexManifest = (io: Pick<Io, 'env' | 'home'>) =>
  readJson<CodexManifest>(manifestPath(io)).catch(() => null)

/** Codex's pendingyou server, as its config has it: where it points and how it signs in; null when there's none. */
export interface CodexServer {
  url: string | null
  helper: string | null
  approval: string | null
  /** Defined some other way than its own table (an inline table, dotted keys): not ours to edit. */
  inline: boolean
}

/** Reads Codex's pendingyou server from its config (read only); null when there's none or no config. */
export async function codexServer(io: Pick<Io, 'env' | 'home'>): Promise<CodexServer | null> {
  const doc = await readText(await configPath(io)).catch(() => null)
  if (doc === null) return null
  if (definedInline(doc, SERVER)) return { url: null, helper: null, approval: null, inline: true }
  if (tableSpans(doc, SERVER).length === 0) return null
  const values = tableValues(doc, SERVER)
  const text = (key: string) => (typeof values[key] === 'string' ? (values[key] as string) : null)
  return {
    url: text('url'),
    helper: text('http_headers_helper'),
    approval: text('default_tools_approval_mode'),
    inline: false,
  }
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

/** The server's table as init writes it: ours first, then whatever else the person had in it (sign-in keys aside). */
function serverTable(doc: string, url: string, helper: string | null): string {
  const kept: string[] = []
  const span = tableSpans(doc, SERVER).find((each) => {
    const first = doc.slice(each.start, each.end).split('\n')[0] ?? ''
    return first.replace(/\s+/g, '').replace(/#.*$/, '') === headerOf(SERVER)
  })
  if (span)
    for (const line of doc.slice(span.start, span.end).split('\n').slice(1)) {
      const key = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1]
      if (key && (SIGN_IN_KEYS.has(key) || key === 'url' || key === 'default_tools_approval_mode'))
        continue
      kept.push(line)
    }
  while (kept.length && kept.at(-1)?.trim() === '') kept.pop()
  return `${[
    headerOf(SERVER),
    `url = ${basicString(url)}`,
    ...(helper ? [`http_headers_helper = ${basicString(helper)}`] : []),
    'default_tools_approval_mode = "approve"',
    ...kept,
  ].join('\n')}\n`
}

/** The JSON a hook's trust hashes, its keys sorted at every level, as Codex serializes it. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted((value as Json)[key])]),
    )
  return value
}

/**
 * What Codex trusts a hook by: "sha256:" and the hash of its definition (its event, its matcher where Codex reads one,
 * and the handler: type, command, timeout, async, statusMessage), keys sorted, as Codex hashes it (0.129 on).
 */
export function hookHash(
  event: string,
  matcher: string | undefined,
  handler: { command: string; timeout?: number; async?: boolean; statusMessage?: string },
): string {
  const identity = {
    event_name: EVENT_LABELS[event] ?? event,
    ...(matcher !== undefined && !NO_MATCHER.has(event) ? { matcher } : {}),
    hooks: [
      {
        type: 'command',
        command: handler.command,
        timeout: handler.timeout ?? 600,
        async: handler.async ?? false,
        ...(handler.statusMessage !== undefined ? { statusMessage: handler.statusMessage } : {}),
      },
    ],
  }
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(sorted(identity)))
    .digest('hex')}`
}

/** A hook's trust key: its file, its event, and where it sits in that event's list. */
const trustKey = (file: string, event: string, group: number, handler: number) =>
  `${file}:${EVENT_LABELS[event] ?? event}:${group}:${handler}`

/** hooks.json as Codex reads it: an object of `description` and `hooks` only (it ignores a file with anything else). */
async function readHooksFile(
  io: Pick<Io, 'env' | 'home'>,
): Promise<{ path: string; json: Json } | { path: string; invalid: string }> {
  const path = await hooksPath(io)
  const text = await readText(path).catch(() => null)
  if (text === null || text.trim() === '') return { path, json: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { path, invalid: `${path} isn’t valid JSON, so I left it alone.` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return { path, invalid: `${path} isn’t a JSON object, so I left it alone.` }
  const extra = Object.keys(parsed).filter((key) => key !== 'description' && key !== 'hooks')
  if (extra.length)
    return {
      path,
      invalid: `${path} has keys Codex doesn’t read (${extra.join(', ')}), so Codex ignores the whole file: I left it alone.`,
    }
  return { path, json: parsed as Json }
}

/** Where each of our hooks sits in hooks.json, and how its trust stands in config.toml. */
type Trust = 'trusted' | 'changed' | 'untrusted' | 'off'

async function readHookTrust(
  io: Pick<Io, 'env' | 'home'>,
): Promise<{ event: string; sub: string; trust: Trust | 'missing' }[]> {
  const file = await readHooksFile(io)
  const config = (await readText(await configPath(io)).catch(() => null)) ?? ''
  const hooks =
    'json' in file && file.json.hooks && typeof file.json.hooks === 'object'
      ? (file.json.hooks as Json)
      : {}
  return ALL_CODEX_HOOKS.map((spec) => {
    const groups = Array.isArray(hooks[spec.event]) ? (hooks[spec.event] as HookGroup[]) : []
    for (const [g, group] of groups.entries())
      for (const [h, handler] of (group?.hooks ?? []).entries()) {
        if (typeof handler?.command !== 'string' || !isOurHook(handler.command, spec.sub)) continue
        const state = tableValues(config, ['hooks', 'state', trustKey(file.path, spec.event, g, h)])
        if (state.enabled === false) return { event: spec.event, sub: spec.sub, trust: 'off' }
        const hash = hookHash(spec.event, group.matcher, {
          command: handler.command,
          ...(typeof handler.timeout === 'number' ? { timeout: handler.timeout } : {}),
        })
        return {
          event: spec.event,
          sub: spec.sub,
          trust:
            state.trusted_hash === hash
              ? 'trusted'
              : typeof state.trusted_hash === 'string'
                ? 'changed'
                : 'untrusted',
        }
      }
    return { event: spec.event, sub: spec.sub, trust: 'missing' as const }
  })
}

/** Our hooks that are in hooks.json and that Codex won't run until the person trusts them (again). */
const untrusted = async (io: Pick<Io, 'env' | 'home'>) =>
  (await readHookTrust(io)).filter((hook) => hook.trust === 'untrusted' || hook.trust === 'changed')

/** Whether `codex mcp list` says Codex holds an OAuth sign-in for its pendingyou server; null when it can't say. */
async function signedInByItself(io: Io, program: string): Promise<boolean | null> {
  const result = await io.run(program, ['mcp', 'list', '--json'], 30_000)
  if (result.code !== 0) return null
  try {
    const servers = JSON.parse(result.stdout) as { name?: unknown; auth_status?: unknown }[]
    const ours = Array.isArray(servers)
      ? servers.find((server) => server?.name === 'pendingyou')
      : null
    return ours ? ours.auth_status === 'o_auth' : null
  } catch {
    return null
  }
}

const switchesFor = (io: Io, ctx: AppContext) =>
  switches(io, ctx, {
    name: 'Codex',
    what: 'Codex signs in to Pending You by itself here (codex mcp login).',
    uses: 'its hooks use',
    headless: true,
  })

/** Writes Codex's config (its mode kept), or says why it couldn't. */
async function writeConfig(path: string, text: string): Promise<boolean> {
  return writeWhole(path, text).then(
    () => true,
    () => false,
  )
}

/**
 * The config without Codex's trust of our hooks (they're going), and with the person's own hooks' trust moved where
 * removing ours moves them: Codex keys trust by a hook's place in its event's list, so a hook that moves up would
 * otherwise need trusting again. Every move is to a lower place, so going in order never lands on a key in use.
 */
function keepTheirTrust(config: string, file: string, before: Json): string {
  let next = config
  const state = (event: string, group: number, handler: number) => [
    'hooks',
    'state',
    trustKey(file, event, group, handler),
  ]
  for (const event of [...new Set(ALL_CODEX_HOOKS.map((spec) => spec.event))]) {
    const subs = ALL_CODEX_HOOKS.filter((spec) => spec.event === event).map((spec) => spec.sub)
    const ours = (hook: { command?: unknown } | undefined) =>
      subs.some((sub) => isOurHook(hook?.command, sub))
    const groups = Array.isArray(before[event]) ? (before[event] as HookGroup[]) : []
    for (const [g, group] of groups.entries())
      for (const [h, hook] of (Array.isArray(group?.hooks) ? group.hooks : []).entries())
        if (ours(hook)) next = withTable(next, state(event, g, h), null)
    let at = 0
    for (const [g, group] of groups.entries()) {
      if (!Array.isArray(group?.hooks)) {
        at++
        continue
      }
      const kept = group.hooks.flatMap((hook, h) => (ours(hook) ? [] : [h]))
      if (kept.length === 0) continue
      for (const [h, was] of kept.entries())
        if (g !== at || was !== h)
          next = renameTable(next, state(event, g, was), state(event, at, h))
      at++
    }
  }
  return next
}

export const codex: AppModule = {
  id: 'codex',
  name: NAME,
  minVersion: CODEX_MIN,

  async detect(io) {
    // `codex` on PATH, else the Codex app's own (codex-app.ts): init, status and the listener run that one.
    const found = await findCodex(io)
    if (!found) return null
    return {
      version: found.version,
      ...(found.app ? { command: found.command, from: FROM_APP } : {}),
    }
  },

  async installed(io) {
    return (await readCodexManifest(io)) !== null
  },

  async usesHelper(io, origin) {
    if (io.platform === 'win32') return false
    const server = await codexServer(io)
    return Boolean(
      server?.url && isOurHelper(server.helper) && new URL(server.url).origin === origin,
    )
  },

  async prepare(io, ctx, detected): Promise<Prepared> {
    const url = `${ctx.origin}/mcp`
    const flag = originArgs(ctx.origin)
    const skip = (step: Step): Prepared => ({
      app: codex,
      detected,
      signIn: null,
      skipped: step,
      install: async () => [],
      next: () => null,
    })
    // Codex runs its helper and hooks with sh: not on Windows, where its setup message sets it up.
    if (io.platform === 'win32')
      return skip({
        ok: true,
        text: 'Codex on Windows isn’t set up by init yet: paste Pending You’s setup message for Codex into it instead.',
      })
    const helperMode = !ctx.oauth
    // The codex init runs: the one on PATH, or the Codex app's own.
    const program = detected.command ?? 'codex'
    const server = await codexServer(io).catch(() => null)
    if (server?.inline)
      return skip({
        ok: false,
        text: `Codex’s config (${await configPath(io)}) defines pendingyou in a way I can’t edit safely (an inline table or dotted keys). Make it a [mcp_servers.pendingyou] table, or take it out, then run init again${flag ? ` with${flag}` : ''}.`,
      })
    let mode: 'helper' | 'oauth' = helperMode ? 'helper' : 'oauth'
    let action: 'add' | 'keep' | 'write' = 'add'
    let note: Step | null = null
    if (server?.url && !sameUrl(server.url, url)) {
      ctx.progress(`Codex’s pendingyou MCP server points at ${server.url}, not ${url}.\n`)
      const replace =
        ctx.yes ||
        (io.interactive && /^\s*y(es)?\s*$/i.test(await io.ask(`Replace it with ${url}? [y/N] `)))
      if (!replace)
        return skip({
          ok: false,
          text: `Kept Codex’s pendingyou MCP server at ${server.url}, so Codex isn’t set up for ${ctx.origin}. To use ${url}, run init again with --yes.`,
        })
      action = 'write'
    } else if (server) {
      const ours = isOurHelper(server.helper)
      if (ours && helperMode)
        action =
          server.helper === helperCommand(io, ctx.origin, 'codex') && server.approval === 'approve'
            ? 'keep'
            : 'write'
      else if (ours) action = 'write'
      // Signing in by itself, as --oauth asks: kept, once its tools run without asking.
      else if (!helperMode && !server.helper)
        action = server.approval === 'approve' ? 'keep' : 'write'
      else if (server.helper) {
        mode = 'oauth'
        action = 'keep'
        note = {
          ok: false,
          text: `Kept Codex’s pendingyou MCP server: it signs in through a headers helper of its own (${server.helper}).`,
        }
      } else if ((await signedInByItself(io, program)) !== true) {
        // Never signed in: copied from Claude Code by /import (which leaves its helper behind), or left half-made.
        action = 'write'
      } else if (await switchesFor(io, ctx)) action = 'write'
      else {
        mode = 'oauth'
        action = 'keep'
        note = {
          ok: true,
          text: `Kept Codex’s own sign-in to Pending You (${url}). To move it to this computer’s, run: npx -y pendingyou@latest init --app codex --yes${flag}`,
        }
      }
    }
    const version = detected.version
    /** Hooks init added that Codex was set up without (an upgrade, 0.15.0), in words: they need trusting once more. */
    let newHooks: string | null = null
    return {
      app: codex,
      detected,
      signIn: mode === 'helper' ? 'connection' : 'hear',
      install: async (ictx) => {
        const steps: Step[] = []
        const report = (step: Step) => {
          steps.push(step)
          ictx.report(step)
        }
        const before = await readCodexManifest(io)
        const config = await configPath(io)
        // The MCP server: a stored OAuth sign-in would win over the helper, so it goes first.
        let added = before?.mcpAdded ?? false
        if (note) report(note)
        else if (action === 'keep')
          report({
            ok: true,
            text:
              mode === 'helper'
                ? `The pendingyou MCP server (${url}) already signs in through this computer’s sign-in.`
                : `The pendingyou MCP server (${url}) was already in Codex.`,
          })
        else if (mode === 'helper' && !ictx.helper)
          report({
            ok: false,
            text: 'Didn’t add Codex’s pendingyou MCP server: it signs in through pendingyou’s own copy, which isn’t installed. Run init again.',
          })
        else {
          if (mode === 'helper' && server)
            await io.run(program, ['mcp', 'logout', 'pendingyou'], 60_000)
          const doc = (await readText(config).catch(() => null)) ?? ''
          const next = withTable(
            doc,
            SERVER,
            serverTable(doc, url, mode === 'helper' ? ictx.helper : null),
          )
          if (await writeConfig(config, next)) {
            added = true
            report({
              ok: true,
              text: !server
                ? `Added the pendingyou MCP server (${url}) to ${config}${mode === 'helper' ? ', signed in through this computer’s sign-in' : ''}; its tools run without asking.`
                : server.url && !sameUrl(server.url, url)
                  ? `Replaced Codex’s pendingyou MCP server (was ${server.url}) with ${url}.`
                  : mode === 'helper' && before?.helper && !server.helper
                    ? `Put this computer’s sign-in back on Codex’s pendingyou MCP server (${url}): it had lost its http_headers_helper, which saving it in the Codex app’s MCP settings does.`
                    : mode === 'helper'
                      ? `Switched Codex’s pendingyou MCP server (${url}) to this computer’s sign-in: one sign-in for it and its hooks.`
                      : server.helper
                        ? `Switched Codex’s pendingyou MCP server (${url}) to Codex’s own sign-in: run codex mcp login pendingyou.`
                        : `Codex’s pendingyou MCP server (${url}) signs in by itself, and its tools now run without asking.`,
            })
          } else
            report({
              ok: false,
              text: `Couldn’t write ${config}, so Codex has no pendingyou MCP server. Run init again.`,
            })
        }
        const skill = await saveSkill(io, ictx.origin, codexSkillPath(io), before?.skill ?? null)
        report(skill.step)
        // The hooks, through the shim: new ones at the end of each list (Codex keys trust by position). The permission
        // and presence hooks (0.15.0) only with this computer's own connection, which alone can post a card or say a
        // thread is open; the permission ones unless the person turned them off, here or before.
        const cards = ctx.permissionCards ?? before?.permissionCards !== false
        const extra = mode === 'helper' && ictx.helper !== null
        const wanted = [
          ...CODEX_HOOKS,
          ...(extra && cards ? CODEX_PERMISSION_HOOKS : []),
          ...(extra ? CODEX_PRESENCE_HOOKS : []),
        ]
        const unwanted = ALL_CODEX_HOOKS.filter((spec) => !wanted.includes(spec))
        const lines = Object.fromEntries(
          wanted.map((spec) => [lineKey(spec), ictx.hookLine(spec.sub)]),
        )
        const file = await readHooksFile(io)
        if ('invalid' in file) report({ ok: false, text: file.invalid })
        else {
          try {
            const hooks =
              file.json.hooks && typeof file.json.hooks === 'object'
                ? (file.json.hooks as Json)
                : {}
            const merged = mergeHooks(hooks, wanted, lines, file.path)
            const removed = removeHooks(merged.hooks, unwanted)
            if (merged.changed || removed.changed)
              await writeWhole(
                file.path,
                `${JSON.stringify({ ...file.json, hooks: removed.hooks }, null, 2)}\n`,
              )
            // Hooks Codex hasn't seen before, on a computer it was set up on: they need trusting once more.
            const fresh = wanted.filter(
              (spec) => !CODEX_HOOKS.includes(spec) && !(lineKey(spec) in (before?.hooks ?? {})),
            )
            if (before && merged.changed && fresh.length)
              newHooks = [
                ...(fresh.some((spec) => spec.sub === 'presence') ? ['session end'] : []),
                ...(fresh.some((spec) => spec.sub.startsWith('permission'))
                  ? ['permission prompts']
                  : []),
              ].join(' and ')
            report({
              ok: true,
              text: merged.changed
                ? `Installed or updated Codex’s session-start pickup, next-message hand-off, card and Stop check hooks${extra ? `, ${cards ? 'its permission-prompt hooks (a card when Codex waits for your OK; --no-permission-cards leaves them out) ' : ''}and its session-end hook (Pending You hears when a thread is open)` : ''} in ${file.path}. Codex runs them once you trust them (how: below).`
                : removed.changed
                  ? `Took out Codex’s permission-prompt hooks, as you asked: no card when Codex waits for your OK. To turn them on: npx pendingyou init --app codex --permission-cards${originArgs(ictx.origin)}`
                  : 'Codex’s hooks were already installed.',
            })
          } catch (error) {
            report({
              ok: false,
              text: error instanceof Error ? error.message : `Couldn’t update ${file.path}.`,
            })
          }
        }
        if (!atLeast(version, detected.command ? CODEX_APP_WAKE : CODEX_WAKE))
          report({
            ok: true,
            text: detected.command
              ? `The Codex app’s codex ${version} has no codex queue, so an answer reaches a chat only when you next write in it. Update the Codex app, then run init again.`
              : `Codex ${version} wakes an idle thread with your answer only while its background server runs, which Codex starts by itself from ${CODEX_WAKE}. Until you update, an answer reaches a thread when you next write in it.`,
          })
        const manifest: CodexManifest = {
          version: 1,
          origin: ictx.origin,
          codexHome: await codexHome(io),
          mcpAdded: added,
          skill: skill.skill,
          hooks: lines,
          helper: mode === 'helper' ? ictx.helper : null,
          setup: { since: new Date(io.now()).toISOString() },
          permissionCards: cards,
        }
        await writeWhole(manifestPath(io), `${JSON.stringify(manifest, null, 2)}\n`, {
          secret: true,
        })
        return steps
      },
      // Asked after init's wait for the hooks' trust (trust.ts): the steps to trust them are above, when they still need it.
      next: async () => {
        const login = mode === 'oauth' && action !== 'keep'
        const first = login ? `run ${shWord(program)} mcp login pendingyou, then ` : ''
        const waiting = (await untrusted(io)).length > 0
        // Codex CLI and the Codex app share ~/.codex: the app's chats run the hooks once they're trusted.
        const start = waiting
          ? 'open Codex as above, type /hooks and trust Pending You’s hooks'
          : detected.command
            ? 'open the Codex app and start a chat in the folder you work in'
            : 'start codex here, or in the folder you work in'
        // Since 0.15.0 there are hooks an earlier init didn't add: Codex skips them until they're trusted.
        const again =
          newHooks && waiting
            ? `Codex has new Pending You hooks (${newHooks}), which it skips until you trust them once.`
            : null
        return {
          lines: [
            `Next: ${first}${start}.`,
            ...(again ? [again] : []),
            DONT_SAVE,
            'Then say this to it:',
            '',
            FINISH_SAY,
          ],
          together: `- Codex: ${first}${start}, then say the line below to it.${again ? ` ${again}` : ''} ${DONT_SAVE}`,
          say: true,
        }
      },
    }
  },

  async uninstall(io) {
    const manifest = await readCodexManifest(io)
    const steps: Step[] = []
    const file = await readHooksFile(io)
    const config = await configPath(io)
    let doc = (await readText(config).catch(() => null)) ?? null
    if ('json' in file) {
      const hooks =
        file.json.hooks && typeof file.json.hooks === 'object' ? (file.json.hooks as Json) : {}
      const removed = removeHooks(hooks, ALL_CODEX_HOOKS)
      if (removed.changed) {
        const rest: Json = { ...file.json, hooks: removed.hooks }
        if (Object.keys(removed.hooks).length === 0) delete rest.hooks
        if (Object.keys(rest).length === 0) await rm(file.path, { force: true })
        else await writeWhole(file.path, `${JSON.stringify(rest, null, 2)}\n`)
        // The person's own hooks that moved up keep the trust they had.
        if (doc !== null) doc = keepTheirTrust(doc, file.path, hooks)
      }
      steps.push({
        ok: true,
        text: removed.changed
          ? 'Removed the Pending You hooks from Codex.'
          : 'No Pending You hooks were in Codex.',
      })
    }
    if (manifest?.mcpAdded && doc !== null && tableSpans(doc, SERVER).length) {
      doc = withTable(doc, SERVER, null)
      steps.push({ ok: true, text: 'Removed the pendingyou MCP server from Codex.' })
    }
    if (doc !== null && doc !== (await readText(config).catch(() => null)))
      await writeConfig(config, doc)
    const skill = await removeSkill(manifest?.skill ?? null)
    if (skill) steps.push(skill)
    await rm(join(configDir(io), 'codex-threads.json'), { force: true })
    await rm(join(configDir(io), 'codex-listen'), { recursive: true, force: true })
    await removePresenceFiles(io, 'codex')
    await rm(manifestPath(io), { force: true })
    return steps
  },

  async status(io, ctx: StatusContext): Promise<AppStatus> {
    const { origin, signIn } = ctx
    const flag = originArgs(origin)
    const [detected, server, manifest, trust, skill] = await Promise.all([
      codex.detect(io),
      codexServer(io),
      readCodexManifest(io),
      readHookTrust(io),
      readText(codexSkillPath(io)).catch(() => null),
    ])
    const credential = await readCredential(io, origin, 'codex')
    const url = `${origin}/mcp`
    const why = headlessReason(io)
    const mark = (ok: boolean) => (ok ? 'ok     ' : 'missing')
    const helped = Boolean(server?.url && sameUrl(server.url, url) && isOurHelper(server.helper))
    const helper = helped || Boolean(manifest?.helper) || (!server && !manifest)
    const fix = `npx pendingyou ${helped ? 'login --app codex' : 'init --app codex'}${flag}`
    const connected = credential?.kind === 'connection'
    const signOk = signIn.state === 'ok' && (!helper || connected)
    const title =
      signIn.state === 'ok' && signIn.for ? connectionTitle(signIn.for) : `${NAME} on this computer`
    const signText =
      signIn.state === 'ok'
        ? helper
          ? connected
            ? `this computer’s own connection, ${title}; Codex here asks and hears through it`
            : `this computer’s sign-in for Codex only hears answers, so Codex here can’t use it; run ${fix}`
          : `hears for ${signIn.connections} Codex connection${signIn.connections === 1 ? '' : 's'}`
        : signIn.state === 'ended'
          ? `ended; run ${fix}`
          : signIn.state === 'none'
            ? `not signed in; run ${fix}`
            : 'Pending You couldn’t be reached'
    const mcpOk = Boolean(server?.url && sameUrl(server.url, url) && (!helper || helped))
    // init gave it the helper, and it's gone: saving it in the Codex app's MCP settings writes the table again without.
    const dropped = Boolean(
      server?.url && sameUrl(server.url, url) && !server.helper && manifest?.helper,
    )
    const mcpText = !server
      ? `not added; run npx pendingyou init --app codex${flag}`
      : server.inline
        ? `defined in a way init can’t edit (an inline table or dotted keys) in ${await configPath(io)}`
        : !server.url || !sameUrl(server.url, url)
          ? `points at ${server.url}, not ${url}; run npx pendingyou init --app codex${flag} to replace it`
          : helped
            ? `pendingyou (${server.url}), signed in through ${helperPath(io)} --app codex${server.approval === 'approve' ? '; its tools run without asking' : ''}`
            : dropped
              ? `pendingyou (${server.url}) has lost its http_headers_helper${server.approval === 'approve' ? '' : ' and default_tools_approval_mode'} (saving it in the Codex app’s MCP settings does that), so Codex can’t sign in through this computer’s sign-in; run npx pendingyou init --app codex${flag} again`
              : helper
                ? `pendingyou (${server.url}) signs in by itself; run npx pendingyou init --app codex${flag} to use this computer’s sign-in`
                : `pendingyou (${server.url}), signed in by Codex itself`
    const check = helper ? await checkHelper(io, origin, 'codex') : null
    const words: Record<Trust | 'missing', string> = {
      trusted: 'trusted',
      changed: 'changed since you trusted it',
      untrusted: 'not trusted yet',
      off: 'turned off',
      missing: 'missing',
    }
    // The four that hand answers over decide Ready; the permission and presence hooks (0.15.0) have lines of their own.
    const core = trust.filter((hook) => CODEX_HOOKS.some((spec) => spec.sub === hook.sub))
    const hooksOk = core.every((hook) => hook.trust === 'trusted')
    const hooksText = core.some((hook) => hook.trust === 'missing')
      ? `not installed; run npx pendingyou init --app codex${flag}`
      : `${core.map((hook) => `${hook.event} ${words[hook.trust]}`).join(', ')}${hooksOk ? '' : `. Codex skips a hook you haven’t trusted: ${TRUST} them`}`
    const extraLine = (
      label: string,
      what: string,
      subs: readonly string[],
      off: string | null,
    ) => {
      const hooks = trust.filter((hook) => subs.includes(hook.sub))
      if (off) return `          ${label} ${off}`
      if (hooks.some((hook) => hook.trust === 'missing'))
        return `  missing ${label} ${what}: not installed; run npx pendingyou@latest init --app codex${flag}`
      const trusted = hooks.every((hook) => hook.trust === 'trusted')
      return trusted
        ? `  ok      ${label} ${what} (${hooks.map((hook) => `${hook.event} trusted`).join(', ')})`
        : `  missing ${label} ${what}, once you trust ${hooks.length === 1 ? 'its hook' : 'its hooks'} (${hooks.map((hook) => `${hook.event} ${words[hook.trust]}`).join(', ')}): ${TRUST} ${hooks.length === 1 ? 'it' : 'them'}`
    }
    const ownConnection = credential?.kind === 'connection' && helper
    const notOwn = 'off: it needs Codex signed in through this computer’s own connection'
    const permissionText = extraLine(
      'Permission prompts:',
      'a card when Codex waits for your OK',
      CODEX_PERMISSION_HOOKS.map((spec) => spec.sub),
      !ownConnection
        ? notOwn
        : manifest?.permissionCards === false
          ? `off, as you chose; for a card when Codex waits for your OK, run npx pendingyou init --app codex --permission-cards${flag}`
          : null,
    )
    const presenceText = extraLine(
      'Presence:',
      'tells Pending You when this session is open',
      CODEX_PRESENCE_HOOKS.map((spec) => spec.sub),
      ownConnection ? null : notOwn,
    )
    const wakes = detected
      ? atLeast(detected.version, detected.command ? CODEX_APP_WAKE : CODEX_WAKE)
      : false
    const lines = [
      `Pending You for Codex · ${origin}${why ? ` · no browser here (${why})` : ''}`,
      `  ${mark(signOk)} Sign-in: ${signText}`,
      `  ${mark(detected !== null)} Codex: ${detected ? `${detected.version}${detected.command ? ` (${FROM_APP}: ${detected.command})` : ''}` : 'not found on PATH, nor the Codex app'}`,
      `  ${mark(mcpOk)} MCP server: ${mcpText}`,
      ...(check
        ? [
            `  ${mark(check.ok)} Sign-in helper: ${
              check.ok
                ? `${check.node} (${foundBy(check.from)}) runs pendingyou ${check.version}, even in Codex’s stripped environment`
                : `${check.why}; run npx pendingyou init --app codex${flag}`
            }`,
          ]
        : []),
      `  ${mark(skill !== null)} Skill: ${skill !== null ? `saved (${codexSkillPath(io)})` : `not saved; run npx pendingyou init --app codex${flag}`}`,
      `  ${mark(hooksOk)} Hooks: ${hooksText}`,
      permissionText,
      presenceText,
      `  ${mark(wakes)} Wake: ${
        wakes
          ? detected?.command
            ? 'codex queue wakes a chat the Codex app has open when you answer, while the app runs (one it let go, idle 3 hours or behind 10 newer idle chats, hears it when you open it again)'
            : 'codex queue wakes a thread when you answer, even while it’s idle'
          : `needs Codex ${detected?.command ? CODEX_APP_WAKE : CODEX_WAKE} or later${detected ? ` (this is ${detected.version})` : ''}; until then an answer reaches a thread when you next write in it`
      }`,
    ]
    const setup = setupStatus(NAME, signIn.state === 'ok' ? setupOf(signIn.for) : null)
    if (setup) lines.push(`  ${setup === 'finished' ? 'ok     ' : '       '} Setup: ${setup}`)
    const reaches = !helper || (signOk && mcpOk && check?.ok === true)
    const ready = reaches && signIn.state === 'ok' && mcpOk && hooksOk
    lines.push(
      ready
        ? 'Ready: Codex hears answers right away (report_setup hears "instant").'
        : reaches && mcpOk
          ? 'Not ready: Codex hears answers only while it’s working until the lines marked missing are fixed.'
          : 'Not ready: Codex here can’t reach Pending You until the lines marked missing are fixed.',
    )
    return { lines, ready }
  },

  async untrustedHooks(io): Promise<HookTrust | null> {
    if ((await untrusted(io)).length === 0) return null
    return {
      lines: trustSteps(await findCodex(io)),
      trusted: async () => (await untrusted(io)).length === 0,
    }
  },
}
