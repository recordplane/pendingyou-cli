// The command line's arguments: one command and its flags, which may come before or after it (`pendingyou handoff
// --origin <url>` and `pendingyou --origin <url> handoff` are the same; 0.2.0 wrote its hooks the second way). No
// dependencies, no surprises: an unknown flag or a stray argument is an error, never ignored.
//
// Since 0.11.0 most commands take `--app <id>` (apps/ids.ts): the hooks run for one app's sessions, and each app has
// its own sign-in. A command that names none acts for Claude Code, as every command did before.
import { APP_IDS, APP_NAMES, type AppId, DEFAULT_APP, isAppId } from './apps/ids.ts'
import { ANSWER_WAIT_MAX } from './codex-answers.ts'

export const DEFAULT_ORIGIN = 'https://www.pendingyou.com'
/** How long `hold` waits for an answer before it lets go (4 hours). */
export const DEFAULT_TIMEOUT_MS = 4 * 60 * 60 * 1000
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000

export type Command =
  | { name: 'help' }
  | { name: 'version' }
  | {
      name: 'login'
      origin: string
      /** Open the browser to sign in (`--no-browser`: only print the address). */
      browser: boolean
      force: boolean
      /** `--device` true, `--browser` false, neither null: decided by looking (remote.ts). */
      device: boolean | null
      /** `--name`: what to call this computer when it signs in with a code ("build-01"). */
      machine?: string
      /** `--app`: whose sign-in (Claude Code's when none is named). */
      app?: AppId
    }
  | { name: 'logout'; origin: string; all: boolean; app?: AppId }
  | { name: 'status'; origin: string; apps?: AppId[] }
  | { name: 'hold'; origin: string; requestId: string; timeoutMs: number }
  | { name: 'pickup'; origin: string; app?: AppId }
  | { name: 'handoff'; origin: string; app?: AppId }
  | { name: 'stopcheck'; origin: string; app?: AppId }
  /** Codex's PostToolUse hook (0.11.0): remembers the cards a turn posted, and starts the thread's listener. */
  | { name: 'posted'; origin: string; app?: AppId }
  /**
   * Claude Code's permission-prompt hooks (0.13.0, permission.ts): `permission` is PermissionRequest's,
   * `permission-done` PostToolUse's, PostToolUseFailure's and SessionEnd's, and `notify` Notification's (0.16.0).
   */
  | { name: 'permission' | 'permission-done' | 'notify'; origin: string; app?: AppId }
  /**
   * Presence (0.15.0, presence.ts): which sessions are open. Without `state` it's Claude Code's and Codex's SessionEnd
   * hook (the hook's input on stdin); with it, one send (OpenCode's plugin, Pi's extension, the wake mod, a hook's
   * background send), or (`keep`) Codex's keeper, which says live while the Codex process `pid` runs.
   */
  | {
      name: 'presence'
      origin: string
      app?: AppId
      state?: 'live' | 'closed'
      session?: string
      cwd?: string
      /** The agent's name with Pending You (not this computer's, as login's and init's `--name` are). */
      agentName?: string
      transcript?: string
      keep?: boolean
      pid?: number
      at?: number
    }
  /** What they start in the background: the worker that posts, changes and withdraws one session's card. */
  | { name: 'permission-card'; origin: string; session: string; worker: string }
  /**
   * What `posted` starts in the background (0.11.0): wakes one Codex thread when its cards are answered. OpenCode's
   * plugin and Pi's extension start one per session (0.12.0) and start the turn themselves. `--handed` (0.14.0) is
   * Codex's one listener for questions the person hands its threads from other assistants, in place of a thread.
   * With `--app claude-code` (0.35.0, handed-wait.ts) it's the wake mod's: one wait, from `since`, that says what came.
   */
  | { name: 'listen'; origin: string; app?: AppId; thread: string }
  | { name: 'listen'; origin: string; app?: AppId; handed: true; since?: string }
  | {
      name: 'init'
      origin: string
      login: boolean
      browser: boolean
      /** `--device` true, `--browser` false, neither null: decided by looking (remote.ts). */
      device: boolean | null
      yes: boolean
      /** `--name`: what to call this computer when it signs in with a code ("build-01"). */
      machine?: string
      /** `--oauth`: every app signs in to its MCP server by itself, as before 0.11.0, not through this computer's. */
      oauth?: boolean
      /** `--app`: only these apps (every one init finds when none are named). */
      apps?: AppId[]
      /**
       * `--no-permission-cards` false, `--permission-cards` true (0.13.0): whether Claude Code's permission prompts put
       * a card in front of the person. Neither: as the person chose before (on unless they turned it off).
       */
      permissionCards?: boolean
    }
  | { name: 'watch'; origin: string; command: string[]; once: boolean }
  /**
   * Codex's "ask on my phone first" (0.34.0, codex-answers.ts): how many minutes its permission prompts wait for an
   * answer on their card before Codex asks in its terminal; 0 turns it off.
   */
  | { name: 'codex-answers'; wait: number }
  | { name: 'uninstall'; origin: string; apps?: AppId[] }
  | { name: 'refresh'; origin: string; force: boolean; app?: AppId }
  | { name: 'mcp-headers'; origin: string; check: boolean; app?: AppId }
  /**
   * The stdio bridge (0.12.0, bridge.ts): a local MCP server for an app that can't sign in through a headers helper.
   * `check`: say which Node runs it, as the helper's check does.
   */
  | { name: 'mcp'; origin: string; app?: AppId; check: boolean }
  /**
   * The permission channel (0.33.0, channel.ts): the stdio MCP server Claude Code relays its permission prompts to, in
   * a session started with `pendingyou claude`.
   */
  | { name: 'channel'; origin: string; app?: AppId }
  /** Claude Code with the permission channel on (0.33.0): `claude` with these arguments after the channel's flag. */
  | { name: 'claude'; args: string[] }
  /**
   * Herdr (0.17.0, herdr.ts and herdr/command.ts): `report` writes an agent's badges onto its Herdr pane (what the
   * agents' hooks and the wake mod run); the rest are what the Pending You plugin for Herdr runs.
   */
  | HerdrCommand
  /** This computer's key (0.18.0, machine.ts and machine-command.ts). */
  | MachineCommand
  /** An app that acts as you, signed in on this computer (0.21.0, app-login.ts). */
  | AppCommand

