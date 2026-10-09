// This computer's own sign-in for an app's MCP server (0.10.0 for Claude Code on a computer with no browser; since
// 0.11.0 for every app, on every computer but Windows). A cloud computer or server reached over SSH can't finish /mcp →
// Authenticate (it sends the person's browser to a localhost there), and on any computer one sign-in for the MCP server
// and the hooks is simpler than two. So `npx pendingyou init` signs each app in once with a device code (approved in the
// browser, or on the phone over SSH), as a connection of its own ("Codex on build-01"; Pending You's
// worker/oauth/device.ts), and gives the app's pendingyou MCP server a headers helper instead of OAuth: a small sh script
// at a stable path, ~/.config/pendingyou/bin/pendingyou-mcp-headers (with `--app <id>` for an app but Claude Code), which
// the app runs each time it connects (Claude Code again on a 401 or 403; 10 seconds to answer) and which prints
// {"Authorization":"Bearer <token>"} from that sign-in, and nothing else: Claude Code's headersHelper and Codex's
// http_headers_helper both read a JSON object of strings. The hooks use the same sign-in.
//
// The script finds Node in this order: node on PATH; nvm's default ($NVM_DIR or ~/.nvm: alias/default, else the newest
// installed); the Node init ran with, by its stable path (Homebrew's /opt/homebrew/bin/node, never the Cellar folder an
// upgrade removes), recorded in ~/.config/pendingyou/node-path, while it's still there; then where Node usually is
// (/opt/homebrew/bin, /usr/local/bin, ~/.volta/bin). An app may run without your shell's PATH (a systemd service, a
// terminal that doesn't read ~/.profile, `ssh host claude`, Claude Code started from its desktop app or an IDE, Codex's
// stripped environment). It runs the private copy init installed (install.ts), never npx, and its stdout is only ever
// that one JSON object.
import { readFile, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { helperToken, SignInNeeded, Unavailable } from './api.ts'
import { APP_NAMES, type AppId, DEFAULT_APP } from './apps/ids.ts'
import { cleanName, DEFAULT_ORIGIN } from './args.ts'
import { readCredential } from './credentials.ts'
import { configDir, writeWhole } from './files.ts'
import type { Installed } from './install.ts'
import type { Io, RunResult } from './io.ts'
import { linkSoon } from './link.ts'
import { recordHelper } from './mcp-health.ts'
import { VERSION } from './version.ts'

export const HELPER = 'pendingyou-mcp-headers'
/** The script Claude Code runs: the same path whatever the version, so its MCP server never needs changing. */
export const helperPath = (io: Pick<Io, 'env' | 'home'>) => join(configDir(io), 'bin', HELPER)
/** Where init records the Node it ran with: the script's last way to find one. */
export const nodePathFile = (io: Pick<Io, 'env' | 'home'>) => join(configDir(io), 'node-path')
/** How long the helper waits for a refresh before it hands over the token it has (Claude Code allows 10 s). */
export const HELPER_WAIT_MS = 7000
/** The PATH a check runs the helper with: as bare as a systemd service's, so it proves Node is found without PATH. */
export const BARE_PATH = '/usr/bin:/bin'

/**
 * Why this computer counts as having no browser here, or null when it doesn't: a session over SSH, or Linux with no
 * display. `init --device` and `--browser` override it.
 */
export function headlessReason(io: Pick<Io, 'env' | 'platform'>): string | null {
  if (io.env.SSH_CONNECTION || io.env.SSH_TTY) return 'an SSH session'
  if (io.platform === 'linux' && !io.env.DISPLAY && !io.env.WAYLAND_DISPLAY)
    return 'Linux with no display'
  return null
}

/** Whether a pendingyou MCP server signs in through our helper, for `origin`. */
export function usesHelper(
  server: { url: string | null; helper?: string | null } | null | false | 'unknown',
  origin: string,
): boolean {
  if (!server || server === 'unknown' || !server.url || !isOurHelper(server.helper)) return false
  try {
    return new URL(server.url).origin === origin
  } catch {
    return false
  }
}

/**
 * The computer's name for its connection, from its hostname ("build-01.tail1234.ts.net" → "build-01"): the first label
 * (unless it's an address), control characters out, spaces collapsed, at most 60 characters.
 */
export function machineOf(host: string): string {
  const name = /^\d+(\.\d+){3}$/.test(host.trim()) ? host.trim() : (host.split('.')[0] ?? '')
  return cleanName(name)
}

/** How long Tailscale may take to say this computer's name before the hostname is used (it answers in milliseconds). */
export const TAILSCALE_MS = 1200

/**
 * Names nobody gave a computer: a cloud's own (AWS's ip-10-42-1-252 and ec2-54-…), or an address. One is still used when
 * there's nothing better, and `login` says how to change it.
 */
export function isUnfriendly(name: string): boolean {
  return /^ip-\d+(-\d+){3}$/i.test(name) || /^ec2-/i.test(name) || /^\d+(\.\d+){3}$/.test(name)
}

/**
 * Tailscale's name for this computer, when Tailscale is installed and answers within TAILSCALE_MS: its MagicDNS name's
 * first label, as `tailscale status` shows it (it follows a rename in Tailscale's admin console), else the hostname it
 * reports (`tailscale up --hostname`, or the computer's own). Null otherwise.
 */
export async function tailscaleName(io: Pick<Io, 'run'>): Promise<string | null> {
  const result = await io.run('tailscale', ['status', '--json'], TAILSCALE_MS)
  if (result.code !== 0) return null
  try {
    const self = (JSON.parse(result.stdout) as { Self?: { DNSName?: unknown; HostName?: unknown } })
      .Self
    const dns = typeof self?.DNSName === 'string' ? (self.DNSName.split('.')[0] ?? '') : ''
    const host = typeof self?.HostName === 'string' ? machineOf(self.HostName) : ''
    return cleanName(dns) || host || null
  } catch {
    return null
  }
}

/** What a computer signing in with a code is called, and where that came from. */
export interface ComputerName {
  name: string
  from: 'flag' | 'mac' | 'tailscale' | 'hostname'
  /** A cloud's own name or an address (isUnfriendly): `login` says how to change it. */
  unfriendly: boolean
}

/**
 * A Mac's own name for itself, as Sharing in System Settings shows it ("Sam’s MacBook Pro"), from `scutil --get
 * ComputerName`; null anywhere else, or when it doesn't answer.
 */
export async function macName(io: Pick<Io, 'run' | 'platform'>): Promise<string | null> {
  if (io.platform !== 'darwin') return null
  const result = await io.run('scutil', ['--get', 'ComputerName'], TAILSCALE_MS)
  return result.code === 0 ? cleanName(result.stdout) || null : null
}

/**
 * The name a computer signs in with: `--name` when given; else, on a Mac, its own name; else Tailscale's name for it;
 * else its hostname's first label. The approval page and the Assistants page show it ("Claude Code on build-01").
 */
export async function computerName(
  io: Pick<Io, 'run' | 'host'> & Partial<Pick<Io, 'platform'>>,
  given?: string,
): Promise<ComputerName> {
  if (given) return { name: given, from: 'flag', unfriendly: false }
  const mac = await macName({ run: io.run, platform: io.platform ?? 'linux' })
  if (mac) return { name: mac, from: 'mac', unfriendly: false }
  const tailscale = await tailscaleName(io)
  if (tailscale) return { name: tailscale, from: 'tailscale', unfriendly: isUnfriendly(tailscale) }
  const host = machineOf(io.host)
  return { name: host, from: 'hostname', unfriendly: isUnfriendly(host) }
}

/** One word for sh: as it is when it's plain, otherwise in single quotes. */
const shWord = (text: string) =>
  /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`

/**
 * What an app runs for its MCP server's headers: the script, `--app` for an app but Claude Code (whose command is as
 * 0.10.0 wrote it, so its server needn't change), and `--origin` when it isn't the default.
 */
export function helperCommand(
  io: Pick<Io, 'env' | 'home'>,
  origin: string,
  app: AppId = DEFAULT_APP,
): string {
  return `${shWord(helperPath(io))}${app === DEFAULT_APP ? '' : ` --app ${app}`}${origin === DEFAULT_ORIGIN ? '' : ` --origin ${shWord(origin)}`}`
}

/** Whether a headersHelper command runs our script, from any folder. */
export const isOurHelper = (command: unknown) =>
  typeof command === 'string' && new RegExp(`(^|[\\\\/'"\\s])${HELPER}(['"]?)(\\s|$)`).test(command)

/**
 * Where Node usually is when it's on no PATH an app passes on: Homebrew's (Apple silicon, then Intel and most
 * installers), then Volta's. Shell words: `$HOME` is the script's to expand.
 */
export const USUAL_NODES = [
  '/opt/homebrew/bin/node',
  '/usr/local/bin/node',
  '$HOME/.volta/bin/node',
]

/** The usual places as sh words, `$HOME` left for the shell. */
export const usualWords = (usual: readonly string[]) =>
  usual
    .map((path) =>
      path.startsWith('$HOME/')
        ? `"$HOME/${path.slice(6).replace(/["$`\\]/g, '\\$&')}"`
        : shWord(path),
    )
    .join(' ')

