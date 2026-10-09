// `pendingyou stopcheck`, the Stop hook `init` installs: when Claude Code is about to end its turn with something for
// the person in the chat (a question to them, a step only they can do, a "Your part:" list) and it posted nothing to
// Pending You in that turn, it asks Claude Code to go on and post it (`{"decision":"block","reason":…}`), once.
//
// Since 0.9.0 (guide 2.21) it also catches a final message asking them to type or reply something in this chat
// ("Reply “yes, erase disk12” here", "confirm here"): an agent that won't act on a card answer for that step must say
// so on a card, or they never learn where they're needed. Unless a card posted in the turn, or one still open from this
// folder, asks for the same thing, it asks Claude Code to post the action card that sends them here (confirm.ts).
//
// Pattern matching only, no model: it reads the hook's JSON, the final message, and the tail of the transcript back to
// the person's last message, never more than READ_CAP bytes. Only an ask to type here, or (0.19.0) something for the
// person in a message that talks about cards, costs a request (this folder's open cards, as the next-message hook asks
// for them, given up after 1.5 seconds). It never loops (stop_hook_active), stays quiet for anyone not signed in to
// this origin, and exits 0 silently on any error.
//
// Since 0.11.0 it's Codex's Stop hook too (`--app codex`). Codex hands it the final message (`last_assistant_message`)
// and the turn's id, and its transcript is its own, so whether the turn posted a card is what Codex's PostToolUse hook
// recorded for that turn (apps/codex-wake.ts); it asks at most once a turn.
//
// Since 0.12.0 OpenCode's plugin runs it when a session goes idle (`--app opencode`), with the turn's messages: the
// final message and the card calls come from them (opencodeTurn), and it asks at most once a turn too. The plugin then
// starts the turn that goes on, with the reason, and shows a toast saying why. Pi's extension (`--app pi`) runs it as
// Codex does, as a run of Pi's settles: the run's id, its last message, and what `posted --app pi` recorded for it.
//
// Since 0.14.0 a question the person handed the agent from another assistant (D21) is never asked to go on a card of
// its own: `answer_delegated` and `hand_back` put it in front of them (the asker's card), so they count as the turn's
// card calls, and a turn that such a question started (its first message the wake's, HANDED_PREFIX) and that answered
// or handed back nothing is asked once to do one of those instead (DELEGATED_REASON). Claude Code's and OpenCode's
// turns say both themselves; Pi's extension says how its run started (`handed`); Codex's next-message hook records a
// turn whose message is a handed question's wake, and its PostToolUse hook, trusted by its exact matcher, never sees
// the two calls, so the reason says "unless you already did".
//
// Since 0.19.0 a final message that recaps cards already in front of the person ends the turn. On 2026-10-06 five
// closing recaps in one day ("Two cards are waiting on you: CLI 0.18.0 (publish it) and the Herdr check …", a
// "**Cards waiting for you:**" list) were asked to go on, and Claude Code shows each block as a "Stop hook error". A
// recap covers what it says, with no request: the sentence it's in, or the list under a heading (RECAP). Whatever else
// in the message is for the person is checked as before, so a new ask beside a recap still goes on a card; but when the
// message talks about cards at all, it's taken as a recap while this folder has a card waiting on them (the same
// request, the same 1.5 seconds; when Pending You can't say, the turn ends).
import { open } from 'node:fs/promises'
import { getJson } from './api.ts'
import { markNudged, turnRecord } from './apps/codex-wake.ts'
import { APP_NAMES, type AppId, DEFAULT_APP } from './apps/ids.ts'
import { asksToTypeHere, cardFits, confirmReason, sessionLink } from './confirm.ts'
import { readCredential } from './credentials.ts'
import { isHandedWake } from './format.ts'
import type { Io } from './io.ts'
import {
  isPermissionCard,
  isPromptApp,
  sessionName,
  settlePrompts,
  subagentsRunning,
} from './permission.ts'
import { askerParams, folderForms } from './pickup.ts'

/** The most of the transcript it reads, from the end. A turn longer than this is let through. */
export const READ_CAP = 4 * 1024 * 1024
const CHUNK = 64 * 1024