/**
 * What `pendingyou app` does: sign an app that acts as you in on this computer (`login`: Pending You's own by its slug,
 * `herdr`, or a registered app with `--client-id`), out (`logout`), or say what each may do (`status`).
 */
export interface AppCommand {
  name: 'app'
  origin: string
  sub: (typeof APP_SUBS)[number]
  /** Which app: its name here (apps/<app>.json). login and logout need one; status says them all without. */
  app?: string
  /** login: a registered app's client, when it isn't Pending You's own. */
  clientId?: string
  /** login: `--scope`, what to ask for, space- or comma-separated. */
  scopes?: string[]
  /** login: `--name`, what to call this computer. */
  machine?: string
  /** login: `--device` true, `--browser` false, neither null (decided by looking, as login's). */
  device: boolean | null
  /** login: false with `--no-browser`. */
  browser: boolean
}

export const APP_SUBS = ['login', 'logout', 'status'] as const

/**
 * What `pendingyou machine` does: say whether Pending You knows this computer by its key (`status`), vouch for an app's
 * own device sign-in (`attest`, with that app's client and, for its own key, `--cnf`), or make a new key (`rotate`).
 */
export type MachineCommand =
  | { name: 'machine'; origin: string; sub: 'status' }
  | {
      name: 'machine'
      origin: string
      sub: 'attest'
      clientId: string
      /** `--cnf`: the RFC 7638 thumbprint of the app's own key for its grant. */
      cnf?: string
      /** `--name`: what to call this computer, when not its own name. */
      machine?: string
    }
  | { name: 'machine'; origin: string; sub: 'rotate'; yes: boolean }
  /** `link` (0.29.0): links this computer's apps' own sign-ins to it, by its key; `--quiet` prints nothing. */
  | { name: 'machine'; origin: string; sub: 'link'; quiet: boolean }

export const MACHINE_SUBS = ['status', 'attest', 'rotate', 'link'] as const

/** What `pendingyou herdr` does: one of HERDR_SUBS, with what that one takes. */
export interface HerdrCommand {
  name: 'herdr'
  origin: string
  sub: HerdrSub
  /** report: whose session (Claude Code's when none is named), its id, the moment, and whether it closed. */
  app?: AppId
  session?: string
  /** report: Claude Code's transcript, where the name it gave Pending You is. */
  transcript?: string
  /** report: the name the session goes by with Pending You. */
  agentName?: string
  closed?: boolean
  at?: number
  /** open: synthetic cards instead of Herdr's (for screenshots). */
  demo?: boolean
  /** setup: yes to what it offers, without asking. */
  yes?: boolean
  /** doctor: wait for Enter before exiting (its popup). */
  wait?: boolean
  /** watch: start one in the background unless one runs, then exit. */
  ensure?: boolean
  /** popup: which of the plugin's panes to open; view: on or off (it switches when neither is given). */
  target?: string
}

/** Everything `pendingyou herdr` does. */
export const HERDR_SUBS = [
  'report',
  'next',
  'open',
  'setup',
  'doctor',
  'unconfigure',
  'watch',
  'event',
  'view',
  'popup',
] as const
export type HerdrSub = (typeof HERDR_SUBS)[number]
/** The plugin's popup panes (its manifest's `[[panes]]`), as `herdr popup` opens them. */
export const HERDR_POPUPS = ['cards', 'setup', 'doctor', 'demo'] as const

