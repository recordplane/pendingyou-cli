// What Claude Code reads when a hold ends or a hook hands an answer over: a few short lines, addressed to the
// assistant, with the answer in words and the one call to make next. Long answers and messages are cut, with a
// pointer to get_request for the rest, to keep the transcript small.
//
// Since 0.14.0 it also says what to do with a question the person handed this assistant from another one (D21,
// Delegate): read it with get_request, then answer_delegated or hand_back, never "they wrote back". Since 0.20.0 an
// answer the person gave with “I’ll handle it” (guide 2.33) says to stand down instead of to act on it.

/**
 * A word for the assistant that asked (hear_answers' `notice`, guide 2.32): a helper's follow-up, a handover, or (0.28.0)
 * why its card came back from its helper to the person.
 */
export interface Notice {
  kind: 'follow_up' | 'handed_over' | 'came_back'
  from: string
}

const NOTICES: readonly unknown[] = ['follow_up', 'handed_over', 'came_back']

/** A notice, as hear_answers marks it; anything else (an older server's, or a kind this version doesn't know) isn't one. */
export function noticeOf(heard: Pick<Heard, 'notice'>): Notice | null {
  const given = heard.notice as unknown
  if (typeof given !== 'object' || given === null) return null
  const { kind, from } = given as Record<string, unknown>
  if (!NOTICES.includes(kind) || typeof from !== 'string') return null
  return { kind: kind as Notice['kind'], from }
}

/**
 * “I’ll handle it” (0.20.0, guide 2.33; one meaning in 0.31.0, guide 2.45): the person ended the card themselves.
 * `self`: they'll handle it themselves. `leave`: a to-do's Skip, they won't do it (a server since guide 2.45 sends an
 * older "Leave it" on any other card as `self`).
 */
export type Handled = 'self' | 'leave'

/** How the person handled it, as hear_answers marks it; anything else (an older server's, a newer kind) isn't one. */
export function handledOf(heard: Pick<Heard, 'handled'>): Handled | null {
  const given = heard.handled as unknown
  return given === 'self' || given === 'leave' ? given : null
}

/**
 * The words for the person's bare “I’ll handle it”, as `said` has them without a note (the domain's HANDLED_WORDS),
 * and as a server before guide 2.45 had them.
 */
const HANDLED_SAID: Record<Handled, string[]> = {
  self: ['I’ll handle it', 'I’ll do it myself'],
  leave: ['I won’t do it', 'Leave it'],
}

/**
 * What “I’ll handle it” means for the agent, in one meaning (2026-10-08), and a to-do's Skip: the domain's
 * HANDLED_MEANS and SKIPPED_MEANS, word for word.
 */
export const HANDLED_MEANS =
  'The person will handle this themselves. Close it out: take no action on it, leave things as they are (an email stays in their inbox, untouched), and don’t follow up or ask again.'
export const SKIPPED_MEANS =
  'The person won’t do this to-do. Close it out: don’t do it for them, leave things as they are, and don’t follow up or ask again.'

/**
 * The person approved a card with a draft (0.24.0): one line saying where its exact words are, and to send them as they
 * are (the domain's APPROVED_DRAFT_NOTICE).
 */
export const APPROVED_DRAFT_NOTICE =
  'The approved words are in get_request’s answer.approvedDrafts: send them exactly.'

/** Whether hear_answers marked the answer as approving a draft; anything else (an older server's) isn't. */
export const approvesDraft = (heard: Pick<Heard, 'approvedDraft'>) =>
  (heard.approvedDraft as unknown) === true

/** How a handed question travels (D21): `freely`, straight to the assistant that asked; `loop`, to the person first. */
export type DelegationMode = 'freely' | 'loop'

/** What a handed question carries (hear_answers' `delegated`): who asked, how its answer travels, the person's note. */
export interface Delegated {
  from: string
  mode: DelegationMode
  /** What the helper may do with it, in plain words (guide 2.43): said first, before the question. */
  authority?: string
  note?: string
}

