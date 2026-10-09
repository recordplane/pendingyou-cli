// Claude Code (0.11.0's module of what claude.ts carries out): what `pendingyou init` decides before anyone signs in,
// what it does after, `status`'s section and the lines init ends with.
//
// Its MCP server signs in through this computer's own connection ("Claude Code on build-01"), by the headers helper, on
// every computer but Windows (where Claude Code runs a headersHelper through cmd) or with `--oauth`; the hooks use the
// same connection, so one approval covers both. A pendingyou server that's there decides the rest, before signing in:
// - ours, through the helper, at this Pending You: kept.
// - one at this Pending You that signs in by itself (Claude Code's own /mcp → Authenticate), or no server beside an
//   enabled Pending You plugin for it (whose server is OAuth): with no browser here it's switched without a word (as
//   0.10.0 did: that sign-in can't finish here); at a terminal init asks, Yes by default; `--yes` switches; with nobody
//   to ask it's kept, and init says how to switch. Kept, Claude Code signs in by itself and the hooks get a sign-in
//   that only hears; kept beside the plugin, no skill is saved either: the plugin carries it.
// - one at another Pending You: replaced once the person says so (or `--yes`), or else Claude Code is left alone.

import {
  addCommand,
  type ClaudeInstall,
  claudeState,
  helperServer,
  installClaude,
  type McpPlan,
  type McpServer,
  mcpFromClaude,
  mcpFromFile,
  PLUGIN_ORIGINS,
  permissionBlocker,
  pluginFor,
  readManifest,
  removeCommand,
  sameUrl,
  uninstallClaude,
} from '../claude.ts'
import { connectionMachine, readCredential } from '../credentials.ts'
import { differs, type FolderServer, serverForFolder, siteOf } from '../environment.ts'
import { originArgs } from '../hooks.ts'
import type { Io } from '../io.ts'
import {
  modConfigured,
  pruneLoadedNotes,
  type Unwoken,
  unwokenLines,
  unwokenSessions,
} from '../loaded.ts'
import { claudeVersion, isOurModDir, loadsMods, MOD_CLAUDE } from '../mod.ts'
import {
  checkHelper,
  foundBy,
  headlessReason,
  helperCommand,
  helperPath,
  isOurHelper,
  machineOf,
  usesHelper,
} from '../remote.ts'
import { connectionTitle, FINISH_SAY, setupOf, setupStatus } from '../setup.ts'
import { shimPath } from '../shim.ts'
import { APP_NAMES } from './ids.ts'
import { switches } from './switch.ts'
import type { AppContext, AppModule, AppStatus, Prepared, StatusContext } from './types.ts'

const NAME = APP_NAMES['claude-code']

/** The sentence's lead-in, and what restarting means, in init's last lines. */
const RESTART =
  'restart Claude Code here (/exit, then claude --continue), or start it in the folder you work in'

async function switchesFor(io: Io, ctx: AppContext, what: string): Promise<boolean> {
  return switches(io, ctx, { name: 'Claude Code', what, uses: 'the hooks use', headless: true })
}

/** The plan for a server at another Pending You: replaced once the person says so, or Claude Code left alone. */
async function replaces(io: Io, ctx: AppContext, server: McpServer, url: string): Promise<boolean> {
  ctx.progress(`Claude Code’s pendingyou MCP server points at ${server.url}, not ${url}.\n`)
  if (ctx.yes) return true
  if (!io.interactive) return false
  const answer = await io.ask(`Replace it with ${url}? [y/N] `)
  return /^\s*y(es)?\s*$/i.test(answer)
}

