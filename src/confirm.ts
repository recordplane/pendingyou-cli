// "Confirm in your agent" (guide 2.21, CLI 0.9.0). Some steps an agent takes only on its person's own words in its
// conversation: a card answer reaches it as a tool's result, and its rules (or its app's) want more for something that
// can't be undone, credentials, or anything outside its sandbox. That's right, but on 2026-10-03 a Claude Code agent
// declined to act on an approved "Erase disk12?" card, asked for "yes, erase disk12" in its own chat, and never told
// Pending You, so the person had to go and find the session.
//
// The Stop hook (stopcheck.ts) now catches a final message that asks the person to type or reply something in this
// chat: asksToTypeHere finds it, cardFits says whether a card already asks for it (one posted in the turn, or one still
// open), and confirmReason is what Claude Code reads when none does: post an action card that sends them here, with
// the exact words as a step's command and, when Claude Code says it, the session's link.
//
// Pattern matching only, deliberately narrow (a block costs a whole extra turn): an ask said to the person (an
// imperative, "please …", "can you …", "I need you to …"), with the words quoted or a plain "yes", and anchored to this
// chat ("here", "in this chat") or to going ahead ("to confirm", "and I'll …"). Never in code, block quotes or quoted
// text; never what a program, a page or a message says; never a step somewhere else (their terminal, a prompt, a page,
// a link) or a standing offer ("anytime"); never a command or slash command to run.

/** Verbs that hand the person something to type. */
const VERB = '(?:type|reply|respond|write|say|send|enter|paste|answer)'

/**
 * What comes right before a verb said to the person: the start of a sentence or clause, "and"/"then", a request
 * ("can you", "I need you to", "I'll wait for you to", "you'll need to", "you can"), then any "please", "just" or
 * "now".
 */
const LEAD = String.raw`(?:^|[,;:(—–→]\s*|\s-\s+|\b(?:and|then|or|so)\s+|\b(?:can|could|would|will)\s+you\s+|\b(?:need|want|like|for)\s+you\s+to\s+|\byou(?:’|')ll\s+(?:need|have)\s+to\s+|\byou\s+(?:need|have)\s+to\s+|\byou\s+can\s+|\ball\s+you\s+need\s+to\s+do\s+is\s+)(?:(?:please|just|simply|kindly|now|then)\s+)*`
const ASK = new RegExp(`${LEAD}${VERB}\\b`, 'giu')
/** "Confirm here", "please confirm in this chat", "can you confirm it here". */
const CONFIRM_HERE = new RegExp(
  `${LEAD}confirm(?:\\s+(?:it|this|that|so))?\\s+(?:here|below|in\\s+(?:this|our|the)\\s+(?:chat|conversation|session))\\b`,
  'iu',
)
/** "Confirm (in this chat) by typing “…”". */
const CONFIRM_BY =
  /\bconfirm\b[^.!?\n]{0,30}?\bby\s+(?:typing|replying(?:\s+with)?|saying|sending)\s+⟦(\d+)⟧/iu

/** This chat: where the words go. */
const HERE =
  /\b(?:here|below|in\s+(?:this|our|the)\s+(?:chat|conversation|session)|in\s+chat|in\s+this\s+(?:terminal|window)|(?:back\s+)?to\s+me)\b/iu
/** What typing it does: lets the agent go ahead. */
const PURPOSE =
  /\b(?:to\s+(?:confirm|proceed|continue|go\s+ahead|approve|start|begin|carry\s+on|unblock\s+me)|(?:and|so|then)\s+I(?:’|')ll\b|(?:and|so)\s+I\s+(?:can|will)\b|if\s+you\s+want\s+me\s+to\b|when\s+you(?:’|')re\s+ready\b|before\s+I\b)/iu
/** Plain words people are asked to type without quotes. */
const PLAIN_WORD =
  /^\s*(?:back\s+)?(?:with\s+)?(go ahead|ship it|do it|yes|y|ok|okay|go|proceed|confirm|confirmed|continue|approve|approved)\b/iu
/**
 * What may come between the verb and the quoted words: "Reply here with “…”", "Type these words in this chat: “…”",
 * "Reply with the exact phrase “…”". Never a recipient ("Reply to Sarah with “…”").
 */
const FILLER =
  /^(?:\s|[,:]|back\b|me\b|it\b|to me\b|with\b|exactly\b|precisely\b|verbatim\b|just\b|the\b|exact\b|following\b|phrase\b|words?\b|text\b|these\b|this\b|that\b|here\b|below\b|in (?:this|our) (?:chat|conversation|session|terminal|window)\b)*$/iu