export class UsageError extends Error {
  override name = 'UsageError'
}

const REQUEST_ID = /^req_[A-Za-z0-9-]{1,40}$/
/** A time as Pending You gives one (`changedAt`): ISO 8601, in UTC. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/

/**
 * A duration: `90s`, `3m`, `4h`, or a bare number of minutes.
 */
export function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(text.trim())
  if (!match) throw new UsageError(`“${text}” isn’t a duration. Use 90s, 3m or 4h.`)
  const amount = Number(match[1])
  const unit = match[2] ?? 'm'
  return Math.round(amount * (unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000))
}

/**
 * A computer's name as Pending You keeps it (a connection's machine, "Claude Code on build-01"): control and format
 * characters out, spaces collapsed, at most 60 characters. Empty when nothing is left.
 */
export function cleanName(text: string): string {
  const cleaned = [...text]
    .map((char) => (/[\p{Cc}\p{Cf}]/u.test(char) ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  let short = ''
  for (const char of cleaned) {
    if (short.length + char.length > 60) break
    short += char
  }
  return short.trim()
}

/** An origin Pending You can live at: https, or http on this computer (the local dev server). */
export function parseOrigin(text: string): string {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new UsageError(`“${text}” isn’t an address. Use one like ${DEFAULT_ORIGIN}.`)
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw new UsageError('Pending You’s address must start with https://.')
  if (url.username || url.password) throw new UsageError('The address can’t hold a user name.')
  return url.origin
}

const COMMANDS = new Set([
  'help',
  'version',
  'login',
  'logout',
  'status',
  'hold',
  'pickup',
  'handoff',
  'stopcheck',
  'init',
  'uninstall',
  'watch',
  'refresh',
  'mcp-headers',
  'posted',
  'listen',
  'mcp',
  'permission',
  'permission-done',
  'notify',
  'permission-card',
  'presence',
  'herdr',
  'machine',
  'app',
  'channel',
  'claude',
  'codex-answers',
])

/** Flags each command takes; `true` when the flag takes a value. */
const FLAGS: Record<string, Record<string, boolean>> = {
  help: {},
  version: {},
  login: {
    origin: true,
    'no-browser': false,
    force: false,
    device: false,
    browser: false,
    name: true,
    app: true,
  },
  logout: { origin: true, all: false, app: true },
  status: { origin: true, app: true },
  hold: { origin: true, timeout: true },
  pickup: { origin: true, app: true },
  handoff: { origin: true, app: true },
  stopcheck: { origin: true, app: true },
  posted: { origin: true, app: true },
  listen: { origin: true, app: true, thread: true, handed: false, since: true },
  permission: { origin: true, app: true },
  'permission-done': { origin: true, app: true },
  notify: { origin: true, app: true },
  'permission-card': { origin: true, session: true, worker: true },
  presence: {
    origin: true,
    app: true,
    state: true,
    session: true,
    cwd: true,
    name: true,
    transcript: true,
    keep: false,
    pid: true,
    at: true,
  },
  init: {
    origin: true,
    'no-login': false,
    'no-browser': false,
    device: false,
    browser: false,
    yes: false,
    name: true,
    oauth: false,
    app: true,
    'permission-cards': false,
    'no-permission-cards': false,
  },
  uninstall: { origin: true, app: true },
  watch: { origin: true, once: false },
  refresh: { origin: true, force: false, app: true },
  'mcp-headers': { origin: true, check: false, app: true },
  mcp: { origin: true, app: true, check: false },
  channel: { origin: true, app: true },
  claude: {},
  'codex-answers': { origin: true, wait: true },
  herdr: {
    origin: true,
    app: true,
    session: true,
    transcript: true,
    name: true,
    state: true,
    at: true,
    demo: false,
    yes: false,
    wait: false,
    ensure: false,
  },
  machine: { origin: true, 'client-id': true, cnf: true, name: true, yes: false, quiet: false },
  app: {
    origin: true,
    'client-id': true,
    scope: true,
    name: true,
    device: false,
    browser: false,
    'no-browser': false,
  },
}

/** Options that take a value, whichever command they belong to: needed to find the command behind them. */
const VALUE_OPTIONS = new Set([
  'origin',
  'timeout',
  'name',
  'app',
  'thread',
  'session',
  'worker',
  'state',
  'cwd',
  'transcript',
  'pid',
  'at',
  'client-id',
  'cnf',
  'scope',
])

/** Splits off the options given before the command: [those options, the command, everything after it]. */
function splitCommand(argv: readonly string[]): [string[], string | undefined, string[]] {
  let index = 0
  while (index < argv.length) {
    const arg = argv[index] as string
    if (arg === '--' || !arg.startsWith('-')) break
    index += arg.startsWith('--') && !arg.includes('=') && VALUE_OPTIONS.has(arg.slice(2)) ? 2 : 1
  }
  return [argv.slice(0, index), argv[index], argv.slice(index + 1)]
}

/** The command the arguments name, wherever its options are; undefined when there isn't one. */
export function commandOf(argv: readonly string[]): string | undefined {
  return splitCommand(argv)[1]
}

/** The commands agents' hooks run. Whatever goes wrong, they exit 0 and never block the person. */
export const HOOK_COMMANDS: ReadonlySet<string> = new Set([
  'pickup',
  'handoff',
  'stopcheck',
  'posted',
  'permission',
  'permission-done',
  'notify',
  'presence',
])

/**
 * A thread's id, as an app's hooks give it (`session_id`): Codex's (letters, digits and dashes), an OpenCode session's
 * (`ses_…`) or a Pi session's (a UUID). The same as apps/codex-wake.ts's THREAD.
 */
const THREAD = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/

/** One app, or several separated by commas (`--app claude-code,codex`). */
function appsOf(text: string): AppId[] {
  const apps = text
    .split(',')
    .map((each) => each.trim())
    .filter(Boolean)
  for (const app of apps)
    if (!isAppId(app))
      throw new UsageError(
        `There’s no app “${app}”. Use ${APP_IDS.slice(0, -1).join(', ')} or ${APP_IDS.at(-1)}.`,
      )
  if (apps.length === 0) throw new UsageError(`--app needs an app, like: --app ${APP_IDS[0]}`)
  return [...new Set(apps)] as AppId[]
}

export function parseArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): Command {
  const [leading, first, after] = splitCommand(argv)
  const helps = (arg: string) => arg === '-h' || arg === '--help'
  const versions = (arg: string) => arg === '-v' || arg === '--version'
  if (leading.some(helps)) return { name: 'help' }
  if (first === undefined) {
    if (leading.some(versions)) return { name: 'version' }
    if (leading.length === 0) return { name: 'help' }
    throw new UsageError('Which command? Like: pendingyou status')
  }
  if (leading.some(versions)) return { name: 'version' }
  if (!COMMANDS.has(first)) throw new UsageError(`There’s no “${first}” command.`)
  // `pendingyou claude [args…]` (0.33.0): everything after it is Claude Code's, taken as it is.
  if (first === 'claude') return { name: 'claude', args: [...after] }
  const rest = [...leading, ...after]
  const allowed = FLAGS[first] ?? {}
  const flags = new Map<string, string | true>()
  const positional: string[] = []
  // `watch -- <command> [args…]`: everything after `--` is the command, taken as it is.
  let command: string[] | undefined
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] as string
    if (arg === '--' && first === 'watch') {
      command = rest.slice(index + 1)
      break
    }
    if (arg === '-h' || arg === '--help') return { name: 'help' }
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const [key, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined]
    if (!(key in allowed)) throw new UsageError(`${first} has no --${key} option.`)
    if (flags.has(key)) throw new UsageError(`--${key} is given twice.`)
    if (allowed[key]) {
      const value = inline ?? rest[++index]
      if (value === undefined || value === '') throw new UsageError(`--${key} needs a value.`)
      flags.set(key, value)
    } else {
      if (inline !== undefined) throw new UsageError(`--${key} takes no value.`)
      flags.set(key, true)
    }
  }
  const text = (key: string) => {
    const value = flags.get(key)
    return typeof value === 'string' ? value : undefined
  }
  const origin = parseOrigin(text('origin') ?? env.PENDINGYOU_ORIGIN ?? DEFAULT_ORIGIN)
  const none = () => {
    if (positional.length) throw new UsageError(`${first} takes no “${positional[0]}”.`)
  }
  /** `--name`, cleaned up as Pending You keeps it; none when it isn't given. */
  const machine = () => {
    const given = text('name')
    if (given === undefined) return {}
    const name = cleanName(given)
    if (!name) throw new UsageError('--name needs a name for this computer, like: --name build-01')
    return { machine: name }
  }
  /** `--device` or `--browser`, or neither (null: decided by looking). */
  const device = () => {
    if (flags.has('device') && flags.has('browser'))
      throw new UsageError('Use --device or --browser, not both.')
    return flags.has('device') ? true : flags.has('browser') ? false : null
  }
  /** `--app`, one app; none when it isn't given (Claude Code's, as before 0.11.0). */
  const app = (): { app?: AppId } => {
    const given = text('app')
    if (given === undefined) return {}
    const apps = appsOf(given)
    if (apps.length > 1) throw new UsageError(`${first} takes one app, like: --app ${apps[0]}`)
    return { app: apps[0] as AppId }
  }
  /** `--permission-cards` or `--no-permission-cards`, or neither (as before). */
  const permissionCards = (): { permissionCards?: boolean } => {
    if (flags.has('permission-cards') && flags.has('no-permission-cards'))
      throw new UsageError('Use --permission-cards or --no-permission-cards, not both.')
    return flags.has('permission-cards')
      ? { permissionCards: true }
      : flags.has('no-permission-cards')
        ? { permissionCards: false }
        : {}
  }
  /** `--app`, one or several; none when it isn't given (every app). */
  const apps = (): { apps?: AppId[] } => {
    const given = text('app')
    return given === undefined ? {} : { apps: appsOf(given) }
  }

  switch (first) {
    case 'help':
      return { name: 'help' }
    case 'version':
      return { name: 'version' }
    case 'login':
      none()
      return {
        name: 'login',
        origin,
        browser: !flags.has('no-browser'),
        force: flags.has('force'),
        device: device(),
        ...machine(),
        ...app(),
      }
    case 'logout':
      none()
      if (flags.has('all') && flags.has('app'))
        throw new UsageError('Use --all or --app, not both.')
      return { name: 'logout', origin, all: flags.has('all'), ...app() }
    case 'status':
      none()
      return { name: 'status', origin, ...apps() }
    case 'pickup':
      none()
      return { name: 'pickup', origin, ...app() }
    case 'handoff':
      none()
      return { name: 'handoff', origin, ...app() }
    case 'stopcheck':
      none()
      return { name: 'stopcheck', origin, ...app() }
    // Not in USAGE: Codex's PostToolUse hook (apps/codex-wake.ts).
    case 'posted':
      none()
      return { name: 'posted', origin, ...app() }
    // Not in USAGE: what `posted` starts in the background, one per Codex thread, and OpenCode's plugin and Pi's
    // extension one per session (apps/codex-wake.ts).
    case 'listen': {
      none()
      const thread = text('thread')
      const since = text('since')
      if (flags.has('handed')) {
        if (thread !== undefined) throw new UsageError('Use --thread or --handed, not both.')
        if (since !== undefined && !ISO_TIME.test(since))
          throw new UsageError('--since needs a time, like: --since 2026-10-09T12:00:00.000Z')
        return { name: 'listen', origin, ...app(), handed: true, ...(since ? { since } : {}) }
      }
      if (since !== undefined) throw new UsageError('--since goes with --handed.')
      if (thread === undefined || !THREAD.test(thread))
        throw new UsageError('listen needs the thread it wakes, like: --thread 0199a1b2-…')
      return { name: 'listen', origin, ...app(), thread }
    }
    // Not in USAGE: Claude Code's permission-prompt hooks (0.13.0, permission.ts), its Notification hook's since 0.16.0.
    case 'permission':
    case 'permission-done':
    case 'notify':
      none()
      return { name: first, origin, ...app() }
    // Not in USAGE: what those hooks start in the background, one per Claude Code session (permission.ts).
    case 'permission-card': {
      none()
      const session = text('session')
      const worker = text('worker')
      if (
        session === undefined ||
        !THREAD.test(session) ||
        !worker ||
        !/^[0-9a-f]{8,64}$/.test(worker)
      )
        throw new UsageError('permission-card needs --session <id> and --worker <id>.')
      return { name: 'permission-card', origin, session, worker }
    }
    // Not in USAGE: the SessionEnd hook and what the apps run to say a session is open or closed (presence.ts).
    case 'presence': {
      none()
      const state = text('state')
      if (state !== undefined && state !== 'live' && state !== 'closed')
        throw new UsageError('--state is live or closed.')
      const session = text('session')
      if (session !== undefined && !THREAD.test(session))
        throw new UsageError('presence needs a session id, like: --session 0199a1b2-…')
      const number = (key: string) => {
        const given = text(key)
        if (given === undefined) return undefined
        if (!/^\d{1,16}$/.test(given)) throw new UsageError(`--${key} needs a number.`)
        return Number(given)
      }
      const pid = number('pid')
      const at = number('at')
      const given = (key: string) => {
        const value = text(key)
        return value === undefined ? {} : { [key]: value }
      }
      const agentName = text('name')
      return {
        name: 'presence',
        origin,
        ...app(),
        ...(state ? { state } : {}),
        ...(session ? { session } : {}),
        ...given('cwd'),
        ...given('transcript'),
        ...(agentName ? { agentName } : {}),
        ...(flags.has('keep') ? { keep: true } : {}),
        ...(pid ? { pid } : {}),
        ...(at ? { at } : {}),
      } as Command
    }
    case 'uninstall':
      none()
      return { name: 'uninstall', origin, ...apps() }
    // Not in USAGE: what a hook starts in the background when the sign-in needs refreshing (api.ts).
    case 'refresh':
      none()
      return { name: 'refresh', origin, force: flags.has('force'), ...app() }
    // Not in USAGE: what an app's MCP server runs for its headers (its headers helper, remote.ts).
    case 'mcp-headers':
      none()
      return { name: 'mcp-headers', origin, check: flags.has('check'), ...app() }
    case 'mcp':
      none()
      return { name: 'mcp', origin, ...app(), check: flags.has('check') }
    // Not in USAGE: what Claude Code runs as the permission channel (0.33.0, channel.ts); `pendingyou claude` is.
    case 'channel':
      none()
      return { name: 'channel', origin, ...app() }
    case 'herdr':
      return herdrCommand(origin, positional, flags, app)
    case 'machine':
      return machineCommand(origin, positional, flags, machine)
    case 'app':
      return appCommandOf(origin, positional, flags, machine, device)
    case 'init':
      none()
      return {
        name: 'init',
        origin,
        login: !flags.has('no-login'),
        browser: !flags.has('no-browser'),
        device: device(),
        yes: flags.has('yes'),
        ...machine(),
        ...(flags.has('oauth') ? { oauth: true } : {}),
        ...apps(),
        ...permissionCards(),
      }
    case 'codex-answers': {
      none()
      const given = text('wait')
      if (given === undefined || !/^\d{1,2}$/.test(given) || Number(given) > ANSWER_WAIT_MAX)
        throw new UsageError(
          `codex-answers needs --wait and a whole number of minutes, 0 (off) to ${ANSWER_WAIT_MAX}, like: pendingyou codex-answers --wait 2`,
        )
      return { name: 'codex-answers', wait: Number(given) }
    }
    case 'watch':
      none()
      if (!command?.length || !command[0])
        throw new UsageError(
          'watch needs a command after --, like: pendingyou watch -- ./on-answer.sh',
        )
      return { name: 'watch', origin, command, once: flags.has('once') }
    case 'hold': {
      if (positional.length !== 1)
        throw new UsageError('hold needs one request id, like: pendingyou hold req_0123…')
      const requestId = positional[0] as string
      if (!REQUEST_ID.test(requestId))
        throw new UsageError(`“${requestId}” isn’t a request id (they start with req_).`)
      const timeout = text('timeout')
      const timeoutMs = timeout === undefined ? DEFAULT_TIMEOUT_MS : parseDuration(timeout)
      if (timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS)
        throw new UsageError('--timeout must be between 1 second and 24 hours.')
      return { name: 'hold', origin, requestId, timeoutMs }
    }
  }
  throw new UsageError(`There’s no “${first}” command.`)
}

