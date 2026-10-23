// A step handed over now (0.37.0, guide 2.55): "Go: approve it now", "you can merge it now", "now open the run link",
// "go ahead and approve it". An agent that ends a card before a step that waits on it ("on my go, open the link"), then
// says the go only in its chat, leaves the person to find it there; they may be in Pending You, not in the chat, and
// miss it. The end-of-turn check (stopcheck.ts) asks for such a step on a card, whatever card is open, unless a card
// call from the same turn carries it. Before 0.37.0 three things let the turn end: no pattern knew a go, any card call
// ended it whatever the card was about, and a message that talks about cards ended it while a card from the session
// waited on the person (the very card whose step said "on my go").
//
// Pattern matching only, as an ask to type here is read (confirm.ts): the message's prose (proseOf), its quotes and
// code as ⟦n⟧ (marked), in sentences split at . ! ? and line ends. A sentence hands over a step now when STEP_NOW
// matches it, unless the words before the match say what something says (DESCRIBED: "Step 3 says: Go ahead and approve
// it"), or the sentence is an offer or an invitation to look (NOT_NOW: "whenever you like", "to see it"). A card call
// carries it when its words hold the sentence's web addresses, or without one, two of its telling words (carriesStep).
// It asks Pending You nothing.
//
// Real closing messages taught it what isn't a go, beyond the plan's patterns (docs/plans/2026-10-22-shared-step-
// progress-amendment-1.md §4a): "the go-between"; open as it stands ("Open for you now: the … card", "Open now:"); a
// label before a colon ("Open questions: …, now in the spec"); a question whether to ("Merge and deploy now?"); "for
// now"; and a Pending You card's own address, which the call that posts the card never holds.
import { DESCRIBED, marked, proseOf, wordsOf } from './confirm.ts'

/** What a step handed over now asks them to do. Not "open to me", "open for you" or "open now": open as it stands. */
const NOW_VERB = String.raw`(?:approve|open(?!\s+(?:to|for|now)\b)|press|click|tap|run|paste|merge|publish|deploy|release|restart|confirm|authori[sz]e|accept|allow|(?:sign|log)\s+in)`
/** The gates a "you can … now" hands over: "You can now run the tests yourself" is news, not a step. */
const GATE_VERB = String.raw`(?:approve|merge|publish|deploy|release|confirm|authori[sz]e|accept|allow|(?:sign|log)\s+in)`
/** What a sentence may open with before the go: "Okay, go now:", "So now run …", "Please approve it now". */
const LEAD = String.raw`(?:(?:ok(?:ay)?|alright|all\s+right|right|so|please|just)[,!]?\s+)*`
/** Not "now that CI is green", nor "from now on". */
const NOT_THAT = String.raw`(?!\s+(?:that|on)\b)`
/** Not "for now", which says how long, not when. */
const NOT_FOR = String.raw`(?<!\bfor\s+)`

/** A sentence that hands the person a step to do now. */
export const STEP_NOW = new RegExp(
  [
    String.raw`^${LEAD}go(?:\s+ahead)?(?:\s+now)?\s*(?:[:!—–]|-\s)`, // Go: · Go! · Go ahead — · Okay, go now:
    String.raw`^${LEAD}(?:it(?:['’]s|\s+is)\s+)?your\s+turn\s*[:!—–]`, // Your turn: · It's your turn —
    String.raw`\b(?:that|this|here)(?:['’]s|\s+is)\s+(?:your|the)\s+go\b(?!-)`, // That's your go (not the go-between)
    String.raw`(?:^${LEAD}|[:;—–]\s*|\byou\s+can\s+)go\s+ahead\s+and\s+${NOW_VERB}\b`, // Go ahead and approve it
    String.raw`(?:^${LEAD}|[:;,—–]\s*|\b(?:and|so|then)\s+)now[,:]?\s+(?:please\s+)?${NOW_VERB}\b`, // Now open the run link
    // Approve it now. Not a question ("Merge and deploy now?": whether the agent should, the general check's), nor a
    // label before a colon ("Open questions: …, now in the spec").
    String.raw`^(?![^\n]*\?\s*$)${LEAD}${NOW_VERB}\b[^.!?\n:]{0,80}?${NOT_FOR}\bnow\b${NOT_THAT}`,
    String.raw`\b(?:you\s+can|can\s+you|could\s+you)\s+(?:go\s+ahead\s+and\s+)?${GATE_VERB}\b[^.!?\n]{0,60}?${NOT_FOR}\bnow\b${NOT_THAT}`, // You can approve it now
    String.raw`\byou\s+can\s+now\s+${GATE_VERB}\b`, // You can now merge it
  ].join('|'),
  'iu',
)
/** STEP_NOW, for each match in a sentence in turn: what something says may come before a go. */
const STEP_NOW_EACH = new RegExp(STEP_NOW.source, 'giu')

