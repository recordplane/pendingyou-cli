// Scoring a drafter against labelled turns (docs/plans/2026-11-16-card-drafter.md §7.4, §10.3): counts only, never a
// word of a turn. Each tier alone (on the turns it was asked) and the tiers together (what would happen), the hard
// rules a draft broke, Claude Code's own notices dropped, items already on a card dropped as duplicates, grouped cards,
// and links kept. The harness (scripts/drafter-eval.ts) runs it over the made-up set in the repo, or over the private
// 300-turn set that stays on the computer it was made on, live or from recorded answers.
import { flags, type TurnDraft } from './tiers.ts'
import type { DraftInput, Kind, Verdict } from './types.ts'
import { type Broken, linksOf } from './validate.ts'

/** A labelled turn: what it holds for the person, and what a drafter should do with it. */
export interface EvalRow {
  id: string
  input: DraftInput
  /** What the final message leaves the person (none, or any of question, step, answer). */
  labels: Kind[]
  expect?: {
    /** Claude Code's own notice: dropped before any model. */
    notice?: boolean
    /** Already on a card listed: dropped as a duplicate. */
    covered?: boolean
    /** One grouped card of this many questions. */
    questions?: number
    /** High stakes, words to send or something to look at: left to the assistant. */
    main?: boolean
  }
}

export interface Counts {
  caught: number
  missed: number
  wrong: number
}

export interface Score {
  turns: number
  needs: Counts
  answer: Counts
  /** Turns whose flags were all right. */
  right: number
  /** Turns a verdict was given for, and calls that failed, by why. */
  answered: number
  failures: Record<string, number>
  /** At or above the tier's threshold: how many, and how many of them right. */
  sure: { turns: number; right: number }
}

export interface Report {
  turns: number
  /** Each tier alone, on the turns it was asked. */
  tiers: { model: string; score: Score }[]
  /** What would happen: the verdict that decided each turn. */
  together: Score
  /** Turns every tier was unsure of. */
  unsure: number
  actions: Record<string, number>
  notices: { dropped: number; expected: number; wrong: number }
  duplicates: { dropped: number; expected: number }
  grouped: { right: number; expected: number }
  main: { left: number; expected: number }
  links: { kept: number; expected: number }
  broken: Partial<Record<Broken, number>>
  seconds: { median: number; p90: number }
  /** Every model call, and how many gave a verdict that fit the schema. */
  calls: { made: number; valid: number }
  costUsd: number
}

const needsIn = (kinds: readonly (Kind | null)[]) =>
  kinds.some((kind) => kind === 'question' || kind === 'step')
const answerIn = (kinds: readonly (Kind | null)[]) => kinds.includes('answer')

const empty = (): Counts => ({ caught: 0, missed: 0, wrong: 0 })
const tally = (counts: Counts, truth: boolean, got: boolean) => {
  if (truth && got) counts.caught++
  else if (truth) counts.missed++
  else if (got) counts.wrong++
}

const emptyScore = (): Score => ({
  turns: 0,
  needs: empty(),
  answer: empty(),
  right: 0,
  answered: 0,
  failures: {},
  sure: { turns: 0, right: 0 },
})

/** Adds one turn's verdict (or none, as nothing flagged) to a score. */
function add(score: Score, row: EvalRow, verdict: Verdict | undefined, sure: boolean) {
  score.turns++
  const truthNeeds = needsIn(row.labels)
  const truthAnswer = answerIn(row.labels)
  const kinds = verdict ? [verdict.kind, verdict.also] : []
  const gotNeeds = needsIn(kinds)
  const gotAnswer = answerIn(kinds)
  tally(score.needs, truthNeeds, gotNeeds)
  tally(score.answer, truthAnswer, gotAnswer)
  const right = truthNeeds === gotNeeds && truthAnswer === gotAnswer
  if (right) score.right++
  if (verdict) score.answered++
  if (sure) {
    score.sure.turns++
    if (right) score.sure.right++
  }
}

const percentile = (values: number[], at: number) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(at * (sorted.length - 1) + 0.5))] as number
}

