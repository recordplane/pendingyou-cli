// Holding cards while you're in the agent's Herdr pane (0.41.0; docs/plans/2026-11-03-herdr-focus-hold.md, its D1 and
// D3). Pending You holds a card the agent in the pane you're in also asks you in the conversation, while you stay;
// Herdr's watcher is what says where you are. Everything here is on this computer:
//
// - The report (POST /v1/focus, presence:focus): the focused pane (Herdr's one per server, the last client to move)
//   and your last sign of you in Herdr. The signs (D3): focus moving between panes, tabs and workspaces; keys in the
//   popup; and each message you send the agent in the focused pane, which its app's next-message hook notes
//   (noteMessage: Claude Code's and Codex's UserPromptSubmit, OpenCode's plugin and Pi's extension, all through
//   `handoff`). Herdr can't tell anyone about keys typed in a pane, so those aren't signs. focusStep says when to send:
//   at once when the pane changes or a card arrives on it, every 30 seconds while you're active or something is held,
//   and once as you go quiet; never two within 2 seconds, and nothing for 10 minutes after Pending You refuses (Herdr
//   signed in before presence:focus existed, or a Pending You that doesn't hold cards).
// - What's held stays off Herdr: Pending You answers each report with the cards held now (ids only). The watcher keeps
//   them in `herdr/held.json` (0600), and every badge write (herdr.ts's writeHerdr) leaves them out of py_waiting,
//   py_card and py_cards, so the sidebar's row, the popup, `next` and the toasts never see them. Each write also keeps
//   its pane's cards (`herdr/panes/`, the redacted titles the badges carry, as Herdr keeps them), so when the held set
//   changes the watcher writes those panes' badges again at once (applyHeld): a card leaves the row as it's held and
//   comes back as it shows, without waiting for the agent's next write. A held list older than 2 minutes counts for
//   nothing (the watcher stopped; Pending You shows the card within 90 seconds of its last report anyway).
//
// Never a message's words, a pane's contents or a card's words beyond the badges' title: a time, ids and pane ids.
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_IDS, type AppId } from '../apps/ids.ts'
import { configDir, readJson, readText, writeWhole } from '../files.ts'
import {
  type HerdrReport,
  herdrBin,
  herdrPane,
  herdrServer,
  isUrgency,
  reportArgs,
  runHerdr,
  type WaitingCard,
} from '../herdr.ts'
import type { Io } from '../io.ts'

/** How long without a sign of you releases a held card (Pending You's FOCUS_HOLD.idleSeconds; it says so too). */
export const IDLE_MS = 5 * 60_000
/** How often to say it while you're active or something is held, unless Pending You says otherwise. */
export const EVERY_MS = 30_000
/** Never two reports closer than this: /v1's 60 writes a minute are shared with everything else Herdr sends. */
export const GAP_MS = 2000
/** How long after a refusal (no scope, holding not served) before asking again. */
export const REFUSED_MS = 10 * 60_000
/** A held list older than this says nothing: the watcher that wrote it has stopped. */
export const HELD_FRESH_MS = 2 * 60_000

const herdrDir = (io: Pick<Io, 'env' | 'home'>) => join(configDir(io), 'herdr')
const heldPath = (io: Pick<Io, 'env' | 'home'>) => join(herdrDir(io), 'held.json')
const messagesDir = (io: Pick<Io, 'env' | 'home'>) => join(herdrDir(io), 'messages')
const panesDir = (io: Pick<Io, 'env' | 'home'>) => join(herdrDir(io), 'panes')

/** A pane's name in a file's: its Herdr server's hash (or `local`) and its id, `:` as `_`. */
const paneFile = (server: string | null, pane: string) =>
  `${server ?? 'local'}-${pane.replace(/[^A-Za-z0-9]/g, '_')}`

/* ───────────────────────── Held ───────────────────────── */

/** The cards held now, as the watcher last heard them; none once that's older than HELD_FRESH_MS. Never throws. */
export async function readHeld(io: Pick<Io, 'env' | 'home'>, now: number): Promise<Set<string>> {
  const held = await readJson<{ at?: unknown; ids?: unknown }>(heldPath(io)).catch(() => null)
  if (!held || typeof held.at !== 'number' || now - held.at > HELD_FRESH_MS) return new Set()
  const ids = Array.isArray(held.ids) ? held.ids : []
  return new Set(
    ids.filter((id): id is string => typeof id === 'string' && /^req_[A-Za-z0-9-]{1,40}$/.test(id)),
  )
}