/** A request as /mcp/cli/* returns it (the capability's hear_answers). */
export interface Heard {
  requestId: string
  title: string
  kind: string
  status: 'pending' | 'delegated' | 'answered' | 'resolved' | 'snoozed' | 'expired' | 'cancelled'
  turn: 'you' | 'agent'
  version: number
  ready: boolean
  said?: string
  /**
   * The person ended it with “I’ll handle it” (0.20.0, guide 2.33): `said` has it in words, with their note. The lines
   * say to stand down instead of to act.
   */
  handled?: Handled
  /**
   * They approved a card that carried a draft (0.24.0): its exact words are in get_request's `answer.approvedDrafts`,
   * and the lines say to send them as they are.
   */
  approvedDraft?: true
  /** A card with several questions (guide 2.6): each one's answer in words, in the card's order. */
  answers?: { questionId: string; title: string; said: string }[]
  /** Questions the person split out of it into cards of their own. */
  splits?: { questionId: string; requestId: string; title: string }[]
  messages: { id: string; author: string; body: string; createdAt: string }[]
  /**
   * Handed to this assistant by the person from another one (D21, Pending You with Delegate): its move (status
   * delegated, turn agent), under the name it answers with (`sessionLabel`) and in the folder of the task it went to
   * (`cwd`, when it went to one). Its `messages` stay empty: the card's thread isn't the helper's.
   */
  delegated?: Delegated
  /**
   * A word on one of its own cards that's neither an answer nor the person's (0.16.0, guide 2.32): the helper that
   * answered it followed up (`follow_up`, its words in `messages`), or the person handed this assistant's open cards to
   * another (`handed_over`). `from`: the helper. Picked up with ack_answer.
   */
  notice?: Notice
  /**
   * The person wrote on the card after it closed (0.31.1; threads TH5, "Write to Wren…"): their words are in `messages`, new for
   * the assistant until it picks them up with ack_answer (or a reply). Servers from before it never send it.
   */
  wrote?: true
  fallback?: string
  fallbackAt?: string
  sessionLabel: string
  cwd?: string
  /**
   * A handed question's: the computer it went to (its app's sign-in, as the Assistants page names it), when one is
   * named. A sign-in that only hears hears every computer's, and leaves another's (handed.ts).
   */
  machine?: string
  updatedAt: string
  changedAt: string
  pollAfterSeconds: number
}

/** How every line about a handed question starts: the Stop check knows a turn it started by these words. */
export const HANDED_PREFIX = 'Pending You: your person handed you'
/**
 * What a wake says when the assistant that asked (or the person, to both) wrote to the helper on a question handed to
 * it (0.15.0, guide 2.30's talk on the card): `Pending You: billing-webhooks replied on the question handed to you, …`.
 */
export const HANDED_REPLY = 'on the question handed to you'
/** What the helper does once it has read what was said to it on the card (guide 2.30). */
export const HANDED_TALK_TODO =
  'If you know now, answer_delegated with your answer and how you know; if you need more, reply_in_thread to “asker”; if it’s your person’s to decide, reply_in_thread with escalate true; if not, hand_back with what you checked.'
/**
 * Whether a message is a wake for a question handed to the session (the hooks' and the Stop check's): the handed
 * words, or (0.15.0) a reply on one.
 */
export function isHandedWake(text: string): boolean {
  const first = text.trimStart().split('\n')[0] ?? ''
  return (
    first.startsWith(HANDED_PREFIX) ||
    (first.startsWith('Pending You: ') && first.includes(` ${HANDED_REPLY}, `))
  )
}

/** The latest words said to the helper on the card (`messages`, from the asker or the person); null for none. */
export function latestTalk(
  heard: Pick<Heard, 'messages'>,
  from: string,
): { who: string; words: string } | null {
  const last = heard.messages?.at(-1)
  if (!last || typeof last.body !== 'string' || !last.body.trim()) return null
  return { who: last.author === 'you' ? 'your person' : from, words: last.body }
}