export const claudeCode: AppModule = {
  id: 'claude-code',
  name: NAME,
  minVersion: '2.0.0',

  async detect(io) {
    const result = await io.run('claude', ['--version'], 20_000)
    if (result.code !== 0) return null
    return {
      version:
        claudeVersion(result.stdout) ?? (result.stdout.trim().split(/\s+/)[0] || 'installed'),
    }
  },

  async installed(io) {
    return (await readManifest(io)) !== null
  },

  async usesHelper(io, origin) {
    if (io.platform === 'win32') return false
    const server = await mcpFromFile(io)
    if (server !== 'unknown') return usesHelper(server, origin)
    const manifest = await readManifest(io)
    return Boolean(manifest?.helper && manifest.origin === origin)
  },

  async prepare(io, ctx, detected): Promise<Prepared> {
    const url = `${ctx.origin}/mcp`
    const flag = originArgs(ctx.origin)
    let server: McpServer | null | 'unknown' | 'timeout' = await mcpFromFile(io)
    if (server === 'unknown') {
      ctx.progress('Checking Claude Code’s MCP servers (this can take a minute)…\n')
      server = await mcpFromClaude(io)
    }
    const plugin = await pluginFor(io, ctx.origin)
    const helperMode = io.platform !== 'win32' && !ctx.oauth
    let mode: ClaudeInstall['mode'] = helperMode ? 'helper' : 'oauth'
    let plan: McpPlan
    const helperAdd = helperServer(url, helperCommand(io, ctx.origin))
    const add = helperMode ? helperAdd.text : addCommand(url)

    if (server === 'timeout') {
      plan = {
        action: 'keep',
        ok: false,
        text: `Claude Code took more than 3 minutes to list its MCP servers, so I left them alone. Check with: claude mcp get pendingyou. If it isn’t there, run: ${add}`,
      }
    } else if (server?.url && !sameUrl(server.url, url)) {
      // Another Pending You (staging, when production was asked for): asked before anyone signs in.
      if (!(await replaces(io, ctx, server, url))) {
        const commands = `  ${removeCommand(server.scope)}\n    ${add}`
        return {
          app: claudeCode,
          detected,
          signIn: null,
          skipped: {
            ok: false,
            text: `Kept Claude Code’s pendingyou MCP server at ${server.url}, so Claude Code isn’t set up for ${ctx.origin}. To use ${url}, run init again with --yes, or run:\n  ${commands}`,
          },
          install: async () => [],
          next: () => null,
        }
      }
      plan = { action: 'replace', server }
    } else if (server) {
      const ours = isOurHelper(server.helper)
      if (ours && helperMode)
        plan =
          server.helper === helperCommand(io, ctx.origin)
            ? {
                action: 'keep',
                ok: true,
                text: `The pendingyou MCP server (${url}) already signs in through this computer’s sign-in.`,
              }
            : { action: 'switch', server }
      else if (ours) plan = { action: 'switch', server }
      else if (server.helper) {
        // Someone else's headersHelper: theirs to change. The hooks hear through a sign-in of their own.
        mode = 'oauth'
        plan = helperMode
          ? {
              action: 'keep',
              ok: false,
              text: `Kept the pendingyou MCP server: it signs in through a headersHelper of its own (${server.helper}). To use this computer’s sign-in instead, run:\n  ${removeCommand(server.scope)}\n    ${helperAdd.text}`,
            }
          : {
              action: 'keep',
              ok: true,
              text: 'The pendingyou MCP server was already in Claude Code.',
            }
      } else if (
        helperMode &&
        (await switchesFor(
          io,
          ctx,
          'Claude Code signs in to Pending You by itself here (/mcp → Authenticate).',
        ))
      )
        plan = { action: 'switch', server }
      else {
        mode = 'oauth'
        plan = {
          action: 'keep',
          ok: true,
          text: helperMode
            ? `Kept Claude Code’s own sign-in to Pending You (${url}). To move it to this computer’s, run: npx -y pendingyou@latest init --yes${flag}`
            : `The pendingyou MCP server (${url}) was already in Claude Code.`,
        }
      }
    } else if (plugin) {
      // No server added by hand, so the Pending You plugin's is Claude Code's: one added by hand would win over it.
      if (
        helperMode &&
        (await switchesFor(
          io,
          ctx,
          'The Pending You plugin signs Claude Code in to Pending You by itself here.',
        ))
      )
        plan = { action: 'add', plugin: true }
      else {
        mode = 'oauth'
        plan = {
          action: 'keep',
          ok: true,
          text: helperMode
            ? `Kept the Pending You plugin as Claude Code’s connection. To move Claude Code to this computer’s sign-in, run: npx -y pendingyou@latest init --yes${flag}`
            : 'The Pending You plugin is Claude Code’s connection here.',
        }
      }
    } else plan = { action: 'add' }

    const signIn = mode === 'helper' ? 'connection' : 'hear'
    const added = plan.action !== 'keep'
    // The sessions open here that the wake mod doesn't run in (0.23.0, loaded.ts): init names them last.
    let unwoken: Unwoken[] = []
    return {
      app: claudeCode,
      detected,
      signIn,
      install: async (ictx) => {
        const steps = await installClaude(io, ctx.origin, {
          version: detected.version,
          mcp: plan,
          mode,
          helper: ictx.helper,
          plugin: Boolean(plugin),
          copy: ictx.copy,
          hookLine: ictx.hookLine,
          report: ictx.report,
          progress: ictx.progress,
          ...(ctx.permissionCards === undefined ? {} : { permissionCards: ctx.permissionCards }),
        })
        await pruneLoadedNotes(io).catch(() => {})
        if (await modConfigured(io)) unwoken = await unwokenSessions(io).catch(() => [])
        return steps
      },
      next: (ictx) => {
        const restart = unwokenLines(unwoken)
        if (mode === 'oauth') {
          const authenticate = added || !ictx.signedIn
          return {
            lines: [
              ...restart,
              authenticate
                ? 'Next, in Claude Code: if it’s open, restart it (/exit, then claude --continue), run /mcp, choose pendingyou and Authenticate. Then ask Claude Code to finish setting up Pending You.'
                : 'Next, in Claude Code: if it’s open, restart it (/exit, then claude --continue), so the hooks load. Then ask Claude Code to finish setting up Pending You.',
            ],
            together: `- Claude Code: restart it (/exit, then claude --continue)${authenticate ? ', run /mcp, choose pendingyou and Authenticate' : ''}, then ask it to finish setting up Pending You.${restart.length ? ` ${restart.join(' ')}` : ''}`,
            say: false,
          }
        }
        const version = claudeVersion(detected.version)
        const byItself = version !== null && loadsMods(version)
        return {
          lines: [
            ...restart,
            `Next: ${RESTART}.`,
            byItself
              ? 'It finishes setting up by itself and sends you a test card. If it doesn’t, say this to it:'
              : 'Then say this to it:',
            '',
            FINISH_SAY,
          ],
          together: `- Claude Code: ${RESTART}. ${byItself ? 'It finishes setting up by itself and sends you a test card.' : 'Then say the line below to it.'}${restart.length ? ` ${restart.join(' ')}` : ''}`,
          say: true,
        }
      },
    }
  },

  async uninstall(io) {
    return uninstallClaude(io)
  },

  async status(io, ctx: StatusContext): Promise<AppStatus> {
    return claudeStatus(io, ctx)
  },
}