/** Keeps the cards held now, ids only, 0600. Never throws. */
export async function writeHeld(
  io: Pick<Io, 'env' | 'home'>,
  ids: readonly string[],
  now: number,
): Promise<void> {
  await writeWhole(heldPath(io), `${JSON.stringify({ version: 1, at: now, ids: [...ids] })}\n`, {
    secret: true,
  }).catch(() => {})
}

/** The cards a badge may show: those not held now. */
export const notHeld = (cards: readonly WaitingCard[], held: ReadonlySet<string>) =>
  cards.filter((card) => !held.has(card.requestId))

/* ───────────────────────── Messages (D3) ───────────────────────── */

/**
 * You sent the agent in this pane a message (its app's next-message hook, `handoff`): the moment, kept for the
 * watcher, when this process runs in a Herdr pane. Never the message. Never throws.
 */
export async function noteMessage(io: Pick<Io, 'env' | 'home' | 'host' | 'now'>): Promise<void> {
  const pane = herdrPane(io.env)
  if (!pane) return
  const server = herdrServer(io.env, io.host)
  await writeWhole(
    join(messagesDir(io), paneFile(server, pane.pane)),
    `${Math.floor(io.now())}\n`,
    { secret: true },
  ).catch(() => {})
}

/** When you last sent the agent in this pane a message, as its hook noted; null when it never did. Never throws. */
export async function lastMessage(
  io: Pick<Io, 'env' | 'home'>,
  server: string | null,
  pane: string,
): Promise<number | null> {
  const text = await readText(join(messagesDir(io), paneFile(server, pane))).catch(() => null)
  const at = Number(text?.trim())
  return text && Number.isFinite(at) && at > 0 ? at : null
}

/* ───────────────────────── Each pane's cards ───────────────────────── */

/** A pane's badges as its agent last wrote them: whose, the name, every card waiting (held ones too). */
interface SavedPane {
  version: 1
  pane: string
  app: AppId
  agent?: string | null
  cards: WaitingCard[]
}

/** Keeps what a badge write said of its pane's cards, for writing them again when the held set changes. */
export async function savePane(
  io: Pick<Io, 'env' | 'home' | 'host'>,
  pane: string,
  report: HerdrReport,
): Promise<void> {
  if (report.cards === undefined) return
  const saved: SavedPane = {
    version: 1,
    pane,
    app: report.app,
    ...(report.agent !== undefined ? { agent: report.agent } : {}),
    cards: report.cards.map((card) => ({
      requestId: card.requestId,
      ...(card.title ? { title: card.title.slice(0, 200) } : {}),
      ...(card.urgency ? { urgency: card.urgency } : {}),
      ...(card.blocking ? { blocking: true } : {}),
      ...(card.askedFirst ? { askedFirst: true } : {}),
      at: card.at,
    })),
  }
  await writeWhole(
    join(panesDir(io), paneFile(herdrServer(io.env, io.host), pane)),
    `${JSON.stringify(saved)}\n`,
    { secret: true },
  ).catch(() => {})
}

/** Forgets a pane's cards (its session ended, everything taken off it). Never throws. */
export async function forgetPane(
  io: Pick<Io, 'env' | 'home' | 'host'>,
  pane: string,
): Promise<void> {
  await rm(join(panesDir(io), paneFile(herdrServer(io.env, io.host), pane)), {
    force: true,
  }).catch(() => {})
}

/** This Herdr server's panes' cards, as their agents last wrote them. Anything that doesn't read as one is left out. */
async function savedPanes(
  io: Pick<Io, 'env' | 'home'>,
  server: string | null,
): Promise<SavedPane[]> {
  const prefix = `${server ?? 'local'}-`
  const names = await readdir(panesDir(io)).catch(() => [] as string[])
  const panes: SavedPane[] = []
  for (const name of names.filter((each) => each.startsWith(prefix))) {
    const saved = await readJson<Partial<SavedPane>>(join(panesDir(io), name)).catch(() => null)
    if (
      !saved ||
      typeof saved.pane !== 'string' ||
      !(APP_IDS as readonly string[]).includes(String(saved.app)) ||
      !Array.isArray(saved.cards)
    )
      continue
    panes.push({
      version: 1,
      pane: saved.pane,
      app: saved.app as AppId,
      ...(saved.agent !== undefined ? { agent: saved.agent } : {}),
      cards: saved.cards.flatMap((card) =>
        typeof card?.requestId === 'string'
          ? [
              {
                requestId: card.requestId,
                ...(typeof card.title === 'string' ? { title: card.title } : {}),
                ...(isUrgency(card.urgency) ? { urgency: card.urgency } : {}),
                ...(card.blocking === true ? { blocking: true } : {}),
                ...(card.askedFirst === true ? { askedFirst: true } : {}),
                at: typeof card.at === 'number' ? card.at : 0,
              },
            ]
          : [],
      ),
    })
  }
  return panes
}

