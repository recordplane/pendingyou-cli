// A plain text rule the drafter runs before any model (the chief's rule 3, 2026-11-16): a final message that is Claude
// Code's own words, not the assistant's, leaves the person nothing to put on a card. Its usage-limit notice ("You've hit
// your … limit · …") was 3 of Haiku's 10 wrong flags in the backtest, and 3 of Sonnet's 7. Matched on the whole message,
// short and on its own, so an assistant that quotes one in a longer reply is still read.

/** The longest an app's own notice runs; an assistant's reply that's longer is the assistant's. */
const NOTICE_CHARS = 400

/** Claude Code's own notices, by what each one is. */
const NOTICES: readonly { id: string; pattern: RegExp }[] = [
  // "You've hit your monthly spend limit · …", "You've hit your usage limit", "You've hit your 5-hour limit".
  { id: 'limit', pattern: /^You(?:'|’)ve (?:hit|reached) your (?:[\w-]+ ){0,3}limit\b/i },
  // "Claude usage limit reached. Your limit will reset at 5pm", "5-hour limit reached ∙ resets 3pm".
  {
    id: 'limit',
    pattern: /^(?:Claude (?:AI )?)?(?:usage|[\w-]+ ?hour|weekly|session) limit reached\b/i,
  },
  { id: 'credit', pattern: /^Credit balance is too low\b/i },
  { id: 'error', pattern: /^API Error\b/ },
  { id: 'error', pattern: /^Prompt is too long\b/ },
  { id: 'interrupted', pattern: /^\[Request interrupted by user/ },
]

/** Which of Claude Code's own notices the final message is, or null when it's the assistant's own words. */
export function appNotice(final: string): string | null {
  const text = final.trim()
  if (!text || text.length > NOTICE_CHARS || text.includes('\n\n')) return null
  return NOTICES.find((notice) => notice.pattern.test(text))?.id ?? null
}
