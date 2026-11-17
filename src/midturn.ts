// Told mid-task (0.43.3, 2026-11-17): an assistant in the middle of a long task when its person answers is told
// at its next tool call, once, in one line; an idle one is woken as before; nobody is told twice. The line's words, the
// same as the Claude Code wake mod's (packages/claude-plugin's wake.ts midTurnText; a test holds them equal). Never the
// answer's own words: the agent reads it with get_request, as the line says.

/** What happened, for the line: an answer, a message, a reply on an answer, a word, a fallback, a withdrawal, a hand-off. */
export type MidTurnKind =
  | 'answered'
  | 'wrote'
  | 'replied'
  | 'word'
  | 'fallback'
  | 'withdrawn'
  | 'handed'
  | 'handed-reply'

export interface MidTurnItem {
  kind: MidTurnKind
  title: string
  requestId: string
  /** The name to read it with (get_request's `name`). */
  name?: string
}

/** The most of a title the line repeats, and the most cards it names before "and N more". */
export const MID_TURN_TITLE_CHARS = 60
export const MID_TURN_SHOWN = 3

function midTitle(title: string): string {
  const flat = title.replace(/\s+/g, ' ').trim().replaceAll('“', '‘').replaceAll('”', '’')
  const chars = [...flat]
  return chars.length <= MID_TURN_TITLE_CHARS
    ? flat
    : `${chars
        .slice(0, MID_TURN_TITLE_CHARS - 1)
        .join('')
        .trimEnd()}…`
}

function midPhrase(item: MidTurnItem): string {
  const titled = `“${midTitle(item.title)}” (${item.requestId})`
  switch (item.kind) {
    case 'answered':
      return `your person answered ${titled}`
    case 'wrote':
      return `your person wrote to you on ${titled}`
    case 'replied':
      return `your person replied to your answer ${titled}`
    case 'word':
      return `there’s word on ${titled}`
    case 'fallback':
      return `nobody answered ${titled} in time, so its fallback is due`
    case 'withdrawn':
      return `${titled} was withdrawn`
    case 'handed':
      return `your person handed you ${titled}`
    case 'handed-reply':
      return `there’s a reply on the question handed to you, ${titled}`
  }
}

/** The read, by the id the phrase already gave: get_request, with the name where sessions share a sign-in. */
const midRead = (item: MidTurnItem) => `get_request${item.name ? ` (name “${item.name}”)` : ''}`

/** The line a session is told mid-task, as the wake mod's midTurnText says it; null for none. */
export function midTurnText(items: readonly MidTurnItem[]): string | null {
  if (items.length === 0) return null
  if (items.length === 1) {
    const item = items[0] as MidTurnItem
    if (item.kind === 'withdrawn')
      return `Pending You, while you were working: ${midPhrase(item)}. Nothing to do.`
    return `Pending You, while you were working: ${midPhrase(item)}. Read it now with ${midRead(item)}, and act on it at the next sensible point in this task.`
  }
  const shown = items.slice(0, MID_TURN_SHOWN)
  const more = items.length - shown.length
  return [
    'Pending You, while you were working:',
    ...shown.map((item) =>
      item.kind === 'withdrawn'
        ? `- ${midPhrase(item)}: nothing to do.`
        : `- ${midPhrase(item)}: ${midRead(item)}.`,
    ),
    ...(more > 0 ? [`- and ${more} more: list_pending with your name.`] : []),
    'Read each now, and act on them at the next sensible point in this task.',
  ].join('\n')
}
