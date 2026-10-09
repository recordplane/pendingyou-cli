// Codex's "ask on my phone first" (0.34.0; docs/plans/2026-10-09-answer-permission-prompts.md §4, PA7): how long
// Codex's PermissionRequest hook waits for the person's Allow or Deny on a Pending You card before Codex asks in its
// terminal. A per-computer setting, 0 (off, the default) to ANSWER_WAIT_MAX minutes, kept in Codex's manifest
// (~/.config/pendingyou/codex.json, beside `permissionCards`), so uninstall clears it with the rest.
//
// What the spike of Codex 0.160.0's source found: Codex runs PermissionRequest hooks before any approval UI
// (core/src/tools/approvals.rs), so nothing is on screen while the hook waits: it's the card or the terminal, never
// both at once. A hook's timeout is its handler's `timeout` in hooks.json, 600 seconds unless it says, with no upper
// limit for PermissionRequest (hooks/src/engine/discovery.rs clamps only SessionEnd and Interrupt, to 3 seconds); at
// the timeout, or on empty output, Codex asks as usual. So the hook's timeout is the wait plus ANSWER_MARGIN_S, which
// leaves the hook time to post the card first and to withdraw it after (10 minutes: 630 seconds). Codex trusts a hook
// by a hash of its definition, timeout included: a changed wait needs trusting once more in Codex's /hooks.
//
// Leaf module: the hook reads the wait on every Codex prompt, so it imports only files.ts and hooks.ts.
import { join } from 'node:path'
import { configDir, readJson } from './files.ts'
import { HOOK_TIMEOUT } from './hooks.ts'
import type { Io } from './io.ts'

/** The longest wait, in minutes. */
export const ANSWER_WAIT_MAX = 10
/** Seconds the hook's timeout adds to the wait: to post the card before, and withdraw it after. */
export const ANSWER_MARGIN_S = 30
/**
 * How long, past the wait, the hook gives itself before it stops (main.ts's deadline): well inside ANSWER_MARGIN_S, so
 * it always ends (printing nothing, or its decision) before Codex's timeout.
 */
export const ANSWER_DEADLINE_MARGIN_MS = 20_000

/** Codex's manifest, where the wait is kept (apps/codex.ts writes the rest of it). */
export const codexManifestPath = (io: Pick<Io, 'env' | 'home'>) => join(configDir(io), 'codex.json')

/** Whether a wait is one the command takes: a whole number of minutes, 0 to ANSWER_WAIT_MAX. */
export const isAnswerWait = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= ANSWER_WAIT_MAX

/** The wait this computer has set, in minutes: 0 (off) when none is set, or Codex isn't set up. */
export async function readAnswerWait(io: Pick<Io, 'env' | 'home'>): Promise<number> {
  const manifest = await readJson<{ answerWait?: unknown }>(codexManifestPath(io)).catch(() => null)
  const wait = manifest?.answerWait
  return isAnswerWait(wait) ? wait : 0
}

/** The seconds Codex gives the PermissionRequest hook for a wait: the usual HOOK_TIMEOUT when it's off. */
export const permissionTimeout = (wait: number) =>
  wait > 0 ? wait * 60 + ANSWER_MARGIN_S : HOOK_TIMEOUT

/** "1 minute", "5 minutes". */
export const minutes = (wait: number) => `${wait} minute${wait === 1 ? '' : 's'}`
