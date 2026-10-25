// The plugin's watcher (`pendingyou herdr watch`): one per Herdr server, detached, held by a lease in the plugin's
// state folder. It listens to Herdr's events (a pane's badges changed, focus moved), reads the panes again when one
// comes, and raises a toast when a pane gains a card waiting on you, by herdr/notice.ts's rules. Herdr's `[[startup]]`
// runs `herdr watch --ensure` (start one unless one runs), as does its event hook, since a plugin just linked or
// enabled runs no startup hook. It stops once the plugin is disabled or unlinked, when Herdr goes, or when `unconfigure`
// takes its lease away. It writes nothing anywhere but its lease, and never a card's words but in the toast itself.
//
// Once Herdr is signed in to Pending You (0.21.0, `pendingyou app login herdr`), it also keeps your phone quiet while
// you're active in Herdr (herdr/presence.ts: focus moving between panes, tabs and workspaces, and keys in the popup),
// says once in a toast when the sign-in has ended (removed in Settings, replaced by a new sign-in, or run out), and
// once a day in its last 3 days that it's about to. Its toasts still come from the badges alone: the change feed is
// followed by the popup while it's open, not here, so nothing is said twice and the feed's waits stay the popup's.
//
// Show in Herdr (0.38.0, herdr/show.ts): once the sign-in holds `assistants:show`, it also follows the person's presses
// of Show on a card for this Herdr server's panes (GET /v1/shows, one wait at a time, beside the rest), and brings the
// agent's pane to the front when it's still the agent's. It follows them while the sign-in may, and stops when the
// watcher does. Nothing it hears is ever thrown: a refusal waits SHOWS_AGAIN_MS before it asks again, a sign-in that
// ended is said once as above, and the network's failures are waited out as the SDK does. Its lease says which
// pendingyou it is, so setup can tell one from before Show in Herdr and start this one's instead.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { appClient, RENEW_WITHIN_MS, readAppSignIn } from '../app-login.ts'
import { herdrServer } from '../herdr.ts'
import type { Io } from '../io.ts'
import { atLeast } from '../mod.ts'
import { type Client, type Credentials, SignedOutError } from '../sdk/index.ts'
import { VERSION } from '../version.ts'
import { due, emptyNotices, look, type Notices, type Toast } from './notice.ts'
import { readWaiting, type Waiting } from './panes.ts'
import { agentView, type PluginPlace, pluginOff, viewOn } from './plugin.ts'
import { awayDesk, type DeskState, deskStep, lastActive } from './presence.ts'
import { followHerdrShows } from './show.ts'
import { HerdrError, herdrRequest, herdrSubscribe } from './socket.ts'

/** A lease untouched this long belongs to a watcher that died. */
export const LEASE_STALE_MS = 60_000
/** How often the watcher renews its lease, and checks the plugin is still enabled. */
export const RENEW_MS = 20_000
/** How often it looks at what's due, between events. */
const TICK_MS = 1000
/** How long it waits before subscribing again after Herdr dropped it. */
const AGAIN_MS = 2000
/** The events that can change what waits on you, or which tab you're looking at. */
export const SUBSCRIPTIONS = [
  { type: 'pane.updated' },
  { type: 'pane.closed' },
  { type: 'pane.moved' },
  { type: 'pane.focused' },
  { type: 'tab.focused' },
  { type: 'workspace.focused' },
] as const

const leasePath = (place: PluginPlace) => join(place.stateDir, 'watch.lease')

/** Whether a watcher holds the lease now: its file, touched within LEASE_STALE_MS. */
export async function watching(place: PluginPlace): Promise<boolean> {
  return stat(leasePath(place)).then(
    (info) => Date.now() - info.mtimeMs < LEASE_STALE_MS,
    () => false,
  )
}

/** Takes the lease for this watcher: its id, or null when a live one holds it. It says which pendingyou this is. */
async function takeLease(place: PluginPlace): Promise<string | null> {
  const path = leasePath(place)
  await mkdir(place.stateDir, { recursive: true, mode: 0o700 })
  if (await watching(place)) return null
  const id = randomBytes(8).toString('hex')
  await rm(path, { force: true })
  try {
    await writeFile(path, JSON.stringify({ id, pid: process.pid, version: VERSION }), {
      flag: 'wx',
      mode: 0o600,
    })
    return id
  } catch {
    return null
  }
}