/**
 * The script, for this version's private copy (`cli`) and config folder. Plain POSIX sh: dash runs it on Ubuntu.
 * `usual`: where Node usually is (USUAL_NODES; a test gives its own).
 */
export function helperScript(
  cli: string,
  config: string,
  usual: readonly string[] = USUAL_NODES,
): string {
  return launcherScript(
    `# Pending You's sign-in for your agents' pendingyou MCP servers on this computer. Each runs it each time it connects
# (Claude Code's headersHelper, Codex's http_headers_helper, with --app), and it prints {"Authorization":"Bearer
# <token>"} from that app's own sign-in here, and nothing else. Written by npx pendingyou init (pendingyou ${VERSION});
# run that again to repair it. It runs pendingyou's own copy, never npx, with the first Node it finds: on PATH, nvm's
# default, the one init ran with, or where Node usually is.`,
    'mcp-headers',
    cli,
    config,
    usual,
  )
}

/**
 * A script at a path that never changes which runs one of pendingyou's commands (`sub`) from this version's private
 * copy (`cli`) with the first Node it finds: the headers helper (`mcp-headers`), and since 0.12.0 the stdio bridge's
 * launcher (`mcp`, bridge.ts). `about` is the comment at its top. Plain POSIX sh: dash runs it on Ubuntu.
 */