/**
 * `pendingyou herdr <what> …` (0.17.0): what to do first, then what it takes. Each takes only its own flags; `report`
 * (the agents' hooks and the wake mod run it) is the only one with a session.
 */
function herdrCommand(
  origin: string,
  positional: readonly string[],
  flags: ReadonlyMap<string, string | true>,
  app: () => { app?: AppId },
): HerdrCommand {
  const [sub, target, ...extra] = positional
  if (sub === undefined)
    throw new UsageError('herdr needs what to do, like: pendingyou herdr doctor')
  if (!(HERDR_SUBS as readonly string[]).includes(sub))
    throw new UsageError(`herdr has no “${sub}”. Use ${HERDR_SUBS.join(', ')}.`)
  const allowed: Record<HerdrSub, readonly string[]> = {
    report: ['app', 'session', 'transcript', 'name', 'state', 'at'],
    next: [],
    open: ['demo'],
    setup: ['yes'],
    doctor: ['wait'],
    unconfigure: [],
    watch: ['ensure'],
    event: [],
    view: [],
    popup: [],
  }
  for (const key of flags.keys())
    if (key !== 'origin' && !allowed[sub as HerdrSub].includes(key))
      throw new UsageError(`herdr ${sub} has no --${key} option.`)
  const command: HerdrCommand = { name: 'herdr', origin, sub: sub as HerdrSub }
  const takes = (choices: readonly string[] | null) => {
    if (extra.length || (target !== undefined && !choices?.includes(target)))
      throw new UsageError(
        choices
          ? `herdr ${sub} takes ${choices.join(' or ')}.`
          : `herdr ${sub} takes no “${target ?? extra[0]}”.`,
      )
  }
  const text = (key: string) => {
    const value = flags.get(key)
    return typeof value === 'string' ? value : undefined
  }
  switch (command.sub) {
    case 'report': {
      takes(null)
      const session = text('session')
      if (session !== undefined && !THREAD.test(session))
        throw new UsageError('herdr report needs a session id, like: --session 0199a1b2-…')
      const state = text('state')
      if (state !== undefined && state !== 'live' && state !== 'closed')
        throw new UsageError('--state is live or closed.')
      const at = text('at')
      if (at !== undefined && !/^\d{1,16}$/.test(at)) throw new UsageError('--at needs a number.')
      const transcript = text('transcript')
      const agentName = text('name')
      return {
        ...command,
        app: app().app ?? DEFAULT_APP,
        ...(session ? { session } : {}),
        ...(transcript ? { transcript } : {}),
        ...(agentName ? { agentName } : {}),
        closed: state === 'closed',
        ...(at ? { at: Number(at) } : {}),
      }
    }
    case 'popup':
      if (target === undefined)
        throw new UsageError(`herdr popup needs a pane: ${HERDR_POPUPS.join(', ')}.`)
      takes(HERDR_POPUPS)
      return { ...command, target }
    case 'view':
      takes(['on', 'off'])
      return target ? { ...command, target } : command
    case 'open':
      takes(null)
      return { ...command, demo: flags.has('demo') }
    case 'setup':
      takes(null)
      return { ...command, yes: flags.has('yes') }
    case 'doctor':
      takes(null)
      return { ...command, wait: flags.has('wait') }
    case 'watch':
      takes(null)
      return { ...command, ensure: flags.has('ensure') }
    default:
      takes(null)
      return command
  }
}

