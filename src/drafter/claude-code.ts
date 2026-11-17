// Claude Code as the drafter (docs/plans/2026-11-16-card-drafter.md §3.3; G1): one `claude -p` call of a model through
// the person's own Claude Code login, with no API key and nothing through Pending You. The command is the backtest's,
// proven under strace on a Linux computer (Claude Code 2.1.326) to load no Pending You or Herdr hook, no plugin, no MCP server and
// no session folder: an empty folder, an environment with nothing of this one's but HOME, PATH and USER (so the wake
// mod and the hooks can't load: they come from CLAUDE_CODE_PLUGIN_DIRS, settings and the session's variables), no
// settings, no tools, no MCP, no slash commands, no session kept. `--bare` can't be used: it never reads the login.
// PENDINGYOU_DRAFTER=1 rides along, so a Pending You hook that did start would do nothing (PR 4 makes them check it).
//
// The turn goes on stdin, never in the arguments, which other programs on the computer can read. The answer is the
// stream's result (`structured_output`), checked against schema v2 before anyone sees it. The stream also says when the
// person's plan is at its limit (`rate_limit_event`: rejected, or the call counted as extra usage): the call is marked
// `overLimit`, and the settings' `atLimit` says whether its verdict is used (decision 4, the person's to decide; `stop` until then).
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { configDir } from '../files.ts'
import type { Io, RunResult } from '../io.ts'
import { atLeast, claudeVersion } from '../mod.ts'
import { SCHEMA, SYSTEM, turnText } from './prompt.ts'
import type { Drafter, DraftInput, TierCall, TierFailure, Verdict } from './types.ts'
import { isVerdict } from './validate.ts'

/** The first Claude Code the command was proven on. An older one isn't used until it is. */
export const CLAUDE_MIN = '2.1.326'
/** The longest one call may take (the backtest's slowest was 17.1 seconds). */
export const CALL_MS = 30_000
/** The environment variable every Pending You hook and the mod will check (PR 4): set, they do nothing. */
export const DRAFTER_MARK = 'PENDINGYOU_DRAFTER'

/** The arguments of one call: the backtest's, with the stream so the plan's limit can be seen. */
export function claudeArgs(model: string): string[] {
  return [
    '-p',
    '--model',
    model,
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--tools',
    '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--system-prompt',
    SYSTEM,
    '--json-schema',
    JSON.stringify(SCHEMA),
    '--output-format',
    'stream-json',
    '--verbose',
  ]
}

/** Exactly the environment the call gets: nothing of this process's but where home is, the path and who's running it. */
export function claudeEnv(
  env: Record<string, string | undefined>,
  home: string,
): Record<string, string> {
  return {
    HOME: env.HOME || home,
    PATH: env.PATH ?? '',
    ...(env.USER ? { USER: env.USER } : {}),
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    [DRAFTER_MARK]: '1',
  }
}

/** Where the calls run: an empty folder of the command line's own. */
export const runDir = (io: Pick<Io, 'env' | 'home'>) => join(configDir(io), 'drafter', 'run')

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Words Claude Code says when nobody is signed in, or the sign-in can't be used. */
const SIGNIN = /not logged in|log ?in|logged out|authenticat|invalid api key|oauth|credential/i

/** What one call's output says: its verdict, or why there's none, and what it cost. */
export function readCall(result: RunResult): Omit<TierCall, 'model' | 'seconds'> {
  if (result.code === 127) return { failure: 'missing' }
  if (result.code === 124) return { failure: 'timeout' }
  let limit = false
  let final: Record<string, unknown> | null = null
  for (const line of result.stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObject(event)) continue
    if (event.type === 'rate_limit_event' && isObject(event.rate_limit_info)) {
      const info = event.rate_limit_info
      if (info.status === 'rejected' || info.isUsingOverage === true || info.overageInUse === true)
        limit = true
    }
    if (event.type === 'result') final = event
  }
  const costUsd =
    final && typeof final.total_cost_usd === 'number' ? { costUsd: final.total_cost_usd } : {}
  if (!final) {
    if (limit) return { failure: 'limit' }
    const said = `${result.stderr}\n${result.stdout}`
    return { failure: result.code !== 0 && SIGNIN.test(said) ? 'signin' : 'failed' }
  }
  if (final.is_error === true) {
    if (limit) return { failure: 'limit', ...costUsd }
    const said = `${typeof final.result === 'string' ? final.result : ''}\n${result.stderr}`
    return { failure: SIGNIN.test(said) ? 'signin' : 'failed', ...costUsd }
  }
  const verdict = final.structured_output
  if (!isVerdict(verdict)) return { failure: limit ? 'limit' : 'output', ...costUsd }
  // At the plan's limit (or past it, on extra usage): the verdict is kept and marked, and the settings' `atLimit` say
  // whether it's used (tiers.ts).
  return { verdict: verdict as Verdict, ...(limit ? { overLimit: true as const } : {}), ...costUsd }
}

/** Whether Claude Code here can draft: installed, at least CLAUDE_MIN, and taking `--json-schema`. */
export async function claudeReady(io: Io): Promise<TierFailure | null> {
  const version = await io.run('claude', ['--version'], 20_000)
  if (version.code === 127) return 'missing'
  const found = claudeVersion(version.stdout)
  if (version.code !== 0 || !found || !atLeast(found, CLAUDE_MIN)) return 'old'
  const help = await io.run('claude', ['--help'], 20_000)
  return help.code === 0 && help.stdout.includes('--json-schema') ? null : 'old'
}

/** Claude Code's `claude -p`, one call of a model on a turn. */
export function claudeCodeDrafter(io: Io): Drafter {
  return {
    id: 'claude-code',
    async call(model: string, input: DraftInput): Promise<TierCall> {
      const started = io.now()
      const cwd = runDir(io)
      try {
        await mkdir(cwd, { recursive: true, mode: 0o700 })
      } catch {
        return { model, seconds: 0, failure: 'failed' }
      }
      const result = await io.run('claude', claudeArgs(model), CALL_MS, {
        env: claudeEnv(io.env, io.home),
        stdin: turnText(input),
        cwd,
      })
      return { model, seconds: (io.now() - started) / 1000, ...readCall(result) }
    },
  }
}
