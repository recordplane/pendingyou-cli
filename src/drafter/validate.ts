// The drafter's checks (docs/plans/2026-11-16-card-drafter.md §7.2): deterministic, before anything posts. A model may
// shorten and title what the message says; it may not add to it. So an option, a recommendation, a step or a link that
// isn't the message's own is dropped rather than posted, and every drop is named, for the eval's hard rules. The links
// a card carries and the words under its title come from the message itself, never from a model.
import { BLANK, isSecretName, looksLikeToken, redactTokens } from '../redact.ts'
import { cutTo } from './prompt.ts'
import type { DraftCard, DraftInput, DraftQuestion, Verdict } from './types.ts'

/** What the checks found wrong in a draft: each a hard rule a drafter must never break (§7.4). */
export type Broken =
  | 'option'
  | 'recommended'
  | 'step'
  | 'url'
  | 'settles'
  | 'grouped'
  | 'answer-from-agent'

/** A card as it may post: checked, with the message's own links. */
export interface CheckedCard {
  title: string
  summary: string
  options: { label: string }[]
  recommended: string | null
  questions: DraftQuestion[]
  steps: string[]
}

export interface Checked {
  verdict: Verdict
  cards: CheckedCard[]
  /** Drafted cards dropped because they say what a card already up says (this turn's, or open in the session). */
  duplicates: number
  /** Every link in the final message, in order, once each, with any credentials in it masked. */
  links: string[]
  broken: Broken[]
}

const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'your',
  'you',
  'are',
  'was',
  'its',
  'it’s',
  "it's",
  'not',
  'but',
  'now',
  'then',
])