/**
 * The held set changed: kept for the agents' writes, and the badges of this Herdr server's panes whose cards it touches
 * written again at once, as their agents last wrote them less what's held now. Never throws.
 */
export async function applyHeld(
  io: Pick<Io, 'env' | 'home' | 'host' | 'run'>,
  server: string | null,
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
  now: number,
): Promise<number> {
  await writeHeld(io, [...after], now)
  const bin = herdrBin(io.env)
  if (!bin) return 0
  const changed = (id: string) => before.has(id) !== after.has(id)
  let written = 0
  for (const saved of await savedPanes(io, server).catch(() => [] as SavedPane[])) {
    if (!saved.cards.some((card) => changed(card.requestId))) continue
    await runHerdr(
      io,
      { bin, pane: saved.pane },
      reportArgs(saved.pane, {
        app: saved.app,
        ...(saved.agent !== undefined ? { agent: saved.agent } : {}),
        cards: notHeld(saved.cards, after),
        at: now,
      }),
    )
    written++
  }
  return written
}

/* ───────────────────────── When to report ───────────────────────── */

/** Where you are, as a report names it: the focused pane on this Herdr server, or none. */
export interface FocusSpot {
  server: string
  paneId: string
}

/** What the watcher last told Pending You, and what it heard back. */
export interface FocusState {
  /** When the last report went (-Infinity: never). */
  sentAt: number
  /** Where it said you were (`server pane`, or null for no pane). */
  place: string | null
  /** Whether you were active as it said so. */
  active: boolean
  /** The cards held there then, as Pending You answered. */
  held: string[]
  /** How often to say it again meanwhile. */
  every: number
  /** No report before this (a refusal's wait). */
  quietUntil: number
}

export const freshFocus = (): FocusState => ({
  sentAt: Number.NEGATIVE_INFINITY,
  place: null,
  active: false,
  held: [],
  every: EVERY_MS,
  quietUntil: 0,
})

const placeKey = (spot: FocusSpot | null) => (spot ? `${spot.server} ${spot.paneId}` : null)

/**
 * Whether to report now: when the pane you're in changed, or a card arrived on it (`nudge`); every `every` while you're
 * active or something is held; and once as you go quiet. Never within GAP_MS of the last, nor before a refusal's wait
 * is over.
 */
export function focusDue(
  state: FocusState,
  look: { now: number; spot: FocusSpot | null; activeAt: number | null; nudge: boolean },
): boolean {
  const { now } = look
  if (now < state.quietUntil || now - state.sentAt < GAP_MS) return false
  // Never said yet: say where you are, a pane or none.
  if (state.sentAt === Number.NEGATIVE_INFINITY) return true
  const active = look.activeAt !== null && now - look.activeAt < IDLE_MS
  if (placeKey(look.spot) !== state.place || look.nudge) return true
  if ((active || state.held.length > 0) && now - state.sentAt >= state.every) return true
  return state.active && !active
}

/** The state once a report went and was answered. */
export function focusSent(
  state: FocusState,
  look: { now: number; spot: FocusSpot | null; activeAt: number | null },
  answer: { held: readonly string[]; everySeconds?: number },
): FocusState {
  return {
    ...state,
    sentAt: look.now,
    place: placeKey(look.spot),
    active: look.activeAt !== null && look.now - look.activeAt < IDLE_MS,
    held: [...answer.held],
    every:
      typeof answer.everySeconds === 'number' && answer.everySeconds >= 5
        ? answer.everySeconds * 1000
        : EVERY_MS,
    quietUntil: 0,
  }
}

/** Pending You refused the report (no scope, or it doesn't hold cards here): nothing held, and quiet for a while. */
export const focusRefused = (state: FocusState, now: number): FocusState => ({
  ...state,
  sentAt: now,
  held: [],
  quietUntil: now + REFUSED_MS,
})