export function launcherScript(
  about: string,
  sub: string,
  cli: string,
  config: string,
  usual: readonly string[] = USUAL_NODES,
): string {
  return `#!/bin/sh
${about}
cli=${shWord(cli)}
PENDINGYOU_CONFIG_DIR=${shWord(config)}
export PENDINGYOU_CONFIG_DIR

# The newest Node nvm installed whose version is $1 or starts with "$1." (any version when $1 is empty).
newest() {
  for dir in "$nvm/versions/node"/v*; do
    [ -x "$dir/bin/node" ] || continue
    version=\${dir##*/v}
    if [ -n "$1" ]; then
      case $version in "$1" | "$1".*) ;; *) continue ;; esac
    fi
    printf '%s\\n' "$version"
  done | sort -t . -k 1,1n -k 2,2n -k 3,3n | tail -n 1
}

node=
from=
if found=$(command -v node 2>/dev/null) && [ -n "$found" ]; then
  node=$found
  from=PATH
else
  nvm=\${NVM_DIR:-$HOME/.nvm}
  want=
  [ -r "$nvm/alias/default" ] && want=$(sed -n 1p "$nvm/alias/default" | tr -d '[:space:]')
  # An alias can name another (lts/* → lts/jod → v22.21.0).
  hops=0
  while [ -n "$want" ] && [ "$hops" -lt 3 ] && [ -r "$nvm/alias/$want" ]; do
    want=$(sed -n 1p "$nvm/alias/$want" | tr -d '[:space:]')
    hops=$((hops + 1))
  done
  case $want in
    v[0-9]*) version=$(newest "\${want#v}") ;;
    [0-9]*) version=$(newest "$want") ;;
    *) version= ;;
  esac
  [ -n "$version" ] || version=$(newest '')
  if [ -n "$version" ]; then
    node=$nvm/versions/node/v$version/bin/node
    from=nvm
  else
    recorded=
    [ -r "$PENDINGYOU_CONFIG_DIR/node-path" ] && recorded=$(sed -n 1p "$PENDINGYOU_CONFIG_DIR/node-path")
    if [ -n "$recorded" ] && [ -x "$recorded" ]; then
      node=$recorded
      from=recorded
    else
      # Where Node usually is: Homebrew's (Apple silicon, then Intel and most installers), then Volta's.
      for found in ${usualWords(usual)}; do
        if [ -z "$node" ] && [ -x "$found" ]; then
          node=$found
          from=usual
        fi
      done
    fi
  fi
fi
if [ -z "$node" ]; then
  echo "pendingyou: no Node.js found (not on PATH, in nvm, where init found it, or in /opt/homebrew/bin, /usr/local/bin or ~/.volta/bin). Install Node, then run: npx pendingyou init" >&2
  exit 1
fi
if [ ! -r "$cli" ]; then
  echo "pendingyou: its copy of pendingyou is gone ($cli). Run: npx pendingyou init" >&2
  exit 1
fi
PENDINGYOU_NODE_FROM=$from
export PENDINGYOU_NODE_FROM
exec "$node" "$cli" ${sub} "$@"
`
}