/**
 * status's line for the permission-prompt hooks (0.13.0): on; on without the Notification hook (0.16.0), which a setup
 * from before it lacks until init runs again; off, as the person chose; or why Claude Code here can't have them. Never a
 * reason status isn't Ready.
 */
function permissionLine(
  io: Io,
  claude: Awaited<ReturnType<typeof claudeState>>,
  manifest: Awaited<ReturnType<typeof readManifest>>,
  helper: boolean,
  flag: string,
): string {
  const label = 'Permission prompts:'
  if (claude.permission && claude.notify)
    return `  ok      ${label} a card when Claude Code waits for your OK`
  if (claude.permission)
    return `  missing ${label} no card for a dialog in bypassPermissions mode, or one the other hooks don’t see; run npx pendingyou@latest init${flag}`
  if (manifest?.permissionCards === false)
    return `          ${label} off, as you chose; for a card when Claude Code waits for your OK, run npx pendingyou init --permission-cards${flag}`
  const blocker = claude.claude
    ? permissionBlocker(io, claude.claude, helper ? 'helper' : 'oauth')
    : null
  return blocker
    ? `          ${label} no card when Claude Code waits for your OK: ${blocker}`
    : `  missing ${label} no card when Claude Code waits for your OK; run npx pendingyou@latest init${flag}`
}

/**
 * status's line for presence (0.15.0, presence.ts): whether Pending You hears when a session here is open. Never a
 * reason status isn't Ready.
 */
function presenceLine(
  claude: Awaited<ReturnType<typeof claudeState>>,
  connected: boolean,
  mod: boolean,
  flag: string,
): string {
  const label = 'Presence:'
  if (!connected)
    return `          ${label} off: it needs Claude Code signed in through this computer’s own connection`
  if (!claude.presence || !claude.hooks)
    return `  missing ${label} Pending You isn’t told when a session closes; run npx pendingyou@latest init${flag}`
  return `  ok      ${label} tells Pending You when this session is open (${mod ? 'as it starts, then every 5 minutes from the wake mod' : 'as it starts and with your messages'}; closed as it ends)`
}