/** A question handed to this assistant, as hear_answers marks it; anything else (an older server's) isn't one. */
export function delegatedOf(heard: Pick<Heard, 'delegated'>): Delegated | null {
  const given = heard.delegated as unknown
  if (typeof given !== 'object' || given === null) return null
  const { from, mode, note, authority } = given as Record<string, unknown>
  if (typeof from !== 'string' || (mode !== 'freely' && mode !== 'loop')) return null
  return {
    from,
    mode,
    ...(typeof authority === 'string' && authority.trim() ? { authority } : {}),
    ...(typeof note === 'string' && note.trim() ? { note } : {}),
  }
}

/** How its answer travels, in a few words: what `freely` and `loop` mean for the helper. */
export const modeWords = (mode: DelegationMode, from: string) =>
  mode === 'freely'
    ? `answer freely: your answer goes straight to ${from}`
    : 'they’ll see your answer first'

/** What the helper does with it, after reading it with get_request. */
export const HANDED_TODO =
  'If you know, answer_delegated with your answer and how you know; if not, hand_back with what you checked.'

const MAX_ANSWER = 600
const MAX_MESSAGE = 400
const MAX_TITLE = 140
/** The helper's authority line: the longest (a to-do's) is about 340 characters. */
const MAX_AUTHORITY = 500
/** A grouped card's question and its answer, each: four of them stay well under one long answer. */
const MAX_QUESTION = 100
const MAX_QUESTION_ANSWER = 300

/** Cuts text to `max` characters on one line, and says so. */
export function clip(text: string, max: number): { text: string; cut: boolean } {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  if (chars.length <= max) return { text: flat, cut: false }
  return {
    text: `${chars
      .slice(0, max - 1)
      .join('')
      .trimEnd()}…`,
    cut: true,
  }
}

const quoted = (text: string, max: number) => {
  const { text: clipped, cut } = clip(text, max)
  return { line: `“${clipped}”`, cut }
}

/**
 * The session's name, as it asked (its session label): the card tools take it, and need it where other sessions share
 * the sign-in (guide 2.5).
 */
const named = (heard: Pick<Heard, 'sessionLabel'>) =>
  `“${clip(heard.sessionLabel, MAX_TITLE).text}”`

/** Closed for good: nothing more to wait for. */
export const isClosed = (heard: Pick<Heard, 'status'>) =>
  heard.status === 'answered' ||
  heard.status === 'resolved' ||
  heard.status === 'cancelled' ||
  heard.status === 'expired'

/** The most of the asking assistant's name a line repeats. */
const MAX_NAME = 60

/**
 * The lines for a question the person handed this assistant (D21): who asked, how its answer travels, the person's
 * note, and the calls to make. Never reply_in_thread or ack_answer: the card is the asker's.
 */
function describeHanded(heard: Heard, delegated: Delegated): string[] {
  const id = heard.requestId
  const from = clip(delegated.from, MAX_NAME).text
  const note = delegated.note ? clip(delegated.note, MAX_MESSAGE) : null
  // Woken again on it (guide 2.30): what the asker (or the person, to both) said to it since it last wrote.
  const talk = latestTalk(heard, from)
  if (talk) {
    let cut = false
    const wrote = heard.messages.map((message) => {
      const said = quoted(message.body, MAX_MESSAGE)
      cut ||= said.cut
      return `${message.author === 'you' ? 'Your person' : from}: ${said.line}`
    })
    return [
      `Pending You: ${talk.who === 'your person' ? 'your person wrote to you both' : `${from} replied`} ${HANDED_REPLY}, ${id} (${modeWords(delegated.mode, from)}).`,
      `Question: ${clip(heard.title, MAX_TITLE).text}`,
      ...wrote,
      `Call get_request (requestId ${id}, name ${named(heard)}) to read what you’ve said to each other. ${HANDED_TALK_TODO}`,
      ...(cut ? [`(Cut short: get_request ${id} has all of it.)`] : []),
    ]
  }
  return [
    `${HANDED_PREFIX} ${id}, a question from ${from} (${modeWords(delegated.mode, from)}).`,
    // What it may do with it, before the question and the asker's own words (guide 2.43).
    ...(delegated.authority ? [clip(delegated.authority, MAX_AUTHORITY).text] : []),
    `Question: ${clip(heard.title, MAX_TITLE).text}`,
    ...(note ? [`Their note: “${note.text}”`] : []),
    `Call get_request (requestId ${id}, name ${named(heard)}) to read it. ${HANDED_TODO}`,
    ...(note?.cut ? [`(Cut short: get_request ${id} has all of it.)`] : []),
  ]
}

