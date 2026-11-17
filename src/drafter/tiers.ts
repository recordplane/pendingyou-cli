// The drafter's tiers (the plan's decision 3, 2026-11-16: "Use the model Sonnet"; the rules set the same
// day, from the backtest's 46 unsure turns): Haiku reads every turn; at 0.7 or more its verdict stands. Below, the same
// call with Sonnet, and Sonnet's verdict decides. A turn Haiku was sure of never goes to Sonnet (on 46 such turns they
// disagreed 10 times, each right 5). When the last tier is unsure too and flags the turn, the configured `unsure` action
// says what happens: a card as any (the default: 114 caught / 22 missed / 11 wrong on all 300 for "needs the person",
// against Haiku alone's 107 / 29 / 10), no card, or a quiet one. Before any model, Claude Code's own notices are
// dropped (own-messages.ts). Every tier's call counts against the computer's limit on calls at once (SLOTS) and has its
// own 30 seconds (claude-code.ts's CALL_MS). Thresholds and the unsure action are configuration (config.ts), not logic.
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { configDir } from '../files.ts'
import type { Io } from '../io.ts'
import { appNotice } from './own-messages.ts'
import type {
  Drafter,
  DrafterConfig,
  DraftInput,
  TierCall,
  UnsureAction,
  Verdict,
} from './types.ts'
import { type Checked, check } from './validate.ts'

/** The most model calls on one computer at once, of any tier (§2 call 3). */
export const SLOTS = 2
/** A slot older than this is taken to be left by a call that died: the longest call and a margin. */
export const SLOT_STALE_MS = 60_000
/** How long a call waits for a slot before it gives up as `busy`. */
export const SLOT_WAIT_MS = 45_000

/** What becomes of a turn. */
export type Action =
  /** Claude Code's own notice, or nothing for the person: no card. */
  | 'none'
  /** It's on a card already. */
  | 'covered'
  /** Cards to post (question or step). */
  | 'cards'
  /** An answer card for the person's own question. */
  | 'answer'
  /** High stakes, words to send in their name, or something to look at: the assistant posts it itself. */
  | 'main'
  /** No tier gave a verdict. */
  | 'failed'

export interface TurnDraft {
  /** Claude Code's own notice it was, when it was one (no model ran). */
  notice?: string
  /** Each tier's call, in order. */
  calls: TierCall[]
  /** The tier whose verdict decided (an index into calls), when one did. */
  decidedBy?: number
  /** Every tier asked was below its threshold. */
  unsure: boolean
  action: Action
  /** With `unsure` and the `quiet` setting: a card that never notifies. */
  quiet: boolean
  /** Beside its cards, an answer card for the person's own question (an answer that ends on a question). */
  withAnswer?: boolean
  checked?: Checked
}

/** A kind the person must act on: a question or a step, as the turn's main kind or its second. */
const needs = (verdict: Verdict) =>
  ['question', 'step'].includes(verdict.kind) ||
  verdict.also === 'question' ||
  verdict.also === 'step'
const answers = (verdict: Verdict) => verdict.kind === 'answer' || verdict.also === 'answer'

/** Whether a verdict flags the turn: something for the person, of any kind. */
export const flags = (verdict: Verdict) => needs(verdict) || answers(verdict)

/** What the decided verdict does, before the unsure rule. */
function actionOf(checked: Checked): Action {
  const { verdict } = checked
  if (!flags(verdict)) return 'none'
  if (verdict.covered) return 'covered'
  if (verdict.stakes === 'high' || verdict.inTheirName || verdict.shows) return 'main'
  if (needs(verdict)) return checked.cards.length ? 'cards' : 'failed'
  return verdict.answerTitle ? 'answer' : 'failed'
}

/** Runs `call` in one of the computer's SLOTS, waiting up to SLOT_WAIT_MS for one; `busy` when none came free. */
export async function inSlot(
  io: Io,
  call: () => Promise<TierCall>,
  model: string,
): Promise<TierCall> {
  const folder = join(configDir(io), 'drafter', 'slots')
  await mkdir(folder, { recursive: true, mode: 0o700 }).catch(() => {})
  const until = io.now() + SLOT_WAIT_MS
  for (;;) {
    for (let index = 0; index < SLOTS; index++) {
      const path = join(folder, `${index}.lock`)
      try {
        // Empty: another call took it a moment ago and is writing its time.
        const since = (await readFile(path, 'utf8')).trim()
        if (since && !(io.now() - Number(since) <= SLOT_STALE_MS)) await rm(path, { force: true })
      } catch {}
      let file: Awaited<ReturnType<typeof open>> | null = null
      try {
        file = await open(path, 'wx', 0o600)
      } catch {
        continue
      }
      try {
        await file.writeFile(String(io.now()))
        await file.close()
        return await call()
      } finally {
        await rm(path, { force: true }).catch(() => {})
      }
    }
    if (io.now() >= until) return { model, seconds: 0, failure: 'busy' }
    await io.sleep(500)
  }
}

/**
 * One turn through the tiers: Claude Code's own notice dropped first; then each tier until one is sure, or the last;
 * its verdict checked (validate.ts) and turned into what happens. `slot` runs each call (inSlot; a test or the
 * harness's recorded run passes the call straight through).
 */
export async function draftTurn(
  input: DraftInput,
  drafter: Drafter,
  config: DrafterConfig,
  slot: (call: () => Promise<TierCall>, model: string) => Promise<TierCall> = (call) => call(),
): Promise<TurnDraft> {
  const notice = appNotice(input.final)
  if (notice) return { notice, calls: [], unsure: false, action: 'none', quiet: false }
  const calls: TierCall[] = []
  let decidedBy: number | undefined
  for (const [index, tier] of config.tiers.entries()) {
    const made = await slot(() => drafter.call(tier.model, input), tier.model)
    // At the plan's limit, a verdict is used only if the settings say to go on (decision 4).
    const stop = made.overLimit && made.verdict && config.atLimit === 'stop'
    const call: TierCall = stop
      ? {
          model: made.model,
          seconds: made.seconds,
          failure: 'limit',
          overLimit: true,
          ...(made.costUsd ? { costUsd: made.costUsd } : {}),
        }
      : made
    calls.push(call)
    if (!call.verdict) break
    decidedBy = index
    if (call.verdict.confidence >= tier.below) break
  }
  if (decidedBy === undefined) return { calls, unsure: false, action: 'failed', quiet: false }
  const decided = calls[decidedBy] as TierCall & { verdict: Verdict }
  const tier = config.tiers[decidedBy] as DrafterConfig['tiers'][number]
  // Unsure: the last tier that answered was below its threshold, and no later one answered (it failed or there's none).
  const unsure = decided.verdict.confidence < tier.below
  const checked = check(decided.verdict, input)
  let action = actionOf(checked)
  const posts = action === 'cards' || action === 'answer'
  const policy: UnsureAction = unsure && posts ? config.unsure : 'card'
  if (policy === 'none') action = 'none'
  const withAnswer =
    action === 'cards' && answers(checked.verdict) && checked.verdict.answerTitle !== ''
  return {
    calls,
    decidedBy,
    unsure,
    action,
    quiet: policy === 'quiet',
    ...(withAnswer ? { withAnswer } : {}),
    checked,
  }
}
