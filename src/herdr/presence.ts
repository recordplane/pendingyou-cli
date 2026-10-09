// Keeping your phone quiet while you're in Herdr (0.21.0; the person API plan §6.3's POST /v1/presence and decision 5):
// with Herdr signed in and allowed to (`presence:desk`), Pending You hears "the person is here" every 30 seconds while
// you've been active in Herdr in the last 2 minutes, and "they've left" once you haven't, so your phone holds its
// notifications for the cards Herdr shows, as it does while Pending You is open on your desk (D29). Pending You quiets
// only the cards in the sign-in's reach.
//
// "Active" is what Herdr lets a plugin see: Herdr 0.9.3 tells plugins nothing of keys typed in a pane, so it's moving
// between panes, tabs and workspaces (its focus events, which the watcher hears) and keys pressed in the plugin's own
// popup (which marks the moment in the plugin's state folder, `active`). The watcher sends it; the popup also says so
// at once as it opens, so the phone is quiet before the watcher's next look.
import { join } from 'node:path'
import { readText, writeWhole } from '../files.ts'
import type { PluginPlace } from './plugin.ts'

/** How long after the last sign of you Herdr still counts you as here. */
export const ACTIVE_MS = 2 * 60_000
/** How often Pending You hears it while you are (its presence lasts 75 seconds). */
export const HEARTBEAT_MS = 30_000

const activePath = (place: PluginPlace) => join(place.stateDir, 'active')

/** Notes that you did something in the plugin's popup just now (`now`, milliseconds). Never throws. */
export async function markActive(place: PluginPlace, now: number): Promise<void> {
  await writeWhole(activePath(place), `${Math.floor(now)}\n`, { secret: true }).catch(() => {})
}

/** When you last did something in the popup, as it noted; null when it never did. */
export async function lastActive(place: PluginPlace): Promise<number | null> {
  const text = await readText(activePath(place)).catch(() => null)
  const at = Number(text?.trim())
  return text && Number.isFinite(at) && at > 0 ? at : null
}

/** What Pending You last heard from here: whether you're here, and when it was told. */
export interface DeskState {
  here: boolean
  sentAt: number
}

export const awayDesk = (): DeskState => ({ here: false, sentAt: Number.NEGATIVE_INFINITY })

/**
 * What to tell Pending You now, given the last sign of you (`activeAt`): `true` while you've been active in the last
 * ACTIVE_MS and it last heard so HEARTBEAT_MS ago or more (or heard you'd left), `false` once when you're no longer
 * active, else nothing. The state is what it will have heard once the send goes through.
 */
export function deskStep(
  state: DeskState,
  activeAt: number | null,
  now: number,
): { state: DeskState; send: boolean | null } {
  const active = activeAt !== null && now - activeAt < ACTIVE_MS
  if (active && (!state.here || now - state.sentAt >= HEARTBEAT_MS))
    return { state: { here: true, sentAt: now }, send: true }
  if (!active && state.here) return { state: { here: false, sentAt: now }, send: false }
  return { state, send: null }
}
