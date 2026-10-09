// The command line's own copy for Claude Code's hooks (0.7.0). Hooks used to run `npx -y --prefer-offline
// pendingyou@<version> …`: npx costs about half a second before the command starts, and sessions starting together
// queue on npm's cache lock. Now `init` puts this exact version in a private folder,
// ~/.config/pendingyou/cli/<version>/node_modules/pendingyou, and the hooks run it with Node directly:
//
//   "<node>" "<config>/cli/<version>/node_modules/pendingyou/dist/cli.js" handoff || true
//
// The copy comes from the package init is running from when that's this very version (npx's copy: no network), and
// otherwise from `npm install --prefix`. It's built in a temporary folder, checked (`--version` must print this
// version), then moved into place, so a hook never runs half a copy. Running init again keeps a copy that checks out,
// and removes the other versions once the hooks point at this one, but for the newest of them (0.23.0): a Claude Code
// session started before may still run the wake mod inside it. When none of that works, the hooks keep the npx form,
// which is slower but works.
//
// The wake mod Claude Code loads (0.23.0) is copied out of this copy into `~/.config/pendingyou/mod` (mod.ts's
// stableModDir), a folder that stays put across versions, one whole file at a time.
import { randomBytes } from 'node:crypto'
import { cp, mkdir, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { configDir, readJson, readText, writeWhole } from './files.ts'
import type { Io } from './io.ts'
import { VERSION } from './version.ts'

/** Where the private copies live: ~/.config/pendingyou/cli. */
export const cliRoot = (io: Pick<Io, 'env' | 'home'>) => join(configDir(io), 'cli')
/** One version's prefix: ~/.config/pendingyou/cli/<version>. */
export const cliPrefix = (io: Pick<Io, 'env' | 'home'>, version = VERSION) =>
  join(cliRoot(io), version)
/** The command line inside a prefix. */
export const cliScript = (prefix: string) =>
  join(prefix, 'node_modules', 'pendingyou', 'dist', 'cli.js')
/** The package inside a prefix, where its mod/ is (0.10.0). */
export const cliPackage = (prefix: string) => join(prefix, 'node_modules', 'pendingyou')

/** How long npm may take to install the package (it usually takes a few seconds). */
const NPM_TIMEOUT_MS = 180_000

export interface Installed {
  version: string
  prefix: string
  /** The Node the hooks run it with. */
  node: string
  script: string
  /** `kept`: already there and working; `copied`: from the running package; `npm`: npm installed it. */
  how: 'kept' | 'copied' | 'npm'
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

/**
 * The Node the hooks should run: the running one, by the path on PATH that leads to it when there is one
 * (Homebrew's /opt/homebrew/bin/node outlives an upgrade; the versioned folder it points into doesn't).
 */
export async function hookNode(io: Pick<Io, 'env' | 'execPath'>): Promise<string> {
  const running = await realpath(io.execPath).catch(() => null)
  if (running)
    for (const dir of (io.env.PATH ?? '').split(':')) {
      if (!dir || !isAbsolute(dir)) continue
      const candidate = join(dir, 'node')
      if ((await realpath(candidate).catch(() => null)) === running) return candidate
    }
  return io.execPath
}

/** Whether `script` run by `node` is this version of the command line. */
async function works(io: Io, node: string, script: string): Promise<boolean> {
  if (!(await exists(script))) return false
  const result = await io.run(node, [script, '--version'], 30_000)
  return result.code === 0 && result.stdout.trim() === VERSION
}

/** The package init is running from, when it's this version of pendingyou (npx's copy, or a global install). */
async function runningPackage(io: Pick<Io, 'script'>): Promise<string | null> {
  if (!io.script || basename(io.script) !== 'cli.js' || basename(dirname(io.script)) !== 'dist')
    return null
  const root = dirname(dirname(io.script))
  const manifest = await readJson<{ name?: unknown; version?: unknown }>(
    join(root, 'package.json'),
  ).catch(() => null)
  return manifest?.name === 'pendingyou' && manifest.version === VERSION ? root : null
}

/** Copies the package's published files (no dependencies to bring: it has none), the wake mod included. */
async function copyPackage(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true })
  for (const name of ['package.json', 'dist', 'mod', 'README.md', 'CHANGELOG.md', 'LICENSE'])
    if (await exists(join(from, name)))
      await cp(join(from, name), join(to, name), { recursive: true })
}

/**
 * Puts this version in its private prefix, or keeps the one already there. Null (and why) when it couldn't: the hooks
 * then use npx.
 */