/** Claude Code's section of `pendingyou status`: what's set up and what's missing, each with the command that fixes it. */
async function claudeStatus(io: Io, ctx: StatusContext): Promise<AppStatus> {
  const { origin, signIn } = ctx
  const [claude, here, manifest] = await Promise.all([
    claudeState(io),
    serverForFolder(io, io.cwd),
    readManifest(io),
  ])
  const credential = await readCredential(io, origin)
  const flag = originArgs(origin)
  const mcp = claude.mcp
  // Through the helper (this computer's own sign-in): Claude Code's server runs ours, init set it up so, or nothing is
  // set up yet and init would (everywhere but Windows).
  const helped = usesHelper(mcp, origin)
  const helper =
    io.platform !== 'win32' &&
    (helped ||
      Boolean(manifest?.helper && manifest.origin === origin) ||
      (mcp === false && !manifest && !claude.plugins.length))
  const why = headlessReason(io)
  const lines = [
    `Pending You for Claude Code · ${origin}${why ? ` · no browser here (${why})` : ''}`,
  ]
  const mark = (ok: boolean) => (ok ? 'ok     ' : 'missing')
  const url = `${origin}/mcp`
  const plugin = claude.plugins.find((id) => siteOf(PLUGIN_ORIGINS[id] ?? '') === siteOf(origin))
  const sameServer =
    mcp !== false && mcp !== 'unknown' && (!mcp.url || mcp.url.replace(/\/+$/, '') === url)
  // The plugin's server is Claude Code's when nobody added one by hand.
  const pluginServer = mcp === false && Boolean(plugin)
  const mcpOk = helper ? sameServer && helped : sameServer || pluginServer
  const mcpText =
    mcp === 'unknown'
      ? 'Claude Code didn’t say in time; check with claude mcp get pendingyou'
      : pluginServer
        ? `the Pending You plugin’s (${plugin}), which signs in by itself`
        : mcp === false
          ? `not added; run npx pendingyou init${flag}`
          : !sameServer
            ? `points at ${mcp.url}, not ${url}, so sessions post cards where these hooks don’t hear them; run npx pendingyou init${flag} to replace it`
            : !helper
              ? `pendingyou${mcp.url ? ` (${mcp.url})` : ''}`
              : helped
                ? `pendingyou (${mcp.url}), signed in through ${helperPath(io)}`
                : mcp.helper
                  ? `pendingyou (${mcp.url}) signs in through a headersHelper of its own (${mcp.helper}); run npx pendingyou init${flag} to use this computer’s sign-in`
                  : `pendingyou (${mcp.url}) signs in through a browser${why ? ', which can’t finish on this computer' : ''}; run npx pendingyou init${flag}`
  const form = claude.form
  const hooksRun = form?.runs ?? true
  // The wake mod (0.10.0): Claude Code 2.1.287 or later loads it from the plugin or from CLAUDE_CODE_PLUGIN_DIRS.
  const mod = claude.mod
  const modOk = mod.loads && (mod.plugin || mod.present)
  const modText = !claude.claude
    ? `needs Claude Code ${MOD_CLAUDE} or later`
    : !mod.loads
      ? `needs Claude Code ${MOD_CLAUDE} or later (this is ${claude.claude}); until then, a background hold wakes it`
      : mod.present
        ? `in CLAUDE_CODE_PLUGIN_DIRS (${mod.dirs.join(', ')}); a session is woken when you answer, with no hold running${mod.dirs.every((dir) => isOurModDir(dir)) ? `. Its folder names a version, so an update leaves open sessions without it: run npx pendingyou@latest init${flag}` : ''}`
        : mod.plugin
          ? 'in the Pending You plugin; a session is woken when you answer, with no hold running'
          : mod.dirs.length
            ? `${mod.dirs.join(', ')} is gone; run npx pendingyou@latest init${flag}`
            : `not installed; run npx pendingyou@latest init${flag}`
  const via = form?.shim ? `, through ${shimPath(io)}` : ''
  const formText = !form
    ? ''
    : form.form === 'direct'
      ? form.runs
        ? `they run pendingyou${form.version ? ` ${form.version}` : ''} directly (${form.script})${via}`
        : `the Node or the copy of pendingyou they run is gone (${form.node}, ${form.script}); run npx pendingyou@latest init${flag}`
      : form.form === 'npx'
        ? `they run through npx${via}, which is slower; run npx pendingyou@latest init${flag} to run them directly`
        : 'they run pendingyou from PATH or a file of your own'
  // login makes a connection only once Claude Code's server signs in through the helper; init does both.
  const fix = `npx pendingyou ${helped ? 'login' : 'init'}${flag}`
  // The connection's name as Pending You has it, so status never drifts from it; else this computer's own record.
  const title =
    signIn.state === 'ok' && signIn.for
      ? connectionTitle(signIn.for)
      : `${NAME} on ${(await connectionMachine(io, origin)) ?? (machineOf(io.host) || 'this computer')}`
  const connected = credential?.kind === 'connection'
  const signOk = signIn.state === 'ok' && (!helper || connected)
  const signText = helper
    ? signIn.state === 'ok'
      ? connected
        ? `this computer’s own connection, ${title}; Claude Code here asks and hears through it`
        : `this computer’s sign-in only hears answers, so Claude Code here can’t use it; run ${fix}`
      : signIn.state === 'ended'
        ? `ended; run ${fix}`
        : signIn.state === 'none'
          ? `not signed in; run ${fix}${why ? ' (you approve a code on your phone)' : ''}`
          : 'Pending You couldn’t be reached'
    : signIn.state === 'ok'
      ? signIn.for
        ? `hears for ${signIn.for.name} only (for pendingyou watch)`
        : `hears for ${signIn.connections} Claude Code connection${signIn.connections === 1 ? '' : 's'}`
      : signIn.state === 'ended'
        ? `ended; run npx pendingyou login${flag}`
        : signIn.state === 'none'
          ? `not signed in; run npx pendingyou login${flag}`
          : 'Pending You couldn’t be reached'
  // The helper as Claude Code runs it at its barest: found Node, and runs pendingyou's copy.
  const check = helper ? await checkHelper(io, origin) : null
  const skillOk = claude.skill || Boolean(plugin)
  const skillText = claude.skill
    ? 'saved'
    : plugin
      ? 'the Pending You plugin carries it'
      : `not saved; run npx pendingyou init${flag}`
  lines.push(
    `  ${mark(signOk)} Sign-in: ${signText}`,
    `  ${mark(claude.claude !== null)} Claude Code: ${claude.claude ?? 'not found on PATH'}`,
    `  ${mark(mcpOk)} MCP server: ${mcpText}`,
    ...(check
      ? [
          `  ${mark(check.ok)} Sign-in helper: ${
            check.ok
              ? `${check.node} (${foundBy(check.from)}) runs pendingyou ${check.version}, even for a Claude Code started without your shell’s PATH`
              : `${check.why}; run npx pendingyou init${flag}`
          }`,
        ]
      : []),
    ...(plugin
      ? [
          `  ok      Plugin: ${plugin} is enabled${pluginServer ? '' : mcp !== false && mcp !== 'unknown' ? '; Claude Code uses the server added by hand instead of its own' : ''}`,
        ]
      : []),
    `  ${mark(skillOk)} Skill: ${skillText}`,
    `  ${mark(claude.hooks && hooksRun)} Hooks: ${claude.hooks ? `session-start pickup and next-message hand-off; ${formText}` : `not installed; run npx pendingyou init${flag}`}`,
    `  ${mark(claude.stopcheck)} Stop check: ${claude.stopcheck ? 'asks Claude Code to post what it leaves you in chat' : `not installed; run npx pendingyou init${flag}`}`,
    `  ${mark(modOk)} Wake mod: ${modText}`,
    permissionLine(io, claude, manifest, helper, flag),
    presenceLine(claude, helper && connected, modOk, flag),
  )
  // How setup stands on Pending You (from servers that say): never a reason it isn't Ready.
  const setup = setupStatus(NAME, signIn.state === 'ok' ? setupOf(signIn.for) : null)
  if (setup) lines.push(`  ${setup === 'finished' ? 'ok     ' : '       '} Setup: ${setup}`)
  // A folder's own server (local or project scope) wins over the user one in Claude Code: say when it's elsewhere. (The
  // plugin's server counts only when no server was added by hand, and is production's.)
  if (here && (here.scope === 'local' || here.scope === 'project') && differs(here, origin))
    lines.push(
      `  ${mark(false)} This folder: its ${here.scope}-scope pendingyou MCP server (${here.url}) is another Pending You than ${origin}; Claude Code uses it here instead`,
    )
  const user: FolderServer | null =
    mcp !== false && mcp !== 'unknown' && mcp.url ? { url: mcp.url, scope: 'user' } : null
  const other = differs(here, origin) ? here : differs(user, origin) ? user : null
  // Through the helper, Claude Code reaches Pending You only with the helper, the connection and the server together.
  const reaches = !helper || (signOk && mcpOk && check?.ok === true)
  const ready = reaches && signIn.state === 'ok' && claude.hooks && hooksRun && !other
  if (other)
    lines.push(
      `Mismatch: Claude Code’s MCP server is ${siteOf(other.url)} but the hooks and sign-in are ${siteOf(origin) ?? origin}. Use the one you look at (npx pendingyou init --origin <it>), then restart your Claude Code sessions.`,
    )
  lines.push(
    ready
      ? helper
        ? 'Ready: Claude Code here signs in through this computer’s sign-in, and hears answers right away (report_setup hears "instant").'
        : 'Ready: Claude Code hears answers right away (report_setup hears "instant").'
      : reaches
        ? 'Not ready: Claude Code hears answers while it’s working (report_setup hears "while-working").'
        : 'Not ready: Claude Code here can’t reach Pending You until the lines marked missing are fixed.',
  )
  return { lines, ready }
}
