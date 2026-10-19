// What the person asked (0.36.0, guide 2.54; docs/plans/2026-10-19-answers.md §4.5): whether the message that started a
// turn was the person's own, and whether it asked the agent something, so the Stop check can ask for the answer on a
// card too (stopcheck.ts's ANSWER_REASON). Pattern matching only, and lenient on dictation: a dictated question often
// comes with no "?", after "pending you" or "okay so", and with no sentence breaks.
//
// Code, quotes and links are left out first, and so are a leading name or filler ("Pending You", "hey Claude",
// "okay", "so"). Then a message asks when its first sentence or one of its last three has a "?", opens with a question
// word and three more words, or asks for facts ("tell me what…", "how many", "check whether"…). Not a sentence that
// asks for work: "can, could, would or will you" with a work verb ("Can you fix the flaky test?"), or one that opens
// with a work verb without asking for facts ("Deploy it to staging"); and never a message under four words with no
// "?" ("yes", "go on").
//
// Four readings of those rules keep a request for work from reading as a question, since a nudge on one is the worst
// this check can do (the plan's §1 counts them, and wants none): a work verb after a comma, "and" or "then" is work
// too ("When you're done, push it"); "do" and "have" open a question only before who's asked ("Do you know…", "Have
// we shipped…"; "Do the migration" and "Have a look" are work), and a negated opener only with its "?" ("Don't
// deploy it yet"); a question word straight before who does it opens a statement ("What we need is…"); and "tell me"
// or "let me know" asks for facts only before what they want to know ("tell me what broke", not "let me know when
// it's live").
//
// Codex's next-message hook keeps only whether it asked, never the words (codex-wake.ts's markAskedTurn).
import { isHandedWake } from './format.ts'

/**
 * Pending You's own lines, which start a turn the person didn't: a wake ("Pending You: your person answered…", "…: 2
 * of your cards need you.", any that names a card by its id), a setup line ("…: Claude Code is connected, but…"), a
 * hook's ("…: anything you need…").
 */