/** Somewhere else to type it: their terminal, a prompt, a page or a form, or a link (but this session's own). */
const ELSEWHERE =
  /\b(?:in|into|at|on)\s+(?:your|a|the|that|their)\s+(?:terminal|shell|browser|console|prompt|form|field|dialog|email|inbox|page|app|site|website|portal|dashboard)\b|\bin\s+(?:Terminal|iTerm)\b|\bwhen\s+(?:prompted|asked|it\s+asks)\b|\bat\s+the\s+prompt\b|https?:\/\/(?!claude\.ai\/code\/)/iu
/** This chat, said outright, which wins over another place in the same sentence. */
const THIS_CHAT = /\bin\s+(?:this|our)\s+(?:chat|conversation|session)\b/iu
/** A standing offer, not a wait: "Say “stop” anytime". */
const OFFER =
  /\b(?:any\s?time|whenever|at\s+any\s+(?:point|time)|if\s+you\s+change\s+your\s+mind|if\s+(?:anything|something)\s+(?:looks|seems|goes))\b/iu
/** What something says rather than an ask: "The email ends with: Reply “STOP” here". */
const DESCRIBED =
  /\b(?:says?|said|reads?|ends?\s+with|starts?\s+with|shows?|prints?|displays?|asks?|prompts?|tells?\s+\w+|text|message|copy|label|button|template)\s*[:,]?$/iu
/** A command or a slash command: a step to run (the general check's business), not words to type to the agent. */
const COMMAND_LIKE =
  /^\s*(?:[!/]|\$\s|(?:cd|npm|npx|pnpm|yarn|bun|git|gh|curl|wget|brew|node|python3?|pip|docker|ssh|scp|sudo|claude|codex|wrangler)\s)/u

/** Quoted spans the words come in: “…”, "…", `…`, ‘…’ and '…' (not an apostrophe). */
const QUOTED =
  /“([^“”\n]{1,160})”|"([^"\n]{1,160})"|`([^`\n]{1,160})`|‘([^‘’\n]{1,160})’|(?<![\p{L}\p{N}])'([^'\n]{1,160})'(?![\p{L}\p{N}])/gu

/**
 * The text as it reads to the person: without fenced code and block quotes (quoted words stay), and without Markdown's
 * list markers, headings and emphasis (`**Reply “yes” here**`).
 */
export function proseOf(text: string): string {
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
        .replace(/^\s*(?:[-*•+]|\d+[.)])\s+/u, '')
        .replace(/^\s*#+\s*/u, '')
        .replace(/\*+|__/gu, ''),
    )
  }
  return kept.join('\n')
}

/** What the person is asked to type, when the message says it ("yes, erase disk12"), or null ("confirm here"). */
export interface TypeHere {
  words: string | null
}

/** Each quoted span replaced by ⟦n⟧, with what it held. */
function marked(text: string): { text: string; quotes: string[] } {
  const quotes: string[] = []
  const out = text.replace(QUOTED, (...groups: unknown[]) => {
    const inner = groups.slice(1, 6).find((group) => typeof group === 'string') as string
    quotes.push(inner.trim())
    return `⟦${quotes.length - 1}⟧`
  })
  return { text: out, quotes }
}

/** One sentence's ask, or null. `quotes` are the message's quoted spans, by marker number. */
function askIn(sentence: string, quotes: readonly string[]): TypeHere | null {
  if ((ELSEWHERE.test(sentence) && !THIS_CHAT.test(sentence)) || OFFER.test(sentence)) return null
  const by = CONFIRM_BY.exec(sentence)
  if (by) {
    const words = quotes[Number(by[1])] ?? ''
    if (words && !COMMAND_LIKE.test(words)) return { words }
  }
  for (const found of sentence.matchAll(ASK)) {
    const start = found.index ?? 0
    // What a program, a page or a message says isn't an ask: "The SMS ends with: Reply “STOP” here".
    if (DESCRIBED.test(sentence.slice(0, start).trimEnd())) continue
    const from = start + found[0].length
    const tail = sentence.slice(from, from + 140)
    const quote = /⟦(\d+)⟧/u.exec(tail)
    let words: string | null = null
    let after = tail
    let before = ''
    if (quote && FILLER.test(tail.slice(0, quote.index))) {
      words = quotes[Number(quote[1])] ?? null
      before = tail.slice(0, quote.index)
      after = tail.slice(quote.index + quote[0].length)
    } else {
      const plain = PLAIN_WORD.exec(tail)
      if (plain) {
        words = (plain[1] as string).toLowerCase()
        after = tail.slice(plain[0].length)
      }
    }
    if (words !== null) {
      if (COMMAND_LIKE.test(words)) continue
      // Anchored to this chat or to going ahead, or the ask stands alone: "Reply “yes, erase disk12”."
      const near = after.slice(0, 80)
      const alone = quote !== null && /^[\s.!)…]*$/u.test(after)
      if (HERE.test(before) || HERE.test(near) || PURPOSE.test(near) || alone) return { words }
      continue
    }
    // "Reply here to confirm": no words, but here and going ahead.
    if (HERE.test(tail.slice(0, 40)) && PURPOSE.test(tail.slice(0, 80))) return { words: null }
  }
  return CONFIRM_HERE.test(sentence) ? { words: null } : null
}