/** A client id as Pending You hands one out, or a metadata document's address: visible characters, no spaces. */
const CLIENT_ID = /^[\x21-\x7e]{1,2048}$/
/** An RFC 7638 thumbprint (SHA-256, base64url). */
const THUMBPRINT = /^[A-Za-z0-9_-]{43}$/

/** `pendingyou machine <what>` (0.18.0): each takes only its own flags. */
function machineCommand(
  origin: string,
  positional: readonly string[],
  flags: ReadonlyMap<string, string | true>,
  machine: () => { machine?: string },
): MachineCommand {
  const [sub, ...extra] = positional
  if (sub === undefined)
    throw new UsageError('machine needs what to do, like: pendingyou machine status')
  if (!(MACHINE_SUBS as readonly string[]).includes(sub))
    throw new UsageError(`machine has no “${sub}”. Use ${MACHINE_SUBS.join(', ')}.`)
  if (extra.length) throw new UsageError(`machine ${sub} takes no “${extra[0]}”.`)
  const allowed: Record<(typeof MACHINE_SUBS)[number], readonly string[]> = {
    status: [],
    attest: ['client-id', 'cnf', 'name'],
    rotate: ['yes'],
    link: ['quiet'],
  }
  for (const key of flags.keys())
    if (key !== 'origin' && !allowed[sub as (typeof MACHINE_SUBS)[number]].includes(key))
      throw new UsageError(`machine ${sub} has no --${key} option.`)
  if (sub === 'status') return { name: 'machine', origin, sub }
  if (sub === 'rotate') return { name: 'machine', origin, sub, yes: flags.has('yes') }
  if (sub === 'link') return { name: 'machine', origin, sub, quiet: flags.has('quiet') }
  const clientId = flags.get('client-id')
  if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId))
    throw new UsageError(
      'machine attest needs the client the app signs in with, like: --client-id <its client id>',
    )
  const cnf = flags.get('cnf')
  if (cnf !== undefined && (typeof cnf !== 'string' || !THUMBPRINT.test(cnf)))
    throw new UsageError(
      '--cnf is the app’s own key’s RFC 7638 thumbprint: 43 base64url characters.',
    )
  return {
    name: 'machine',
    origin,
    sub: 'attest',
    clientId,
    ...(typeof cnf === 'string' ? { cnf } : {}),
    ...machine(),
  }
}

