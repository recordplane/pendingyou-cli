// Answering from the plugin's popup (0.21.0; Herdr plugin 0.2; the person API plan PR 13): what each key does to the
// cards on screen and what it asks the popup to send, and what's drawn, as plain functions with no network or Herdr in
// them. The popup (herdr/popup.ts) reads the keys, sends what these ask for through the SDK with Herdr's own sign-in
// (`pendingyou app login herdr`), and draws these lines.
//
// One key per decision, for every kind of card:
// - choice: 1–9 answers with that option. multi: 1–9 choose, Enter sends (within the card's least and most).
// - approve: y approves, n declines. review: y looks good, n needs changes.
// - text: Enter writes an answer (Enter sends, Esc goes back); 1–9 sends one of its suggestions.
// - action: y (or Enter) done; n didn't work: which step (when there are several), then what happened.
// - fyi: y (or Enter) got it.
// - group: Tab and Shift-Tab go through its questions, each answered with its own kind's keys; Enter sends them all once
//   every one is answered.
// Then for any card: r writes to the assistant that asked, l puts it in Later (in an hour, tonight, tomorrow morning),
// d hands it to another assistant (then how much it may do), u undoes the last answer, Later or handing over for 5
// seconds, t goes to its agent's pane, o opens it in Pending You, a opens all your cards there, ↑↓ (or j and k) move
// and q (or Esc) closes.
//
// High stakes are never answered here: a card that spends money, can't be undone or goes public (its own flag, its
// approval's risk, or any of its questions') takes no key but o, t and moving. Pending You refuses an app's answer to one
// anyway (403 high_stakes); the popup never sends one. What a card allows this sign-in (`actions`) is Pending You's to
// say, and a key it doesn't allow says where to do it instead.
import { cleanValue } from '../herdr.ts'
import type { AnswerRequest, Assistant, Card, CardList } from '../sdk/index.ts'

/** How long an answer, Later or handing over can be undone, unless Pending You says. */
export const UNDO_MS = 5000
/** The longest answer and reply Pending You takes. */
export const ANSWER_MAX = 4000
export const REPLY_MAX = 2000
/** The most options, suggestions, steps or assistants a key can reach. */
const KEYS_MAX = 9

type QuestionAnswer = NonNullable<AnswerRequest['answers']>[string]
type Question = NonNullable<Card['questions']>[number]

/** Someone a card can be handed to: an assistant, and one of its agents when it has any. */
export interface Target {
  assistantId: string
  agentId?: string
  /** "Maple (Codex)". */
  label: string
  /** "live · pane w3:p2", "recent". */
  detail: string
}

/** What's on screen besides the list. */
export type Screen =
  | { kind: 'list' }
  | {
      kind: 'write'
      /** answer: a text card's answer; reply: words to the asker; failed: what happened at a step; question: a group's. */
      purpose: 'answer' | 'reply' | 'failed' | 'question'
      text: string
      step?: number
      questionId?: string
    }
  | { kind: 'step' }
  | { kind: 'later' }
  | { kind: 'delegate'; targets: Target[] }
  | { kind: 'mode'; target: Target }

/** The last thing sent that can be undone, while it can. */
export interface Sent {
  cardId: string
  what: 'answer' | 'later' | 'delegate'
  /** What was sent, in words: "Deploy now", "Tonight", "Maple". */
  words: string
  /** Until when it can be undone (milliseconds). */
  until: number
}

export interface QueueState {
  /** The cards waiting, in Pending You's order. */
  cards: Card[]
  counts: CardList['counts'] | null
  /** The computer the sign-in sees the cards of; null when it sees all of them. */
  machine: string | null
  selected: number
  screen: Screen
  /** A multi card's choices so far, or a group's current multi question's. */
  chosen: string[]
  /** A group card: the question on screen, and the answers so far. */
  question: number
  answers: Record<string, QuestionAnswer>
  sent: Sent | null
  /** The line under everything: what just happened, or what went wrong. */
  note: string
  /** Each card's pane in this Herdr, when it's known. */
  panes: Record<string, string>
  demo: boolean
}

export const emptyQueue = (overrides: Partial<QueueState> = {}): QueueState => ({
  cards: [],
  counts: null,
  machine: null,
  selected: 0,
  screen: { kind: 'list' },
  chosen: [],
  question: 0,
  answers: {},
  sent: null,
  note: '',
  panes: {},
  demo: false,
  ...overrides,
})

