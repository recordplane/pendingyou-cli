// The plugin's popup (`pendingyou herdr open`, its `cards` pane). Once Herdr is signed in to Pending You (`pendingyou app
// login herdr`, from the plugin's setup), it's the popup that answers: your cards from Pending You, a key each
// (herdr/queue.ts and herdr/answer.ts), and so is `--demo`, with made-up cards. Until then it's Phase 0's, read-only:
// the panes whose agents wait on you, from their badges, most pressing first. ↑/↓ (or j/k) choose, Enter opens the card
// in Pending You through a terminal hyperlink (and the browser too, on a computer with one), `t` takes you to the pane,
// `a` opens your whole queue, `q` closes, and a line says how to answer from here. It reads Herdr again every few
// seconds while it's open.
//
// The keys and what's drawn are plain functions (popupKey, popupLines); `cardsPopup` only reads keys and draws.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readAppSignIn } from '../app-login.ts'
import { APP_NAMES, type AppId } from '../apps/ids.ts'
import { configDir } from '../files.ts'
import { cleanValue } from '../herdr.ts'
import type { Io } from '../io.ts'
import { headlessReason } from '../remote.ts'
import { readWaiting, type Waiting } from './panes.ts'
import type { PluginPlace } from './plugin.ts'
import { queuePopup } from './queue.ts'
import { HerdrError, herdrRequest } from './socket.ts'

/** How often an open popup reads Herdr again. */
export const REFRESH_MS = 3000

/** Made-up panes for screenshots (`--demo`): synthetic names, never anyone's. */
export const DEMO: readonly Waiting[] = [
  {
    paneId: 'w1:p1',
    workspaceId: 'w1',
    tabId: 'w1:t1',
    workspace: 'billing',
    tab: 'webhooks',
    app: 'claude-code',
    agent: 'Wren',
    herdrAgent: 'claude',
    status: 'idle',
    waiting: 2,
    card: 'Deploy billing-webhooks to staging?',
    cards: ['req_0f3a0000000000000001', 'req_9c1d0000000000000002'],
    pressing: 'blocking',
    asked: [],
  },
  {
    paneId: 'w2:p3',
    workspaceId: 'w2',
    tabId: 'w2:t1',
    workspace: 'infra',
    tab: 'review',
    app: 'codex',
    agent: 'infra',
    herdrAgent: 'codex',
    status: 'done',
    waiting: 1,
    card: 'Which DNS host for the new domain?',
    cards: ['req_77b20000000000000003'],
    pressing: 'now',
    asked: [],
  },
  {
    paneId: 'w3:p1',
    workspaceId: 'w3',
    tabId: 'w3:t2',
    workspace: 'docs',
    tab: 'site',
    app: 'opencode',
    agent: 'Sam',
    herdrAgent: 'opencode',
    status: 'idle',
    waiting: 1,
    card: 'Publish the pricing page today?',
    cards: ['req_5e4c0000000000000004'],
    pressing: 'today',
    asked: [],
  },
]

/** What the popup shows. */
export interface PopupState {
  panes: readonly Waiting[]
  selected: number
  /** The line under the list: a link just opened, or what went wrong. */
  note: string
  demo: boolean
  /** How to answer from here, while Herdr isn't signed in. */
  hint?: string
}

/** What the read-only popup says while Herdr isn't signed in. */
export const SIGN_IN_HINT = 'To answer from here, sign Herdr in: Pending You: set up.'

/** What a key asks for. */
export type PopupAction =
  | { kind: 'none' }
  | { kind: 'close' }
  | { kind: 'refresh' }
  | { kind: 'open'; pane: Waiting }
  | { kind: 'queue' }
  | { kind: 'focus'; pane: Waiting }

/** What one key does: the state after it, and what to do. */
export function popupKey(state: PopupState, key: string): [PopupState, PopupAction] {
  const count = state.panes.length
  const move = (by: number): [PopupState, PopupAction] => [
    { ...state, selected: count ? (state.selected + by + count) % count : 0, note: '' },
    { kind: 'none' },
  ]
  const chosen = state.panes[state.selected]
  switch (key) {
    case 'q':
    case '\x1b':
    case '\x03':
    case '\x04':
      return [state, { kind: 'close' }]
    case 'j':
    case '\x1b[B':
    case '\x1bOB':
      return move(1)
    case 'k':
    case '\x1b[A':
    case '\x1bOA':
      return move(-1)
    case 'r':
      return [state, { kind: 'refresh' }]
    case 'a':
      return [state, { kind: 'queue' }]
    case '\r':
    case '\n':
    case 'o':
      return chosen ? [state, { kind: 'open', pane: chosen }] : [state, { kind: 'queue' }]
    case 't':
      return chosen ? [state, { kind: 'focus', pane: chosen }] : [state, { kind: 'none' }]
    default:
      return [state, { kind: 'none' }]
  }
}