/**
 * Writes a launcher (`text`, 0755) unless it's already exactly that, and records the Node the hooks run (install.ts's
 * hookNode: by its stable path, which outlives a Homebrew upgrade, where the running one's Cellar folder doesn't) as one
 * way for it to find Node. Throws when it can't write them.
 */
export async function writeLauncher(
  io: Pick<Io, 'env' | 'home'>,
  path: string,
  text: string,
  installed: Pick<Installed, 'node'>,
): Promise<{ path: string; changed: boolean }> {
  const before = await readFile(path, 'utf8').catch(() => null)
  const mode = await stat(path).then(
    (info) => info.mode & 0o777,
    () => 0,
  )
  const recorded = await readFile(nodePathFile(io), 'utf8').catch(() => null)
  if (recorded !== `${installed.node}\n`)
    await writeWhole(nodePathFile(io), `${installed.node}\n`, { mode: 0o644 })
  if (before === text && mode === 0o755) return { path, changed: false }
  await writeWhole(path, text, { mode: 0o755 })
  return { path, changed: true }
}

/** Writes the helper for this version's private copy (writeLauncher). */
export async function writeHelper(
  io: Pick<Io, 'env' | 'home'>,
  installed: Pick<Installed, 'script' | 'node'>,
): Promise<{ path: string; changed: boolean }> {
  return writeLauncher(io, helperPath(io), helperScript(installed.script, configDir(io)), installed)
}

/** Removes the helper and the Node it recorded (uninstall). True when there was a helper. */
export async function removeHelper(io: Pick<Io, 'env' | 'home'>): Promise<boolean> {
  const path = helperPath(io)
  const there = await stat(path).then(
    () => true,
    () => false,
  )
  await rm(path, { force: true })
  await rm(nodePathFile(io), { force: true })
  await rmdir(dirname(path)).catch(() => {})
  return there
}

/** What a check of the helper found: the Node it runs and how it found it, or why it can't run. */
export type HelperCheck =
  | { ok: true; node: string; from: 'PATH' | 'nvm' | 'recorded' | string; version: string }
  | { ok: false; why: string }

/**
 * Runs the helper as an app would at its barest (PATH /usr/bin:/bin, as a systemd service has it), in its check mode:
 * it finds Node and runs pendingyou's copy, which says which Node it is, and nothing is signed in or printed.
 */
export async function checkHelper(
  io: Io,
  origin: string,
  app: AppId = DEFAULT_APP,
): Promise<HelperCheck> {
  const path = helperPath(io)
  const exists = await stat(path).then(
    (info) => info.isFile(),
    () => false,
  )
  if (!exists) return { ok: false, why: `${path} is gone` }
  // Exactly as Claude Code runs it (sh -c with the command), with only HOME and a bare PATH.
  const result = await io.run(
    '/bin/sh',
    ['-c', `${helperCommand(io, origin, app)} --check`],
    15_000,
    {
      env: { HOME: io.home, PATH: BARE_PATH },
    },
  )
  return checkOutcome(result)
}

/** What a launcher's check said (`node <path> (<how>), pendingyou <version>`), or why it didn't run. */
export function checkOutcome(result: RunResult): HelperCheck {
  const line = result.stdout.trim().split('\n').at(-1) ?? ''
  const found = /^node (.+) \(([\w-]+)\), pendingyou (\S+)$/.exec(line)
  if (result.code !== 0 || !found)
    return {
      ok: false,
      why:
        result.stderr
          .trim()
          .split('\n')
          .at(-1)
          ?.replace(/^pendingyou: /, '')
          .replace(/\s*Run: npx pendingyou init\.?$/, '') || `it didn’t run (exit ${result.code})`,
    }
  return {
    ok: true,
    node: found[1] as string,
    from: found[2] as string,
    version: found[3] as string,
  }
}

