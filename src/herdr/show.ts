// Show in Herdr (0.38.0; Show me, docs/plans/2026-10-25-show-me.md §4): the person presses Show in Herdr on a card in
// Pending You, and Herdr moves to the pane of the agent that asked, on every client attached to it. The plugin's watcher
// (herdr/watch.ts), once Herdr's sign-in holds `assistants:show`, follows those presses for Herdr panes on this computer
// through the SDK's followShows (GET /v1/shows?places=herdr, one wait at a time), and for each:
//
// 1. mine: a place is this watcher's only when its `server` is this Herdr server's hash (herdrServer, with the
//    watcher's own HERDR_SOCKET_PATH). A show with no place of its own is left unanswered: that server's watcher
//    answers it.
// 2. find: Herdr's panes now (`session.snapshot`), and the first of the show's places (its sessions, newest first)
//    whose pane is there and is the agent's: its py_cards badge lists the card, or else Herdr says the pane runs that
//    kind of agent (`claude` for Claude Code: HERDR_AGENTS). None: Pending You hears `not_found`, and nothing moves.
// 3. focus: `pane.focus` on that pane, from Herdr's own list, never a place as the network sent it (as `next` and the
//    popup's `t` do), then `shown`.
//
// Nothing else, ever: it never types into a pane, runs or opens anything for a show, and asks Herdr for nothing but its
// panes and that one focus. It prints nothing (the watcher prints nowhere), so never a card's title, an agent's name or
// a pane's. What it hears is ids, and the agent's name, which it never uses.
import { isAppId } from '../apps/ids.ts'
import { HERDR_AGENTS, TOKENS } from '../herdr.ts'
import type { Client, Show, ShowPlace } from '../sdk/index.ts'
import { idsOf, readSnapshot } from './panes.ts'
import { herdrRequest } from './socket.ts'

/** The kind of place the watcher brings to the front: Herdr's panes. */
export const SHOW_PLACES = ['herdr'] as const

/** A pane as this Herdr lists it now: all a show can bring to the front. */
export interface ShowPane {
  paneId: string
}

/** Whether a show's place is this Herdr server's: a Herdr pane on the server with this hash. */
export const placeHere =
  (server: string) =>
  (place: ShowPlace): boolean =>
    place.app === 'herdr' && place.server === server

/** Herdr's name for an app's agent (`claude` for Claude Code); null for an app the command line doesn't run. */
const herdrAgentOf = (app: string) => (isAppId(app) ? HERDR_AGENTS[app] : null)

/**
 * The agent's pane in this Herdr now: the first of the show's places whose pane is there and is the agent's, by its
 * badge (py_cards lists the card) or else by the kind of agent Herdr says it runs. Null when none is.
 */
export async function showPane(socket: string, show: Show): Promise<ShowPane | null> {
  const result = await herdrRequest<{ snapshot?: unknown }>(socket, 'session.snapshot')
  const { panes } = readSnapshot(result?.snapshot)
  const agent = herdrAgentOf(show.agent.app)
  for (const place of show.places) {
    const pane = panes.find((each) => each.paneId === place.paneId)
    if (!pane) continue
    if (idsOf(pane.tokens[TOKENS.cards]).includes(show.card.id)) return { paneId: pane.paneId }
    if (agent !== null && pane.agent === agent) return { paneId: pane.paneId }
  }
  return null
}

/** Brings a pane to the front: Herdr moves every client attached to it there. */
export async function focusPane(socket: string, pane: ShowPane): Promise<void> {
  await herdrRequest(socket, 'pane.focus', { pane_id: pane.paneId })
}

/**
 * Follows the person's presses of Show for this Herdr server's panes, answering each of its own, until `signal`
 * aborts. It rejects only when the sign-in can't follow them: it ended (SignedOutError), or Pending You refused it
 * (ApiError). Herdr's failures are answers (`not_found`), and the network's are waited out (the SDK's backoff).
 */
export function followHerdrShows(
  client: Pick<Client, 'followShows'>,
  options: { socket: string; server: string; signal: AbortSignal },
): Promise<void> {
  const { socket, server, signal } = options
  return client.followShows<ShowPane>({
    places: [...SHOW_PLACES],
    mine: placeHere(server),
    find: (show) => showPane(socket, show),
    focus: (pane) => focusPane(socket, pane),
    signal,
  })
}