/** What Claude Code reads when it's asked to go on: one short line (about 30 tokens). */
export const STOP_REASON =
  'Items for your person are in chat but not in Pending You: post them as cards (ask in both places), or say they don’t need one.'

/**
 * What an agent reads instead when its turn started with a question the person handed it (0.14.0), and it left them
 * something in chat without answering it or handing it back (about 45 tokens).
 */
export const DELEGATED_REASON =
  'Your person handed you that question to answer, not to ask them back: answer_delegated if you know, or hand_back with what you checked, unless you already did. Never post it as a card of your own.'

/**
 * Tools that put something in front of the person: Pending You's, under any MCP server name. Since 0.14.0 also the two
 * that answer a question the person handed the agent, or give it back.
 */
const POSTING_TOOL =
  /^mcp__.+__(post_request|update_request|reply_in_thread|answer_delegated|hand_back)$/

/** How long it waits for this folder's open cards, inside the hook's 3-second deadline (main.ts). */
export const OPEN_TIME_BOX_MS = 1500
/** As many of them as Pending You lists. */
const OPEN_CARDS = 5
/** The most of one posting call's words it keeps, to match an ask against. */
const CARD_TEXT = 20_000

/**
 * Text that says the items are already in Pending You, or will be: "you'll get a card to publish it once it's merged"
 * announces a card to come, not a step left in chat. Since 0.19.0 also "that one is already a card", "a card is
 * coming", "there'll be a card" and "I'll create a card" (not "the card is coming together").
 */
const SAYS_POSTED = new RegExp(
  [
    String.raw`\b(posted|put|added|raised|filed)\b[^.\n]{0,60}\b(cards?|pending ?you)\b`,
    String.raw`\bon (a|the|its|their|your|that|this) cards?\b`,
    String.raw`\b(in|to|through|via|on) pending ?you\b`,
    String.raw`\bpending ?you cards?\b`,
    String.raw`\b(i|we|you)(?:(?:'|’)ll| will)\s+(?:\w+\s+)?(post|send|put|add|raise|file|get|see|find|make|create|open)\b[^.\n]{0,40}\bcards?\b`,
    String.raw`\balready (?:a |on (?:a )?)?cards?\b`,
    String.raw`\bcards? (?:is|are|will be) (?:coming|on (?:its|their|the) way)\b(?! (?:together|along))`,
    String.raw`\bcards? (?:will|to) follow\b`,
    String.raw`\bthere(?:(?:'|’)ll| will) be (?:a |another |one )?cards?\b`,
  ].join('|'),
  'i',
)

/**
 * A recap of cards already in front of the person (0.19.0), which covers what the sentence it's in asks: "Two cards
 * are waiting on you: …", "Cards waiting for you", "The card is still open for your answer", "Both cards are in your
 * queue", "Waiting on you as two cards", "… (both cards)." Not cards that aren't said to wait on them ("Can you check
 * the two cards line up?", "Add a credit card"): those are what the person is asked about.
 */
const RECAP = new RegExp(
  [
    String.raw`\bcards?\b[^.!?\n]{0,40}?\b(?:(?:waiting|pending|open|parked|queued|left)\b[^.!?\n]{0,20}?\b(?:on|for)\s+your?|in\s+your\s+queue)\b`,
    String.raw`\b(?:waiting|pending|parked)\s+(?:on|for)\s+you\b[^.!?\n]{0,30}?\b(?:as|in)\s+(?:(?:a|two|both|three|its|their|the|separate)\s+)?cards?\b`,
    String.raw`\((?:(?:both|all|two|three|each)\s+)?(?:(?:are|is|on|as)\s+)?(?:a\s+|(?:its|their)\s+own\s+)?cards?(?:\s+(?:already|too))?\)`,
  ].join('|'),
  'i',
)
/** A heading over the cards themselves (0.19.0): "Your cards:", "Your open cards:", "Open cards:". */
const CARDS_HEADING = /\b(?:your|open|pending|waiting)\s+(?:(?:open|pending|waiting)\s+)?cards\b/i
/** Where a sentence ends, within a line. */
const SENTENCE_END = /(?<=[.!?])\s+/
/** Cards of other kinds, which aren't Pending You's: a credit card, a SIM card, a card number. */
const OTHER_CARDS =
  /\b(?:credit|debit|payment|gift|sim|sd|business|graphics|video|sound|network|memory|smart)\s+cards?\b|\bcards?\s+(?:numbers?|readers?|details|holders?)\b/gi

