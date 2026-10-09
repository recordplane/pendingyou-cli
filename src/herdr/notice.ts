// When the plugin's watcher (herdr/watch.ts) raises a toast, as plain functions with no Herdr in them: a card that
// arrived on a pane's badges since the last look, once it's ready, batched with any others, and never for the tab
// you're looking at (Herdr keeps its own toasts out of that tab too). The plan's noise rules (§3.3):
//
// - nothing for what was already there when the watcher started looking (a restart is no news);
// - a card also asked in the conversation (py_asked) waits ASKED_QUIET_MS first, standing in for the person's handoff
//   minutes, which the plugin can't read; one answered by then is never toasted;
// - cards ready within COALESCE_MS of each other make one toast ("3 new cards"), never a burst;
// - nothing for a card in the tab you're viewing: you can see it.
import { APP_NAMES } from '../apps/ids.ts'
import { cleanValue } from '../herdr.ts'
import type { Waiting } from './panes.ts'

/** How long a card also asked in the conversation stays quiet. */
export const ASKED_QUIET_MS = 3 * 60_000
/** How long the first ready card waits for others, so they make one toast. */
export const COALESCE_MS = 3000
/** Herdr's most for a toast's title and body. */
export const TOAST_TITLE_MAX = 80
export const TOAST_BODY_MAX = 240

/** A card that arrived on a pane's badges: when it was first seen, and whether it was also asked in the conversation. */
export interface Arrival {
  requestId: string
  paneId: string
  seen: number
  asked: boolean
}

export interface Notices {
  /**
   * Each pane's cards at the last look: their ids (a card past what the token holds as `<pane>#<n>`) and how many.
   */
  known: Map<string, { ids: Set<string>; count: number }>
  /** Arrivals not toasted yet. */
  pending: Arrival[]
  /** False until the first look, which only learns what's there. */
  seeded: boolean
}

export const emptyNotices = (): Notices => ({ known: new Map(), pending: [], seeded: false })

/** A pane's cards as the watcher counts them: its ids, and one more `<pane>#<n>` for each past what the token holds. */
function cardsOf(waiting: Waiting): string[] {
  const extra = Math.max(0, waiting.waiting - waiting.cards.length)
  return [
    ...waiting.cards,
    ...Array.from(
      { length: extra },
      (_, index) => `${waiting.paneId}#${waiting.cards.length + index + 1}`,
    ),
  ]
}

/**
 * What the panes say now: the cards that arrived since the last look, and arrivals no longer waiting dropped. A pane
 * gains a card only when it has more than before: a card answered can bring one into what the token holds that was
 * there all along.
 */
export function look(state: Notices, waiting: readonly Waiting[], now: number): Notices {
  const known: Notices['known'] = new Map()
  const arrived: Arrival[] = []
  for (const pane of waiting) {
    const cards = cardsOf(pane)
    known.set(pane.paneId, { ids: new Set(cards), count: pane.waiting })
    if (!state.seeded) continue
    const before = state.known.get(pane.paneId) ?? { ids: new Set<string>(), count: 0 }
    const gained = pane.waiting - before.count
    if (gained <= 0) continue
    for (const requestId of cards.filter((id) => !before.ids.has(id)).slice(0, gained))
      arrived.push({
        requestId,
        paneId: pane.paneId,
        seen: now,
        asked: pane.asked.includes(requestId),
      })
  }
  const still = state.pending.filter((arrival) =>
    known.get(arrival.paneId)?.ids.has(arrival.requestId),
  )
  return { known, pending: [...still, ...arrived], seeded: true }
}

/** When an arrival may be toasted. */
const readyAt = (arrival: Arrival) => arrival.seen + (arrival.asked ? ASKED_QUIET_MS : 0)

/** A toast, as Herdr's notification.show takes it. */
export interface Toast {
  title: string
  body: string
}

/** Who's waiting: the name the agent goes by with Pending You, else its app's. */
const who = (pane: Waiting) => pane.agent ?? (pane.app ? APP_NAMES[pane.app] : 'An agent')

/** The toast for arrivals on these panes (most pressing first): one card, or how many, and where. */
export function toastFor(arrivals: readonly Arrival[], waiting: readonly Waiting[]): Toast | null {
  const panes = waiting.filter((pane) => arrivals.some((arrival) => arrival.paneId === pane.paneId))
  const first = panes[0]
  if (!first) return null
  const more = first.waiting > 1 ? ` (+${first.waiting - 1} more)` : ''
  const others =
    panes.length > 1 ? `, and ${panes.length - 1} more pane${panes.length > 2 ? 's' : ''}` : ''
  const title =
    arrivals.length === 1
      ? `Pending You · ${who(first)} is waiting on you`
      : `Pending You · ${arrivals.length} new cards waiting on you`
  const body = `${first.card ?? 'A new card'}${more} · ${first.workspace} › ${first.tab}${others}`
  return { title: cleanValue(title, TOAST_TITLE_MAX), body: cleanValue(body, TOAST_BODY_MAX) }
}

/**
 * The toast due now, if any, and what's left pending: every arrival ready by the time the first ready one has waited
 * COALESCE_MS, without those in the tab you're viewing (dropped: you can see them).
 */
export function due(
  state: Notices,
  waiting: readonly Waiting[],
  now: number,
  viewingTab: string | null,
): { toast: Toast | null; state: Notices } {
  const ready = state.pending.filter((arrival) => readyAt(arrival) <= now)
  if (ready.length === 0) return { toast: null, state }
  const first = Math.min(...ready.map(readyAt))
  if (now < first + COALESCE_MS) return { toast: null, state }
  const rest = state.pending.filter((arrival) => !ready.includes(arrival))
  const tabOf = new Map(waiting.map((pane) => [pane.paneId, pane.tabId]))
  const shown = ready.filter((arrival) => tabOf.get(arrival.paneId) !== viewingTab)
  return {
    toast: shown.length ? toastFor(shown, waiting) : null,
    state: { ...state, pending: rest },
  }
}
