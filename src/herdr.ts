// Herdr (0.17.0; Phase 0 of the Pending You plugin for Herdr, docs/integrations/herdr.md). When an agent runs in a Herdr
// pane (Herdr gives every pane HERDR_ENV=1, HERDR_BIN_PATH and HERDR_PANE_ID), the command line writes display-only
// metadata onto that pane, so Herdr's sidebar, its Agents panel and the plugin (`pendingyou herdr …`, herdr/command.ts)
// can show what the agent is waiting on you for:
//
//   "$HERDR_BIN_PATH" pane report-metadata "$HERDR_PANE_ID" --source pendingyou \
//     --token py_app=claude-code --token py_agent=Wren --token py_waiting=2 \
//     --token py_card="Deploy billing-webhooks to staging?" --token py_cards=req_…,req_… \
//     --token py_urgency=blocking --token py_asked=req_… \
//     --agent claude --state-label idle="waiting on you" --state-label done="waiting on you" \
//     --ttl-ms 900000 --seq <the moment it describes, in ms>
//
// - py_app, py_agent: which app the pane's agent is and the name it goes by with Pending You.
// - py_waiting: how many of its cards wait on the person; py_card the most pressing one's title, redacted as permission
//   cards are (redact.ts) and cut to Herdr's 80 characters; py_cards their request ids, most pressing first, as many as
//   fit in 80; py_urgency the most pressing one's (`blocking` before `now`, `today` and `whenever`, which sort in that
//   order as text); py_asked the ones also asked in the conversation (post_request's askedFirst), which the plugin
//   leaves quiet for a while.
// - The state labels make Herdr read `idle` and `done` as "waiting on you" while something waits. `--agent` keeps them
//   to the pane's own agent: Herdr drops them once another runs there (tokens stay until cleared or expired).
//
// Who writes: Claude Code's wake mod (on every change, and every 5 minutes) and its session-start hook (the name);
// Codex's thread keeper and its card hook; OpenCode's plugin and Pi's extension through `presence` and `posted`. Each
// write says everything it knows, so the latest wins, and `--seq` keeps a late one from winning: Herdr ignores a report
// whose sequence isn't above the last it took from this source. Tokens expire after 15 minutes unless a heartbeat
// writes them again, and a session's end clears them.
//
// Never in an agent's way: run without a shell (an argument list), given up after a second, its outcome never thrown,
// and in a hook only ever started in the background. Never anything of a card but its title, never an answer or a note.
// Herdr keeps all of it on this computer. `pendingyou herdr unconfigure` (the plugin's) turns the badges off here, and
// its setup on again (`<config>/herdr.json`).
//
// Which terminal (0.18.0; product contract §6m): a session's presence report (presence.ts) also tells Pending You the
// pane it runs in, `terminal: { app: "herdr", paneId: "w2:p1", server }`, so the plugin can go from a card to its
// agent's pane. `server` names the Herdr server without its socket's path: the first 16 hex characters of a SHA-256 of
// this computer's name and HERDR_SOCKET_PATH. It goes whether or not the badges are on: it's Pending You's, not Herdr's.
import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import type { AppId } from './apps/ids.ts'
import { configDir, readJson, writeWhole } from './files.ts'
import type { Io } from './io.ts'
import { cut, redactText } from './redact.ts'

/** The one source every report uses: Herdr keeps sequenced reports from at most 32 sources a pane. */
export const HERDR_SOURCE = 'pendingyou'
/** How long one call to Herdr may take before it's stopped. */
export const HERDR_TIMEOUT_MS = 1000
/** How long tokens last unless written again: a heartbeat every 5 minutes keeps them. */
export const TOKEN_TTL_MS = 15 * 60_000
/** How often a session's writer says it all again. */
export const HERDR_EVERY_MS = 5 * 60_000
/** Herdr's most for a token's value, a label or a title. */
export const VALUE_MAX = 80
/** What `idle` and `done` read while something waits. */
export const WAITING_LABEL = 'waiting on you'

/** The pane tokens, by what they say. */
export const TOKENS = {
  app: 'py_app',
  agent: 'py_agent',
  waiting: 'py_waiting',
  card: 'py_card',
  cards: 'py_cards',
  urgency: 'py_urgency',
  asked: 'py_asked',
} as const
export const TOKEN_NAMES: readonly string[] = Object.values(TOKENS)
/** A token's name as Herdr takes it. */
export const TOKEN_NAME = /^[A-Za-z0-9_-]{1,32}$/
/** A pane's id as Herdr gives it: `w1:p1`, `w6:pC`. */
export const PANE_ID = /^[A-Za-z0-9]{1,16}:[A-Za-z0-9]{1,16}$/
const REQUEST_ID = /^req_[A-Za-z0-9-]{1,40}$/

