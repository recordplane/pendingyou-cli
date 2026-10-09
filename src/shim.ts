// The hooks' shim (0.11.0): ~/.config/pendingyou/bin/pendingyou-hook, a small sh script that every agent's hooks run by
// its path, which never changes:
//
//   "<config>/bin/pendingyou-hook" pickup --app codex || true
//
// It runs this version's private copy (install.ts) with the Node init ran with. Upgrading pendingyou rewrites the
// script, never the hook definitions in Claude Code's settings or Codex's hooks.json: Codex runs a hook only while the
// person trusts its exact definition (since 0.129), and skips a changed one without a word until they trust it again,
// so a definition that changed with every version would quietly turn Pending You off there.
//
// The script carries the stable Node path (Homebrew's /opt/homebrew/bin/node, not the Cellar folder an upgrade
// removes); when that's gone it takes the first Node it finds. Without one it exits 0 with one line on stderr: a hook
// never blocks anyone. When the private copy couldn't be made, it runs this version through npx instead.
//
// Its one fast path: `permission-done` (every tool call) starts no Node while no session has a prompt written down.
// `notify` (0.16.0, Claude Code's Notification hook) needs none: init's matcher has Claude Code run it only for a
// dialog that has waited on screen (`permission_prompt`), which always has something to do, and never for its other
// notifications.
import { readFile, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { configDir, PERMISSION_FOLDER, writeWhole } from './files.ts'
import type { HookForm, Installed } from './install.ts'
import type { Io } from './io.ts'
import { USUAL_NODES, usualWords } from './remote.ts'
import { VERSION } from './version.ts'

export const SHIM = 'pendingyou-hook'
/** Where the shim lives: the same path whatever the version, so hook definitions never need changing. */
export const shimPath = (io: Pick<Io, 'env' | 'home'>) => join(configDir(io), 'bin', SHIM)

/** One word for sh, always in single quotes, so the script reads back exactly (readShim). */
const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`
const unquoted = (text: string) => text.replaceAll(`'\\''`, "'")

/** What the shim runs: the private copy with a Node, or (no copy) npx, or a command of the person's own. */
export type ShimRun =
  | Pick<Installed, 'node' | 'script'>
  | { npx: string }
  /** PENDINGYOU_SELF: what a developer points the hooks at instead. */
  | { self: string }

/**
 * The script, for what it runs and the config folder it was written for. Plain POSIX sh: dash runs it on Ubuntu.
 * `usual`: where Node usually is, when the recorded one is gone (remote.ts's USUAL_NODES; a test gives its own).
 */
export function shimScript(
  run: ShimRun,
  config: string,
  usual: readonly string[] = USUAL_NODES,
): string {
  const head = `#!/bin/sh
# Pending You's hooks run this, by this path, which never changes: upgrading pendingyou rewrites this file, never your
# agents' hook definitions. Written by npx pendingyou init (pendingyou ${VERSION}); run that again to repair it.
PENDINGYOU_CONFIG_DIR=${quoted(config)}
export PENDINGYOU_CONFIG_DIR
# A Claude Code tool call ran or a session ended: nothing to do unless a permission card may be open.
if [ "$1" = permission-done ]; then
  for open in "$PENDINGYOU_CONFIG_DIR"/${PERMISSION_FOLDER}/*.json; do
    [ -e "$open" ] && break
    exit 0
  done
fi
`
  if ('npx' in run) return `${head}exec ${run.npx} "$@"\n`
  if ('self' in run) return `${head}exec ${run.self} "$@"\n`
  return `${head}node=${quoted(run.node)}
cli=${quoted(run.script)}
if [ ! -x "$node" ]; then
  # The Node init ran with is gone: the first one to be found.
  node=$(command -v node 2>/dev/null) || node=
  for found in ${usualWords(usual)}; do
    if [ -z "$node" ] && [ -x "$found" ]; then node=$found; fi
  done
fi
if [ -z "$node" ] || [ ! -r "$cli" ]; then
  echo "pendingyou: its Node or its copy of pendingyou is gone. Run: npx -y pendingyou@latest init" >&2
  exit 0
fi
exec "$node" "$cli" "$@"
`
}

/** Writes the shim (0755) unless it's already exactly that. */
export async function writeShim(
  io: Pick<Io, 'env' | 'home'>,
  run: ShimRun,
): Promise<{ path: string; changed: boolean }> {
  const path = shimPath(io)
  const text = shimScript(run, configDir(io))
  const before = await readFile(path, 'utf8').catch(() => null)
  const mode = await stat(path).then(
    (info) => info.mode & 0o777,
    () => 0,
  )
  if (before === text && mode === 0o755) return { path, changed: false }
  await writeWhole(path, text, { mode: 0o755 })
  return { path, changed: true }
}

/** Removes the shim (uninstall, once no app is left set up). True when there was one. */
export async function removeShim(io: Pick<Io, 'env' | 'home'>): Promise<boolean> {
  const path = shimPath(io)
  const there = await stat(path).then(
    () => true,
    () => false,
  )
  await rm(path, { force: true })
  await rmdir(dirname(path)).catch(() => {})
  return there
}

/** What a shim runs, read back from its text, as a hook's form (install.ts). */
export function shimForm(text: string): HookForm {
  const node = /^node='((?:[^']|'\\'')*)'$/m.exec(text)?.[1]
  const cli = /^cli='((?:[^']|'\\'')*)'$/m.exec(text)?.[1]
  if (node !== undefined && cli !== undefined) {
    const script = unquoted(cli)
    const version = /\/cli\/([^/]+)\/node_modules\/pendingyou\/dist\/cli\.js$/.exec(script)
    return { form: 'direct', node: unquoted(node), script, version: version?.[1] ?? null }
  }
  const npx = /^exec (npx\s.*) "\$@"$/m.exec(text)?.[1]
  if (npx) return { form: 'npx', version: /pendingyou@([^\s]+)/.exec(npx)?.[1] ?? null }
  return { form: 'other' }
}

/** What the shim at its path runs now; null when it isn't there. */
export async function readShim(io: Pick<Io, 'env' | 'home'>): Promise<HookForm | null> {
  const text = await readFile(shimPath(io), 'utf8').catch(() => null)
  return text === null ? null : shimForm(text)
}