/** The scopes an app may ask for (the person API's catalogue). */
const APP_SCOPE_NAMES = [
  'cards:read',
  'cards:read:all',
  'cards:answer',
  'cards:reply',
  'cards:later',
  'cards:delegate',
  'assistants:read',
  'presence:desk',
]

/** `pendingyou app <login|logout|status> [<app>]` (0.21.0): each takes only its own flags. */
function appCommandOf(
  origin: string,
  positional: readonly string[],
  flags: ReadonlyMap<string, string | true>,
  machine: () => { machine?: string },
  device: () => boolean | null,
): AppCommand {
  const [sub, app, ...extra] = positional
  if (sub === undefined)
    throw new UsageError('app needs what to do, like: pendingyou app login herdr')
  if (!(APP_SUBS as readonly string[]).includes(sub))
    throw new UsageError(`app has no “${sub}”. Use ${APP_SUBS.join(', ')}.`)
  if (extra.length) throw new UsageError(`app ${sub} takes one app, not “${extra[0]}”.`)
  const allowed: Record<(typeof APP_SUBS)[number], readonly string[]> = {
    login: ['client-id', 'scope', 'name', 'device', 'browser', 'no-browser'],
    logout: [],
    status: [],
  }
  for (const key of flags.keys())
    if (key !== 'origin' && !allowed[sub as (typeof APP_SUBS)[number]].includes(key))
      throw new UsageError(`app ${sub} has no --${key} option.`)
  if (app !== undefined && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(app))
    throw new UsageError(
      `“${app}” isn’t an app’s name here: lower-case letters, digits and dashes.`,
    )
  if (app === undefined && sub !== 'status')
    throw new UsageError(`app ${sub} needs the app, like: pendingyou app ${sub} herdr`)
  const command: AppCommand = {
    name: 'app',
    origin,
    sub: sub as (typeof APP_SUBS)[number],
    ...(app ? { app } : {}),
    device: null,
    browser: true,
  }
  if (sub !== 'login') return command
  const clientId = flags.get('client-id')
  if (clientId !== undefined && (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)))
    throw new UsageError('--client-id needs the client the app signs in with.')
  const scope = flags.get('scope')
  let scopes: string[] | undefined
  if (typeof scope === 'string') {
    scopes = [...new Set(scope.split(/[\s,]+/).filter(Boolean))]
    const unknown = scopes.find((each) => !APP_SCOPE_NAMES.includes(each))
    if (unknown || scopes.length === 0)
      throw new UsageError(`--scope takes the person API’s scopes: ${APP_SCOPE_NAMES.join(', ')}.`)
  }
  return {
    ...command,
    ...(typeof clientId === 'string' ? { clientId } : {}),
    ...(scopes ? { scopes } : {}),
    ...machine(),
    device: device(),
    browser: !flags.has('no-browser'),
  }
}

