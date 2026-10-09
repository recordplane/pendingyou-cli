// Questions the person hands one of their assistants from another (D21, Delegate; 0.14.0): which of this computer's
// sessions hears one, and the words that wake it. Pending You's /mcp/cli/answers brings such a question to the app's
// sign-in once the delegation's 5-second hold is over, marked `delegated` (who asked, how its answer travels, the
// person's note), under the name the helper answers with (`sessionLabel`: the task the person picked) and in that
// task's folder (`cwd`, when it has one). It doesn't say which of the app's sessions on this computer that is, so the
// command line decides, the same way for every app:
//
// 1. a session that goes by that name, in that folder (with no folder, anywhere): the task the person picked;
// 2. else the session in that folder that used Pending You most recently (with no folder, the app's most recent),
//    never the one that asked it (a session that goes by the asking assistant's name);
// 3. never two: the session that takes it claims it first (state.ts's claimHanded), and the others leave it.
//
// Several sessions by one name in one folder are one task to Pending You: the most recent of them hears it. A sign-in
// that only hears (`--oauth`) hears every computer's questions, so it leaves one whose `machine` (the computer it went
// to, as the Assistants page names it) is another computer, by its name or its hostname; one with no `machine` goes by
// the folder. The session it's for is woken (codex-wake.ts's listeners); a session start or a message in that folder
// picks it up too (pickup.ts), at once in a session by that name and after HANDED_GRACE_MS in any other, so the one the
// person picked hears it first. The wake's words never carry the person's note, since a program's arguments are there
// for any other program to read (`codex queue`): get_request has it.
import {
  clip,
  type Delegated,
  type DelegationMode,
  HANDED_PREFIX,
  HANDED_REPLY,
  HANDED_TALK_TODO,
  HANDED_TODO,
  type Heard,
  latestTalk,
  modeWords,
} from './format.ts'

/**
 * How long a session that used Pending You's card tools stays listening for a question handed to it: as long as Pending
 * You offers its task to the person as running (12 hours since it was last seen).
 */
export const HANDED_FOR_MS = 12 * 60 * 60_000
/**
 * How long a session that goes by another name (or none) leaves a handed question for the one it went to, before it
 * picks it up itself at its next message: the session it's for hears within a minute or two.
 */
export const HANDED_GRACE_MS = 5 * 60_000
/** The most of a title, and of the asking assistant's name, a wake repeats. */
const TITLE_CHARS = 80
const NAME_CHARS = 60

/** One of the app's sessions on this computer, as its hooks know it. */
export interface Candidate {
  /** Its id: Codex's thread, an OpenCode or Pi session. */
  thread: string
  /** The names it went by on Pending You's card tools. */
  names: readonly string[]
  /** Its folder, as its hooks gave it. */
  cwd?: string
  /** When it last used Pending You or heard from the person. */
  at: number
  /** Whether it can be woken now (a listener holds it, or `codex queue` reaches it). */
  live: boolean
}

/** A name as Pending You compares them: trimmed, case and inner spacing aside. */
export const nameKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ')

/** Whether one of these names is that name. */
export const goesBy = (names: readonly string[], name: string) =>
  names.some((each) => nameKey(each) === nameKey(name))

/**
 * A folder as compared: `~` expanded, `\` as `/`, no doubled or trailing slash, in lower case (as Pending You compares
 * them).
 */
export function folderKey(path: string, home: string): string {
  const base = home.replace(/\/+$/, '')
  const given = path
    .trim()
    .replaceAll('\\', '/')
    .replace(/\/{2,}/g, '/')
  const full = given === '~' ? base : given.startsWith('~/') ? `${base}${given.slice(1)}` : given
  return (full.replace(/\/+$/, '') || '/').toLowerCase()
}

/** Whether a session's folder is the task's folder or inside it. */
export function inFolder(session: string | undefined, task: string, home: string): boolean {
  if (!session) return false
  const here = folderKey(session, home)
  const there = folderKey(task, home)
  return here === there || here.startsWith(there === '/' ? '/' : `${there}/`)
}

/** The most recent of these sessions (the lowest id among equals), or null. */
const latest = (list: readonly Candidate[]) =>
  [...list].sort((a, b) => b.at - a.at || a.thread.localeCompare(b.thread))[0]?.thread ?? null

/**
 * Which session hears a handed question (the rules above): the id of one that can be woken now, or null when none
 * should (the next session start or message in its folder picks it up).
 */
export function chooseThread(
  heard: Pick<Heard, 'sessionLabel' | 'cwd' | 'delegated'>,
  sessions: readonly Candidate[],
  options: { home: string },
): string | null {
  const live = sessions.filter((session) => session.live)
  const here = (session: Candidate) =>
    heard.cwd === undefined || inFolder(session.cwd, heard.cwd, options.home)
  const named = live.filter((session) => here(session) && goesBy(session.names, heard.sessionLabel))
  if (named.length) return latest(named)
  const asker = heard.delegated?.from
  return latest(live.filter((session) => here(session) && !(asker && goesBy(session.names, asker))))
}