/** Not a step now: an offer, or an invitation to look. */
export const NOT_NOW =
  /\b(?:any\s?time|whenever|at\s+any\s+(?:point|time)|if\s+you\s+(?:want|like|prefer|['’]d\s+like)|when\s+you\s+get\s+a\s+(?:chance|minute)|no\s+rush|or\s+later|to\s+(?:see|look|check|try|test|compare))\b/iu

/**
 * What the agent reads when its last message hands the person a step now and no card from the turn has it: put it on
 * a card, following the one they answered, or on the one still waiting (about 49 tokens).
 */
export const STEP_NOW_REASON =
  'Your last message hands them a step now, and no card from this turn has it: put it on a card (follows: the card they answered; one still waiting: update_request it), or say it doesn’t need one.'

/** A step handed over now: its sentence as said, the web addresses in it, and its telling words. */
export interface StepNow {
  /** The sentence, its quotes and code put back. */
  text: string
  /** Its web addresses, lower case, without what ends the sentence or a trailing slash. */
  links: string[]
  /** Its words that tell it from another step (STEP_COMMON left out). */
  words: string[]
}

/** Where a sentence ends: after . ! ? and a space, and at a line's end, as confirm.ts reads an ask. */
const SENTENCE_END = /(?<=[.!?])\s+|\n+/u
/** A quoted span or code, as marked leaves it. */
const MARK = /⟦(\d+)⟧/gu
/** A web address, up to a space or a quote. */
const LINK = /\bhttps?:\/\/[^\s<>"'`“”‘’⟦⟧]+/giu
/** What follows an address in a sentence rather than being part of it: "…/runs/123)." */
const LINK_END = /[.,;:!?)]+$/u
/** What would carry on an address: …/runs/1234 isn't …/runs/123. */
const LINK_GOES_ON = /[\p{L}\p{N}_-]/u
/**
 * A Pending You card's own page (…/app/r/req_…): the call that posts a card never holds its address, so a step that
 * links its card is told by its words.
 */
const CARD_PAGE = /\/app\/r\/req_/iu

/** Words that don't tell one step from another: the go itself, who it's for, where it is, and the little words. */
const STEP_COMMON = new Set([
  'go',
  'ahead',
  'now',
  'you',
  'your',
  'yours',
  'can',
  'could',
  'please',
  'just',
  'ok',
  'okay',
  'alright',
  'all',
  'right',
  'so',
  'then',
  'still',
  'card',
  'cards',
  'done',
  'step',
  'steps',
  'turn',
  'it',
  'its',
  's',
  't',
  'll',
  're',
  've',
  'd',
  'm',
  'i',
  'me',
  'my',
  'we',
  'our',
  'the',
  'a',
  'an',
  'and',
  'or',
  'to',
  'of',
  'on',
  'in',
  'at',
  'for',
  'with',
  'from',
  'by',
  'is',
  'are',
  'be',
  'this',
  'that',
  'here',
  'there',
])

/** Whether a sentence (its quotes and code as ⟦n⟧) hands over a step now, and not as what something says. */
function handsOver(sentence: string): boolean {
  if (NOT_NOW.test(sentence)) return false
  for (const found of sentence.matchAll(STEP_NOW_EACH))
    if (!DESCRIBED.test(sentence.slice(0, found.index).trimEnd())) return true
  return false
}

/** The web addresses in a sentence as said, each once, but a Pending You card's own. */
function linksIn(said: string): string[] {
  const links = (said.match(LINK) ?? [])
    .map((link) => link.replace(LINK_END, '').replace(/\/$/u, '').toLowerCase())
    .filter((link) => !CARD_PAGE.test(link))
  return [...new Set(links)]
}

/**
 * The steps a final message hands the person to do now: "Go: approve it now: https://…", "You can merge it now", "Now
 * open the run link", "That’s your go". Not what something says ("The page now says “Go: approve it”"), the agent's own
 * act ("I’ll go ahead and merge it now"), an offer ("Approve it whenever you like") or a look ("Now open … to see it").
 */
export function stepsNow(text: string): StepNow[] {
  const { text: prose, quotes } = marked(proseOf(text))
  const steps: StepNow[] = []
  for (const each of prose.split(SENTENCE_END)) {
    const sentence = each.trim()
    if (!sentence || !handsOver(sentence)) continue
    const said = sentence.replace(MARK, (_, index: string) => quotes[Number(index)] ?? '')
    steps.push({
      text: said,
      links: linksIn(said),
      words: [
        ...new Set(wordsOf(said.replace(LINK, ' ')).filter((word) => !STEP_COMMON.has(word))),
      ],
    })
  }
  return steps
}

/** Whether lower-case words hold an address whole, ending where it ends. */
function holds(said: string, link: string): boolean {
  for (let at = said.indexOf(link); at !== -1; at = said.indexOf(link, at + 1))
    if (!LINK_GOES_ON.test(said.charAt(at + link.length))) return true
  return false
}

/**
 * Whether one card call's words (as the turn keeps them) carry a step handed over now: every web address in its
 * sentence, ignoring case and a trailing slash; with none, two of its telling words, or all of them when it has fewer.
 * A sentence with no telling words ("Go: it’s on the card.") is carried by any card call.
 */
export function carriesStep(card: string, step: StepNow): boolean {
  if (step.links.length) {
    const said = card.toLowerCase()
    return step.links.every((link) => holds(said, link))
  }
  const has = new Set(wordsOf(card))
  const shared = step.words.filter((word) => has.has(word)).length
  return shared >= Math.min(2, step.words.length)
}