/** The lease's holder as its file says: its id, its process and its pendingyou (null before 0.38.0); null when none. */
async function holder(
  place: PluginPlace,
): Promise<{ id: string; pid: number; version: string | null } | null> {
  try {
    const held = JSON.parse(await readFile(leasePath(place), 'utf8')) as {
      id?: unknown
      pid?: unknown
      version?: unknown
    }
    return typeof held.id === 'string' && typeof held.pid === 'number'
      ? {
          id: held.id,
          pid: held.pid,
          version: typeof held.version === 'string' ? held.version : null,
        }
      : null
  } catch {
    return null
  }
}

/**
 * Whether the watcher running now is from an older pendingyou than this one: one from before 0.38.0 (its lease says no
 * version) doesn't follow Show in Herdr's presses. Setup stops it and starts this one's.
 */
export async function olderWatcher(place: PluginPlace): Promise<boolean> {
  if (!(await watching(place))) return false
  const held = await holder(place)
  return held !== null && (held.version === null || !atLeast(held.version, VERSION))
}

/** Renews the lease while it's this watcher's; false once it's gone (`unconfigure`) or another holds it. */
async function renew(place: PluginPlace, id: string): Promise<boolean> {
  if ((await holder(place))?.id !== id) return false
  const now = new Date()
  await utimes(leasePath(place), now, now).catch(() => {})
  return true
}

/** Stops the watcher that holds the lease, if any (`unconfigure`): its lease goes, and its process is told to stop. */
export async function stopWatcher(place: PluginPlace): Promise<boolean> {
  const held = await holder(place)
  await rm(leasePath(place), { force: true }).catch(() => {})
  if (!held) return false
  try {
    process.kill(held.pid, 'SIGTERM')
  } catch {}
  return true
}

/** Whether Herdr still has the plugin, enabled. */
export async function pluginEnabled(socket: string, pluginId: string): Promise<boolean> {
  try {
    const result = await herdrRequest<{ plugins?: unknown }>(socket, 'plugin.list', {
      plugin_id: pluginId,
    })
    const plugins = Array.isArray(result?.plugins) ? result.plugins : []
    return plugins.some(
      (plugin) =>
        typeof plugin === 'object' &&
        plugin !== null &&
        (plugin as { plugin_id?: unknown }).plugin_id === pluginId &&
        (plugin as { enabled?: unknown }).enabled === true,
    )
  } catch (error) {
    // Herdr has no such plugin: it was unlinked or uninstalled.
    if (error instanceof HerdrError && error.code === 'plugin_not_found') return false
    throw error
  }
}

/** Raises a toast through Herdr; its outcome as Herdr says it (`shown`, `disabled`, `rate_limited`…). */
export async function showToast(socket: string, toast: Toast): Promise<string> {
  try {
    const result = await herdrRequest<{ shown?: unknown; reason?: unknown }>(
      socket,
      'notification.show',
      { title: toast.title, body: toast.body, sound: 'request' },
    )
    return result?.shown === true ? 'shown' : String(result?.reason ?? 'not shown')
  } catch (error) {
    return error instanceof HerdrError ? error.code : 'failed'
  }
}

/** Sets the plugin's Agents view again when it's on (Herdr forgets it when it restarts). */
export async function reapplyView(place: PluginPlace): Promise<void> {
  if (!place.socket || !(await viewOn(place))) return
  await herdrRequest(place.socket, 'agent.view.set', agentView(place.id)).catch(() => {})
}

/**
 * One look: the panes now, what arrived, and the toast that's due (if any), raised. Exported for the tests, which
 * drive it against a pretend Herdr.
 */
export async function watchStep(
  io: Pick<Io, 'now'>,
  socket: string,
  state: Notices,
  options: { read: boolean; last: { waiting: Waiting[]; viewing: string | null } },
): Promise<{
  state: Notices
  last: { waiting: Waiting[]; viewing: string | null }
  toast: string | null
}> {
  let last = options.last
  let next = state
  if (options.read) {
    const { snapshot, waiting } = await readWaiting(socket)
    last = { waiting, viewing: snapshot.focusedTab }
    next = look(next, last.waiting, io.now())
  }
  const decided = due(next, last.waiting, io.now(), last.viewing)
  next = decided.state
  const toast = decided.toast ? await showToast(socket, decided.toast) : null
  return { state: next, last, toast }
}

