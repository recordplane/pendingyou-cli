// What the Pending You plugin for Herdr (packages/herdr-plugin) keeps and writes, as plain functions where they can be:
// where it is (Herdr hands each plugin command its id, its state folder and the socket), the managed block it offers to
// add to Herdr's config.toml (a sidebar row that shows `$py_card`), the keybindings it prints for you to add yourself,
// the Agents view it can set, and whether toasts reach you. Herdr has no settings API and no uninstall hook, so
// `unconfigure` takes out exactly the block between its two marker lines, and nothing else of the file.
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { configDir, readJson, writeWhole } from '../files.ts'
import type { Io } from '../io.ts'
import { definedInline, tableSpans, tableValues } from '../toml.ts'

/** The plugin's id, as its manifest says (packages/herdr-plugin). */
export const PLUGIN_ID = 'pendingyou.herdr'

/** Where the plugin is: its id, its state folder, and Herdr's socket (none outside a Herdr command). */
export interface PluginPlace {
  id: string
  stateDir: string
  socket: string | null
}

export function pluginPlace(io: Pick<Io, 'env' | 'home'>): PluginPlace {
  const id = io.env.HERDR_PLUGIN_ID || PLUGIN_ID
  return {
    id,
    // Herdr's own folder for the plugin's state; run by hand, the command line's.
    stateDir: io.env.HERDR_PLUGIN_STATE_DIR || join(configDir(io), 'herdr-plugin'),
    socket: io.env.HERDR_SOCKET_PATH || null,
  }
}

/** Herdr's config file: HERDR_CONFIG_PATH, else config.toml in its folder under XDG_CONFIG_HOME or ~/.config. */
export function herdrConfigPath(io: Pick<Io, 'env' | 'home'>): string {
  if (io.env.HERDR_CONFIG_PATH) return io.env.HERDR_CONFIG_PATH
  return join(io.env.XDG_CONFIG_HOME || join(io.home, '.config'), 'herdr', 'config.toml')
}

/** The managed block's first and last lines: everything between them is the plugin's. */
export const BLOCK_START = '# >>> Pending You for Herdr'
export const BLOCK_END = '# <<< Pending You for Herdr'

/** The sidebar row the plugin adds: the most pressing card's title, in amber, under each agent waiting on you. */
export const CARD_ROW = '[{ token = "$py_card", fg = "#e0a526" }]'

/**
 * The block setup offers: Herdr's default agent rows, the state's text beside the agent (so "waiting on you" shows),
 * and the card's row. A whole `[ui.sidebar.agents]` table, since Herdr's rows replace its defaults rather than add.
 */
export const SIDEBAR_BLOCK = `${BLOCK_START} (added by the plugin's setup; its "unconfigure" takes it out again)
[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent", "state_text"],
  ${CARD_ROW},
]
${BLOCK_END}
`

/** Where the managed block is in the file: its first line's start and its last line's end; null when it isn't. */
function blockSpan(doc: string): { start: number; end: number } | null {
  const start = doc.indexOf(BLOCK_START)
  if (start < 0 || (start > 0 && doc[start - 1] !== '\n')) return null
  const close = doc.indexOf(BLOCK_END, start)
  if (close < 0) return null
  const newline = doc.indexOf('\n', close)
  return { start, end: newline < 0 ? doc.length : newline + 1 }
}

export const hasBlock = (doc: string) => blockSpan(doc) !== null

/** Whether the file sets the agent rows itself (a table of its own, or dotted keys or an inline table). */
export function ownSidebar(doc: string): boolean {
  const path = ['ui', 'sidebar', 'agents']
  const without = withoutBlock(doc)
  return tableSpans(without, path).length > 0 || definedInline(without, path)
}

/** The file with the managed block added at its end, after a blank line. */
export function withBlock(doc: string): string {
  if (hasBlock(doc)) return doc
  const gap = doc === '' ? '' : doc.endsWith('\n\n') ? '' : doc.endsWith('\n') ? '\n' : '\n\n'
  return `${doc}${gap}${SIDEBAR_BLOCK}`
}

/** The file without the managed block, and without the blank line added before it. Every other byte stays. */
export function withoutBlock(doc: string): string {
  const span = blockSpan(doc)
  if (!span) return doc
  let before = doc.slice(0, span.start)
  const after = doc.slice(span.end)
  if (after === '' && before.endsWith('\n\n')) before = before.slice(0, -1)
  return before + after
}

/**
 * Herdr's toast delivery as this file sets it: `off` (Herdr's default, also when the file says nothing), `herdr`,
 * `terminal` or `system`; `unknown` when it's set some way this can't read.
 */
export function toastDelivery(doc: string): string {
  if (definedInline(doc, ['ui', 'toast'])) return 'unknown'
  const delivery = tableValues(doc, ['ui', 'toast']).delivery
  if (delivery === undefined) return 'off'
  return typeof delivery === 'string' ? delivery : 'unknown'
}

/** What turns toasts on, to paste into config.toml on the computer you attach from. */
export const TOAST_SNIPPET = `[ui.toast]
delivery = "herdr"
`

/** The keybindings setup suggests: prefix+y your cards, prefix+shift+y the next pane waiting on you. */
export const KEYS_SNIPPET = `[[keys.command]]
key = "prefix+y"
type = "plugin_action"
command = "${PLUGIN_ID}.open"
description = "Pending You: what's waiting on you"

[[keys.command]]
key = "prefix+shift+y"
type = "plugin_action"
command = "${PLUGIN_ID}.next"
description = "Pending You: next pane waiting on you"
`

/** The Agents view the plugin can set: agents waiting on you (or on a prompt) first, the most pressing on top. */
export function agentView(pluginId: string): Record<string, unknown> {
  return {
    source: `plugin:${pluginId}`,
    label: 'waiting on you',
    filter: {
      op: 'any',
      filters: [
        { op: 'exists', field: { token: 'py_waiting' } },
        { op: 'eq', field: 'status', value: 'blocked' },
      ],
    },
    sort: [
      { field: { token: 'py_urgency' }, order: 'asc' },
      { field: 'attention', order: 'desc' },
      { field: 'state_change_seq', order: 'desc' },
    ],
  }
}

/** The plugin's own settings, in its state folder: whether its Agents view is on (reapplied as Herdr starts). */
const settingsPath = (place: PluginPlace) => join(place.stateDir, 'settings.json')

export async function viewOn(place: PluginPlace): Promise<boolean> {
  const settings = await readJson<{ view?: unknown }>(settingsPath(place)).catch(() => null)
  return settings?.view === true
}

export async function saveView(place: PluginPlace, on: boolean): Promise<void> {
  await writeWhole(settingsPath(place), `${JSON.stringify({ version: 1, view: on }, null, 2)}\n`)
}

/**
 * `unconfigure` turns the plugin off until its setup runs again: a file in its state folder, which the plugin's script
 * reads before starting Node for an event, so a plugin left linked starts no watcher again.
 */
const offPath = (place: PluginPlace) => join(place.stateDir, 'off')

export const pluginOff = (place: PluginPlace) =>
  stat(offPath(place)).then(
    () => true,
    () => false,
  )

export async function setPluginOff(place: PluginPlace, off: boolean): Promise<void> {
  if (off) await writeWhole(offPath(place), 'Pending You is off in Herdr: its setup turns it on.\n')
  else await rm(offPath(place), { force: true })
}