/** A link a terminal shows as its text and opens on a click (OSC 8), the address in plain sight too. */
export const hyperlink = (url: string) => `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`

/** The card's page in Pending You. */
export const cardUrl = (origin: string, requestId: string) =>
  `${origin}/app/r/${encodeURIComponent(requestId)}`

const appName = (app: AppId | null) => (app ? APP_NAMES[app] : 'an agent')

/** The popup's lines, for a terminal this wide: a heading, two lines a pane, then the keys. */
export function popupLines(state: PopupState, width: number): string[] {
  const room = Math.max(30, width - 2)
  const fit = (text: string, max = room) => cleanValue(text, max)
  const count = state.panes.length
  const heading = count
    ? `Pending You · ${count === 1 ? '1 agent in Herdr is' : `${count} agents in Herdr are`} waiting on you${state.demo ? ' (demo)' : ''}`
    : `Pending You${state.demo ? ' (demo)' : ''}`
  const lines = [`\x1b[1m${fit(heading)}\x1b[0m`, '']
  if (!count)
    lines.push(
      fit('Nothing in Herdr is waiting on you.'),
      fit('Cards from your other assistants are in Pending You: press a to open it.'),
    )
  for (const [index, pane] of state.panes.entries()) {
    const chosen = index === state.selected
    const tag = pane.pressing ?? ''
    const title = fit(`⏳ ${pane.card ?? 'A card'}`, Math.max(10, room - tag.length - 3))
    const gap = ' '.repeat(Math.max(1, room - 2 - [...title].length - tag.length))
    const first = `${chosen ? '▸ ' : '  '}${title}${gap}${tag}`
    const where = [
      pane.agent ? `${pane.agent} (${appName(pane.app)})` : appName(pane.app),
      `${pane.workspace} › ${pane.tab}`,
      pane.paneId,
      ...(pane.waiting > 1 ? [`${pane.waiting} waiting`] : []),
    ].join(' · ')
    lines.push(chosen ? `\x1b[7m${first}\x1b[0m` : first, `    ${fit(where, room - 4)}`)
  }
  lines.push(
    '',
    fit(
      `${count ? '↑↓ choose · enter open the card · t take me there · ' : ''}a all your cards · q close`,
    ),
  )
  if (state.hint) lines.push(fit(state.hint))
  if (state.note) lines.push('', state.note)
  return lines
}

/** Clears the popup's terminal and draws the lines, the cursor hidden. */
const frame = (lines: readonly string[]) => `\x1b[?25l\x1b[2J\x1b[H${lines.join('\r\n')}`

/** The Pending You an app's cards are on, from what init recorded for it (`<config>/<app>.json`), else `fallback`. */
export async function originFor(
  io: Pick<Io, 'env' | 'home'>,
  app: AppId | null,
  fallback: string,
): Promise<string> {
  if (!app) return fallback
  try {
    const manifest = JSON.parse(await readFile(join(configDir(io), `${app}.json`), 'utf8'))
    const origin = manifest?.origin
    return typeof origin === 'string' && /^https?:\/\/[^\s/]+$/.test(origin) ? origin : fallback
  } catch {
    return fallback
  }
}

/**
 * Opens a page: as a link the person can click in the popup (OSC 8), and in the browser too where this computer has
 * one (never over SSH: the plugin runs on the Herdr server, which may not be where the person is).
 */
async function openPage(io: Io, url: string, what: string): Promise<string> {
  const opened = headlessReason(io) ? false : await io.openBrowser(url).catch(() => false)
  return `${opened ? `Opened ${what} in your browser:` : `Open ${what}: Ctrl-click (or ⌘-click)`} ${hyperlink(url)}`
}