/**
 * Steps only the person can take, said to them. Not "nothing (is) waiting on you" or "no cards … waiting on you" (a
 * negation within the clause), nor "say if it needs you to …" (what another agent will say, if it ever does).
 */
const STEPS_FOR_THEM =
  /\b(you(?:'|’)ll need to|you will need to|you(?:'|’)ll have to|you will have to|your (?:next )?steps?\b|can you|could you|would you mind|please (?:run|confirm|approve|check|add|set|sign|create|open|paste|reply|send|choose|pick|decide|let me know)|in your terminal|only you can|(?<!\b(?:no|nothing|none|not)\b[^.,;:!?\n]{0,40})waiting (?:on|for) you|(?<!\bif (?:it|he|she|they|that|this|anything|something|someone|anyone|one) )needs? you to|over to you|parked for you|when you(?:'|’)re ready|up to you|your call\b|is yours\b|say the word|let me know (?:which|whether)|tell me (?:which|whether)|needs? your (?:ok|okay|approval|decision|sign-?off|go-ahead))/i

/**
 * Text that says nothing here needs a card: the "or say they don’t need one" the Stop reason offers ("No card
 * needed.", "Nothing needs your attention.", "There’s nothing waiting on you.").
 */
const SAYS_NO_CARD =
  /\bno (?:new |more |further )?cards? (?:is |are )?(?:needed|necessary|required)\b|\b(?:doesn(?:'|’)t|don(?:'|’)t|does not|do not|won(?:'|’)t|will not) need (?:a |any )?(?:new )?cards?\b|\bnothing (?:here |else |more |now )?(?:needs|requires) your (?:attention|input|action|answer)\b|\b(?:nothing|no cards?)\b[^.,;:!?\n]{0,40}\b(?:waiting|pending) (?:on|for) you\b/i

/** A heading over a list of things for the person. */
const FOR_THEM_HEADING =
  /\b(your part|your steps?|your to-?dos?|your turn|your call|for you|waiting on you|left for you|parked for you|needs you|over to you|what you need to do|you(?:'|’)ll need)\b/i
const LIST_ITEM = /^\s*(?:\d+[.)]|[-*•]|\[ \])\s+\S/
const YOU = /\byou(?:r|rs|(?:'|’)(?:ll|d|re|ve))?\b/i

/** The text without what isn't said to the person: code (fenced and inline), block quotes and quoted strings. */
export function plainText(text: string): string {
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
    kept.push(line.replace(/`[^`]*`/g, '').replace(/“[^”]*”|"[^"]*"/g, ''))
  }
  return kept.join('\n')
}

/** A heading's words (`## Your part`, `**Your part:**`, `Your part:`), or null when the line isn't one. */
function headingOf(line: string): string | null {
  const bare = line.replace(/[*_#]/g, '').trim()
  if (!bare || bare.length > 80) return null
  return /^\s*#/.test(line) || bare.endsWith(':') || /^\s*\*\*.+\*\*\s*$/.test(line) ? bare : null
}

/** What in the text, as plainText leaves it, is for the person (itemsForPerson), or null. */
function itemsIn(plain: string): 'question' | 'steps' | 'list' | null {
  const lines = plain.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const heading = headingOf(lines[index] as string)
    if (!heading || !FOR_THEM_HEADING.test(heading)) continue
    const next = lines.slice(index + 1, index + 4).find((candidate) => candidate.trim())
    if (next && LIST_ITEM.test(next)) return 'list'
  }
  if (STEPS_FOR_THEM.test(plain)) return 'steps'
  for (const sentence of plain.split(/(?<=[.!?])\s+|\n/))
    if (sentence.trim().endsWith('?') && YOU.test(sentence)) return 'question'
  return null
}

/**
 * What in the final text is for the person, or null: `list` (a list under a heading like "Your part:"), `steps`
 * (something only they can do) or `question` (a question to them).
 */
export function itemsForPerson(text: string): 'question' | 'steps' | 'list' | null {
  return itemsIn(plainText(text))
}

/**
 * The last line of the list under the heading at `index` (its items, what's indented under them, and the blank lines
 * between), or `index` when no list starts within the next three lines, as itemsForPerson reads one.
 */
function listEnd(lines: readonly string[], index: number): number {
  let end = index
  for (let next = index + 1; next < lines.length; next++) {
    const line = lines[next] as string
    if (!line.trim()) {
      if (end === index && next - index >= 3) return index
    } else if (LIST_ITEM.test(line) || (end > index && /^\s/.test(line))) end = next
    else break
  }
  return end
}

/**
 * The plain text without its recaps of cards already in front of the person (0.19.0): each sentence that is one
 * (RECAP), and a heading that is one, or that names their cards ("Your open cards:"), with the list under it. What a
 * recap asks is on a card already; anything else stays the person's.
 */
function withoutRecaps(plain: string): string {
  const lines = plain.split('\n')
  const kept: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string
    const heading = headingOf(line)
    if (heading && (RECAP.test(heading) || CARDS_HEADING.test(heading))) {
      const end = listEnd(lines, index)
      if (end > index) {
        index = end
        continue
      }
    }
    kept.push(
      line
        .split(SENTENCE_END)
        .filter((sentence) => !RECAP.test(sentence))
        .join(' '),
    )
  }
  return kept.join('\n')
}

/**
 * What in the final text is for the person outside its recaps of cards already in front of them (0.19.0), or null:
 * "Two cards are waiting on you: A and B. Can you also run `npm login`?" still has the second sentence's step.
 */
export function itemsOutsideRecaps(text: string): 'question' | 'steps' | 'list' | null {
  return itemsIn(withoutRecaps(plainText(text)))
}

/** Whether the text says the items are already in Pending You. */
export const saysPosted = (text: string) => SAYS_POSTED.test(plainText(text))

/** Whether the text says nothing in it needs a card. */
export const saysNoCard = (text: string) => SAYS_NO_CARD.test(plainText(text))

/** Whether the text talks about cards at all (0.19.0), as a recap would: credit cards, SIM cards and the like aside. */
export const mentionsCards = (text: string) =>
  /\bcards?\b/i.test(plainText(text).replace(OTHER_CARDS, ''))

interface Entry {
  type?: string
  isSidechain?: boolean
  isMeta?: boolean
  message?: { role?: string; content?: unknown }
}
interface Block {
  type?: string
  text?: string
  name?: string
  input?: unknown
}

/** Every string a tool call carried (a card's title, summary, steps and their commands…), up to `max` characters. */
function wordsIn(value: unknown, max = CARD_TEXT): string {
  const found: string[] = []
  let left = max
  const walk = (item: unknown, depth: number) => {
    if (left <= 0 || depth > 8) return
    if (typeof item === 'string') {
      found.push(item.slice(0, left))
      left -= item.length
    } else if (Array.isArray(item)) for (const each of item) walk(each, depth + 1)
    else if (item && typeof item === 'object')
      for (const each of Object.values(item)) walk(each, depth + 1)
  }
  walk(value, 0)
  return found.join('\n')
}

/** A message from the person (not a tool's result): where a turn starts. */
function startsTurn(entry: Entry): boolean {
  if (entry.type !== 'user' || entry.isMeta || entry.message?.role !== 'user') return false
  const content = entry.message.content
  if (typeof content === 'string') return true
  return Array.isArray(content) && content.some((block: Block) => block?.type === 'text')
}

/** The words of the message a turn starts with. */
function startText(entry: Entry): string {
  const content = entry.message?.content
  if (typeof content === 'string') return content
  return Array.isArray(content)
    ? content
        .flatMap((block: Block) =>
          block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
        )
        .join('\n')
    : ''
}

/** Whether a turn's first message is a wake for a question the person handed the agent (0.14.0). */
export const startsHanded = (text: string) => isHandedWake(text)

export interface LastTurn {
  /** The assistant's text after its last tool call in the turn (its final message), or ''. */
  text: string
  /** Whether it posted, updated or replied in Pending You, or started a hold, in the turn. */
  posted: boolean
  /** What each Pending You post, update or reply in the turn carried, as words (wordsIn). */
  cards: string[]
  /** Whether the turn started with a question the person handed the agent (0.14.0): the wake mod's prompt. */
  handed: boolean
  /** Whether the start of the turn was found within the cap. */
  complete: boolean
  bytesRead: number
}

/**
 * The last turn of a Claude Code transcript (JSONL): read backwards from the end in chunks, line by line, until the
 * person's last message, never more than `cap` bytes.
 */
export async function lastTurn(path: string, cap = READ_CAP): Promise<LastTurn> {
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    let position = size
    let bytesRead = 0
    let carry = Buffer.alloc(0)
    const texts: string[] = []
    let finalDone = false
    let posted = false
    let handed = false
    const cards: string[] = []
    const take = (raw: string): boolean => {
      if (!raw.trim()) return false
      let entry: Entry
      try {
        entry = JSON.parse(raw) as Entry
      } catch {
        return false
      }
      if (entry.isSidechain) return false
      if (startsTurn(entry)) {
        handed = startsHanded(startText(entry))
        return true
      }
      if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) return false
      const blocks = entry.message.content as Block[]
      for (const block of [...blocks].reverse()) {
        if (block?.type === 'tool_use') {
          finalDone = true
          const name = typeof block.name === 'string' ? block.name : ''
          const input = (block.input ?? {}) as { command?: unknown }
          const command = typeof input.command === 'string' ? input.command : ''
          if (POSTING_TOOL.test(name)) {
            posted = true
            cards.push(wordsIn(block.input))
          } else if (/\bpendingyou\b.*\bhold\s+req_/.test(command)) posted = true
        } else if (block?.type === 'text' && !finalDone && typeof block.text === 'string')
          texts.unshift(block.text)
      }
      return false
    }
    while (position > 0 && bytesRead < cap) {
      const length = Math.min(CHUNK, position, cap - bytesRead)
      position -= length
      const chunk = Buffer.alloc(length)
      await file.read(chunk, 0, length, position)
      bytesRead += length
      let buffer = Buffer.concat([chunk, carry])
      let newline = buffer.lastIndexOf(10)
      while (newline !== -1) {
        if (take(buffer.subarray(newline + 1).toString('utf8')))
          return { text: texts.join('\n'), posted, cards, handed, complete: true, bytesRead }
        buffer = buffer.subarray(0, newline)
        newline = buffer.lastIndexOf(10)
      }
      carry = buffer
    }
    if (position === 0 && take(carry.toString('utf8')))
      return { text: texts.join('\n'), posted, cards, handed, complete: true, bytesRead }
    return { text: texts.join('\n'), posted, cards, handed, complete: position === 0, bytesRead }
  } finally {
    await file.close()
  }
}

interface StopInput {
  transcript_path?: unknown
  stop_hook_active?: unknown
  last_assistant_message?: unknown
  cwd?: unknown
  /**
   * Codex's, OpenCode's plugin's and Pi's extension's: the turn that's stopping (OpenCode: the message that started
   * it).
   */
  turn_id?: unknown
  /** OpenCode's plugin's: the turn's messages, from the one that started it (opencodeTurn has their shape). */
  messages?: unknown
  /** Claude Code's: the session, and what's still running in the background (subagents among them). */
  session_id?: unknown
  background_tasks?: unknown
  /** Pi's extension's (0.14.0): the run started with a question the person handed the session. */
  handed?: unknown
}

/** OpenCode's tools that put something in front of the person: Pending You's, under its server's name. */
const OPENCODE_POSTING =
  /^[A-Za-z0-9_-]*pendingyou[A-Za-z0-9_-]*_(post_request|update_request|reply_in_thread|answer_delegated|hand_back)$/i

/** What the Stop check knows of a turn. */
interface Turn {
  /** Its final message. */
  text: string
  /** Whether it posted, changed or replied on a card, or answered or handed back a question handed to it. */
  posted: boolean
  /** What each of those calls said, as words. */
  cards: string[]
  /** Whether a question the person handed the agent started it (0.14.0). */
  handed: boolean
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * An OpenCode session's last turn, as its plugin hands it over (apps/opencode-plugin.ts): each message's `role`,
 * `error` (the name of the one it ended with) and `parts`, each part a `text` (with `synthetic`, and `pendingyou` on
 * the plugin's own), or a `tool` (its name, `status` and, for Pending You's card tools, its `input`). Null when there's
 * nothing to check: the turn the plugin started to ask for cards (asked once, never twice in a row), one the person
 * stopped (MessageAbortedError), or one with no final words.
 */
function opencodeTurn(input: StopInput): Turn | null {
  const messages = Array.isArray(input.messages) ? input.messages.filter(isObject) : []
  const [first, ...rest] = messages
  if (first?.role !== 'user') return null
  const partsOf = (message: Record<string, unknown>) =>
    Array.isArray(message.parts) ? message.parts.filter(isObject) : []
  if (partsOf(first).some((part) => part.pendingyou === 'stopcheck')) return null
  // A wake for a question the person handed the session (0.14.0): the plugin's own prompt, in the listener's words.
  const handed = partsOf(first).some(
    (part) =>
      part.pendingyou === 'wake' &&
      part.type === 'text' &&
      typeof part.text === 'string' &&
      startsHanded(part.text),
  )
  const answers = rest.filter((message) => message.role === 'assistant')
  if (answers.at(-1)?.error === 'MessageAbortedError') return null
  let final: string[] = []
  let posted = false
  const cards: string[] = []
  for (const message of answers)
    for (const part of partsOf(message)) {
      if (part.type === 'tool') {
        // The final message is what it said after its last tool call.
        final = []
        if (
          typeof part.tool === 'string' &&
          OPENCODE_POSTING.test(part.tool) &&
          part.status === 'completed'
        ) {
          posted = true
          cards.push(wordsIn(part.input))
        }
      } else if (part.type === 'text' && part.synthetic !== true && typeof part.text === 'string')
        final.push(part.text)
    }
  const text = final.join('\n').trim()
  return text ? { text, posted, cards, handed } : null
}

/**
 * The titles of this session's own cards still waiting on the person (what the next-message hook names; 0.25.0: its
 * own, not every card asked from its folder), or null when that can't be told: an error, a slow answer, a server too
 * old to list them.
 */
async function openTitles(
  io: Io,
  origin: string,
  cwd: string,
  app: AppId,
  session: { id: string | null; transcript: string | null },
): Promise<string[] | null> {
  try {
    const name =
      app === 'claude-code' ? await sessionName(session.transcript ?? undefined) : undefined
    const query = new URLSearchParams([
      ...folderForms(cwd, io.home).map((form) => ['cwd', form] as [string, string]),
      ['limit', '0'],
      ['open', String(OPEN_CARDS)],
      ['source', app],
      ...(await askerParams(io, origin, app, { ...session, name: name ?? null })),
    ])
    const { status, body } = await getJson<{ open?: { requests?: unknown } }>(
      io,
      origin,
      `/mcp/cli/answers?${query}`,
      OPEN_TIME_BOX_MS,
      io.signal,
      { hook: true, app },
    )
    const requests = status === 200 ? body.open?.requests : undefined
    if (!Array.isArray(requests)) return null
    return requests.flatMap((card: { title?: unknown } | null) =>
      typeof card?.title === 'string' ? [card.title] : [],
    )
  } catch {
    return null
  }
}

/** What the Stop check knows of the turn: the final message, whether it posted, and what each card said. */
async function turnOf(io: Io, input: StopInput, app: AppId): Promise<Turn | null> {
  const final =
    typeof input.last_assistant_message === 'string' && input.last_assistant_message.trim()
      ? input.last_assistant_message
      : ''
  if (app === 'codex' || app === 'pi') {
    // What Codex's PostToolUse hook (or Pi's extension) recorded for this turn; one nudge a turn, whatever it says.
    // Whether a handed question started it: what Codex's next-message hook recorded, or what Pi's extension says.
    if (typeof input.turn_id !== 'string' || !input.turn_id || !final) return null
    const record = await turnRecord(io, input.turn_id, app)
    if (record?.nudged) return null
    return {
      text: final,
      posted: Boolean(record?.cards.length),
      cards: record?.cards ?? [],
      handed: Boolean(record?.delegated) || input.handed === true,
    }
  }
  if (app === 'opencode') {
    // The turn's own messages, and what the plugin's `posted` recorded for it; one nudge a turn.
    if (typeof input.turn_id !== 'string' || !input.turn_id) return null
    const record = await turnRecord(io, input.turn_id, app)
    if (record?.nudged) return null
    const turn = opencodeTurn(input)
    if (!turn) return null
    return {
      text: turn.text,
      posted: turn.posted || Boolean(record?.cards.length),
      cards: [...turn.cards, ...(record?.cards ?? [])],
      handed: turn.handed,
    }
  }
  if (typeof input.transcript_path !== 'string' || !input.transcript_path) return null
  const turn = await lastTurn(input.transcript_path)
  if (!turn.complete) return null
  // The transcript can lag the final message; Claude Code hands it over itself.
  const text = final || turn.text
  return text ? { text, posted: turn.posted, cards: turn.cards, handed: turn.handed } : null
}

export async function stopcheck(io: Io, options: { origin: string; app?: AppId }): Promise<number> {
  const app = options.app ?? DEFAULT_APP
  try {
    const input = JSON.parse(await io.readStdin(1000)) as StopInput
    if (typeof input !== 'object' || input === null) return 0
    // The turn ended: nothing it asked the person's OK for is waiting any more (0.13.0; Codex's since 0.15.0).
    if (isPromptApp(app))
      await settlePrompts(io, {
        session: typeof input.session_id === 'string' ? input.session_id : null,
        event: 'stop',
        subagents: subagentsRunning(input),
      })
    if (input.stop_hook_active === true) return 0
    if (!(await readCredential(io, options.origin, app))) return 0
    const turn = await turnOf(io, input, app)
    if (!turn) return 0
    const { text } = turn
    const block = async (reason: string) => {
      if (app !== 'claude-code' && typeof input.turn_id === 'string')
        await markNudged(io, input.turn_id, app)
      io.out(`${JSON.stringify({ decision: 'block', reason })}\n`)
      return 0
    }
    // A turn a question the person handed the agent started (0.14.0): that question is on the asker's card already.
    // Answered or handed back, it's done; one that left them something here instead answers it or hands it back.
    if (turn.handed) {
      if (turn.posted || saysPosted(text) || saysNoCard(text)) return 0
      return asksToTypeHere(text) || itemsForPerson(text) ? block(DELEGATED_REASON) : 0
    }
    // The session's folder, and who it is: Pending You lists its own open cards (0.25.0).
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : io.cwd
    const session = {
      id: typeof input.session_id === 'string' && input.session_id ? input.session_id : null,
      transcript:
        typeof input.transcript_path === 'string' && input.transcript_path
          ? input.transcript_path
          : null,
    }
    // Words they must type here (guide 2.21): a card has to say so, one from this turn or one still open.
    const ask = asksToTypeHere(text)
    if (ask) {
      if (saysNoCard(text) || turn.cards.some((card) => cardFits(card, ask.words, 'posted')))
        return 0
      const open = await openTitles(io, options.origin, cwd, app, session)
      // Not known (offline, slow, an older server): take the message's word that it's on a card.
      if (open ? open.some((title) => cardFits(title, ask.words, 'open')) : saysPosted(text))
        return 0
      return block(confirmReason(ask.words, sessionLink(io.env), APP_NAMES[app]))
    }
    if (turn.posted || saysPosted(text) || saysNoCard(text) || !itemsOutsideRecaps(text)) return 0
    // Something for them outside any recap (0.19.0). A message that talks about cards may be recapping ones already
    // open in words no pattern knows: asked only then, any card of this folder's still waiting on them (not a
    // permission prompt's, which the hooks post) says it is. Not known (offline, slow, an older server): let it end.
    if (mentionsCards(text)) {
      const open = await openTitles(io, options.origin, cwd, app, session)
      if (open === null || open.some((title) => !isPermissionCard(title))) return 0
    }
    return block(STOP_REASON)
  } catch {
    return 0
  }
}