/** A computer's name, or a hostname, as compared: its first label (not an address's), case and spacing aside. */
export function computerKey(name: string): string {
  const trimmed = name.trim()
  const first = /^\d+(\.\d+){3}$/.test(trimmed) ? trimmed : (trimmed.split('.')[0] ?? '')
  return first.replaceAll('’', "'").toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Whether a handed question's `machine` names another computer than this one, known by these names (its name, its
 * hostname): what a sign-in that only hears leaves alone. Without a `machine`, it's never another's: the folder decides.
 */
export function namesAnotherComputer(
  machine: string | undefined,
  names: readonly string[],
): boolean {
  if (!machine?.trim()) return false
  const ours = new Set(names.filter((name) => name.trim()).map(computerKey))
  return !ours.has(computerKey(machine))
}

/** One handed question, as a wake names it: never the person's note itself, only whether there is one. */
export interface HandedCard {
  requestId: string
  title: string
  /** The assistant that asked. */
  from: string
  mode: DelegationMode
  /** The person added a note: get_request has it. */
  note: boolean
  /** The name the helper answers with. */
  name: string
  /**
   * Woken again on it (0.15.0, guide 2.30): who wrote to it last on the card (the asker, or "your person" to both) and
   * their words.
   */
  said?: { who: string; words: string }
}

export const handedCard = (heard: Heard, delegated: Delegated): HandedCard => {
  const said = latestTalk(heard, delegated.from)
  return {
    requestId: heard.requestId,
    title: heard.title,
    from: delegated.from,
    mode: delegated.mode,
    note: Boolean(delegated.note),
    name: heard.sessionLabel,
    ...(said ? { said } : {}),
  }
}

/** The most of the words said on the card a wake quotes. */
const SAID_CHARS = 300

/** The words as a wake quotes them: one line, at most SAID_CHARS, double quotes made single. */
const quotedWords = (words: string) =>
  `“${clip(words.replace(/\s+/g, ' ').trim(), SAID_CHARS).text.replaceAll('“', '‘').replaceAll('”', '’')}”`

/** Who wrote to it on the card, as the wake says it: “billing-webhooks replied”, “your person wrote to you both”. */
const replied = (said: NonNullable<HandedCard['said']>) =>
  said.who === 'your person'
    ? 'your person wrote to you both'
    : `${clip(said.who, NAME_CHARS).text} replied`

const readTalk = (card: HandedCard) =>
  `get_request (requestId ${card.requestId}, name “${card.name}”) to read what you’ve said to each other`

/** A title as a wake quotes it: one line, at most TITLE_CHARS, its double quotes made single. */
const titled = (card: HandedCard) =>
  `“${clip(card.title, TITLE_CHARS).text.replaceAll('“', '‘').replaceAll('”', '’')}” (${card.requestId})`

/** Who asked and how its answer travels: “from billing-webhooks (answer freely: …)”. */
const asked = (card: HandedCard) => {
  const from = clip(card.from, NAME_CHARS).text
  return `from ${from} (${modeWords(card.mode, from)})`
}

const read = (card: HandedCard) =>
  `get_request (requestId ${card.requestId}, name “${card.name}”) to read it${card.note ? ' and their note' : ''}`

/**
 * The message that wakes a session for questions the person handed it, in the words of the Claude Code wake mod's
 * handedText (a test holds them equal); null for none.
 */
export function handedMessage(
  cards: readonly HandedCard[],
  options: { words?: boolean } = {},
): string | null {
  if (cards.length === 0) return null
  // `codex queue` carries the wake in its arguments, which any program here can read: the words stay in get_request.
  const words = options.words !== false
  const said = (card: HandedCard) => (card.said && words ? `: ${quotedWords(card.said.words)}` : '')
  if (cards.length === 1) {
    const card = cards[0] as HandedCard
    // Woken again on it (guide 2.30): the asker's (or the person's) latest words, not the handed question again.
    if (card.said)
      return `Pending You: ${replied(card.said)} ${HANDED_REPLY}, ${titled(card)}${said(card)}. Call ${readTalk(card)}. ${HANDED_TALK_TODO}`
    return `${HANDED_PREFIX} ${titled(card)}, a question ${asked(card)}. Call ${read(card)}. ${HANDED_TODO}`
  }
  return [
    `${HANDED_PREFIX} ${cards.length} questions from other assistants.`,
    ...cards.map((card) =>
      card.said
        ? `- ${titled(card)}, ${asked(card)}; ${replied(card.said)}${said(card)}: call ${readTalk(card)}.`
        : `- ${titled(card)}, ${asked(card)}: call ${read(card)}.`,
    ),
    `For each one: ${HANDED_TODO.charAt(0).toLowerCase()}${HANDED_TODO.slice(1)}${cards.some((card) => card.said) ? ` Where one replied, you may also reply_in_thread to “asker”, or escalate.` : ''}`,
  ].join('\n')
}