/**
 * The lines for a word on one of its own cards (0.16.0, guide 2.32): the helper that answered it followed up, or its
 * person handed its open cards to another assistant. Nothing to answer: ack_answer picks it up.
 */
function describeNotice(heard: Heard, notice: Notice): string[] {
  const id = heard.requestId
  const from = clip(notice.from, MAX_NAME).text
  const ack = `ack_answer with requestId ${id}, name ${named(heard)} and expectedVersion ${heard.version}`
  if (notice.kind === 'handed_over')
    return [
      `Pending You: your person handed your open cards to ${from}, ${id} among them.`,
      `Stop working on them: ${from} answers them and follows up. Call ${ack} to say you’ve stopped.`,
    ]
  if (notice.kind === 'came_back') {
    // Pending You's own line says why; its closing words are said below, once.
    const why = heard.messages.at(-1)?.body.split(' Nothing to answer:')[0] ?? ''
    const said = clip(why, MAX_MESSAGE)
    return [
      `Pending You: ${id} came back from ${from} to your person.`,
      ...(said.text ? [said.text] : []),
      `Nothing to answer: call ${ack} to say you’ve read it. Your person’s answer reaches you as usual.`,
      ...(said.cut ? [`(Cut short: get_request ${id} has all of it.)`] : []),
    ]
  }
  let cut = false
  const wrote = heard.messages.map((message) => {
    const said = quoted(message.body, MAX_MESSAGE)
    cut ||= said.cut
    return said.line
  })
  return [
    `Pending You: ${from} followed up on ${id}, which it answered for your person.`,
    `Question: ${clip(heard.title, MAX_TITLE).text}`,
    ...wrote,
    `Act on it if it needs anything, then call ${ack} to mark it heard.`,
    ...(cut ? [`(Cut short: get_request ${id} has all of it.)`] : []),
  ]
}

/**
 * What to do with “I’ll handle it” (0.20.0, guide 2.33; one meaning in 0.31.0), in one line: its meaning word for word
 * (close it out, leave things as they are, don't follow up; a to-do's Skip: don't do it for them), only what their note
 * asks if it asks something, then ack_answer with an outcome, and never post it again.
 */
function standDown(heard: Heard, handled: Handled): string {
  const ack = `ack_answer with requestId ${heard.requestId}, name ${named(heard)}, expectedVersion ${heard.version}`
  const said = heard.said?.trim()
  const noted = Boolean(said && !HANDLED_SAID[handled].includes(said))
  const note = noted ? ' If their note asks you for one thing, do just that.' : ''
  return handled === 'self'
    ? `${HANDLED_MEANS}${note} Then call ${ack} and an outcome like “Left to you”. Never post it again.`
    : `${SKIPPED_MEANS}${note} Then call ${ack} and an outcome like “Skipped”. Never post it again.`
}