/** What a key asks the popup to do. */
export type QueueEffect =
  | { kind: 'none' }
  | { kind: 'close' }
  | { kind: 'open'; card: Card }
  | { kind: 'queue' }
  | { kind: 'focus'; card: Card }
  | { kind: 'answer'; card: Card; answer: AnswerRequest; words: string }
  | { kind: 'undo'; sent: Sent }
  | { kind: 'reply'; card: Card; body: string }
  | { kind: 'later'; card: Card; until: '1h' | 'tonight' | 'tomorrow'; words: string }
  | { kind: 'targets'; card: Card }
  | { kind: 'delegate'; card: Card; target: Target; mode: 'freely' | 'loop' }

/* ───────────────────────── Words ───────────────────────── */

/** Who asked: the agent's name with Pending You, and its app. */
export const askerOf = (card: Card) =>
  `${card.asker.agent?.name ?? card.asker.assistant.name} (${card.asker.assistant.appName})`
/** Who asked, by name alone. */
const askerName = (card: Card) => card.asker.agent?.name ?? card.asker.assistant.name

export const HIGH_STAKES =
  'High stakes: answer it in Pending You, where you hold to approve. o opens it.'
export const NOT_HERE = 'Answer this one in Pending You: o opens it.'
const NO_WORDS = 'Pending You takes no words on this card from Herdr: o opens it.'
const NO_LATER = 'This card can’t go to Later from Herdr: o opens it.'
const NO_HANDING = 'This card can’t be handed over from Herdr: o opens it.'

const LATER: { key: string; until: '1h' | 'tonight' | 'tomorrow'; words: string }[] = [
  { key: '1', until: '1h', words: 'In an hour' },
  { key: '2', until: 'tonight', words: 'Tonight' },
  { key: '3', until: 'tomorrow', words: 'Tomorrow morning' },
]

/** An option's key: 1 to 9. */
const digit = (key: string) => (/^[1-9]$/.test(key) ? Number(key) : null)

const steps = (card: Card) =>
  (card.action?.steps ?? []).map((step) => (typeof step === 'string' ? { text: step } : step))

/* ───────────────────────── Keys ───────────────────────── */

const NONE: QueueEffect = { kind: 'none' }

/** Back to the list, with a note. */
const said = (state: QueueState, note: string): [QueueState, QueueEffect] => [
  { ...state, screen: { kind: 'list' }, note },
  NONE,
]

/** A card's answers start again: another card, or this one sent. */
const fresh = (state: QueueState): QueueState => ({
  ...state,
  chosen: [],
  question: 0,
  answers: {},
  screen: { kind: 'list' },
})

/** What one key does in the popup: the state after it, and what to send or do. `now` in milliseconds. */
export function queueKey(state: QueueState, key: string, now: number): [QueueState, QueueEffect] {
  switch (state.screen.kind) {
    case 'write':
      return writeKey(state, state.screen, key)
    case 'step':
      return stepKey(state, key)
    case 'later':
      return laterKey(state, key)
    case 'delegate':
      return delegateKey(state, state.screen.targets, key)
    case 'mode':
      return modeKey(state, state.screen.target, key)
    case 'list':
      return listKey(state, key, now)
  }
}

const isBack = (key: string) => key === '\x1b' || key === '\x03'

function listKey(state: QueueState, key: string, now: number): [QueueState, QueueEffect] {
  const count = state.cards.length
  const move = (by: number): [QueueState, QueueEffect] => [
    {
      ...fresh(state),
      selected: count ? (state.selected + by + count) % count : 0,
      note: '',
    },
    NONE,
  ]
  switch (key) {
    case 'q':
    case '\x1b':
    case '\x03':
    case '\x04':
      return [state, { kind: 'close' }]
    case 'j':
    case '\x1b[B':
    case '\x1bOB':
      return move(1)
    case 'k':
    case '\x1b[A':
    case '\x1bOA':
      return move(-1)
    case 'a':
      return [state, { kind: 'queue' }]
    case 'u': {
      const sent = state.sent
      if (sent && now < sent.until) return [state, { kind: 'undo', sent }]
      return [{ ...state, note: 'Nothing to undo now.' }, NONE]
    }
  }
  const card = state.cards[state.selected]
  if (!card) return [state, NONE]
  if (key === 'o') return [state, { kind: 'open', card }]
  if (key === 't') return [state, { kind: 'focus', card }]
  // Everything else acts on the card.
  const acting = /^[1-9yn\r\nrld\t ]$/.test(key) || key === '\x1b[Z'
  if (!acting) return [state, NONE]
  if (card.highStakes) return [{ ...state, note: HIGH_STAKES }, NONE]
  if (state.sent?.cardId === card.id && now < state.sent.until)
    return [{ ...state, note: 'Sent: u undoes it for a moment more.' }, NONE]
  if (key === 'r') {
    if (!card.actions.includes('reply')) return [{ ...state, note: NO_WORDS }, NONE]
    return [{ ...state, screen: { kind: 'write', purpose: 'reply', text: '' }, note: '' }, NONE]
  }
  if (key === 'l') {
    if (!card.actions.includes('later')) return [{ ...state, note: NO_LATER }, NONE]
    return [{ ...state, screen: { kind: 'later' }, note: '' }, NONE]
  }
  if (key === 'd') {
    if (!card.actions.includes('delegate')) return [{ ...state, note: NO_HANDING }, NONE]
    return [
      { ...state, note: '' },
      { kind: 'targets', card },
    ]
  }
  if (!card.actions.includes('answer')) return [{ ...state, note: NOT_HERE }, NONE]
  return answerKey(state, card, key)
}

