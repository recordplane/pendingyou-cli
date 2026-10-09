// The wake mod (0.10.0, guide 2.24): the Pending You plugin's mod, which this package carries in mod/ for Claude Code
// set up with `npx pendingyou init` and no plugin. Claude Code 2.1.287 and later load it from CLAUDE_CODE_PLUGIN_DIRS
// (`env` in ~/.claude/settings.json). Every session then learns the cards it posts, checks them through its own
// Pending You connection, and is woken when the person answers, with no hold running; a hold an agent still starts is
// answered by the mod. `init` adds the copy inside the hooks' private copy (install.ts), keeping every other entry and
// replacing an older version's; `uninstall` takes it out; `status` says whether it's there. With the Pending You plugin
// installed too, the two copies agree that one acts.
//
// Since 0.23.0 the entry is `~/.config/pendingyou/mod` (stableModDir), a folder init copies this version's mod into
// file by file, rather than the private copy's own `cli/<version>/…/mod`. Claude Code reads CLAUDE_CODE_PLUGIN_DIRS
// only as a session starts, so an entry that named a version changed with every upgrade: open sessions kept the folder
// they loaded, which the upgrade then removed, and nothing told anyone (seen 2026-10-06). The folder stays put now, so
// the entry never changes, and an interactive session, which watches it, reloads the mod when init updates it.
import { join } from 'node:path'
import { configDir } from './files.ts'
import type { Io } from './io.ts'

type Json = Record<string, unknown>

/** The first Claude Code that loads mods. */
export const MOD_CLAUDE = '2.1.287'
/** Where Claude Code finds plugin folders to load as --plugin-dir does. */
export const PLUGIN_DIRS = 'CLAUDE_CODE_PLUGIN_DIRS'
/** The Pending You plugins, which carry the same mod: production's, and staging's for our own testing. */
export const PLUGINS_WITH_MOD = ['pending-you@pendingyou', 'pending-you-staging@pendingyou-staging']

/** The mod in a copy of this package (its folder in node_modules). */
export const modDir = (packageRoot: string) => join(packageRoot, 'mod')

/** Where Claude Code loads the command line's mod from (0.23.0): the same folder whatever the version. */
export const stableModDir = (io: Pick<Io, 'env' | 'home'>) => join(configDir(io), 'mod')

/** Claude Code's version from `claude --version` ("2.1.289 (Claude Code)"); null when it can't be read. */
export function claudeVersion(output: string): string | null {
  return /^\s*(\d+\.\d+\.\d+)\b/.exec(output)?.[1] ?? null
}

/** "2.1.289" against "2.1.287": whether `version` is at least `least`, part by part. */
export function atLeast(version: string, least: string): boolean {
  const have = version.split('.').map((part) => Number.parseInt(part, 10) || 0)
  const want = least.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(have.length, want.length); index++) {
    const a = have[index] ?? 0
    const b = want[index] ?? 0
    if (a !== b) return a > b
  }
  return true
}

/** Whether that Claude Code loads mods (2.1.287 or later). */
export const loadsMods = (version: string): boolean => atLeast(version, MOD_CLAUDE)

/** A folder as compared: trimmed, with no trailing slash. */
const bare = (path: string) => path.trim().replace(/[\\/]+$/, '')

/**
 * Whether a CLAUDE_CODE_PLUGIN_DIRS entry is a copy of this mod: a private copy's, from any version of this package,
 * or one of `also` (stableModDir).
 */
export const isOurModDir = (entry: string, also: readonly string[] = []) =>
  /(^|[\\/])node_modules[\\/]pendingyou[\\/]mod[\\/]?$/.test(entry.trim()) ||
  also.some((dir) => bare(dir) === bare(entry))

/** What Claude Code splits CLAUDE_CODE_PLUGIN_DIRS on. */
export const separatorFor = (platform: string) => (platform === 'win32' ? ';' : ':')

const objectAt = (parent: Json, key: string): Json | null => {
  const value = parent[key]
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null
}

/** The entries of CLAUDE_CODE_PLUGIN_DIRS in settings' `env`; null when it's there but isn't text. */
export function pluginDirs(settings: Json, separator: string): string[] | null {
  const env = objectAt(settings, 'env')
  if (settings.env !== undefined && env === null) return null
  const value = env?.[PLUGIN_DIRS]
  if (value === undefined) return []
  if (typeof value !== 'string') return null
  return value.split(separator).filter((entry) => entry.trim() !== '')
}

/**
 * Settings with the mod at `dir` in CLAUDE_CODE_PLUGIN_DIRS, or with none of ours when `dir` is null: every other entry
 * kept as it was, in its place, and any copy of ours (an older version's, or one of `also`) replaced. `changed` is
 * false when there was nothing to do; `invalid` says why the settings were left alone.
 */
export function withModDir(
  settings: Json,
  dir: string | null,
  separator: string,
  also: readonly string[] = [],
): { settings: Json; changed: boolean } | { invalid: string } {
  const entries = pluginDirs(settings, separator)
  if (entries === null)
    return {
      invalid: `Claude Code’s settings have an “env” or ${PLUGIN_DIRS} that I can’t read, so I left them alone.`,
    }
  if (dir?.includes(separator))
    return { invalid: `The wake mod’s folder has a “${separator}” in its path: ${dir}` }
  const ours = dir ? [...also, dir] : also
  const wanted = [...entries.filter((entry) => !isOurModDir(entry, ours)), ...(dir ? [dir] : [])]
  if (wanted.join(separator) === entries.join(separator)) return { settings, changed: false }
  const next = structuredClone(settings)
  const env = objectAt(next, 'env') ?? {}
  if (wanted.length) env[PLUGIN_DIRS] = wanted.join(separator)
  else delete env[PLUGIN_DIRS]
  if (Object.keys(env).length) next.env = env
  else delete next.env
  return { settings: next, changed: true }
}

/** Whether settings enable a Pending You plugin, which carries the mod itself. */
export function pluginEnabled(settings: Json): boolean {
  const enabled = objectAt(settings, 'enabledPlugins')
  return PLUGINS_WITH_MOD.some((id) => enabled?.[id] === true)
}