/** The report for labelled turns and what the drafter made of each (`belows`: each tier's threshold, in order). */
export function report(
  rows: readonly EvalRow[],
  drafts: readonly TurnDraft[],
  tiers: readonly { model: string; below: number }[],
): Report {
  const perTier = tiers.map((tier) => ({ model: tier.model, score: emptyScore() }))
  const together = emptyScore()
  const actions: Record<string, number> = {}
  const broken: Partial<Record<Broken, number>> = {}
  const result: Report = {
    turns: rows.length,
    tiers: perTier,
    together,
    unsure: 0,
    actions,
    notices: { dropped: 0, expected: 0, wrong: 0 },
    duplicates: { dropped: 0, expected: 0 },
    grouped: { right: 0, expected: 0 },
    main: { left: 0, expected: 0 },
    links: { kept: 0, expected: 0 },
    broken,
    seconds: { median: 0, p90: 0 },
    calls: { made: 0, valid: 0 },
    costUsd: 0,
  }
  const seconds: number[] = []
  rows.forEach((row, index) => {
    const draft = drafts[index] as TurnDraft
    for (const [at, call] of draft.calls.entries()) {
      const tier = perTier[at]
      if (!tier) continue
      if (call.failure)
        tier.score.failures[call.failure] = (tier.score.failures[call.failure] ?? 0) + 1
      if (call.seconds) seconds.push(call.seconds)
      result.costUsd += call.costUsd ?? 0
      result.calls.made++
      if (call.verdict) result.calls.valid++
      if (call.verdict)
        add(tier.score, row, call.verdict, call.verdict.confidence >= (tiers[at]?.below ?? 1))
      else tier.score.turns++
    }
    // What would happen: the deciding verdict after the checks (an "answer" to an agent's message is none).
    const decided = draft.checked?.verdict
    // A turn the unsure rule leaves without a card counts as not flagged; a notice too.
    const flagged = draft.notice || draft.action === 'none' ? undefined : decided
    add(together, row, flagged && flags(flagged) ? flagged : undefined, !draft.unsure && !!decided)
    if (draft.unsure) result.unsure++
    actions[draft.action] = (actions[draft.action] ?? 0) + 1
    if (row.expect?.notice) result.notices.expected++
    if (draft.notice) {
      result.notices.dropped++
      if (!row.expect?.notice) result.notices.wrong++
    }
    if (row.expect?.covered) {
      result.duplicates.expected++
      if (draft.action === 'covered') result.duplicates.dropped++
    }
    if (row.expect?.questions) {
      result.grouped.expected++
      const cards = draft.checked?.cards ?? []
      if (cards.length === 1 && cards[0]?.questions.length === row.expect.questions)
        result.grouped.right++
    }
    if (row.expect?.main) {
      result.main.expected++
      if (draft.action === 'main') result.main.left++
    }
    const links = linksOf(row.input.final)
    if (links.length && (draft.action === 'cards' || draft.action === 'answer')) {
      result.links.expected++
      if (draft.checked && links.every((link) => draft.checked?.links.includes(link)))
        result.links.kept++
    }
    for (const rule of draft.checked?.broken ?? []) broken[rule] = (broken[rule] ?? 0) + 1
  })
  result.seconds = { median: percentile(seconds, 0.5), p90: percentile(seconds, 0.9) }
  return result
}

/**
 * The pass mark (§10.3) on a report of the private set: needs caught 75% or more with at most 10% of flags wrong;
 * answers 85% or more with at most 25% wrong; 98% of calls valid; p90 of 10 seconds or less. Returns what failed.
 */
export function passMark(
  score: Score,
  p90: number,
  calls: { made: number; valid: number },
): string[] {
  const failed: string[] = []
  const share = (part: number, whole: number) => (whole ? part / whole : 0)
  const needs = score.needs
  const answer = score.answer
  if (share(needs.caught, needs.caught + needs.missed) < 0.75) failed.push('needs caught under 75%')
  if (share(needs.wrong, needs.caught + needs.wrong) > 0.1)
    failed.push('needs flags over 10% wrong')
  if (share(answer.caught, answer.caught + answer.missed) < 0.85)
    failed.push('answers caught under 85%')
  if (share(answer.wrong, answer.caught + answer.wrong) > 0.25)
    failed.push('answer flags over 25% wrong')
  if (calls.made && share(calls.valid, calls.made) < 0.98) failed.push('under 98% of calls valid')
  if (p90 > 10) failed.push('p90 over 10 seconds')
  return failed
}

/** The backtest's v1 answer (one card, no coverage) in schema v2, so the recorded 300 can be scored as they are. */
export function fromV1(out: unknown): Verdict | undefined {
  if (typeof out !== 'object' || out === null) return undefined
  const o = out as Record<string, unknown>
  const kinds = ['question', 'step', 'answer', 'none']
  if (!kinds.includes(o.kind as string) || typeof o.confidence !== 'number') return undefined
  const kind = o.kind as Kind
  const also =
    kinds.includes(o.also as string) && o.also !== 'none' ? (o.also as Verdict['also']) : null
  const title = typeof o.title === 'string' ? o.title : ''
  const options = Array.isArray(o.options)
    ? o.options.flatMap((option) =>
        typeof option === 'object' &&
        option &&
        typeof (option as { label?: unknown }).label === 'string'
          ? [{ label: (option as { label: string }).label }]
          : [],
      )
    : []
  const card = {
    title,
    summary: typeof o.summary === 'string' ? o.summary : '',
    options,
    recommended: typeof o.recommended === 'string' ? o.recommended : null,
    questions: [],
    steps: [],
  }
  return {
    kind,
    also,
    confidence: o.confidence,
    covered: false,
    stakes: 'normal',
    inTheirName: false,
    shows: false,
    cards: (kind === 'question' || kind === 'step') && title ? [card] : [],
    answerTitle: kind === 'answer' || also === 'answer' ? title : '',
    settles: [],
    outcome: '',
  }
}