/** The message's words, lower case, for matching an option or a step against it. */
const plain = (text: string) =>
  text
    .toLowerCase()
    .replace(/[“”"‘’'`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

const words = (text: string) =>
  plain(text)
    .split(/[^\p{L}\p{N}#./-]+/u)
    .map((word) => word.replace(/^[./-]+|[./-]+$/g, ''))
    .filter((word) => word.length >= 3 && !STOP.has(word))

/** Whether a label is the message's own: most of its words are in it (at least 80%, and all of a one- or two-word one). */
export function grounded(label: string, message: string): boolean {
  const said = new Set(words(message))
  const own = words(label)
  if (own.length === 0) return plain(message).includes(plain(label)) && plain(label) !== ''
  const found = own.filter((word) => said.has(word)).length
  return own.length <= 2 ? found === own.length : found / own.length >= 0.8
}

/**
 * Whether two card titles ask the same thing: most of the shorter one's words are in the other (70%), with at least
 * three words to go on. "Merge PR #478 now?" and "Ship PR #478 (Herdr y/n), or change something?" share too little;
 * a reminder titled from the same message shares nearly all.
 */
export function sameAsk(a: string, b: string): boolean {
  const left = new Set(words(a))
  const right = new Set(words(b))
  const [short, long] = left.size <= right.size ? [left, right] : [right, left]
  if (short.size < 3) return [...short].every((word) => long.has(word)) && short.size === long.size
  const shared = [...short].filter((word) => long.has(word)).length
  return shared / short.size >= 0.7
}

/** Words a message recommends with. */
const RECOMMENDS =
  /\b(?:i(?:'|’)d|i would|i(?:'|’)m leaning|i lean|i recommend|recommend(?:ed|ation)?|suggest(?:ed|ion)?|my (?:pick|vote|choice)|i prefer|go with|best bet)\b/i

/** A step is the message's own when it appears in it word for word (case, spacing and Markdown aside). */
export const stepIn = (step: string, message: string) =>
  plain(step).length > 0 && plain(message).includes(plain(step))

const URL = /\bhttps?:\/\/[^\s<>()\]"'`]+/g

/**
 * A link as a card may carry it: as written, but with no user name or password, and with the value of any query
 * parameter that is named like a secret or looks like a token masked. Unlike a permission card's commands (redact.ts's
 * redactUrls), its other parameters and its fragment stay: they're what makes the link go where the message meant.
 */
export function safeLink(url: string): string | null {
  let parsed: globalThis.URL
  try {
    parsed = new globalThis.URL(url)
  } catch {
    return null
  }
  parsed.username = ''
  parsed.password = ''
  for (const [name, value] of [...parsed.searchParams])
    if (isSecretName(name) || looksLikeToken(value)) parsed.searchParams.set(name, BLANK)
  return parsed.toString()
}

/** Every link in the message, in order, once each, with its trailing punctuation off and credentials masked. */
export function linksOf(message: string): string[] {
  const found: string[] = []
  for (const match of message.matchAll(URL)) {
    const url = safeLink(match[0].replace(/[.,;:!?]+$/, ''))
    if (url && !found.includes(url)) found.push(url)
  }
  return found
}

/** The words with any link not in the message taken out. */
function onlyTheirLinks(text: string, message: string, broken: Set<Broken>): string {
  return text.replace(URL, (url) => {
    if (message.includes(url.replace(/[.,;:!?]+$/, ''))) return url
    broken.add('url')
    return ''
  })
}

/** A card's words as they may show: redacted, cut to fit, with no link the message lacks. */
const tidy = (text: string, max: number, message: string, broken: Set<Broken>) =>
  cutTo(
    redactTokens(onlyTheirLinks(text, message, broken))
      .replace(/\s+/g, ' ')
      .trim(),
    max,
  )

function checkOptions(
  options: { label: string }[],
  recommended: string | null,
  message: string,
  broken: Set<Broken>,
): { options: { label: string }[]; recommended: string | null } {
  const kept = options.filter((option) => {
    if (grounded(option.label, message)) return true
    broken.add('option')
    return false
  })
  const enough = kept.length >= 2 ? kept : []
  let pick =
    recommended && enough.some((option) => option.label === recommended) ? recommended : null
  if (recommended && !pick) broken.add('recommended')
  if (pick && !RECOMMENDS.test(message)) {
    broken.add('recommended')
    pick = null
  }
  return {
    options: enough.map((option) => ({ label: cutTo(option.label, 80) })),
    recommended: pick,
  }
}

function checkCard(card: DraftCard, message: string, broken: Set<Broken>): CheckedCard[] {
  const steps = card.steps.filter((step) => {
    if (stepIn(step, message)) return true
    broken.add('step')
    return false
  })
  const base = {
    title: tidy(card.title, 90, message, broken),
    summary: tidy(card.summary, 400, message, broken),
    steps,
  }
  const questions = card.questions
    .map((question) => ({
      id: question.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'q',
      title: tidy(question.title, 140, message, broken),
      ...checkOptions(question.options, question.recommended, message, broken),
    }))
    .filter((question) => question.title)
  // A grouped card holds 2 to 4 questions; one left is a card of its own, more are a mistake.
  if (card.questions.length === 1 || card.questions.length > 4) broken.add('grouped')
  if (questions.length >= 2 && questions.length <= 4)
    return [{ ...base, options: [], recommended: null, questions }]
  if (questions.length === 1) {
    const [only] = questions as [DraftQuestion]
    return [
      {
        ...base,
        title: only.title || base.title,
        options: only.options,
        recommended: only.recommended,
        questions: [],
      },
    ]
  }
  return [
    { ...base, ...checkOptions(card.options, card.recommended, message, broken), questions: [] },
  ]
}

/** The verdict with its cards checked against the turn, and what broke a rule. */
export function check(verdict: Verdict, input: DraftInput): Checked {
  const message = input.final
  const broken = new Set<Broken>()
  const open = new Set(input.openCards.map((card) => card.requestId))
  const settles = verdict.settles.filter((id) => {
    if (open.has(id)) return true
    broken.add('settles')
    return false
  })
  // An answer is to the person's own question: only when they started the turn.
  let kind = verdict.kind
  let also = verdict.also
  if (input.promptKind !== 'person') {
    if (kind === 'answer') {
      broken.add('answer-from-agent')
      kind = also ?? 'none'
      also = null
    } else if (also === 'answer') {
      broken.add('answer-from-agent')
      also = null
    }
  }
  // Cards for a question or a step, as the main kind or the second (an answer that ends on a question).
  const asks = [kind, also].some((each) => each === 'question' || each === 'step')
  const cards =
    !asks || verdict.covered
      ? []
      : verdict.cards.flatMap((card) => checkCard(card, message, broken)).slice(0, 3)
  // A draft that says what a card already up says is a reminder of it, whatever the model thought: dropped.
  const up = [...input.turnCards, ...input.openCards.map((card) => card.title)]
  const fresh = cards.filter(
    (card) => card.title && !up.some((title) => sameAsk(card.title, title)),
  )
  const duplicates = cards.filter((card) => card.title).length - fresh.length
  return {
    verdict: {
      ...verdict,
      // Every card it drafted was already up: it's covered.
      covered: verdict.covered || (duplicates > 0 && fresh.length === 0),
      kind,
      also,
      settles,
      answerTitle: tidy(verdict.answerTitle, 90, message, broken),
      outcome: tidy(verdict.outcome, 200, message, broken),
    },
    cards: fresh,
    duplicates,
    links: linksOf(message),
    broken: [...broken],
  }
}

/** Whether a value is a schema v2 verdict, so a model's answer that isn't one is a failure, never a card. */
export function isVerdict(value: unknown): value is Verdict {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const kinds = ['question', 'step', 'answer', 'none']
  const list = (item: unknown) => Array.isArray(item)
  const options = (item: unknown) =>
    list(item) &&
    (item as unknown[]).every(
      (option) =>
        typeof option === 'object' &&
        option !== null &&
        typeof (option as { label?: unknown }).label === 'string',
    )
  const pick = (item: unknown) => item === null || typeof item === 'string'
  const cardOk = (card: unknown) => {
    if (typeof card !== 'object' || card === null) return false
    const c = card as Record<string, unknown>
    return (
      typeof c.title === 'string' &&
      typeof c.summary === 'string' &&
      options(c.options) &&
      pick(c.recommended) &&
      list(c.questions) &&
      (c.questions as unknown[]).every((question) => {
        if (typeof question !== 'object' || question === null) return false
        const q = question as Record<string, unknown>
        return (
          typeof q.id === 'string' &&
          typeof q.title === 'string' &&
          options(q.options) &&
          pick(q.recommended)
        )
      }) &&
      list(c.steps) &&
      (c.steps as unknown[]).every((step) => typeof step === 'string')
    )
  }
  return (
    kinds.includes(v.kind as string) &&
    (v.also === null || (kinds.includes(v.also as string) && v.also !== 'none')) &&
    typeof v.confidence === 'number' &&
    v.confidence >= 0 &&
    v.confidence <= 1 &&
    typeof v.covered === 'boolean' &&
    (v.stakes === 'normal' || v.stakes === 'high') &&
    typeof v.inTheirName === 'boolean' &&
    typeof v.shows === 'boolean' &&
    list(v.cards) &&
    (v.cards as unknown[]).every(cardOk) &&
    typeof v.answerTitle === 'string' &&
    list(v.settles) &&
    (v.settles as unknown[]).every((id) => typeof id === 'string') &&
    typeof v.outcome === 'string'
  )
}