/** A key that answers the card on screen, by its kind. */
function answerKey(state: QueueState, card: Card, key: string): [QueueState, QueueEffect] {
  const send = (
    answer: Omit<AnswerRequest, 'version'>,
    words: string,
  ): [QueueState, QueueEffect] => [
    { ...state, note: '' },
    { kind: 'answer', card, answer: { version: card.version, ...answer }, words },
  ]
  const n = digit(key)
  switch (card.kind) {
    case 'choice': {
      const option = n ? card.options?.[n - 1] : undefined
      if (option) return send({ choiceIds: [option.id] }, option.label)
      return [
        { ...state, note: `Press 1–${Math.min(KEYS_MAX, card.options?.length ?? 0)} to choose.` },
        NONE,
      ]
    }
    case 'multi': {
      const option = n ? card.options?.[n - 1] : undefined
      if (option) return [{ ...state, chosen: toggled(state.chosen, option.id), note: '' }, NONE]
      if (key === '\r' || key === '\n') {
        const min = card.multi?.min ?? 1
        const max = card.multi?.max ?? card.options?.length ?? 0
        if (state.chosen.length < min || state.chosen.length > max)
          return [
            {
              ...state,
              note: `Choose ${min === max ? min : `${min} to ${max}`}, then press Enter.`,
            },
            NONE,
          ]
        const ids = (card.options ?? [])
          .map((each) => each.id)
          .filter((id) => state.chosen.includes(id))
        return send({ choiceIds: ids }, labels(card.options, ids))
      }
      return [state, NONE]
    }
    case 'approve':
      if (key === 'y') return send({ approved: true }, 'Approved')
      if (key === 'n') return send({ approved: false }, 'Declined')
      return [{ ...state, note: 'y approves, n declines.' }, NONE]
    case 'review':
      if (key === 'y') return send({ approved: true }, 'Looks good')
      if (key === 'n') return send({ approved: false }, 'Needs changes')
      return [{ ...state, note: 'y: it looks good; n: it needs changes.' }, NONE]
    case 'text': {
      const suggestion = n ? card.text?.suggestions?.[n - 1] : undefined
      if (suggestion) return send({ text: suggestion }, suggestion)
      if (key === '\r' || key === '\n')
        return [
          { ...state, screen: { kind: 'write', purpose: 'answer', text: '' }, note: '' },
          NONE,
        ]
      return [{ ...state, note: 'Enter writes your answer.' }, NONE]
    }
    case 'action': {
      if (key === 'y' || key === '\r' || key === '\n') return send({}, 'Done')
      if (key === 'n') {
        const count = steps(card).length
        if (count > 1) return [{ ...state, screen: { kind: 'step' }, note: '' }, NONE]
        return [
          { ...state, screen: { kind: 'write', purpose: 'failed', text: '', step: 1 }, note: '' },
          NONE,
        ]
      }
      return [{ ...state, note: 'y: done; n: it didn’t work.' }, NONE]
    }
    case 'fyi':
      if (key === 'y' || key === '\r' || key === '\n') return send({}, 'Got it')
      return [{ ...state, note: 'y: got it.' }, NONE]
    case 'group':
      return groupKey(state, card, key, send)
  }
}

const toggled = (chosen: readonly string[], id: string) =>
  chosen.includes(id) ? chosen.filter((each) => each !== id) : [...chosen, id]