/** Herdr's name for each app's agent: its rows_by_agent keys, and what `--agent` guards the state labels with. */
export const HERDR_AGENTS: Record<AppId, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi',
}

export const URGENCIES = ['now', 'today', 'whenever'] as const
export type Urgency = (typeof URGENCIES)[number]
/** How pressing a pane's cards are, most first: a blocking card, then by urgency. Sorted as text, in this order. */
export type Pressing = 'blocking' | Urgency
export const PRESSING: readonly Pressing[] = ['blocking', ...URGENCIES]

export const isUrgency = (value: unknown): value is Urgency =>
  typeof value === 'string' && (URGENCIES as readonly string[]).includes(value)

/** One card waiting on the person, as a writer knows it. */
export interface WaitingCard {
  requestId: string
  title?: string | undefined
  urgency?: Urgency | undefined
  blocking?: boolean | undefined
  /** Also asked in the conversation (post_request's askedFirst). */
  askedFirst?: boolean | undefined
  /** When it was put in front of the person (ms). */
  at: number
}

/** Where this process's tokens go: Herdr's own command line, and its pane. */
export interface HerdrPane {
  bin: string
  pane: string
}

/** Herdr's own program, as Herdr names it to what it runs (a pane, a plugin's command); null outside Herdr. */
export function herdrBin(env: Record<string, string | undefined>): string | null {
  const bin = env.HERDR_BIN_PATH ?? ''
  if (env.HERDR_ENV !== '1' || !bin || !isAbsolute(bin) || /[\0\r\n]/.test(bin)) return null
  return bin
}

/** This process's Herdr pane, from what Herdr puts in a pane's environment; null outside Herdr. */
export function herdrPane(env: Record<string, string | undefined>): HerdrPane | null {
  const bin = herdrBin(env)
  const pane = env.HERDR_PANE_ID ?? ''
  if (!bin || !PANE_ID.test(pane)) return null
  return { bin, pane }
}

/** Where presence says a session runs (0.18.0): its Herdr pane, and which Herdr server that is. */
export interface HerdrTerminal {
  app: 'herdr'
  paneId: string
  server?: string
}

/**
 * Which Herdr server this process belongs to, as Pending You keeps it: the first 16 hex characters of a SHA-256 of the
 * computer's name and Herdr's socket (HERDR_SOCKET_PATH), so two servers' `w1:p1` aren't confused and the path never
 * leaves the computer. The plugin's commands, which have the socket but no pane, can work it out the same way. Null
 * without a socket path it can use.
 */
export function herdrServer(env: Record<string, string | undefined>, host: string): string | null {
  const socket = env.HERDR_SOCKET_PATH ?? ''
  if (!socket || !isAbsolute(socket) || /[\0\r\n]/.test(socket)) return null
  return createHash('sha256').update(`${host}${socket}`).digest('hex').slice(0, 16)
}

/** The Herdr pane this process runs in, as presence reports it (and its server, when it can tell); null outside Herdr. */
export function herdrTerminal(
  env: Record<string, string | undefined>,
  host: string,
): HerdrTerminal | null {
  const pane = herdrPane(env)
  if (!pane) return null
  const server = herdrServer(env, host)
  return { app: 'herdr', paneId: pane.pane, ...(server ? { server } : {}) }
}

/** The command line's own Herdr settings: whether it writes badges on this computer (on unless turned off). */
const settingsPath = (io: Pick<Io, 'env' | 'home'>) => join(configDir(io), 'herdr.json')

export async function badgesOn(io: Pick<Io, 'env' | 'home'>): Promise<boolean> {
  const settings = await readJson<{ badges?: unknown }>(settingsPath(io)).catch(() => null)
  return settings?.badges !== false
}

/** Turns the badges on or off on this computer (the plugin's setup and unconfigure). */
export async function setBadges(io: Pick<Io, 'env' | 'home'>, on: boolean): Promise<void> {
  await writeWhole(settingsPath(io), `${JSON.stringify({ version: 1, badges: on }, null, 2)}\n`, {
    secret: true,
  })
}

