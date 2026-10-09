// The plugin's popup once Herdr is signed in (0.21.0; Herdr plugin 0.2; the person API plan PR 13): your cards from
// Pending You, the chosen one open, answered with a key (herdr/answer.ts says which), through the SDK as Herdr, with
// its own sign-in and key (`pendingyou app login herdr`, apps/herdr.json). Nothing else in the command line answers.
//
// - What it shows: the cards waiting on you that the sign-in reaches (this computer's agents', or all of them with the
//   tick), in Pending You's order, and how many wait elsewhere. It reads them as it opens, again whenever the change
//   feed (GET /v1/changes, followed while it's open) says something changed, and every 30 seconds besides.
// - Where each card's agent is: its pane in this Herdr, from the agents' badges (py_cards) or, failing those, the
//   agent's sessions running now (`liveSessions`, whose `terminal` names the pane and this Herdr server's hash). `t`
//   goes there.
// - Undo: an answer, Later or handing over can be taken back with `u` for 5 seconds (Pending You's hold for an answer).
// - High stakes are never answered here (answer.ts); `o` opens the card in Pending You.
// - Presence: opening it, and every key, tells Pending You you're here (herdr/presence.ts).
// - `--demo`: made-up cards and nothing sent, for screenshots.
// It never logs, and never writes a card's words anywhere but the screen.
import { appClient, readAppSignIn } from '../app-login.ts'
import { herdrServer } from '../herdr.ts'
import type { Io } from '../io.ts'
import { ApiError, type Assistant, type Card, type Client, SignedOutError } from '../sdk/index.ts'
import {
  askerOf,
  emptyQueue,
  HIGH_STAKES,
  type QueueEffect,
  type QueueState,
  queueKey,
  queueLines,
  sentState,
  targetsFor,
  UNDO_MS,
} from './answer.ts'
import { idsOf, readSnapshot, type Snapshot } from './panes.ts'
import type { PluginPlace } from './plugin.ts'
import { markActive } from './presence.ts'
import { HerdrError, herdrRequest } from './socket.ts'

/** How often the popup looks again: the countdown, the panes (every third), the cards (when they changed). */
export const TICK_MS = 1000
/** How often it reads the cards again even when the feed says nothing. */
export const RELIST_MS = 30_000
/** How often it tells Pending You you're here, at most. */
const PRESENCE_MS = 30_000

/** What the popup says when Herdr's sign-in has ended. */
export const SIGNED_OUT =
  'Herdr is signed out of Pending You (removed in Settings, signed in again, or ended). Sign in again: Pending You: set up.'

/** A refusal or failure, in words for the note line. */
export function failureWords(error: unknown): string {
  if (error instanceof SignedOutError) return SIGNED_OUT
  if (!(error instanceof ApiError)) return 'Pending You couldn’t be reached. Try again.'
  switch (error.code) {
    case 'high_stakes':
      return HIGH_STAKES
    case 'version_conflict':
      return 'The card changed since you saw it: look again, then answer.'
    case 'not_waiting':
      return 'It isn’t waiting on you any more: it was answered or moved meanwhile.'
    case 'hold_over':
      return 'Too late to undo: it’s gone to the agent.'
    case 'delegated':
      return 'It’s with a helper: take it back in Pending You first.'
    case 'not_found':
      return 'That card isn’t there any more.'
    case 'rate_limited':
      return `Too many at once: try again in ${error.retryAfterSeconds ?? 60} s.`
    case 'insufficient_scope':
      return 'You didn’t let Herdr do that when you signed it in.'
    case 'invalid':
      return `Pending You didn’t take that: ${error.message}`
    default:
      return error.message || `Pending You couldn’t do that (${error.code}).`
  }
}