const labels = (options: Card['options'], ids: readonly string[]) =>
  (options ?? [])
    .filter((option) => ids.includes(option.id))
    .map((option) => option.label)
    .join(', ')

/** A grouped card: each question by its own kind's keys, Tab between them, Enter sends once all are answered. */
function groupKey(
  state: QueueState,
  card: Card,
  key: string,
  send: (answer: Omit<AnswerRequest, 'version'>, words: string) => [QueueState, QueueEffect],
): [QueueState, QueueEffect] {
  const questions = card.questions ?? []
  const question = questions[state.question]
  if (!question) return [state, NONE]
  const go = (to: number): QueueState => ({
    ...state,
    question: (to + questions.length) % questions.length,
    chosen: [],
    note: '',
  })
  /** Records this question's answer, and goes on to the next one not answered yet. */
  const answered = (answer: QuestionAnswer): [QueueState, QueueEffect] => {
    const answers = { ...state.answers, [question.id]: answer }
    const next = questions.findIndex((each, index) => index > state.question && !answers[each.id])
    const first = questions.findIndex((each) => !answers[each.id])
    const to = next >= 0 ? next : first >= 0 ? first : state.question
    return [{ ...go(to), answers }, NONE]
  }
  if (key === '\t') return [go(state.question + 1), NONE]
  if (key === '\x1b[Z') return [go(state.question - 1), NONE]
  const n = digit(key)
  if (key === '\r' || key === '\n') {
    // A multi question takes its choices with Enter first.
    if (question.kind === 'multi' && state.chosen.length && !state.answers[question.id])
      return answered({ choiceIds: state.chosen })
    const left = questions.filter((each) => !state.answers[each.id])
    if (left.length === 0)
      return send(
        { answers: state.answers },
        `${questions.length} answer${questions.length === 1 ? '' : 's'}`,
      )
    if (question.kind === 'text' && !state.answers[question.id])
      return [
        {
          ...state,
          screen: { kind: 'write', purpose: 'question', text: '', questionId: question.id },
          note: '',
        },
        NONE,
      ]
    return [
      {
        ...state,
        note: `Answer every question first: ${left.length} to go. Tab goes to the next.`,
      },
      NONE,
    ]
  }
  switch (question.kind) {
    case 'choice': {
      const option = n ? question.options?.[n - 1] : undefined
      return option ? answered({ choiceIds: [option.id] }) : [state, NONE]
    }
    case 'multi': {
      const option = n ? question.options?.[n - 1] : undefined
      if (!option) return [state, NONE]
      const { [question.id]: _gone, ...others } = state.answers
      return [
        { ...state, answers: others, chosen: toggled(state.chosen, option.id), note: '' },
        NONE,
      ]
    }
    case 'approve':
      if (key === 'y') return answered({ approved: true })
      if (key === 'n') return answered({ approved: false })
      return [state, NONE]
    case 'text': {
      const suggestion = n ? question.text?.suggestions?.[n - 1] : undefined
      return suggestion ? answered({ text: suggestion }) : [state, NONE]
    }
  }
}

/** Typing: printable characters add, Backspace takes one off, Enter sends, Esc goes back. */
function writeKey(
  state: QueueState,
  screen: Extract<Screen, { kind: 'write' }>,
  key: string,
): [QueueState, QueueEffect] {
  const card = state.cards[state.selected]
  if (!card) return [{ ...state, screen: { kind: 'list' } }, NONE]
  if (isBack(key)) return said(state, '')
  if (key === '\x7f' || key === '\b')
    return [{ ...state, screen: { ...screen, text: [...screen.text].slice(0, -1).join('') } }, NONE]
  if (key === '\r' || key === '\n') {
    const text = screen.text.trim()
    if (!text) return [{ ...state, note: 'Write something first, or Esc to go back.' }, NONE]
    switch (screen.purpose) {
      case 'reply':
        return [
          { ...state, screen: { kind: 'list' }, note: '' },
          { kind: 'reply', card, body: text },
        ]
      case 'answer':
        return [
          { ...state, screen: { kind: 'list' }, note: '' },
          { kind: 'answer', card, answer: { version: card.version, text }, words: text },
        ]
      case 'failed':
        return [
          { ...state, screen: { kind: 'list' }, note: '' },
          {
            kind: 'answer',
            card,
            answer: { version: card.version, failedStep: screen.step ?? 1, text },
            words: `Step ${screen.step ?? 1} didn’t work`,
          },
        ]
      case 'question': {
        const answers = { ...state.answers, [screen.questionId ?? '']: { text } }
        const questions = card.questions ?? []
        const next = questions.findIndex((each) => !answers[each.id])
        return [
          {
            ...state,
            answers,
            screen: { kind: 'list' },
            question: next >= 0 ? next : state.question,
            note: '',
          },
          NONE,
        ]
      }
    }
  }
  // Anything printable, as it was typed (a paste comes a character at a time).
  if ([...key].some((char) => /[\p{Cc}\p{Cf}]/u.test(char))) return [state, NONE]
  const max = screen.purpose === 'reply' ? REPLY_MAX : ANSWER_MAX
  const text = [...`${screen.text}${key}`].slice(0, max).join('')
  return [{ ...state, screen: { ...screen, text }, note: '' }, NONE]
}