/**
 * Whether the final message asks the person to type or reply something in this chat, and what: "Reply “yes, erase
 * disk12” here", "To confirm, type `yes`", "Please reply yes here and I'll merge it", "Confirm here". Null otherwise.
 */
export function asksToTypeHere(text: string): TypeHere | null {
  const { text: prose, quotes } = marked(proseOf(text))
  for (const sentence of prose.split(/(?<=[.!?])\s+|\n+/u)) {
    const ask = askIn(sentence.trim(), quotes)
    if (ask) return ask
  }
  return null
}

/** Words that don't tell one card from another: "yes", "confirm", "please"… */
const COMMON = new Set([
  'yes',
  'y',
  'ok',
  'okay',
  'sure',
  'please',
  'confirm',
  'confirmed',
  'go',
  'ahead',
  'proceed',
  'continue',
  'approve',
  'approved',
  'do',
  'it',
  'i',
  'the',
  'a',
  'an',
  'to',
  'and',
  'of',
  'me',
  'my',
  'this',
  'that',
])

const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

/** The words that say what's being confirmed: "yes, erase disk12" → erase, disk12. */
export const telling = (words: string | null) =>
  words === null ? [] : [...new Set(wordsOf(words).filter((word) => !COMMON.has(word)))]

/**
 * Whether a card asks for this: one posted in the turn (`posted`: the words its call carried) or one still open
 * (`open`: its title). A card fits when it names everything that tells the words apart ("erase" and "disk12" for
 * “yes, erase disk12”). With nothing to tell them by ("yes", or no words at all), any card posted in the turn fits,
 * and an open one only when its title asks to confirm; an open "Confirm …" card that names some of them fits too.
 */
export function cardFits(text: string, words: string | null, where: 'posted' | 'open'): boolean {
  const wanted = telling(words)
  const has = new Set(wordsOf(text))
  if (wanted.length && wanted.every((word) => has.has(word))) return true
  if (where === 'posted') return wanted.length === 0
  return /\bconfirm/i.test(text) && (wanted.length === 0 || wanted.some((word) => has.has(word)))
}

/**
 * The session's link when Claude Code says it: Remote Control's session (CLAUDE_CODE_BRIDGE_SESSION_ID, in `session_`
 * form) or a session on the web (CLAUDE_CODE_REMOTE_SESSION_ID, whose `cse_` is the link's `session_`), as
 * https://code.claude.com/docs/en/env-vars documents them. Null when neither is set.
 */
export function sessionLink(env: Record<string, string | undefined>): string | null {
  const bridge = env.CLAUDE_CODE_BRIDGE_SESSION_ID?.trim()
  if (bridge && /^session_[A-Za-z0-9]{8,80}$/.test(bridge))
    return `https://claude.ai/code/${bridge}`
  const remote = env.CLAUDE_CODE_REMOTE_SESSION_ID?.trim()
  if (remote && /^(?:cse|session)_[A-Za-z0-9]{8,80}$/.test(remote))
    return `https://claude.ai/code/${remote.replace(/^cse_/, 'session_')}`
  return null
}

/** The most of the asked-for words the reason repeats. */
export const REASON_WORDS = 60

/**
 * What the agent reads when it asked for words here and no card says so: post the action card that sends them here,
 * following the card they already answered (about 65 tokens, 80 with a link; 0.32.0 stopped teaching reopen). `app` names where to type them: Claude
 * Code, or (0.11.0) Codex.
 */
export function confirmReason(
  words: string | null,
  link: string | null,
  app = 'Claude Code',
): string {
  const chars = [...(words?.replace(/\s+/g, ' ').trim() ?? '')]
  const shown =
    chars.length > REASON_WORDS
      ? `${chars
          .slice(0, REASON_WORDS - 1)
          .join('')
          .trimEnd()}…`
      : chars.join('')
  const asked = shown ? `to type “${shown}” here` : 'to confirm here'
  const what = shown ? 'those exact words' : 'the words to type'
  return `You asked them ${asked}, but no open Pending You card says so: post an action card “Confirm in ${app} on <computer>: <step>” with ${what} as a step command, where ${app} on <computer>${link ? `, ${link}` : ''}, done what you’ll do (after a card they answered: with follows, its requestId).`
}