/** How the helper found Node, in words. */
export const foundBy = (from: string) =>
  from === 'nvm'
    ? 'nvm’s default'
    : from === 'recorded'
      ? 'the Node init ran with'
      : from === 'usual'
        ? 'where Node usually is'
        : from === 'PATH'
          ? 'PATH'
          : from

const originOf = (url: string) => {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * `pendingyou mcp-headers`: what the helper runs. Prints {"Authorization":"Bearer <token>"} to stdout and nothing else
 * (the app reads stdout as the headers), from this computer's connection for the app (`--app`, Claude Code's when none)
 * at `origin`, refreshed when it's due; every problem goes to stderr in one line, with a non-zero exit. It never hands a
 * token to a server other than `origin`'s (Claude Code says which it's for: CLAUDE_CODE_MCP_SERVER_URL). `--check` says
 * which Node runs it instead.
 */
export async function mcpHeaders(
  io: Io,
  options: { origin: string; check: boolean; app?: AppId },
): Promise<number> {
  const app = options.app ?? DEFAULT_APP
  const name = APP_NAMES[app]
  const login = `npx pendingyou login${app === DEFAULT_APP ? '' : ` --app ${app}`}${options.origin === DEFAULT_ORIGIN ? '' : ` --origin ${options.origin}`}`
  if (options.check) {
    io.out(
      `node ${io.execPath} (${io.env.PENDINGYOU_NODE_FROM || 'PATH'}), pendingyou ${VERSION}\n`,
    )
    return 0
  }
  const server = io.env.CLAUDE_CODE_MCP_SERVER_URL
  if (app === DEFAULT_APP && server && originOf(server) !== options.origin) {
    io.err(
      `pendingyou: this helper signs in to ${options.origin}, but Claude Code’s server is ${server}, so it gave no token. Run: npx pendingyou init --origin ${originOf(server) ?? server}\n`,
    )
    return 1
  }
  const stored = await readCredential(io, options.origin, app)
  if (!stored) {
    io.err(
      `pendingyou: ${app === DEFAULT_APP ? 'this computer' : `${name} on this computer`} isn’t signed in to Pending You (${options.origin}). Run: ${login}\n`,
    )
    return 1
  }
  if (stored.kind !== 'connection') {
    io.err(
      `pendingyou: this computer’s sign-in only hears answers, so ${name} can’t use it. Run: ${login}\n`,
    )
    return 1
  }
  const headers = (token: string) =>
    io.out(`${JSON.stringify({ Authorization: `Bearer ${token}` })}\n`)
  try {
    const token = await helperToken(io, options.origin, HELPER_WAIT_MS, app)
    headers(token)
    await recordHelper(io, options.origin, app, 'ok')
    // This computer's sign-ins linked to it by its key, every few hours, in the background (0.29.0, link.ts).
    await linkSoon(io, options.origin)
    return 0
  } catch (error) {
    // Never nothing while there's a token (0.27.0): with no Authorization from its helper, Claude Code turns on its own
    // OAuth, and the 401 leaves the server at "needs authentication" for the rest of the session. A token that has run
    // out is refused like any other, which Claude Code counts as a failed connect and tries again, running this again;
    // by then the refresh started in the background has usually landed.
    if (error instanceof Unavailable) {
      const current = await readCredential(io, options.origin, app).catch(() => null)
      if (current?.kind === 'connection') {
        headers(current.accessToken)
        io.err(
          'pendingyou: couldn’t refresh the sign-in in time (is this computer online?), so this token may be refused; the refresh goes on in the background.\n',
        )
        await recordHelper(io, options.origin, app, current.expiresAt > io.now() ? 'ok' : 'stale')
        return 0
      }
    }
    io.err(
      error instanceof SignInNeeded
        ? `pendingyou: this computer’s sign-in has ended. Run: ${login}\n`
        : error instanceof Unavailable
          ? `pendingyou: ${error.message} Try again in a minute.\n`
          : 'pendingyou: something went wrong.\n',
    )
    return 1
  }
}
