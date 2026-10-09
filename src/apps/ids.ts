// The apps `pendingyou init` sets up (0.11.0), by the id Pending You knows each by: a connection's `source`, and what
// the hooks send as `source` so a session only ever hears its own app's cards. Each has a module in this folder
// (registry.ts lists them; docs/apps.md says what a module does). Kept apart from the modules so the argument parser can
// read the list without loading them.

/** Every app with a module, in the order init sets them up and status lists them. */
export const APP_IDS = ['claude-code', 'codex', 'opencode', 'pi'] as const
export type AppId = (typeof APP_IDS)[number]

/** What people call each app: "Claude Code on build-01" is a connection's name on the Assistants page. */
export const APP_NAMES: Record<AppId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
}

/**
 * The app a command acts for when it names none: Claude Code, the only app before 0.11.0, so hook lines and helpers
 * written by 0.10.0 keep meaning what they meant.
 */
export const DEFAULT_APP: AppId = 'claude-code'

export const isAppId = (text: string): text is AppId =>
  (APP_IDS as readonly string[]).includes(text)

/** "Claude Code and Codex", "Claude Code, Codex and OpenCode" (or "… or …"). */
export function namesOf(apps: readonly AppId[], joiner: 'and' | 'or' = 'and'): string {
  const names = apps.map((app) => APP_NAMES[app])
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} ${joiner} ${names.at(-1)}`
}