export const USAGE = `pendingyou: Pending You for your coding agents (Claude Code, Codex, OpenCode and Pi)

  npx -y pendingyou@latest init
                               Set up every agent on this computer: its MCP server, signed in through
                               this computer's own sign-in, the skill, and the hooks that hand it your
                               answers and catch what it leaves you only in chat. One approval
                               connects them all: your browser opens on Pending You, or over SSH you
                               approve a code on your phone. Claude Code 2.1.287 or later also gets the
                               wake mod; Codex is woken by codex queue; OpenCode gets a plugin and Pi
                               an extension that do all of that. --app limits it to some
  npx pendingyou hold <req_…>  Wait in the background until the answer to a request is ready,
                               print it, and exit (which wakes Claude Code); with the wake mod,
                               the mod answers it and nothing runs
  npx pendingyou status        What's set up for each agent, and whether it hears answers right away
  npx pendingyou login [--app <app>] | logout
                               Sign an agent in again (Claude Code's when none is named), or out
  npx pendingyou claude [args…]
                               Start Claude Code so its permission prompts can be answered on their
                               Pending You cards: Allow or Deny there, or in the terminal; the first
                               answer wins. Claude Code warns about the development channel each start
  npx pendingyou codex-answers --wait <minutes>
                               Codex asks on your phone first: its permission prompts go to your
                               Pending You card, with Allow and Deny, and wait up to that many minutes
                               (0 to ${ANSWER_WAIT_MAX}; 0, the default, is off) before Codex asks in its terminal
  npx pendingyou watch -- <command> [args…]
                               Run a command each time an answer is ready (always-on scripts)
  npx pendingyou uninstall     Remove exactly what init added
  npx pendingyou pickup        Answers waiting for this folder (the session-start hook)
  npx pendingyou handoff       The same, with your next message (the next-message hook)
  npx pendingyou stopcheck     Questions or steps for you left only in chat (the Stop hook)
  npx pendingyou mcp --app <app>
                               A stdio MCP server for an agent that can't run a headers helper: it
                               passes each message on to Pending You with that agent's sign-in here
  npx pendingyou herdr doctor  Pending You in Herdr: the badges on your agents' panes, the plugin, its
                               toasts and its sidebar row. The plugin runs herdr next, open, setup,
                               view and unconfigure
  npx pendingyou machine status | attest | rotate | link
                               This computer's key, which Pending You knows it by (init makes it; it
                               never leaves the computer): whether Pending You knows each agent's
                               connection by it, a proof of it for an app's own sign-in
                               (--client-id, --cnf), or a new key (--yes: without asking)
  npx pendingyou app login herdr | logout herdr | status
                               Sign in an app that answers your cards when you press a key in it (the
                               Pending You plugin for Herdr), out again, or what each may do. This
                               command line never answers: the app does, with its own sign-in and key

Apps (for --app): ${APP_IDS.map((app) => `${app} (${APP_NAMES[app]})`).join(', ')}.

Options: --origin <url> (default ${DEFAULT_ORIGIN}), --app <app> (init, status, uninstall: several with commas),
--timeout 4h (hold), --device (login, init: show a code and a QR code for your phone instead of opening the browser;
the default over SSH), --browser (open the browser anyway), --no-browser (only print the address), --name <name>
(login, init: what to call this computer; by default its own name on a Mac, its Tailscale name, else its hostname),
--no-login (init), --oauth (init: every agent signs in to Pending You by itself, as before 0.11.0), --yes (init: switch
or replace a pendingyou MCP server without asking), --no-permission-cards (init: no card when Claude Code waits for your
OK; --permission-cards turns them back on), --all (logout), --force (login), --once (watch).
`
