// What Herdr says about its panes (`session.snapshot`), as the plugin reads it: each pane's place and tokens, which
// tab you're looking at, and the panes whose agents wait on you (their py_* tokens: herdr.ts), most pressing first.
// Read forgivingly: anything that doesn't read as Herdr says it is left out, never thrown.
import { APP_IDS, type AppId } from '../apps/ids.ts'
import { PRESSING, type Pressing, TOKENS } from '../herdr.ts'
import { herdrRequest } from './socket.ts'

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown) => (typeof value === 'string' ? value : null)
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER

export interface Place {
  id: string
  label: string
  number: number
  focused: boolean
}

export interface PaneView {
  paneId: string
  workspaceId: string
  tabId: string
  focused: boolean
  /** Herdr's name for its agent (`claude`, `codex`…), and that agent's state. */
  agent: string | null
  status: string | null
  tokens: Record<string, string>
}

export interface Snapshot {
  version: string
  focusedPane: string | null
  focusedTab: string | null
  focusedWorkspace: string | null
  workspaces: Place[]
  tabs: (Place & { workspaceId: string })[]
  panes: PaneView[]
}

const placeOf = (value: Json, key: string): Place | null => {
  const id = text(value[key])
  if (!id) return null
  return {
    id,
    label: text(value.label) ?? id,
    number: count(value.number),
    focused: value.focused === true,
  }
}

/** A `session.snapshot` result (its `snapshot`), read forgivingly. */
export function readSnapshot(value: unknown): Snapshot {
  const snapshot = isObject(value) ? value : {}
  const list = (key: string) => (Array.isArray(snapshot[key]) ? snapshot[key] : []).filter(isObject)
  const tokensOf = (value: unknown) =>
    Object.fromEntries(
      Object.entries(isObject(value) ? value : {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    )
  return {
    version: text(snapshot.version) ?? '',
    focusedPane: text(snapshot.focused_pane_id),
    focusedTab: text(snapshot.focused_tab_id),
    focusedWorkspace: text(snapshot.focused_workspace_id),
    workspaces: list('workspaces').flatMap((each) => {
      const place = placeOf(each, 'workspace_id')
      return place ? [place] : []
    }),
    tabs: list('tabs').flatMap((each) => {
      const place = placeOf(each, 'tab_id')
      const workspaceId = text(each.workspace_id)
      return place && workspaceId ? [{ ...place, workspaceId }] : []
    }),
    panes: list('panes').flatMap((each) => {
      const paneId = text(each.pane_id)
      const workspaceId = text(each.workspace_id)
      const tabId = text(each.tab_id)
      if (!paneId || !workspaceId || !tabId) return []
      return [
        {
          paneId,
          workspaceId,
          tabId,
          focused: each.focused === true,
          agent: text(each.agent),
          status: text(each.agent_status),
          tokens: tokensOf(each.tokens),
        },
      ]
    }),
  }
}

/** A pane whose agent waits on you, as its tokens say. */
export interface Waiting {
  paneId: string
  workspaceId: string
  tabId: string
  /** Where it is, as Herdr labels it. */
  workspace: string
  tab: string
  /** The app and the name its agent goes by with Pending You. */
  app: AppId | null
  agent: string | null
  /** Herdr's name for its agent, and that agent's state. */
  herdrAgent: string | null
  status: string | null
  waiting: number
  /** The most pressing card's title, and the request ids (as many as its token holds), most pressing first. */
  card: string | null
  cards: string[]
  pressing: Pressing | null
  /** Those also asked in the conversation. */
  asked: string[]
}

/** The request ids a token holds (py_cards, py_asked), in its order. */
export const idsOf = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((each) => each.trim())
    .filter((each) => /^req_[A-Za-z0-9-]{1,40}$/.test(each))

const pressingRank = (pressing: Pressing | null) =>
  pressing ? PRESSING.indexOf(pressing) : PRESSING.length

/** The panes whose agents wait on you: most pressing first, then the most cards, then in Herdr's own order. */
export function waitingIn(snapshot: Snapshot): Waiting[] {
  const workspaces = new Map(snapshot.workspaces.map((each) => [each.id, each]))
  const tabs = new Map(snapshot.tabs.map((each) => [each.id, each]))
  const found = snapshot.panes.flatMap((pane, index) => {
    const waiting = Number.parseInt(pane.tokens[TOKENS.waiting] ?? '', 10)
    if (!Number.isFinite(waiting) || waiting < 1) return []
    const app = pane.tokens[TOKENS.app]
    const pressing = pane.tokens[TOKENS.urgency]
    const workspace = workspaces.get(pane.workspaceId)
    const tab = tabs.get(pane.tabId)
    const entry: Waiting & { order: number[] } = {
      paneId: pane.paneId,
      workspaceId: pane.workspaceId,
      tabId: pane.tabId,
      workspace: workspace?.label ?? pane.workspaceId,
      tab: tab?.label ?? pane.tabId,
      app: app && (APP_IDS as readonly string[]).includes(app) ? (app as AppId) : null,
      agent: pane.tokens[TOKENS.agent] ?? null,
      herdrAgent: pane.agent,
      status: pane.status,
      waiting,
      card: pane.tokens[TOKENS.card] ?? null,
      cards: idsOf(pane.tokens[TOKENS.cards]),
      pressing:
        pressing && (PRESSING as readonly string[]).includes(pressing)
          ? (pressing as Pressing)
          : null,
      asked: idsOf(pane.tokens[TOKENS.asked]),
      order: [
        workspace?.number ?? Number.MAX_SAFE_INTEGER,
        tab?.number ?? Number.MAX_SAFE_INTEGER,
        index,
      ],
    }
    return [entry]
  })
  found.sort((a, b) => {
    const first = pressingRank(a.pressing) - pressingRank(b.pressing)
    if (first) return first
    if (a.waiting !== b.waiting) return b.waiting - a.waiting
    for (let index = 0; index < a.order.length; index++)
      if (a.order[index] !== b.order[index]) return (a.order[index] ?? 0) - (b.order[index] ?? 0)
    return 0
  })
  return found.map(({ order: _order, ...waiting }) => waiting)
}

/** Herdr's panes now, and those waiting on you. */
export async function readWaiting(
  socket: string,
): Promise<{ snapshot: Snapshot; waiting: Waiting[] }> {
  const result = await herdrRequest<{ snapshot?: unknown }>(socket, 'session.snapshot')
  const snapshot = readSnapshot(result?.snapshot)
  return { snapshot, waiting: waitingIn(snapshot) }
}

/** The panes with any of Pending You's tokens on them (to take them off). */
export const badgedPanes = (snapshot: Snapshot) =>
  snapshot.panes.filter((pane) => Object.keys(pane.tokens).some((name) => name.startsWith('py_')))

/** The pane after the focused one among those waiting (the first when the focused one isn't), or null when none. */
export function nextWaiting(waiting: readonly Waiting[], focused: string | null): Waiting | null {
  if (waiting.length === 0) return null
  const at = waiting.findIndex((each) => each.paneId === focused)
  return waiting[(at + 1) % waiting.length] ?? null
}