/** Herdr's events that mean you moved in it: a pane, tab or workspace focused (as subscribed, or as delivered). */
const FOCUS_EVENTS = new Set([
  'pane.focused',
  'tab.focused',
  'workspace.focused',
  'pane_focused',
  'tab_focused',
  'workspace_focused',
])

/** How often the watcher asks Pending You when Herdr's sign-in ends. */
const EXPIRY_CHECK_MS = 6 * 60 * 60_000

/** How long the watcher waits to follow Show in Herdr's presses again after Pending You refused to let it. */
export const SHOWS_AGAIN_MS = 10 * 60_000

/** A sign-in, as the watcher tells them apart: by its key, which each new sign-in makes and keeps as its tokens renew. */
const signInOf = (stored: Credentials) => `${stored.key.x}.${stored.key.y}`

/** What a toast about Herdr's own sign-in says. */
export const SIGNED_OUT_TOAST: Toast = {
  title: 'Pending You · Herdr is signed out',
  body: 'Removed in Settings, signed in again, or ended. To answer from Herdr again: Pending You: set up.',
}
export const endingToast = (days: number): Toast => ({
  title: `Pending You · Herdr’s sign-in ends in ${days} day${days === 1 ? '' : 's'}`,
  body: 'Sign in again before then: Pending You: set up.',
})

/**
 * Herdr's sign-in, as the watcher keeps it: your presence while you're active in Herdr, a toast when the sign-in has
 * ended or is about to, and Show in Herdr's presses followed while it may. Quiet when Herdr isn't signed in; never
 * throws.
 */
export function signInKeeper(io: Io, socket: string, place: PluginPlace) {
  let client: Client | null = null
  /** The sign-in the client is for (signInOf): a client renews its own tokens, so only a new sign-in needs a new one. */
  let current: string | null = null
  let presence = false
  /** Whether the sign-in may bring the agent that asked to the front here (assistants:show). */
  let shows = false
  let desk: DeskState = awayDesk()
  let checkedAt = Number.NEGATIVE_INFINITY
  /** The sign-in that was said to have ended, so it's said once. */
  let endedSignIn: string | null = null
  let warnedAt = Number.NEGATIVE_INFINITY
  let focusAt: number | null = null
  /** This Herdr server as the agents' presence names it: without it no show can be told to be this one's. */
  const server = herdrServer(io.env, io.host)
  /** Show in Herdr's presses while they're followed: for which sign-in, and what stops it. */
  let following: { signIn: string; stop: AbortController } | null = null
  /** When Pending You last refused to let a sign-in follow them: it isn't asked again for SHOWS_AGAIN_MS. */
  let refused: { signIn: string; at: number } | null = null

  const stopShows = () => {
    following?.stop.abort()
    following = null
  }
  /** The sign-in `which` has ended: said once in a toast, and nothing more is asked with it. */
  const ended = async (which: string | null = current) => {
    if (which === null || which !== current) return
    client = null
    stopShows()
    if (endedSignIn !== which) {
      endedSignIn = which
      await showToast(socket, SIGNED_OUT_TOAST)
    }
  }
  /** Follows Show in Herdr's presses with the sign-in's client, unless it does already or mayn't now. */
  const followShows = () => {
    if (!client || !current || !shows || !server || following || io.signal.aborted) return
    if (refused?.signIn === current && io.now() - refused.at < SHOWS_AGAIN_MS) return
    const run = { signIn: current, stop: new AbortController() }
    following = run
    void followHerdrShows(client, { socket, server, signal: run.stop.signal })
      .catch(async (error: unknown) => {
        // Its sign-in ended (removed in Settings, replaced, run out): said once, as for presence. Any other refusal
        // (no computer, no scope, a Pending You without shows): asked again later, not at every look.
        if (error instanceof SignedOutError) await ended(run.signIn)
        else refused = { signIn: run.signIn, at: io.now() }
      })
      .catch(() => {})
      .finally(() => {
        if (following === run) following = null
      })
  }
  return {
    /** A Herdr event: moving between panes, tabs and workspaces is you in Herdr. */
    heard(event: string) {
      if (FOCUS_EVENTS.has(event)) focusAt = io.now()
    },
    /** Looks at the sign-in again (a new one, or none any more), and follows Show in Herdr's presses while it may. */
    async renew() {
      const stored = await readAppSignIn(io, 'herdr').catch(() => null)
      const signIn = stored ? signInOf(stored) : null
      if (!stored || signIn === endedSignIn) {
        client = null
        current = signIn
        stopShows()
        return
      }
      if (signIn !== current || !client) {
        current = signIn
        client = appClient(io, 'herdr')
        // A new sign-in: the presses are followed with its own client.
        stopShows()
      }
      presence = stored.scopes.includes('presence:desk')
      shows = stored.scopes.includes('assistants:show')
      if (shows) followShows()
      else stopShows()
    },
    /** Stops following Show in Herdr's presses: the watcher is stopping. */
    stop() {
      stopShows()
    },
    /** One look: presence when it's due, and the sign-in's end when it's time to ask. */
    async tick() {
      if (!client) return
      const now = io.now()
      if (presence) {
        const popup = await lastActive(place)
        const activeAt = Math.max(focusAt ?? -1, popup ?? -1)
        const step = deskStep(desk, activeAt >= 0 ? activeAt : null, now)
        if (step.send !== null)
          try {
            await client.presence(step.send)
            desk = step.state
          } catch (error) {
            if (error instanceof SignedOutError) return ended()
          }
      }
      if (now - checkedAt >= EXPIRY_CHECK_MS) {
        checkedAt = now
        try {
          const me = await client.me()
          const left = Date.parse(me.grant.expiresAt) - now
          if (left <= RENEW_WITHIN_MS && now - warnedAt >= 24 * 60 * 60_000) {
            warnedAt = now
            await showToast(socket, endingToast(Math.max(1, Math.ceil(left / 86_400_000))))
          }
        } catch (error) {
          if (error instanceof SignedOutError) return ended()
        }
      }
    },
  }
}

