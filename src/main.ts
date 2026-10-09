// The command line: parse the arguments, run the command, return the exit code. `cli.ts` runs it for real; tests run
// it with their own Io.
import { HOOK_DEADLINE_MS, refreshInBackground, SignInNeeded, Unavailable } from './api.ts'
import { listen, listenHanded, posted } from './apps/codex-wake.ts'
import { DEFAULT_APP } from './apps/ids.ts'
import { appModule } from './apps/registry.ts'
import { type Command, commandOf, HOOK_COMMANDS, parseArgs, USAGE, UsageError } from './args.ts'
import { bridge } from './bridge.ts'
import { PlainError } from './errors.ts'
import { hold } from './hold.ts'
import { init, status, uninstall } from './init.ts'
import type { Io } from './io.ts'
import { machine } from './machine-command.ts'
import { OAuthError } from './oauth.ts'
import { isPromptApp, permissionHook, permissionWorker } from './permission.ts'
import { type HookRun, pickup } from './pickup.ts'
import { presence } from './presence.ts'
import { mcpHeaders } from './remote.ts'
import { login, logout } from './signin.ts'
import { stopcheck } from './stopcheck.ts'
import { VERSION } from './version.ts'
import { watch } from './watch.ts'

async function run(io: Io, command: Command, hook: HookRun = { fallback: '' }): Promise<number> {
  switch (command.name) {
    case 'help':
      io.out(USAGE)
      return 0
    case 'version':
      io.out(`${VERSION}\n`)
      return 0
    case 'login': {
      const app = command.app ?? DEFAULT_APP
      return login(io, {
        ...command,
        app,
        // The app's MCP server signs in through this computer's sign-in: then the sign-in is its connection.
        connection: await appModule(app).usesHelper(io, command.origin),
      })
    }
    case 'logout':
      return logout(io, command)
    case 'status':
      return status(io, command)
    case 'hold':
      return hold(io, command)
    case 'pickup':
    case 'handoff':
      return pickup(
        io,
        { origin: command.origin, mode: command.name, app: command.app ?? DEFAULT_APP },
        hook,
      )
    case 'stopcheck':
      return stopcheck(io, { origin: command.origin, app: command.app ?? DEFAULT_APP })
    case 'posted':
      return posted(io, { origin: command.origin, app: command.app ?? DEFAULT_APP })
    case 'permission':
    case 'permission-done':
    case 'notify': {
      // Claude Code's (0.13.0; Notification's since 0.16.0) and Codex's (0.15.0): a hook line with another app does
      // nothing.
      const app = command.app ?? DEFAULT_APP
      if (!isPromptApp(app)) return 0
      return permissionHook(io, { origin: command.origin, app })
    }
    case 'presence':
      return presence(io, {
        origin: command.origin,
        app: command.app ?? DEFAULT_APP,
        ...(command.state ? { state: command.state } : {}),
        ...(command.session ? { session: command.session } : {}),
        ...(command.cwd ? { cwd: command.cwd } : {}),
        ...(command.agentName ? { name: command.agentName } : {}),
        ...(command.transcript ? { transcript: command.transcript } : {}),
        ...(command.keep ? { keep: true } : {}),
        ...(command.pid ? { pid: command.pid } : {}),
        ...(command.at ? { at: command.at } : {}),
      })
    case 'permission-card':
      // Detached and quiet, like refresh: nobody reads what it prints.
      try {
        await permissionWorker(io, command)
      } catch {}
      return 0
    case 'listen':
      // Codex's is detached, started by `posted`: nobody reads what it prints. OpenCode's plugin and Pi's extension
      // read their own child's. Codex's one listener for handed questions (0.14.0) is detached too.
      if ('handed' in command)
        return listenHanded(io, { origin: command.origin, app: command.app ?? DEFAULT_APP })
      return listen(io, { ...command, app: command.app ?? DEFAULT_APP })
    case 'init':
      return init(io, command)
    case 'uninstall':
      return uninstall(io, command)
    case 'watch':
      return watch(io, command)
    case 'refresh':
      // Detached and quiet: nobody reads what it prints, and the next hook sees the result in the credentials file.
      try {
        await refreshInBackground(io, command.origin, command.force, command.app ?? DEFAULT_APP)
      } catch {}
      return 0
    case 'mcp-headers':
      // An app's MCP server's headers helper: stdout is the headers and nothing else.
      return mcpHeaders(io, command)
    case 'mcp':
      // The stdio bridge (bridge.ts): stdout carries the app's protocol messages and nothing else.
      return bridge(io, command)
    case 'herdr':
      // Herdr (0.17.0): `report` is the agents' writers', quiet and 0 whatever happens; the rest the plugin's. Loaded
      // only when it's run (0.21.0), with the person API's SDK it now brings, so the hooks start as fast as before.
      return (await import('./herdr/command.ts')).herdr(io, command)
    case 'machine':
      // This computer's key (0.18.0): never printed; `attest` prints only an attestation.
      return machine(io, command)
    case 'app':
      // An app that acts as you (0.21.0): signed in, out, or said. The command line itself never answers.
      return (await import('./app-login.ts')).appCommand(io, command)
  }
}