/** `pendingyou herdr open`: the popup. Exits when it's closed, or after taking you to a pane. */
export async function cardsPopup(
  io: Io,
  place: PluginPlace,
  options: { origin: string; demo: boolean },
): Promise<number> {
  // Signed in (or the demo): the popup that answers.
  if (options.demo || (await readAppSignIn(io, 'herdr').catch(() => null)))
    return queuePopup(io, place, {
      demo: options.demo,
      openPage: (url, what) => openPage(io, url, what),
      splitKeys,
    })
  const width = () => io.columns?.() ?? 80
  let state: PopupState = {
    panes: [],
    selected: 0,
    note: '',
    demo: options.demo,
    hint: SIGN_IN_HINT,
  }
  const load = async () => {
    if (options.demo) return [...DEMO]
    if (!place.socket) throw new HerdrError('unreachable', 'Run this from Herdr: no socket here.')
    return (await readWaiting(place.socket)).waiting
  }
  const refresh = async () => {
    try {
      const panes = await load()
      const keep = state.panes[state.selected]?.paneId
      const at = panes.findIndex((pane) => pane.paneId === keep)
      state = {
        ...state,
        panes,
        selected: at >= 0 ? at : Math.max(0, Math.min(state.selected, panes.length - 1)),
      }
    } catch (error) {
      state = {
        ...state,
        note: error instanceof HerdrError ? error.message : 'Herdr isn’t answering.',
      }
    }
  }
  await refresh()
  const draw = () => io.out(frame(popupLines(state, width())))
  draw()
  /** Does what a key asked for: true when the popup is done. */
  const act = async (action: PopupAction): Promise<boolean> => {
    switch (action.kind) {
      case 'close':
        return true
      case 'refresh':
        await refresh()
        return false
      case 'queue': {
        const origin = await originFor(io, state.panes[0]?.app ?? null, options.origin)
        state = { ...state, note: await openPage(io, `${origin}/app`, 'your cards') }
        return false
      }
      case 'open': {
        const requestId = action.pane.cards[0]
        const origin = await originFor(io, action.pane.app, options.origin)
        const url = requestId ? cardUrl(origin, requestId) : `${origin}/app`
        state = { ...state, note: await openPage(io, url, requestId ? 'the card' : 'your cards') }
        return false
      }
      case 'focus':
        if (options.demo) {
          state = { ...state, note: `Demo: this would take you to ${action.pane.paneId}.` }
          return false
        }
        try {
          await herdrRequest(place.socket ?? '', 'pane.focus', { pane_id: action.pane.paneId })
          return true
        } catch (error) {
          state = {
            ...state,
            note: error instanceof HerdrError ? error.message : 'Herdr couldn’t go there.',
          }
          return false
        }
      default:
        return false
    }
  }
  const keys = io.keys?.()[Symbol.asyncIterator]()
  if (!keys) return 0
  let pending = keys.next()
  try {
    for (;;) {
      const next = await Promise.race([
        pending,
        options.demo
          ? new Promise<never>(() => {})
          : io.sleep(REFRESH_MS, io.signal).then(() => 'tick' as const),
      ])
      if (io.signal.aborted) return 0
      if (next === 'tick') {
        await refresh()
        draw()
        continue
      }
      if (next.done) return 0
      pending = keys.next()
      for (const key of splitKeys(next.value)) {
        const [after, action] = popupKey(state, key)
        state = after
        if (await act(action)) return 0
      }
      draw()
    }
  } finally {
    await keys.return?.()
    io.out('\x1b[?25h')
  }
}

const ESC = '\u001b'

/** A chunk of terminal input as keys: an escape sequence (an arrow: ESC [ A) stays one key, anything else a character. */
export function splitKeys(chunk: string): string[] {
  const keys: string[] = []
  let index = 0
  while (index < chunk.length) {
    const kind = chunk[index + 1]
    if (chunk[index] === ESC && (kind === '[' || kind === 'O')) {
      let end = index + 2
      if (kind === '[') while (end < chunk.length && /[0-9;]/.test(chunk[end] as string)) end++
      if (end < chunk.length && /[A-Za-z~]/.test(chunk[end] as string)) {
        keys.push(chunk.slice(index, end + 1))
        index = end + 1
        continue
      }
    }
    keys.push(chunk[index] as string)
    index++
  }
  return keys
}