/**
 * `pendingyou herdr watch`: the watcher itself, until the plugin is disabled or turned off (`unconfigure`), Herdr goes
 * or its lease is taken. `--ensure`: start one in the background unless one runs (and set the Agents view again),
 * then exit.
 */
export async function watch(
  io: Io,
  place: PluginPlace,
  options: { ensure: boolean },
): Promise<number> {
  if (!place.socket || (await pluginOff(place))) return 0
  if (options.ensure) {
    await reapplyView(place)
    if (!(await watching(place))) io.background(['herdr', 'watch'])
    return 0
  }
  const lease = await takeLease(place)
  if (!lease) return 0
  const socket = place.socket
  let state = emptyNotices()
  let last: { waiting: Waiting[]; viewing: string | null } = { waiting: [], viewing: null }
  const signIn = signInKeeper(io, socket, place)
  try {
    while (!io.signal.aborted) {
      if (!(await renew(place, lease)) || !(await pluginEnabled(socket, place.id))) return 0
      await signIn.renew()
      const live = { changed: true, ending: null as string | null }
      const subscription = herdrSubscribe(socket, SUBSCRIPTIONS, (event) => {
        live.changed = true
        signIn.heard(event.event)
      })
      void subscription.done.then((how) => {
        live.ending = how
      })
      try {
        await subscription.started
      } catch {}
      // What's there as it starts (again) is known already: only what arrives after is news.
      state = { ...state, seeded: false }
      let checked = io.now()
      while (live.ending === null && !io.signal.aborted) {
        try {
          const step = await watchStep(io, socket, state, { read: live.changed, last })
          live.changed = false
          state = step.state
          last = step.last
        } catch {
          live.changed = true
        }
        await signIn.tick().catch(() => {})
        if (io.now() - checked >= RENEW_MS) {
          checked = io.now()
          await signIn.renew()
          // Read everything again now and then, in case an event went missing.
          live.changed = true
          const enabled = await pluginEnabled(socket, place.id).catch(() => true)
          if (!(await renew(place, lease)) || !enabled || (await pluginOff(place))) {
            subscription.stop()
            return 0
          }
        }
        await io.sleep(TICK_MS, io.signal)
      }
      subscription.stop()
      if (live.ending === 'closed' || live.ending === 'stopped') return 0
      // Herdr dropped the subscription (it fell behind): read everything again, and subscribe again.
      await io.sleep(AGAIN_MS, io.signal)
    }
    return 0
  } catch {
    return 0
  } finally {
    // Show in Herdr's wait is given up with the watcher.
    signIn.stop()
    if ((await holder(place))?.id === lease)
      await rm(leasePath(place), { force: true }).catch(() => {})
  }
}