export async function installCli(
  io: Io,
  progress: (text: string) => void,
): Promise<{ installed: Installed; error?: undefined } | { installed: null; error: string }> {
  const node = await hookNode(io)
  const prefix = cliPrefix(io)
  const script = cliScript(prefix)
  if (await works(io, node, script))
    return { installed: { version: VERSION, prefix, node, script, how: 'kept' } }

  const root = cliRoot(io)
  const staging = join(root, `.tmp-${VERSION}-${randomBytes(4).toString('hex')}`)
  try {
    await mkdir(root, { recursive: true, mode: 0o700 })
    let how: Installed['how'] | null = null
    const from = await runningPackage(io)
    if (from) {
      try {
        await copyPackage(from, join(staging, 'node_modules', 'pendingyou'))
        if (await works(io, node, cliScript(staging))) how = 'copied'
      } catch {}
    }
    if (!how) {
      await rm(staging, { recursive: true, force: true })
      await mkdir(staging, { recursive: true })
      progress(`Installing pendingyou@${VERSION} with npm, so the hooks start fast…\n`)
      const result = await io.run(
        'npm',
        [
          'install',
          '--prefix',
          staging,
          '--no-save',
          '--no-package-lock',
          '--no-audit',
          '--no-fund',
          '--prefer-offline',
          '--loglevel=error',
          `pendingyou@${VERSION}`,
        ],
        NPM_TIMEOUT_MS,
      )
      if (result.code === 127)
        return { installed: null, error: 'npm isn’t on this computer’s PATH' }
      if (result.code === 124)
        return { installed: null, error: 'npm took more than 3 minutes to install it' }
      if (result.code !== 0) return { installed: null, error: 'npm couldn’t install it' }
      if (!(await works(io, node, cliScript(staging))))
        return { installed: null, error: 'the installed copy didn’t run' }
      how = 'npm'
    }
    await rm(prefix, { recursive: true, force: true })
    await rename(staging, prefix)
    return { installed: { version: VERSION, prefix, node, script, how } }
  } catch {
    return { installed: null, error: `couldn’t write to ${root}` }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

/** "0.22.1" before "0.23.0", part by part; anything that isn't a version sorts first. */
function byVersion(a: string, b: string): number {
  const parts = (version: string) => version.split('.').map((part) => Number.parseInt(part, 10))
  const [left, right] = [parts(a), parts(b)]
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference) return difference
  }
  return 0
}

const VERSION_NAME = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

/**
 * Removes the private copies the hooks no longer run, and leftovers: every one but `keep` and the newest other version
 * (0.23.0). Before 0.23.0 Claude Code loaded the wake mod from inside a copy, and a session keeps the folder it loaded
 * until it restarts: removing that copy with the upgrade left it with no mod at all (seen 2026-10-06).
 */
export async function pruneCli(io: Pick<Io, 'env' | 'home'>, keep: string | null): Promise<void> {
  const root = cliRoot(io)
  const entries = await readdir(root).catch(() => [] as string[])
  const previous = entries
    .filter((entry) => entry !== keep && VERSION_NAME.test(entry))
    .sort(byVersion)
    .at(-1)
  for (const entry of entries)
    if (entry !== keep && entry !== previous)
      await rm(join(root, entry), { recursive: true, force: true }).catch(() => {})
}

/** Every file under a folder, by its path from there, but its `tests`. */
async function filesUnder(root: string, at = root): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(at, { withFileTypes: true })) {
    const path = join(at, entry.name)
    if (entry.isDirectory()) {
      if (at === root && entry.name === 'tests') continue
      found.push(...(await filesUnder(root, path)))
    } else if (entry.isFile()) found.push(relative(root, path))
  }
  return found
}

/** The order the mod's files are written in: what the hooks module imports first, the module, then the rest. */
const MOD_ORDER = ['hooks/wake.js', 'hooks/register.js', 'hooks/hooks.json']
const modRank = (path: string) => {
  const at = MOD_ORDER.indexOf(path.replaceAll('\\', '/'))
  return at === -1 ? MOD_ORDER.length : at
}

/**
 * Copies the wake mod from a copy of this package (`from`, its mod/) into `to` (stableModDir), one whole file at a time,
 * and only the files that changed: an interactive Claude Code session watches the folder and reloads the mod once the
 * writes stop, so it never loads a half-written file, and an init that changes nothing reloads nothing. The module it
 * imports goes first. Files of the folder's own (Claude Code writes its types there) are left alone. `changed` says
 * whether any file was written.
 */
export async function installMod(from: string, to: string): Promise<{ changed: boolean }> {
  const files = (await filesUnder(from)).sort((a, b) => modRank(a) - modRank(b))
  let changed = false
  for (const file of files) {
    const text = await readFile(join(from, file), 'utf8')
    if ((await readText(join(to, file)).catch(() => null)) === text) continue
    await writeWhole(join(to, file), text, { mode: 0o644 })
    changed = true
  }
  return { changed }
}

/** Removes the private copies altogether (uninstall). True when there were any. */
export async function removeCli(io: Pick<Io, 'env' | 'home'>): Promise<boolean> {
  const root = cliRoot(io)
  if (!(await exists(root))) return false
  await rm(root, { recursive: true, force: true })
  return true
}

/** A double-quoted shell word: safe for any path, spaces and quotes included. */
export const shellQuote = (text: string) => `"${text.replace(/["$`\\]/g, '\\$&')}"`

/** What a hook command runs: this computer's private copy (and which), npx, or something else. */
export type HookForm =
  | { form: 'direct'; node: string; script: string; version: string | null }
  | { form: 'npx'; version: string | null }
  | { form: 'other' }

const QUOTED = /^"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"\s/
const unquote = (text: string) => text.replace(/\\(.)/g, '$1')

export function hookForm(command: string): HookForm {
  const direct = QUOTED.exec(command)
  if (direct) {
    const script = unquote(direct[2] as string)
    const version = /\/cli\/([^/]+)\/node_modules\/pendingyou\/dist\/cli\.js$/.exec(script)
    return {
      form: 'direct',
      node: unquote(direct[1] as string),
      script,
      version: version?.[1] ?? null,
    }
  }
  if (/^npx\s/.test(command))
    return { form: 'npx', version: /pendingyou@([^\s]+)/.exec(command)?.[1] ?? null }
  return { form: 'other' }
}

/** Whether a direct hook's Node and script are both still there. */
export const hookRuns = async (form: HookForm) =>
  form.form !== 'direct' || ((await exists(form.node)) && (await exists(form.script)))