/** The lines for one heard request. `again` names how to keep waiting after a follow-up. */
export function describe(heard: Heard, again: string): string[] {
  const id = heard.requestId
  const delegated = delegatedOf(heard)
  if (delegated) return describeHanded(heard, delegated)
  // An answer not picked up yet says it all (its follow-ups among what they wrote); anything else, the word itself.
  const notice = noticeOf(heard)
  if (notice && heard.status !== 'answered') return describeNotice(heard, notice)
  const question = `Question: ${clip(heard.title, MAX_TITLE).text}`
  let cut = false
  const wrote = heard.messages.map((message) => {
    const { line, cut: messageCut } = quoted(message.body, MAX_MESSAGE)
    cut ||= messageCut
    return line
  })
  const lines: string[] = []
  // Their words on a card that's closed: new for it, whatever became of the card.
  if (heard.wrote && heard.status !== 'answered' && isClosed(heard)) {
    lines.push(
      `Pending You: your person wrote to you on ${id} after it closed.`,
      question,
      `They wrote: ${wrote.join(' ') || '(call get_request to read it)'}`,
      `Act on it, then call ack_answer with requestId ${id}, name ${named(heard)}, expectedVersion ${heard.version} and a one-line outcome (reply_in_thread instead if they asked you something).`,
    )
    if (cut) lines.push(`(Cut short: get_request ${id} has all of it.)`)
    return lines
  }
  switch (heard.status) {
    case 'answered': {
      // “I’ll handle it” (0.20.0; one meaning in 0.31.0), or a to-do's Skip. The agent closes it out instead of acting.
      const handled = handledOf(heard)
      if (handled) {
        const answer = clip(heard.said ?? HANDLED_SAID[handled][0] ?? '', MAX_ANSWER)
        cut ||= answer.cut
        lines.push(
          `Pending You: ${id} is answered: ${handled === 'self' ? 'your person will handle it themselves' : 'your person won’t do it'}.`,
          question,
          `Answer: ${answer.text}`,
        )
        if (wrote.length) lines.push(`They also wrote: ${wrote.join(' ')}`)
        lines.push(standDown(heard, handled))
        break
      }
      if (heard.answers?.length) {
        // One line per question, so each answer reads against its own question (and its id, as answer.answers has it).
        lines.push(
          `Pending You: ${id} is answered, all ${heard.answers.length} questions.`,
          question,
        )
        for (const [index, each] of heard.answers.entries()) {
          const asked = clip(each.title, MAX_QUESTION)
          const answer = clip(each.said, MAX_QUESTION_ANSWER)
          cut ||= asked.cut || answer.cut
          lines.push(`${index + 1}. ${asked.text} (${each.questionId}): ${answer.text}`)
        }
      } else {
        const answer = clip(heard.said ?? 'Answered', MAX_ANSWER)
        cut ||= answer.cut
        lines.push(`Pending You: ${id} is answered.`, question, `Answer: ${answer.text}`)
      }
      if (wrote.length)
        lines.push(`${noticeOf(heard) ? 'Also' : 'They also wrote'}: ${wrote.join(' ')}`)
      if (approvesDraft(heard)) lines.push(APPROVED_DRAFT_NOTICE)
      lines.push(
        `Act on it, then call ack_answer with requestId ${id}, name ${named(heard)}, expectedVersion ${heard.version} and a one-line outcome.`,
      )
      break
    }
    case 'expired':
      lines.push(
        `Pending You: nobody answered ${id} in time, so its fallback is due.`,
        question,
        ...(heard.fallback ? [`Fallback: ${clip(heard.fallback, MAX_ANSWER).text}`] : []),
        'Do it now if you haven’t already. There’s nothing to acknowledge.',
      )
      break
    case 'cancelled':
      lines.push(`Pending You: ${id} was cancelled. Nothing to do.`)
      break
    case 'resolved':
      lines.push(`Pending You: ${id} is already handled. Nothing to do.`)
      break
    default:
      if (heard.turn === 'agent') {
        lines.push(
          `Pending You: they wrote back on ${id}.`,
          question,
          `They wrote: ${wrote.join(' ') || '(a follow-up; call get_request to read it)'}`,
          `Answer with reply_in_thread (requestId ${id}, name ${named(heard)}), then ${again}.`,
        )
      } else {
        lines.push(`Pending You: ${id} is still waiting for them (${heard.status}).`, question)
      }
  }
  // Questions split out of a grouped card are cards of their own now, with answers of their own.
  if (heard.splits?.length && heard.status !== 'cancelled' && heard.status !== 'resolved')
    lines.push(
      `They split ${heard.splits
        .map((split) => `“${clip(split.title, MAX_QUESTION).text}” (${split.requestId})`)
        .join(
          ', ',
        )} out into ${heard.splits.length === 1 ? 'a card of its own' : 'cards of their own'}: hear ${heard.splits.length === 1 ? 'its answer' : 'their answers'} there.`,
    )
  if (cut) lines.push(`(Cut short: get_request ${id} has all of it.)`)
  return lines
}
