// Which terminal a session runs in (0.18.0 Herdr; 0.39.0 tmux, Show me's docs/plans/2026-10-25-show-me.md §5): every
// presence report (presence.ts) tells Pending You the pane the session runs in, so the person's apps can find its agent
// there, and an app they signed in on this computer can bring that pane to the front when they press Show on a card:
//
//   in a Herdr pane:  { "app": "herdr", "paneId": "w2:p1", "server": "<16 hex>" }   (herdr.ts's herdrTerminal)
//   in a tmux pane:   { "app": "tmux",  "paneId": "%12",   "server": "<16 hex>" }
//
// `server` names which server of that terminal it is without its socket's path: the first 16 hex characters of a SHA-256
// of this computer's name and the socket's path, so two servers' `w1:p1` or `%12` aren't confused and the path never
// leaves the computer. tmux gives what runs in its panes TMUX (`<socket path>,<server pid>,<session>`) and TMUX_PANE
// (`%12`); the socket's path is TMUX's first part, and a revealer works the same hash out from tmux's own
// `#{socket_path}` (the SDK's show-in-tmux example).
//
// In a Herdr pane Herdr's wins, even when Herdr runs inside tmux: the pane the agent is in is Herdr's. A pane id that
// isn't one tmux gives (`%` and digits) is left out, and the report then says nothing of where it runs. Nothing else of
// tmux is read, and nothing is ever run in it.
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { type HerdrTerminal, herdrTerminal } from './herdr.ts'

/** A pane's id as tmux gives it (TMUX_PANE): `%` and its number, `%12`. */
export const TMUX_PANE = /^%[0-9]{1,9}$/

/** Where presence says a session runs in tmux (0.39.0): its pane, and which tmux server that is. */
export interface TmuxTerminal {
  app: 'tmux'
  paneId: string
  server?: string
}

/** Where presence says a session runs: its Herdr pane or its tmux pane. */
export type Terminal = HerdrTerminal | TmuxTerminal

/**
 * Which tmux server this process belongs to, as Pending You keeps it: the first 16 hex characters of a SHA-256 of the
 * computer's name and tmux's socket path (TMUX's first part), as herdrServer names Herdr's. Null without a socket path
 * it can use.
 */
export function tmuxServer(env: Record<string, string | undefined>, host: string): string | null {
  const [socket = ''] = (env.TMUX ?? '').split(',')
  if (!socket || !isAbsolute(socket) || /[\0\r\n]/.test(socket)) return null
  return createHash('sha256').update(`${host}${socket}`).digest('hex').slice(0, 16)
}

/** The tmux pane this process runs in, as presence reports it (and its server, when it can tell); null outside tmux. */
export function tmuxTerminal(
  env: Record<string, string | undefined>,
  host: string,
): TmuxTerminal | null {
  const pane = env.TMUX_PANE ?? ''
  if (!env.TMUX || !TMUX_PANE.test(pane)) return null
  const server = tmuxServer(env, host)
  return { app: 'tmux', paneId: pane, ...(server ? { server } : {}) }
}

/**
 * Where this process runs, as presence reports it: its Herdr pane (Herdr's wins, even inside tmux), else its tmux pane;
 * null in neither.
 */
export function terminalOf(env: Record<string, string | undefined>, host: string): Terminal | null {
  return herdrTerminal(env, host) ?? tmuxTerminal(env, host)
}