function stepKey(state: QueueState, key: string): [QueueState, QueueEffect] {
  const card = state.cards[state.selected]
  if (!card || isBack(key)) return said(state, '')
  const n = digit(key)
  if (!n || n > steps(card).length) return [state, NONE]
  return [{ ...state, screen: { kind: 'write', purpose: 'failed', text: '', step: n } }, NONE]
}

function laterKey(state: QueueState, key: string): [QueueState, QueueEffect] {
  const card = state.cards[state.selected]
  if (!card || isBack(key)) return said(state, '')
  const choice = LATER.find((each) => each.key === key)
  if (!choice) return [state, NONE]
  return [
    { ...state, screen: { kind: 'list' }, note: '' },
    { kind: 'later', card, until: choice.until, words: choice.words },
  ]
}

function delegateKey(
  state: QueueState,
  targets: readonly Target[],
  key: string,
): [QueueState, QueueEffect] {
  if (isBack(key)) return said(state, '')
  const n = digit(key)
  const target = n ? targets[n - 1] : undefined
  if (!target) return [state, NONE]
  return [{ ...state, screen: { kind: 'mode', target } }, NONE]
}

function modeKey(state: QueueState, target: Target, key: string): [QueueState, QueueEffect] {
  const card = state.cards[state.selected]
  if (!card || isBack(key)) return said(state, '')
  const mode = key === '1' ? 'freely' : key === '2' ? 'loop' : null
  if (!mode) return [state, NONE]
  return [
    { ...state, screen: { kind: 'list' }, note: '' },
    { kind: 'delegate', card, target, mode },
  ]
}

/** Who a card can be handed to: the assistants in reach and their agents, live first, never the one that asked. */
export function targetsFor(card: Card, assistants: readonly Assistant[]): Target[] {
  const targets: Target[] = []
  for (const assistant of assistants) {
    if (assistant.app === 'webhook') continue
    const where = assistant.machine ? [`on ${assistant.machine.name}`] : []
    if (assistant.agents.length === 0) {
      if (assistant.id === card.asker.assistant.id) continue
      targets.push({
        assistantId: assistant.id,
        label: `${assistant.name} (${assistant.appName})`,
        detail: [...where].join(' · ') || 'in the cloud',
      })
      continue
    }
    for (const agent of assistant.agents) {
      if (agent.id === card.asker.agent?.id || agent.state === 'quiet') continue
      const pane = agent.liveSessions.map((session) => session.terminal?.paneId).find(Boolean)
      targets.push({
        assistantId: assistant.id,
        agentId: agent.id,
        label: `${agent.name} (${assistant.appName})`,
        detail: [agent.state, ...where, ...(pane ? [`pane ${pane}`] : [])].join(' · '),
      })
    }
  }
  // Live agents first, as Pending You's own list has them, then in its order.
  const live = (target: Target) => (target.detail.startsWith('live') ? 0 : 1)
  return targets
    .map((target, index) => ({ target, index }))
    .sort((a, b) => live(a.target) - live(b.target) || a.index - b.index)
    .map((each) => each.target)
    .slice(0, KEYS_MAX)
}

/* ───────────────────────── Results ───────────────────────── */

/** After an answer, Later or handing over went through: the card is sent, and can be undone until `until`. */
export function sentState(
  state: QueueState,
  sent: Omit<Sent, 'until'> & { until?: string | number },
  now: number,
): QueueState {
  const until =
    typeof sent.until === 'string'
      ? Date.parse(sent.until) || now + UNDO_MS
      : (sent.until ?? now + UNDO_MS)
  return {
    ...fresh(state),
    sent: { cardId: sent.cardId, what: sent.what, words: sent.words, until },
    note: '',
  }
}

/* ───────────────────────── Drawing ───────────────────────── */