/** Each card's pane in this Herdr: from the agents' badges first, else from its agent's sessions running now. */
export function panesOf(
  cards: readonly Card[],
  snapshot: Snapshot | null,
  assistants: readonly Assistant[] | null,
  server: string | null,
): Record<string, string> {
  const panes: Record<string, string> = {}
  if (!snapshot) return panes
  const here = new Set(snapshot.panes.map((pane) => pane.paneId))
  const badged = new Map<string, string>()
  for (const pane of snapshot.panes)
    for (const id of idsOf(pane.tokens.py_cards)) if (!badged.has(id)) badged.set(id, pane.paneId)
  const live = new Map<string, string>()
  for (const assistant of assistants ?? [])
    for (const agent of assistant.agents)
      for (const session of agent.liveSessions) {
        const terminal = session.terminal
        if (
          terminal?.app === 'herdr' &&
          (terminal.server === undefined || terminal.server === server) &&
          here.has(terminal.paneId) &&
          !live.has(agent.id)
        )
          live.set(agent.id, terminal.paneId)
      }
  for (const card of cards) {
    const pane =
      badged.get(card.id) ?? (card.asker.agent ? live.get(card.asker.agent.id) : undefined)
    if (pane) panes[card.id] = pane
  }
  return panes
}

/* ───────────────────────── Demo ───────────────────────── */

const DEMO_AT = '2026-10-06T12:00:00.000Z'

/** A made-up card for screenshots: synthetic names only. */
function demoCard(id: string, overrides: Partial<Card>): Card {
  return {
    id,
    version: 1,
    status: 'pending',
    turn: 'you',
    kind: 'choice',
    title: '',
    summary: '',
    urgency: 'today',
    blocking: false,
    highStakes: false,
    actions: ['answer', 'undo', 'reply', 'later', 'delegate'],
    area: { id: 'prj_00000000000000000001', name: 'billing' },
    asker: {
      assistant: {
        id: 'con_00000000000000000001',
        name: 'Claude Code',
        app: 'claude-code',
        appName: 'Claude Code',
      },
      agent: { id: 'agt_00000000000000000001', name: 'Wren' },
      task: { label: 'billing-webhooks' },
      machine: { id: 'mch_00000000000000000001', name: 'build-01' },
    },
    threadCount: 0,
    url: `https://www.pendingyou.com/app/r/${id}`,
    createdAt: DEMO_AT,
    updatedAt: DEMO_AT,
    ...overrides,
  }
}

/** The demo's cards: one of most kinds, and one with high stakes. */
export const DEMO_CARDS: readonly Card[] = [
  demoCard('req_0f3a0000000000000001', {
    title: 'Deploy billing-webhooks to staging?',
    summary:
      'The retry fix passed CI (214 tests). Staging takes about 4 minutes and rolls back with ./scripts/rollback.sh.',
    blocking: true,
    urgency: 'now',
    options: [
      { id: 'now', label: 'Deploy now' },
      { id: 'review', label: 'Wait for review' },
      { id: 'skip', label: 'Skip it' },
    ],
    recommendedIds: ['now'],
  }),
  demoCard('req_77b20000000000000003', {
    kind: 'text',
    title: 'Which DNS host for the new domain?',
    summary: 'The registrar offers its own DNS; the other sites use Cloudflare.',
    text: { placeholder: 'Where should DNS live?', suggestions: ['Cloudflare', 'The registrar'] },
    asker: {
      assistant: { id: 'con_00000000000000000002', name: 'Codex', app: 'codex', appName: 'Codex' },
      agent: { id: 'agt_00000000000000000002', name: 'infra' },
      task: { label: 'dns' },
      machine: { id: 'mch_00000000000000000001', name: 'build-01' },
    },
    area: { id: 'prj_00000000000000000002', name: 'infra' },
  }),
  demoCard('req_5e4c0000000000000004', {
    kind: 'approve',
    title: 'Publish the pricing page today?',
    summary: 'The copy is approved; this makes it public on the website.',
    approve: { action: 'Publish /pricing', risk: 'high', reversible: false, because: 'public' },
    highStakes: true,
    actions: [],
    area: { id: 'prj_00000000000000000003', name: 'site' },
    asker: {
      assistant: {
        id: 'con_00000000000000000003',
        name: 'OpenCode',
        app: 'opencode',
        appName: 'OpenCode',
      },
      agent: { id: 'agt_00000000000000000003', name: 'Sam' },
      task: { label: 'site' },
      machine: { id: 'mch_00000000000000000001', name: 'build-01' },
    },
  }),
  demoCard('req_9c1d0000000000000002', {
    kind: 'action',
    title: 'Add the Stripe webhook secret to staging',
    summary: 'Only you can see the secret in Stripe’s dashboard.',
    urgency: 'whenever',
    action: {
      steps: [
        { text: 'Open the webhook in Stripe’s dashboard and reveal its signing secret' },
        {
          text: 'Add it to staging',
          command: 'npx wrangler secret put STRIPE_WEBHOOK_SECRET --env staging',
        },
      ],
    },
  }),
]