/** This process's pane, when it's in Herdr and the badges are on here; null otherwise. Never throws. */
export async function herdrTarget(io: Pick<Io, 'env' | 'home'>): Promise<HerdrPane | null> {
  const pane = herdrPane(io.env)
  if (!pane) return null
  return (await badgesOn(io).catch(() => true)) ? pane : null
}

/** Text on one line: no control or format characters (a terminal's escapes among them), spaces collapsed. */
const oneLine = (text: string) =>
  [...text]
    .map((char) => (/[\p{Cc}\p{Cf}]/u.test(char) ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()

/** One line of text as Herdr keeps it, at most `max` characters, ending in "…" when it was cut. */
export const cleanValue = (text: string, max = VALUE_MAX) => cut(oneLine(text), max)

/** A card's title as a token: its secrets out (redact.ts), one line, at most 80 characters. */
export const cardTitle = (title: string) => redactText(oneLine(title), VALUE_MAX)

/** Request ids, comma-separated, as many as fit in one token's 80 characters. */
export function idsToken(ids: readonly string[]): string {
  let out = ''
  for (const id of ids) {
    const next = out ? `${out},${id}` : id
    if (next.length > VALUE_MAX) break
    out = next
  }
  return out
}

const rank = (card: WaitingCard) => [
  card.blocking ? 0 : 1,
  card.urgency ? URGENCIES.indexOf(card.urgency) : 1,
  card.at,
]

/** The cards, most pressing first: blocking ones, then by urgency (none given counts as today), then oldest first. */
export function mostPressing(cards: readonly WaitingCard[]): WaitingCard[] {
  return [...cards].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)]
    for (let index = 0; index < x.length; index++)
      if (x[index] !== y[index]) return (x[index] as number) - (y[index] as number)
    return a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0
  })
}

/** How pressing the most pressing card is; null when there's none (or none says). */
export function pressingOf(cards: readonly WaitingCard[]): Pressing | null {
  if (cards.some((card) => card.blocking)) return 'blocking'
  const given = cards.flatMap((card) => (card.urgency ? [URGENCIES.indexOf(card.urgency)] : []))
  return given.length ? (URGENCIES[Math.min(...given)] as Urgency) : null
}

/** What one write says: always the app; the name and the cards when the writer knows them. */
export interface HerdrReport {
  app: AppId
  /** The name the session goes by with Pending You: undefined leaves py_agent as it is, null clears it. */
  agent?: string | null
  /** The cards waiting on the person: undefined leaves those tokens as they are (the name alone), [] clears them. */
  cards?: readonly WaitingCard[]
  /** The moment it describes (ms): Herdr's sequence for this report. */
  at: number
}

const seqOf = (at: number) => String(Math.max(0, Math.floor(Number.isFinite(at) ? at : 0)))

/** The arguments of `herdr pane report-metadata` for a report: never more than 16 tokens, each value at most 80. */
export function reportArgs(pane: string, report: HerdrReport): string[] {
  const set: string[] = []
  const clear: string[] = []
  const token = (name: string, value: string | null | undefined) => {
    if (value === undefined || !TOKEN_NAME.test(name)) return
    if (value === null || value === '') clear.push('--clear-token', name)
    else set.push('--token', `${name}=${value}`)
  }
  token(TOKENS.app, report.app)
  if (report.agent !== undefined)
    token(TOKENS.agent, report.agent === null ? null : cleanValue(report.agent))
  const labels: string[] = []
  if (report.cards !== undefined) {
    const valid = report.cards.filter((card) => REQUEST_ID.test(card.requestId))
    const cards = mostPressing(valid)
    const first = cards[0]
    token(TOKENS.waiting, cards.length ? String(cards.length) : null)
    token(TOKENS.card, first?.title ? cardTitle(first.title) : null)
    token(TOKENS.cards, cards.length ? idsToken(cards.map((card) => card.requestId)) : null)
    token(TOKENS.urgency, pressingOf(cards))
    token(TOKENS.asked, idsToken(cards.filter((card) => card.askedFirst).map((c) => c.requestId)))
    if (cards.length)
      labels.push(
        '--agent',
        HERDR_AGENTS[report.app],
        '--state-label',
        `idle=${WAITING_LABEL}`,
        '--state-label',
        `done=${WAITING_LABEL}`,
      )
    else labels.push('--clear-state-labels')
  }
  return [
    'pane',
    'report-metadata',
    pane,
    '--source',
    HERDR_SOURCE,
    ...set,
    ...clear,
    ...labels,
    '--ttl-ms',
    String(TOKEN_TTL_MS),
    '--seq',
    seqOf(report.at),
  ]
}

