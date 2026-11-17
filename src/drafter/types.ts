// The card drafter's shapes (docs/plans/2026-11-16-card-drafter.md §7, §10.1): what a turn hands the drafter, what a
// model answers (schema v2), and the tiers it runs. The command line's own, not any model's: each tier has its prompt
// and its command, and the checks and the posting are shared. Nothing here is wired to a hook yet (PR 2); PR 4 does that.

/** Whose message started the turn: the person's, a task notification, another agent's, or a Pending You wake. */
export type PromptKind = 'person' | 'task' | 'peer' | 'wake'

/** One end of a turn, as the drafter reads it. Words only in memory and on the model's stdin, never in arguments. */
export interface DraftInput {
  /** The message that started the turn, cut to PROMPT_CHARS. */
  prompt: string
  promptKind: PromptKind
  /** A turn a wake started: the card it was for. */
  wakeFor?: { requestId: string; title: string }
  /** The assistant's final message, cut to FINAL_CHARS. */
  final: string
  /** The titles of the cards the turn itself posted, updated or replied on. */
  turnCards: string[]
  /**
   * This session's cards still open, as Pending You lists them: enough of each to recognise a reminder of it (its
   * title, its kind, when it went up). Most turns every model gets wrong say the item is already on a card; only this
   * list settles those (the chief, 2026-11-16).
   */
  openCards: OpenCard[]
  /** This session's cards settled lately (answered or withdrawn): a reminder of one has nothing new for the person. */
  closedCards?: ClosedCard[]
}

/** One of the session's open cards, as the drafter is told of it. */
export interface OpenCard {
  requestId: string
  title: string
  /** What it asks: a question, a step, an answer card of the agent's own. */
  kind?: 'question' | 'step' | 'answer'
  /** When it went up (ISO 8601). */
  postedAt?: string
}

/** One of the session's cards settled lately. */
export interface ClosedCard {
  requestId: string
  title: string
  status: 'answered' | 'withdrawn'
}

export const PROMPT_CHARS = 1500
export const FINAL_CHARS = 6000

export type Kind = 'question' | 'step' | 'answer' | 'none'

/** One question of a grouped card. */
export interface DraftQuestion {
  id: string
  title: string
  options: { label: string }[]
  recommended: string | null
}

/** One card a model drafted: a single question or step, or a grouped card (`questions`, 2–4). */
export interface DraftCard {
  title: string
  summary: string
  options: { label: string }[]
  recommended: string | null
  questions: DraftQuestion[]
  steps: string[]
}

/** What a model answers (schema v2, prompt.ts's SCHEMA). */
export interface Verdict {
  kind: Kind
  also: Exclude<Kind, 'none'> | null
  confidence: number
  /** The item is on one of the cards listed: this turn's, or open in this session. */
  covered: boolean
  /** Money, can't be undone, or public. */
  stakes: 'normal' | 'high'
  /** It asks them to approve words to send in their name. */
  inTheirName: boolean
  /** It asks them to look at a file or a picture. */
  shows: boolean
  cards: DraftCard[]
  /** For an answer: its bottom line. */
  answerTitle: string
  /** Open cards of this session that the person's message answered. */
  settles: string[]
  /** For a turn a wake started: what the assistant did, in a line. */
  outcome: string
}

/** Why a tier gave no verdict. */
export type TierFailure =
  | 'missing'
  | 'signin'
  | 'limit'
  | 'old'
  | 'timeout'
  | 'output'
  | 'failed'
  | 'busy'

/** One tier's call: its verdict, or why there's none, and what it cost. */
export interface TierCall {
  model: string
  verdict?: Verdict
  failure?: TierFailure
  seconds: number
  costUsd?: number
  /** Claude Code said the person's plan is at its limit, or the call ran on extra usage. */
  overLimit?: true
}

/** A tier as configured: which model, and the confidence below which the next tier is asked. */
export interface TierConfig {
  model: string
  /** Below this, the next tier looks again. The last tier's is where "unsure" starts. */
  below: number
}

/** What happens to a turn that every tier was unsure of and that the last one flagged (the chief's rule 2, 2026-11-16). */
export type UnsureAction = 'card' | 'quiet' | 'none'

/** At the plan's limit: stop drafting (the verdict isn't used), or go on, on the person's extra usage (decision 4). */
export type AtLimit = 'stop' | 'go'

export interface DrafterConfig {
  tiers: TierConfig[]
  unsure: UnsureAction
  atLimit: AtLimit
}

/** The model tiers a drafter runs, in order: Claude Code's Haiku, then Sonnet when Haiku is unsure (decision 3, 2026-11-16). */
export const DEFAULT_CONFIG: DrafterConfig = {
  tiers: [
    { model: 'haiku', below: 0.7 },
    { model: 'sonnet', below: 0.7 },
  ],
  unsure: 'card',
  atLimit: 'stop',
}

/** One way to call a model once (§10.1): Claude Code's `claude -p` now; other agent CLIs once they pass (§10.3). */
export interface Drafter {
  /** 'claude-code' */
  id: string
  /** One call of `model` on the turn; never throws. */
  call(model: string, input: DraftInput, signal?: AbortSignal): Promise<TierCall>
}