const DEMO_PANES: Record<string, string> = {
  req_0f3a0000000000000001: 'w1:p1',
  req_77b20000000000000003: 'w2:p3',
  req_5e4c0000000000000004: 'w3:p1',
  req_9c1d0000000000000002: 'w1:p1',
}

/* ───────────────────────── The popup ───────────────────────── */

/** Clears the popup's terminal and draws the lines, the cursor hidden. */
const frame = (lines: readonly string[]) => `\x1b[?25l\x1b[2J\x1b[H${lines.join('\r\n')}`

/** The time zone Later's presets are in: this computer's. */
const timeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export interface QueuePopupOptions {
  demo: boolean
  /** Opens a page (the card, or all your cards) and says how, for the note line. */
  openPage(url: string, what: string): Promise<string>
  /** A chunk of terminal input as keys. */
  splitKeys(chunk: string): string[]
}

/** `pendingyou herdr open`, signed in (or `--demo`): the popup that answers. Exits when it's closed. */
export async function queuePopup(
  io: Io,
  place: PluginPlace,
  options: QueuePopupOptions,
): Promise<number> {
  const width = () => io.columns?.() ?? 80
  const height = () => io.rows?.() ?? 40
  const controller = new AbortController()
  const stop = () => controller.abort()
  if (io.signal.aborted) stop()
  io.signal.addEventListener('abort', stop, { once: true })
  const client: Client | null = options.demo ? null : appClient(io, 'herdr')
  const stored = options.demo ? null : await readAppSignIn(io, 'herdr').catch(() => null)
  const scopes = new Set(stored?.scopes ?? [])
  const origin = stored?.origin ?? 'https://www.pendingyou.com'
  const server = herdrServer(io.env, io.host)
  let state: QueueState = emptyQueue({ demo: options.demo })
  let assistants: Assistant[] | null = null
  let snapshot: Snapshot | null = null
  let stale = true
  let listedAt = Number.NEGATIVE_INFINITY
  let ended = false
  let presenceAt = Number.NEGATIVE_INFINITY

  const draw = () => io.out(frame(queueLines(state, width(), height(), io.now())))
  const fail = (error: unknown) => {
    if (error instanceof SignedOutError) ended = true
    state = { ...state, note: failureWords(error) }
  }

  /** What `here` is still doing (a key's note in the state folder, its send): the popup waits for it as it closes. */
  const telling = new Set<Promise<void>>()
  /** Tells Pending You you're here, at most every 30 seconds; never in the way. */
  const here = async () => {
    await markActive(place, io.now())
    if (!client || ended || !scopes.has('presence:desk')) return
    if (io.now() - presenceAt < PRESENCE_MS) return
    presenceAt = io.now()
    await client.presence(true).catch((error: unknown) => {
      if (error instanceof SignedOutError) fail(error)
    })
  }

  /** The cards again, the one on screen kept chosen; a card just sent stays until its undo runs out. */
  const list = async () => {
    listedAt = io.now()
    stale = false
    if (options.demo) {
      if (!state.cards.length)
        state = { ...state, cards: [...DEMO_CARDS], machine: 'build-01', panes: DEMO_PANES }
      return
    }
    if (!client || ended) return
    try {
      const page = await client.cards.list({ status: 'pending', limit: 50, whole: 0 })
      const keep = state.cards[state.selected]?.id
      let cards = page.cards
      const sent = state.sent
      if (sent && io.now() < sent.until && !cards.some((card) => card.id === sent.cardId)) {
        const held = state.cards.find((card) => card.id === sent.cardId)
        if (held) cards = [...cards.slice(0, state.selected), held, ...cards.slice(state.selected)]
      }
      const at = cards.findIndex((card) => card.id === keep)
      const moved = at < 0 && keep !== undefined
      state = {
        ...state,
        cards,
        counts: page.counts,
        selected: at >= 0 ? at : Math.max(0, Math.min(state.selected, cards.length - 1)),
        ...(moved
          ? { screen: { kind: 'list' as const }, chosen: [], answers: {}, question: 0 }
          : {}),
        panes: panesOf(cards, snapshot, assistants, server),
      }
    } catch (error) {
      fail(error)
    }
  }

  /** Herdr's panes again, for each card's pane. */
  const readPanes = async () => {
    if (options.demo || !place.socket) return
    try {
      const result = await herdrRequest<{ snapshot?: unknown }>(place.socket, 'session.snapshot')
      snapshot = readSnapshot(result?.snapshot)
      state = { ...state, panes: panesOf(state.cards, snapshot, assistants, server) }
    } catch {}
  }

  const loadAssistants = async (): Promise<Assistant[] | null> => {
    if (!client || ended || !scopes.has('assistants:read')) return assistants
    try {
      assistants = (await client.assistants.list()).assistants
    } catch (error) {
      if (error instanceof SignedOutError) fail(error)
    }
    return assistants
  }

  // As it opens: who it's signed in as, the cards, the panes, and that you're here.
  if (client) {
    try {
      const me = await client.me()
      state = {
        ...state,
        machine: me.grant.reach === 'machine' ? (me.grant.machine?.name ?? null) : null,
      }
    } catch (error) {
      fail(error)
    }
  }
  await readPanes()
  await list()
  draw()
  await here()
  if (client)
    void loadAssistants().then(() => {
      state = { ...state, panes: panesOf(state.cards, snapshot, assistants, server) }
    })

  // The change feed while it's open: anything that changes a card in reach reads the cards again.
  const feed = (async () => {
    if (!client || ended) return
    try {
      for await (const batch of client.changes({ signal: controller.signal })) {
        if (batch.changes.length || batch.resync) stale = true
        if (batch.resync) void loadAssistants()
      }
    } catch (error) {
      if (error instanceof SignedOutError) fail(error)
    }
  })()

  /** Does what a key asked for: true when the popup is done. */
  const act = async (effect: QueueEffect): Promise<boolean> => {
    const now = io.now()
    switch (effect.kind) {
      case 'none':
        return false
      case 'close':
        return true
      case 'open':
        state = { ...state, note: await options.openPage(effect.card.url, 'the card') }
        return false
      case 'queue':
        state = { ...state, note: await options.openPage(`${origin}/app`, 'your cards') }
        return false
      case 'focus': {
        const pane = state.panes[effect.card.id]
        if (!pane) {
          state = { ...state, note: 'Its agent isn’t in a pane of this Herdr.' }
          return false
        }
        if (options.demo) {
          state = { ...state, note: `Demo: this would take you to ${pane}.` }
          return false
        }
        try {
          await herdrRequest(place.socket ?? '', 'pane.focus', { pane_id: pane })
          return true
        } catch (error) {
          state = {
            ...state,
            note: error instanceof HerdrError ? error.message : 'Herdr couldn’t go there.',
          }
          return false
        }
      }
      case 'answer':
        if (!client) {
          state = sentState(
            state,
            { cardId: effect.card.id, what: 'answer', words: effect.words },
            now,
          )
          return false
        }
        try {
          const done = await client.cards.answer(effect.card.id, effect.answer)
          state = sentState(
            state,
            { cardId: effect.card.id, what: 'answer', words: effect.words, until: done.undoUntil },
            io.now(),
          )
        } catch (error) {
          fail(error)
          stale = true
        }
        return false
      case 'undo': {
        if (!client) {
          state = { ...state, sent: null, note: 'Undone: it’s waiting on you again.' }
          return false
        }
        try {
          const { cardId, what } = effect.sent
          if (what === 'answer') await client.cards.undo(cardId)
          else if (what === 'later') await client.cards.back(cardId)
          else await client.cards.takeBack(cardId)
          state = { ...state, sent: null, note: 'Undone: it’s waiting on you again.' }
        } catch (error) {
          fail(error)
        }
        stale = true
        return false
      }
      case 'reply':
        if (client)
          try {
            await client.cards.reply(effect.card.id, { body: effect.body })
          } catch (error) {
            fail(error)
            return false
          }
        state = { ...state, note: `Sent to ${askerOf(effect.card)}: it’s their turn now.` }
        stale = true
        return false
      case 'later':
        if (client)
          try {
            await client.cards.later(effect.card.id, { until: effect.until, timeZone: timeZone() })
          } catch (error) {
            fail(error)
            return false
          }
        state = sentState(
          state,
          { cardId: effect.card.id, what: 'later', words: effect.words, until: io.now() + UNDO_MS },
          io.now(),
        )
        stale = true
        return false
      case 'targets': {
        const known = options.demo ? [] : await loadAssistants()
        state = {
          ...state,
          screen: { kind: 'delegate', targets: targetsFor(effect.card, known ?? []) },
        }
        return false
      }
      case 'delegate': {
        const name = effect.target.label.replace(/ \(.*\)$/, '')
        if (!client) {
          state = sentState(state, { cardId: effect.card.id, what: 'delegate', words: name }, now)
          return false
        }
        try {
          const done = await client.cards.delegate(effect.card.id, {
            to: {
              assistantId: effect.target.assistantId,
              ...(effect.target.agentId ? { agentId: effect.target.agentId } : {}),
            },
            mode: effect.mode,
          })
          state = sentState(
            state,
            { cardId: effect.card.id, what: 'delegate', words: name, until: done.undoUntil },
            io.now(),
          )
        } catch (error) {
          fail(error)
        }
        stale = true
        return false
      }
    }
  }

  const keys = io.keys?.()[Symbol.asyncIterator]()
  if (!keys) {
    stop()
    await feed
    return 0
  }
  let pending = keys.next()
  let ticks = 0
  try {
    for (;;) {
      const next = await Promise.race([
        pending,
        io.sleep(TICK_MS, controller.signal).then(() => 'tick' as const),
      ])
      if (controller.signal.aborted) return 0
      if (next === 'tick') {
        ticks++
        if (ticks % 3 === 0) await readPanes()
        // A card just sent leaves once its undo runs out.
        if (state.sent && io.now() >= state.sent.until) {
          state = { ...state, sent: null }
          stale = true
        }
        if (stale || io.now() - listedAt >= RELIST_MS) await list()
        draw()
        continue
      }
      if (next.done) return 0
      pending = keys.next()
      // Never awaited here, so a slow send never holds a key; but never left running once the popup has closed.
      const told = here()
      telling.add(told)
      void told.finally(() => telling.delete(told)).catch(() => {})
      for (const key of options.splitKeys(next.value)) {
        const [after, effect] = queueKey(state, key, io.now())
        state = after
        if (await act(effect)) return 0
      }
      if (stale) await list()
      draw()
    }
  } finally {
    stop()
    await keys.return?.()
    await feed.catch(() => {})
    await Promise.allSettled(telling)
    io.signal.removeEventListener('abort', stop)
    io.out('\x1b[?25h')
  }
}
