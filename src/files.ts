// Where the command line keeps its files, and how it writes them: whole files only (a temporary file, then a rename),
// private to you (0600 files in a 0700 folder), and one writer at a time through a lock folder.
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PlainError } from './errors.ts'
import type { Io } from './io.ts'

/** ~/.config/pendingyou (or $XDG_CONFIG_HOME/pendingyou, or $PENDINGYOU_CONFIG_DIR). */
export function configDir(io: Pick<Io, 'env' | 'home'>): string {
  if (io.env.PENDINGYOU_CONFIG_DIR) return io.env.PENDINGYOU_CONFIG_DIR
  const base = io.env.XDG_CONFIG_HOME || join(io.home, '.config')
  return join(base, 'pendingyou')
}

/**
 * The folder, under configDir, of Claude Code sessions' permission prompts (0.13.0, permission.ts): one file a session
 * while it has a prompt or a card. The hooks' shim looks for any file here before it starts Node (shim.ts).
 */
export const PERMISSION_FOLDER = 'permission-cards'

/** Claude Code's own folder: ~/.claude, or $CLAUDE_CONFIG_DIR. */
export function claudeDir(io: Pick<Io, 'env' | 'home'>): string {
  return io.env.CLAUDE_CONFIG_DIR || join(io.home, '.claude')
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Reads JSON, or null when the file isn't there. A file that isn't JSON is an error: never silently replaced. */
export async function readJson<T>(path: string): Promise<T | null> {
  const text = await readText(path)
  if (text === null) return null
  return JSON.parse(text) as T
}

/**
 * Writes a whole file at once. `secret` files and their folder are private to you (0600 and 0700), however they were
 * before; a `mode` given is the file's (a script's 0755); other files keep the mode they had.
 */
export async function writeWhole(
  path: string,
  text: string,
  options: { secret?: boolean; mode?: number } = {},
): Promise<void> {
  const folder = dirname(path)
  await mkdir(folder, { recursive: true, ...(options.secret ? { mode: 0o700 } : {}) })
  if (options.secret) await chmod(folder, 0o700)
  let mode = options.mode ?? (options.secret ? 0o600 : 0o644)
  if (!options.secret && options.mode === undefined) {
    try {
      mode = (await stat(path)).mode & 0o777
    } catch {}
  }
  const temporary = join(folder, `.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, text, { mode, flag: 'wx' })
    await chmod(temporary, mode)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** A lock older than this was left by a process that died; it's taken over. */
export const STALE_MS = 30_000

/** Whether another process holds `<path>.lock` now (a lock older than STALE_MS doesn't count). */
export async function isLocked(path: string): Promise<boolean> {
  return stat(`${path}.lock`).then(
    (info) => Date.now() - info.mtimeMs <= STALE_MS,
    () => false,
  )
}

/** Runs `work` while holding `<path>.lock`, so two processes (a hold and a hook) never write over each other. */
export async function withLock<T>(
  path: string,
  io: Pick<Io, 'now' | 'sleep'>,
  work: () => Promise<T>,
): Promise<T> {
  const lock = `${path}.lock`
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 })
  const started = io.now()
  for (;;) {
    try {
      await mkdir(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const age = await stat(lock).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0,
      )
      if (age > STALE_MS) {
        await rm(lock, { recursive: true, force: true })
        continue
      }
      if (io.now() - started > 15_000)
        throw new PlainError('Another pendingyou command is busy. Try again.')
      await io.sleep(50 + Math.floor(Math.random() * 100))
    }
  }
  try {
    return await work()
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}