/** The arguments that take everything Pending You put on a pane off it again (a session's end). */
export function clearArgs(pane: string, at: number): string[] {
  return [
    'pane',
    'report-metadata',
    pane,
    '--source',
    HERDR_SOURCE,
    ...TOKEN_NAMES.flatMap((name) => ['--clear-token', name]),
    '--clear-state-labels',
    '--seq',
    seqOf(at),
  ]
}

/**
 * What one call to Herdr came to: `written`; `refused` (Herdr said no: a pane that's gone, an older Herdr);
 * `timeout` (stopped after HERDR_TIMEOUT_MS); `missing` (no such program); `off` (not in Herdr, or badges off here);
 * `failed` (anything else).
 */
export type HerdrOutcome = 'written' | 'refused' | 'timeout' | 'missing' | 'off' | 'failed'

/** Runs Herdr's command line with these arguments, no shell, for a second at most. Never throws. */
export async function runHerdr(
  io: Pick<Io, 'run'>,
  pane: HerdrPane,
  args: readonly string[],
): Promise<HerdrOutcome> {
  try {
    const result = await io.run(pane.bin, args, HERDR_TIMEOUT_MS)
    if (result.code === 0) return 'written'
    if (result.code === 124) return 'timeout'
    if (result.code === 127) return 'missing'
    return 'refused'
  } catch {
    return 'failed'
  }
}

/** Writes a report onto this process's pane, when it's in Herdr and the badges are on. Never throws. */
export async function writeHerdr(
  io: Pick<Io, 'env' | 'home' | 'run'>,
  report: HerdrReport,
  pane?: HerdrPane | null,
): Promise<HerdrOutcome> {
  const target = pane === undefined ? await herdrTarget(io) : pane
  if (!target) return 'off'
  return runHerdr(io, target, reportArgs(target.pane, report))
}

/** Takes Pending You's tokens and labels off this process's pane. Never throws. */
export async function clearHerdr(
  io: Pick<Io, 'env' | 'home' | 'run'>,
  at: number,
  pane?: HerdrPane | null,
): Promise<HerdrOutcome> {
  const target = pane === undefined ? await herdrTarget(io) : pane
  if (!target) return 'off'
  return runHerdr(io, target, clearArgs(target.pane, at))
}

/** The arguments of a background `pendingyou herdr report` (a hook never waits on Herdr). */
export function reportCommand(
  app: AppId,
  fields: { session?: string | null; transcript?: string | null; closed?: boolean; at: number },
): string[] {
  return [
    'herdr',
    'report',
    '--app',
    app,
    ...(fields.session ? ['--session', fields.session] : []),
    ...(fields.transcript ? ['--transcript', fields.transcript] : []),
    ...(fields.closed ? ['--state', 'closed'] : []),
    '--at',
    seqOf(fields.at),
  ]
}

/**
 * What the wake mod hands `herdr report` on stdin: the session's name and its cards waiting on the person. Anything
 * that doesn't read as one is left out; null when it isn't one at all.
 */
export function readPayload(text: string): { name: string | null; cards: WaitingCard[] } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const given = parsed as { name?: unknown; cards?: unknown }
  if (!Array.isArray(given.cards)) return null
  const cards: WaitingCard[] = []
  for (const card of given.cards.slice(0, 50)) {
    if (typeof card !== 'object' || card === null) continue
    const each = card as Record<string, unknown>
    if (typeof each.requestId !== 'string' || !REQUEST_ID.test(each.requestId)) continue
    cards.push({
      requestId: each.requestId,
      ...(typeof each.title === 'string' && each.title.trim()
        ? { title: each.title.slice(0, 1000) }
        : {}),
      ...(isUrgency(each.urgency) ? { urgency: each.urgency } : {}),
      ...(each.blocking === true ? { blocking: true } : {}),
      ...(each.askedFirst === true ? { askedFirst: true } : {}),
      at: typeof each.at === 'number' && Number.isFinite(each.at) ? each.at : 0,
    })
  }
  const name = typeof given.name === 'string' && given.name.trim() ? given.name.trim() : null
  return { name, cards }
}