const PENDING_YOU_LINE =
  /^Pending You: (?:your person|nobody answered|\d+ of your cards|this computer|anything you need|[\w .’'-]{1,40} is connected|.*\(req_[A-Za-z0-9-]+)/
/** A message Claude Code wrote, not the person: a slash command, a local command's output, a background task's note. */
const TAGGED = /^<[a-z][\w-]*>/i
/** A slash command typed as it is (`/review`, `/compact`). */
const SLASH = /^\/[a-z]/i
/** What Claude Code says when the person stops it, or a hook asked it to go on: not a message of theirs. */
const NOT_THEIRS = /^(?:\[Request interrupted|Stop hook feedback)/i

/** The person's own words in a message that starts a turn, or null when the message isn't theirs. */
export function ownWords(text: string): string | null {
  const words = text.trim()
  if (!words) return null
  const first = words.split('\n')[0] ?? ''
  if (
    PENDING_YOU_LINE.test(first) ||
    isHandedWake(words) ||
    TAGGED.test(words) ||
    SLASH.test(words) ||
    NOT_THEIRS.test(words)
  )
    return null
  return words
}

/** The text without code (fenced and inline), block quotes, quoted strings and links: what the person said themselves. */
function spoken(text: string): string {
  const kept: string[] = []
  let fence: string | null = null
  for (const line of text.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (fence) {
      if (marker?.startsWith(fence)) fence = null
      continue
    }
    if (marker) {
      fence = marker
      continue
    }
    if (/^\s*>/.test(line)) continue
    kept.push(
      line
        .replace(/`[^`]*`/g, ' ')
        .replace(/“[^”]*”|"[^"]*"/g, ' ')
        .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' '),
    )
  }
  return kept.join('\n')
}

/** What a dictated message may open with before what it asks: Pending You as dictation writes it, a greeting, filler. */
const FILLER =
  /^(?:(?:pending\s*(?:you|new|view)|hey|hi|hello|yo|ok(?:ay)?|so|um+|uh+|well|alright|all right|right|oh|and|also|now|please|quick question)\b[\s,.:;!?-]*)+/i
/** An assistant's name a message may open with: "hey Claude", "Codex, …". */
const ASSISTANT = /^(?:claude|codex|opencode|pi|cursor|grok|chatgpt|gemini)\b[\s,.:;!-]*/i
/** A name said to the agent at the very start: one word and a comma ("Wren, how many …"). */
const NAMED = /^[A-Z][\p{L}’'-]*,\s+/u

/** A sentence without the name or filler it opens with. */
function opening(sentence: string): string {
  let text = sentence.trim()
  for (let tries = 0; tries < 6; tries++) {
    const next = text.replace(FILLER, '').replace(ASSISTANT, '').replace(NAMED, '').trim()
    if (next === text) break
    text = next
  }
  return text
}

/** The words of a text: runs of letters and digits, with what joins them in a word (it’s, 9:14, 1,204). */
export const wordsOf = (text: string): string[] =>
  text.match(/[\p{L}\p{N}][\p{L}\p{N}’'.,:%-]*/gu) ?? []

/** The question words a question opens with (§4.5), "isn't" and the like too. */
const QUESTION =
  /^(?:what|which|who|when|where|why|how|is|are|was|do|does|did|can|could|will|would|should|has|have|any)(?:n[’']t)?\b/i
/** "do" and "have" open a question only before who's asked: "Do you know …", not "Do the migration". */
const DO_OR_HAVE =
  /^(?:do|have)\s+(?!(?:you|we|i|they|he|she|it|any|all|both|our|my|your|their)\b)/i
/** A negated opener asks only with its "?": "Don't deploy it until Friday" is an instruction. */
const NEGATED = /^[a-z]+n[’']t\b/i
/** A question word straight before who does it opens a statement: "What we need is …", "When you're done, …". */
const STATEMENT = /^(?:what|which|when|where|why|how)\s+(?:i|we|you|they|he|she)\b/i
/**
 * Asking for facts: §4.5's words. "Tell me" and "let me know" only before what they want to know ("tell me what
 * broke", "let me know how many"): "let me know when it's live" and a bare "…and let me know" end a request for work.
 */
const FACTS =
  /\b(?:(?:tell me|let me know)\s+(?:what|which|who|whose|where|why|how|whether|about)|find out|look up|show me|how many|how much|i want to know|do you know|check (?:whether|if))\b/i
/** The work verbs that make a message a request for work, not for facts (§4.5). */
const WORK = String.raw`(?:fix|add|make|run|deploy|write|create|update|change|remove|commit|push|merge|install|set\s+up|try)`
/** "Can you fix …?": work, whatever its "?". */
const WORK_ASKED = new RegExp(
  String.raw`\b(?:can|could|would|will)\s+you\s+(?:please\s+|just\s+|also\s+|quickly\s+|now\s+)?${WORK}\b`,
  'i',
)
/** A sentence that opens with a work verb: "Deploy it to staging". */
const WORK_FIRST = new RegExp(String.raw`^${WORK}\b`, 'i')
/** A work verb after a comma, "and" or "then": "When you're done, push it", "Look at it and fix it". */
const WORK_LATER = new RegExp(String.raw`(?:[,;:]\s*|\b(?:and|then)\s+)${WORK}\b`, 'i')

/** The sentences of a text: split at a full stop, "!" or "?" and at a line's end. */
const sentencesOf = (text: string) =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)

/** Whether one sentence (its name and filler left out) asks the agent something, by §4.5's patterns. */
function asks(sentence: string): boolean {
  const said = opening(sentence)
  if (!said) return false
  if (WORK_ASKED.test(said)) return false
  const facts = FACTS.test(said)
  if (WORK_FIRST.test(said) && !facts) return false
  if (said.includes('?')) return true
  if (facts) return true
  if (WORK_LATER.test(said)) return false
  return (
    QUESTION.test(said) &&
    !DO_OR_HAVE.test(said) &&
    !NEGATED.test(said) &&
    !STATEMENT.test(said) &&
    wordsOf(said).length >= 4
  )
}

/**
 * Whether a message asks the agent something, lenient on dictation (§4.5): its first sentence or one of its last three
 * asks, and it isn't under four words with no "?".
 */
export function askedQuestion(message: string): boolean {
  const plain = spoken(message)
  const said = opening(plain)
  if (!said.includes('?') && wordsOf(said).length < 4) return false
  const sentences = sentencesOf(plain)
  const looked = [...new Set([sentences[0], ...sentences.slice(-3)])].filter(
    (sentence): sentence is string => sentence !== undefined,
  )
  return looked.some(asks)
}

/** Whether a message that started a turn was the person's own, and asked the agent something. */
export function asksQuestion(message: string | null | undefined): boolean {
  const words = typeof message === 'string' ? ownWords(message) : null
  return words !== null && askedQuestion(words)
}