/** Words wrapped to `width`, at most `lines` lines, the last ending in "…" when there was more. */
export function wrap(text: string, width: number, lines: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of cleanValue(text, 100_000).split(' ').filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if ([...next].length <= width) line = next
    else {
      if (line) out.push(line)
      line = [...word].length > width ? cleanValue(word, width) : word
    }
  }
  if (line) out.push(line)
  if (out.length <= lines) return out
  const kept = out.slice(0, lines)
  const last = [...(kept[lines - 1] ?? '')]
  kept[lines - 1] = `${last
    .slice(0, Math.max(0, width - 1))
    .join('')
    .trimEnd()}…`
  return kept
}

/** When something is, from now: "in 25 min", "in 3 h", "in 2 days"; "now" once it's past. */
export function fromNow(at: string, now: number): string {
  const ms = Date.parse(at) - now
  if (!Number.isFinite(ms) || ms <= 0) return 'now'
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `in ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `in ${hours} h`
  return `in ${Math.round(hours / 24)} days`
}

/** A card's tag on its line: high stakes, sent, their turn, blocking, else its urgency. */
function tagOf(card: Card, state: QueueState, now: number): string {
  if (state.sent?.cardId === card.id && now < state.sent.until) return 'sent'
  if (card.highStakes) return 'high stakes'
  if (card.turn === 'agent') return 'their turn'
  return card.blocking ? 'blocking' : card.urgency
}

const BOLD = (text: string) => `\x1b[1m${text}\x1b[0m`
const DIM = (text: string) => `\x1b[2m${text}\x1b[0m`
const INVERSE = (text: string) => `\x1b[7m${text}\x1b[0m`

/** The heading: how many wait, whose, and how many elsewhere. */
export function headingOf(state: QueueState): string {
  const waiting = state.counts?.pending ?? state.cards.length
  const from = state.machine ? ` from ${state.machine}` : ''
  const elsewhere = state.counts?.elsewhere ? ` · ${state.counts.elsewhere} elsewhere` : ''
  const body = waiting ? `${waiting} waiting on you${from}` : `nothing waiting on you${from}`
  return `Pending You · ${body}${elsewhere}${state.demo ? ' (demo)' : ''}`
}

/** The lines that say what a card asks, and the keys that answer it. */
function askLines(card: Card, state: QueueState, room: number, now: number): string[] {
  const fit = (text: string) => cleanValue(text, room)
  const lines: string[] = []
  const options = (
    list: Card['options'],
    recommended: readonly string[] = [],
    chosen?: readonly string[],
  ) =>
    (list ?? []).slice(0, KEYS_MAX).map((option, index) => {
      const box = chosen ? (chosen.includes(option.id) ? '[x] ' : '[ ] ') : ''
      const star = recommended.includes(option.id) ? '★ ' : ''
      return fit(
        `${box}${index + 1} ${star}${option.label}${option.detail ? ` · ${option.detail}` : ''}`,
      )
    })
  const more = (list: readonly unknown[] | undefined) =>
    (list?.length ?? 0) > KEYS_MAX
      ? [fit(`… and ${(list?.length ?? 0) - KEYS_MAX} more: o opens the card`)]
      : []
  switch (card.kind) {
    case 'choice':
      lines.push(...options(card.options, card.recommendedIds), ...more(card.options))
      break
    case 'multi':
      lines.push(...options(card.options, card.recommendedIds, state.chosen), ...more(card.options))
      break
    case 'approve':
      if (card.approve) {
        lines.push(fit(card.approve.action))
        if (card.approve.command) lines.push(fit(`$ ${card.approve.command}`))
      }
      break
    case 'review':
      break
    case 'text':
      if (card.text?.placeholder) lines.push(DIM(fit(card.text.placeholder)))
      for (const [index, suggestion] of (card.text?.suggestions ?? []).slice(0, KEYS_MAX).entries())
        lines.push(fit(`${index + 1} ${suggestion}`))
      break
    case 'action':
      for (const [index, step] of steps(card).entries()) {
        lines.push(fit(`${index + 1}. ${step.text}`))
        if (step.command) lines.push(fit(`   $ ${step.command}`))
      }
      if (card.action?.command) lines.push(fit(`$ ${card.action.command}`))
      if (card.action?.where) lines.push(DIM(fit(`Where: ${card.action.where}`)))
      break
    case 'fyi':
      break
    case 'group': {
      const questions = card.questions ?? []
      for (const [index, question] of questions.entries()) {
        const answer = state.answers[question.id]
        const mark = index === state.question ? '▸' : answer ? '✓' : '·'
        lines.push(
          fit(
            `${mark} ${index + 1}/${questions.length} ${question.title}${answer ? ` · ${answerWords(question, answer)}` : ''}`,
          ),
        )
      }
      const question = questions[state.question]
      if (question && !card.highStakes) {
        if (question.kind === 'choice')
          lines.push(
            ...options(question.options, question.recommendedIds).map((line) => `  ${line}`),
          )
        if (question.kind === 'multi')
          lines.push(
            ...options(
              question.options,
              question.recommendedIds,
              state.answers[question.id]?.choiceIds ?? state.chosen,
            ).map((line) => `  ${line}`),
          )
        if (question.kind === 'approve' && question.approve)
          lines.push(fit(`  ${question.approve.action}`))
        if (question.kind === 'text')
          for (const [index, suggestion] of (question.text?.suggestions ?? [])
            .slice(0, KEYS_MAX)
            .entries())
            lines.push(fit(`  ${index + 1} ${suggestion}`))
      }
      break
    }
  }
  if (card.fallback)
    lines.push(
      DIM(fit(`If you don’t answer ${fromNow(card.fallback.at, now)}: ${card.fallback.text}`)),
    )
  if (card.highStakes) lines.push(...wrap(HIGH_STAKES, room, 2))
  else if (!card.actions.includes('answer')) lines.push(...wrap(NOT_HERE, room, 2))
  return lines
}

/** A group question's answer, in words. */
function answerWords(question: Question, answer: QuestionAnswer): string {
  if (answer.text) return answer.text
  if (answer.approved !== undefined) return answer.approved ? 'Approved' : 'Declined'
  return labels(question.options, answer.choiceIds ?? [])
}

/** The keys that answer this card, first in the key line. */
function answerKeys(card: Card, state: QueueState): string[] {
  const count = (list: readonly unknown[] | undefined) => Math.min(KEYS_MAX, list?.length ?? 0)
  switch (card.kind) {
    case 'choice':
      return [`1–${count(card.options)} answer`]
    case 'multi':
      return [`1–${count(card.options)} choose`, 'Enter send']
    case 'approve':
      return ['y approve', 'n decline']
    case 'review':
      return ['y looks good', 'n needs changes']
    case 'text':
      return card.text?.suggestions?.length
        ? ['Enter write', `1–${count(card.text.suggestions)} send a suggestion`]
        : ['Enter write']
    case 'action':
      return ['y done', 'n didn’t work']
    case 'fyi':
      return ['y got it']
    case 'group': {
      const question = card.questions?.[state.question]
      const own =
        question?.kind === 'approve'
          ? ['y/n']
          : question?.kind === 'text'
            ? ['Enter write']
            : [`1–${count(question?.options)}`]
      return [...own, 'Tab next question', 'Enter send all']
    }
  }
}

/** The line of keys for what's on screen. */
export function keysLine(state: QueueState, now: number): string {
  const screen = state.screen
  const card = state.cards[state.selected]
  switch (screen.kind) {
    case 'write':
      return 'Enter send · Esc back'
    case 'step':
      return `Which step didn’t work? 1–${card ? steps(card).length : 1} · Esc back`
    case 'later':
      return `Later: ${LATER.map((each) => `${each.key} ${each.words.toLowerCase()}`).join(' · ')} · Esc back`
    case 'delegate':
      return screen.targets.length
        ? `1–${screen.targets.length} hand it to them · Esc back`
        : 'Esc back'
    case 'mode':
      return card
        ? `1 they answer ${askerName(card)} directly · 2 they answer you first · Esc back`
        : 'Esc back'
    case 'list':
      break
  }
  const keys: string[] = []
  if (state.sent && now < state.sent.until) keys.push('u undo')
  if (card) {
    const busy = state.sent?.cardId === card.id && now < state.sent.until
    if (!card.highStakes && !busy) {
      if (card.actions.includes('answer')) keys.push(...answerKeys(card, state))
      if (card.actions.includes('reply')) keys.push('r reply')
      if (card.actions.includes('later')) keys.push('l later')
      if (card.actions.includes('delegate')) keys.push('d hand over')
    }
    keys.push('t its pane', 'o open in Pending You')
  }
  keys.push('a all your cards', '↑↓ choose', 'q close')
  return keys.join(' · ')
}

/** What the last thing sent says while it can be undone. */
export function sentLine(state: QueueState, now: number): string | null {
  const sent = state.sent
  if (!sent || now >= sent.until) return null
  const seconds = Math.max(1, Math.ceil((sent.until - now) / 1000))
  const undo = `u to undo (${seconds} s)`
  switch (sent.what) {
    case 'answer':
      return `Sent: ${sent.words} · ${undo}`
    case 'later':
      return `In Later: ${sent.words.toLowerCase()} · ${undo}`
    case 'delegate':
      return `Handed to ${sent.words} · ${undo}`
  }
}

/** The popup's lines for a terminal `width` wide and `height` high: a heading, the cards, the one chosen open, the keys. */
export function queueLines(
  state: QueueState,
  width: number,
  height: number,
  now: number,
): string[] {
  const room = Math.max(30, width - 2)
  const fit = (text: string, max = room) => cleanValue(text, max)
  const head = [BOLD(fit(headingOf(state))), '']
  const foot: string[] = ['']
  const screen = state.screen
  const card = state.cards[state.selected]
  if (screen.kind === 'write' && card) {
    const label =
      screen.purpose === 'reply'
        ? `To ${askerName(card)}: `
        : screen.purpose === 'failed'
          ? `What happened at step ${screen.step ?? 1}? `
          : screen.purpose === 'question'
            ? 'Your answer: '
            : 'Your answer: '
    // The end of what's typed, so the cursor's always in sight.
    const typed = [...screen.text]
    const shown = typed.slice(Math.max(0, typed.length - (room - label.length - 1))).join('')
    foot.push(`${label}${shown}▏`)
  }
  if (screen.kind === 'delegate')
    foot.push(
      ...(screen.targets.length
        ? screen.targets.map((target, index) =>
            fit(`${index + 1} ${target.label} · ${target.detail}`),
          )
        : [fit('No other assistant of yours to hand it to.')]),
    )
  if (screen.kind === 'mode')
    foot.push(fit(`Hand it to ${screen.target.label}: how much should they do?`))
  for (const line of wrap(keysLine(state, now), room, 3)) foot.push(DIM(line))
  const status = sentLine(state, now) ?? state.note
  // A link the popup just gave (a terminal hyperlink) goes as it is: wrapping would take its escapes out.
  if (status) foot.push('', ...(status.includes('\x1b') ? [status] : wrap(status, room, 3)))

  if (state.cards.length === 0) {
    const body = [
      fit(
        state.machine
          ? `Nothing from ${state.machine}’s agents is waiting on you.`
          : 'Nothing is waiting on you.',
      ),
      ...(state.counts?.elsewhere ? [fit('Your other cards are in Pending You: a opens it.')] : []),
    ]
    return [...head, ...body, ...foot]
  }

  // The chosen card open; the others a line each, as many as fit around it.
  const blocks = state.cards.map((each, index) => {
    const chosen = index === state.selected
    const tag = tagOf(each, state, now)
    const title = fit(each.title, Math.max(10, room - tag.length - 3))
    const gap = ' '.repeat(Math.max(1, room - 2 - [...title].length - tag.length))
    const first = `${chosen ? '▸ ' : '  '}${title}${gap}${tag}`
    if (!chosen) return [first]
    const pane = state.panes[each.id]
    const where = [
      askerOf(each),
      each.area.name,
      ...(each.asker.machine && each.asker.machine.name !== state.machine
        ? [each.asker.machine.name]
        : []),
      ...(pane ? [`pane ${pane}`] : []),
    ].join(' · ')
    const inner = room - 4
    return [
      INVERSE(first),
      `    ${DIM(fit(where, inner))}`,
      ...wrap(each.summary, inner, 3).map((line) => `    ${line}`),
      ...askLines(each, state, inner, now).map((line) => `    ${line}`),
    ]
  })
  // Two lines kept for "↑ 3 more" and "↓ 2 more".
  const space = Math.max(4, height - head.length - foot.length - 2)
  let from = state.selected
  let to = state.selected + 1
  let used = blocks[state.selected]?.length ?? 0
  for (let grew = true; grew; ) {
    grew = false
    if (to < blocks.length && used < space) {
      to++
      used++
      grew = true
    }
    if (from > 0 && used < space) {
      from--
      used++
      grew = true
    }
  }
  const list = blocks.slice(from, to).flat()
  if (from > 0) list.unshift(DIM(fit(`  ↑ ${from} more`)))
  if (to < blocks.length) list.push(DIM(fit(`  ↓ ${blocks.length - to} more`)))
  return [...head, ...list, ...foot]
}