/** A hook's hard deadline (api.ts, where the sign-in's wait for a refresh counts on it). */
export { HOOK_DEADLINE_MS }

async function runHook(io: Io, command: Command): Promise<number> {
  const hook: HookRun = { fallback: '' }
  const controller = new AbortController()
  const stop = () => controller.abort()
  if (io.signal.aborted) stop()
  io.signal.addEventListener('abort', stop, { once: true })
  let finished = false
  let printed = false
  const hookIo: Io = {
    ...io,
    out: (text) => {
      if (finished) return
      printed = true
      io.out(text)
    },
    signal: controller.signal,
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), Math.max(0, HOOK_DEADLINE_MS - io.uptime()))
  })
  try {
    const outcome = await Promise.race([run(hookIo, command, hook), deadline])
    if (outcome !== 'deadline') return outcome
    finished = true
    controller.abort()
    if (!printed && hook.fallback) io.out(hook.fallback)
    io.err('pendingyou: Pending You took too long; skipped this hook.\n')
    return 0
  } finally {
    finished = true
    clearTimeout(timer)
    io.signal.removeEventListener('abort', stop)
  }
}

/**
 * Whether these arguments run an agent's hook (pickup, handoff, stopcheck or posted). A hook must never get in the way
 * of the person: Claude Code blocks their message when a UserPromptSubmit hook exits 2 and flags any other failure, so
 * a hook exits 0 whatever goes wrong, with at most a short note on stderr (which the agent doesn't add to the
 * conversation).
 */
export const isHook = (argv: readonly string[]) => {
  const command = commandOf(argv) ?? ''
  // `presence --state …` is a send (or Codex's keeper) the apps start themselves, not a hook: no 3-second deadline.
  if (command === 'presence' && argv.some((arg) => arg === '--state' || arg.startsWith('--state=')))
    return false
  return HOOK_COMMANDS.has(command)
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const hook = isHook(argv)
  let command: Command
  try {
    command = parseArgs(argv, io.env)
  } catch (error) {
    if (hook) {
      const message = error instanceof UsageError ? error.message : 'Something went wrong.'
      io.err(
        `pendingyou: ${message} Skipped this hook; run npx pendingyou@latest init to repair it.\n`,
      )
      return 0
    }
    if (error instanceof UsageError) {
      io.err(`${error.message}\n\n${USAGE}`)
      return 2
    }
    throw error
  }
  // `pickup --help` and the like: nothing for Claude Code to add to the conversation.
  if (hook && !HOOK_COMMANDS.has(command.name)) return 0
  try {
    return hook ? await runHook(io, command) : await run(io, command)
  } catch (error) {
    // Plain words only: never a stack, a token or a server's description.
    const message =
      error instanceof OAuthError ||
      error instanceof Unavailable ||
      error instanceof SignInNeeded ||
      error instanceof PlainError
        ? error.message
        : 'Something went wrong.'
    io.err(`pendingyou: ${message}\n`)
    return hook ? 0 : 1
  }
}
