// What the headers helper (remote.ts) last handed an app's pendingyou MCP server, so the hooks can say when that
// server is likely stuck (0.27.0). Kept in ~/.config/pendingyou/helper.json: per app and Pending You address, when the
// helper last ran and whether its token was good (`ok`) or one that had already run out (`stale`). No token, ever.
//
// Why (2026-10-07): a Mac slept for five hours, with brief maintenance wakes. During one, Claude Code reconnected its
// pendingyou server, which runs the helper; the access token had run out while the Mac slept and the refresh couldn't
// land in the helper's time, so the helper printed nothing and exited 1. Claude Code (2.1.292) then connects with no
// Authorization, which brings in its own OAuth: the 401 marks the server "needs authentication", and it stays so,
// every tool call failing, until the person runs /mcp. Since 0.27.0 the helper never leaves Claude Code without a
// token while it has one (a refused token is a failed connect, which never turns on Claude Code's OAuth), and records
// here when the one it handed over had run out. Claude Code runs the helper only as it connects, so while the last run
// was `stale` the server may still be refused: the next-message hook tells the session how to bring it back.
import { join } from 'node:path'
import { APP_NAMES, type AppId, DEFAULT_APP } from './apps/ids.ts'
import { slotOf } from './credentials.ts'
import { configDir, readJson, writeWhole } from './files.ts'
import type { Io } from './io.ts'

export type HelperOutcome = 'ok' | 'stale'

interface HelperFile {
  version: 1
  /** `slotOf(origin, app)` → the helper's last run. */
  slots: Record<string, { at: number; outcome: HelperOutcome }>
}

/** How long after a `stale` run the hooks still say the server may be stuck: a working day's session. */
export const STUCK_FOR_MS = 12 * 60 * 60_000

const helperStatePath = (io: Pick<Io, 'env' | 'home'>) => join(configDir(io), 'helper.json')

async function readAll(io: Pick<Io, 'env' | 'home'>): Promise<HelperFile['slots']> {
  const file = await readJson<HelperFile>(helperStatePath(io)).catch(() => null)
  return file && typeof file.slots === 'object' && file.slots !== null ? file.slots : {}
}

/** Records the helper's run for an app at `origin`. Never throws: the helper's answer matters more. */
export async function recordHelper(
  io: Pick<Io, 'env' | 'home' | 'now'>,
  origin: string,
  app: AppId,
  outcome: HelperOutcome,
): Promise<void> {
  try {
    const slots = await readAll(io)
    const key = slotOf(origin, app)
    if (slots[key]?.outcome === outcome && outcome === 'ok') return
    slots[key] = { at: io.now(), outcome }
    await writeWhole(helperStatePath(io), `${JSON.stringify({ version: 1, slots }, null, 2)}\n`, {
      secret: true,
    })
  } catch {}
}

/** The helper's last run for an app at `origin`, if it ran since 0.27.0. */
export async function helperOutcome(
  io: Pick<Io, 'env' | 'home'>,
  origin: string,
  app: AppId = DEFAULT_APP,
): Promise<{ at: number; outcome: HelperOutcome } | null> {
  const entry = ((await readAll(io).catch(() => ({}))) as HelperFile['slots'])[slotOf(origin, app)]
  return entry &&
    typeof entry.at === 'number' &&
    (entry.outcome === 'ok' || entry.outcome === 'stale')
    ? entry
    : null
}

/** What the next-message hook says while the server may be stuck (about 75 tokens). */
export function stuckText(app: AppId): string {
  const back =
    app === DEFAULT_APP
      ? 'run /mcp, choose pendingyou and Reconnect (no need to Authenticate), or restart Claude Code'
      : `restart ${APP_NAMES[app]}`
  return `Pending You: when ${APP_NAMES[app]} last connected to its pendingyou MCP server, this computer couldn’t refresh its sign-in in time, so that connection may have been refused. If a pendingyou tool fails (not connected, or needs authentication), tell your person in chat: ${back}. Until it works, ask them in chat.`
}

/** The hook's line while the helper's last run for this app handed over a run-out token; null otherwise. */
export async function stuckLine(
  io: Pick<Io, 'env' | 'home' | 'now'>,
  origin: string,
  app: AppId,
): Promise<string | null> {
  try {
    const last = await helperOutcome(io, origin, app)
    if (last?.outcome !== 'stale' || io.now() - last.at > STUCK_FOR_MS) return null
    return stuckText(app)
  } catch {
    return null
  }
}
