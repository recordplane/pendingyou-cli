// Is this session on the Pending You its hooks are on? A Claude Code session stayed connected to staging after its
// person moved to production (2026-10-01): its cards went where they no longer looked, and the hooks, signed in to
// production, never heard them. So the hooks compare the `pendingyou` MCP server Claude Code has for the session's
// folder (read from ~/.claude.json and the folder's .mcp.json, read only) with the origin they run against (`--origin`),
// and when they differ, add one line telling the agent to ask its person which one they use. `status` says the same.
//
// Only the pendingyou server's url is read, never anything else from those files; nothing is written, nothing is sent.
// A server Claude Code can't be read for (no file, another shape, a plugin's server) is never called a mismatch.
import { join } from 'node:path'
import { codexServer } from './apps/codex.ts'
import { type AppId, DEFAULT_APP } from './apps/ids.ts'
import { opencodeServer } from './apps/opencode.ts'
import { piServerUrl } from './apps/pi.ts'
import { claudeJsonPath, MCP_NAME } from './claude.ts'
import { claudeDir, readText } from './files.ts'
import type { Io } from './io.ts'

type Json = Record<string, unknown>

/** Which of Claude Code's scopes the server came from, most specific first: what Claude Code itself uses. */
export type McpScope = 'local' | 'project' | 'user' | 'plugin'

/**
 * The published Pending You plugin for Claude (recordplane/pendingyou-plugin) and where its server is. A hand-added
 * pendingyou server at any scope overrides it in Claude Code, so it counts only when there's none.
 */
export const PLUGIN_ID = 'pending-you@pendingyou'
export const PLUGIN_MCP_URL = 'https://www.pendingyou.com/mcp'

export interface FolderServer {
  url: string
  scope: McpScope
}

const objectAt = (value: unknown, key: string): Json | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const found = (value as Json)[key]
  return typeof found === 'object' && found !== null && !Array.isArray(found)
    ? (found as Json)
    : null
}

const urlOf = (servers: Json | null): string | null => {
  const url = objectAt(servers, MCP_NAME)?.url
  return typeof url === 'string' && url.length > 0 ? url : null
}

async function readJsonQuietly(path: string): Promise<unknown> {
  try {
    const text = await readText(path)
    return text === null ? null : JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * The `pendingyou` MCP server Claude Code uses in `folder`: local scope (~/.claude.json's projects[folder]), then the
 * folder's own .mcp.json, then user scope (~/.claude.json's mcpServers), then the Pending You plugin when
 * ~/.claude/settings.json enables it. Null when none of them has one with a url.
 */
export async function serverForFolder(
  io: Pick<Io, 'env' | 'home'>,
  folder: string,
): Promise<FolderServer | null> {
  const [state, project, settings] = await Promise.all([
    readJsonQuietly(claudeJsonPath(io)),
    readJsonQuietly(join(folder, '.mcp.json')),
    readJsonQuietly(join(claudeDir(io), 'settings.json')),
  ])
  const local = urlOf(objectAt(objectAt(objectAt(state, 'projects'), folder), 'mcpServers'))
  if (local) return { url: local, scope: 'local' }
  const shared = urlOf(objectAt(project, 'mcpServers'))
  if (shared) return { url: shared, scope: 'project' }
  const user = urlOf(objectAt(state, 'mcpServers'))
  if (user) return { url: user, scope: 'user' }
  return objectAt(settings, 'enabledPlugins')?.[PLUGIN_ID] === true
    ? { url: PLUGIN_MCP_URL, scope: 'plugin' }
    : null
}

/**
 * The site an address is on, as one name: www.pendingyou.com and pendingyou.com are the same Pending You (the bare
 * name redirects), so both read https://www.pendingyou.com. Null when it isn't an address.
 */
export function siteOf(address: string): string | null {
  try {
    const url = new URL(address)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    const host = url.host === 'pendingyou.com' ? 'www.pendingyou.com' : url.host
    return `${url.protocol}//${host}`
  } catch {
    return null
  }
}

/** Whether the server and the hooks' origin are different Pending Yous. Unknown addresses never differ. */
export function differs(server: FolderServer | null, origin: string): server is FolderServer {
  if (!server) return false
  const a = siteOf(server.url)
  const b = siteOf(origin)
  return a !== null && b !== null && a !== b
}

/** The line a hook adds when they differ (about 45 tokens). */
export const mismatchLine = (server: FolderServer, origin: string) =>
  `Pending You: your MCP server is ${siteOf(server.url)} but your hooks and sign-in are ${siteOf(origin)}, so your cards and their answers may not meet. Ask your person which one they use, and restart the session after fixing it (npx pendingyou init --origin <that one>).`

/**
 * The hook's warning for this folder, or null when the two agree or can't be told. Never throws. Codex's server is the
 * one in its own config (~/.codex/config.toml), for every folder; OpenCode's the one in its global config; Pi's the one
 * in its mcp.json (its bridge's `--origin`, or production).
 */
export async function environmentWarning(
  io: Pick<Io, 'env' | 'home' | 'cwd'>,
  folder: string,
  origin: string,
  app: AppId = DEFAULT_APP,
): Promise<string | null> {
  try {
    const server: FolderServer | null =
      app === 'codex'
        ? await codexServer(io).then((found) =>
            found?.url ? { url: found.url, scope: 'user' } : null,
          )
        : app === 'opencode'
          ? await opencodeServer(io).then((url) => (url ? { url, scope: 'user' } : null))
          : app === 'pi'
            ? await piServerUrl(io).then((url) => (url ? { url, scope: 'user' } : null))
            : await serverForFolder(io, folder)
    return differs(server, origin) ? mismatchLine(server, origin) : null
  } catch {
    return null
  }
}
