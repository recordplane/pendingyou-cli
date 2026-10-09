// Agents' hook definitions, as init writes them (0.11.0). Claude Code's settings.json `hooks` and Codex's hooks.json
// share one shape:
//
//   { "<Event>": [ { "matcher": "…", "hooks": [ { "type": "command", "command": "…", "timeout": 10 } ] } ] }
//
// Ours are recognised by what they run (pendingyou and the command: pickup, handoff, stopcheck, posted), whatever
// version or path wrote them, so init updates them in place and uninstall takes out exactly them. Every other entry is
// kept as it was, in its place. Each line runs the shim (shim.ts) by its fixed path, with the app it's for:
//
//   "<config>/bin/pendingyou-hook" pickup --app claude-code || true
//
// `|| true` keeps a hook from ever blocking the person, even when the shim can't start (Claude Code blocks a message
// when its UserPromptSubmit hook exits 2, and flags any other failure).

import type { AppId } from './apps/ids.ts'
import { DEFAULT_ORIGIN } from './args.ts'
import { PlainError } from './errors.ts'
import { shellQuote } from './install.ts'

type Json = Record<string, unknown>
export interface HookEntry {
  type?: string
  command?: string
  timeout?: number
}
export interface HookGroup {
  matcher?: string
  hooks?: HookEntry[]
}

/** Seconds an agent gives each hook; they time-box themselves well inside it (main.ts's 3-second deadline). */
export const HOOK_TIMEOUT = 10

/** One of an app's hooks: its event, the command it runs, and the event's matcher when it needs one. */
export interface HookSpec {
  event: string
  sub: string
  matcher?: string
  /**
   * Seconds the agent gives it: HOOK_TIMEOUT unless it says. Null: none of ours, so the event keeps its own (Claude
   * Code's SessionEnd hooks share 1.5 seconds, which a longer timeout of one hook would raise for all of them).
   */
  timeout?: number | null
}

/**
 * Which of `mergeHooks`' lines is a hook's: `<event>:<command>` (0.15.0, where one event has two of ours, as Codex's
 * PostToolUse does), else the event's.
 */
export const lineKey = (spec: Pick<HookSpec, 'event' | 'sub'>) => `${spec.event}:${spec.sub}`

/** One word for sh: as it is when it's plain, otherwise in single quotes. */
export const shWord = (text: string) =>
  /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`

/** `--origin <it>`, for a command line, only when it isn't production. */
export const originArgs = (origin: string) =>
  origin === DEFAULT_ORIGIN ? '' : ` --origin ${shWord(origin)}`

/** A hook's command line through the shim: the command first, then the app, then `--origin` off production. */
export function hookLine(shim: string, origin: string, app: AppId, sub: string): string {
  return `${shellQuote(shim)} ${sub} --app ${app}${originArgs(origin)} || true`
}

/** Whether a hook command is one of ours: it runs pendingyou's `sub` (pickup, handoff, stopcheck, posted). */
export function isOurHook(command: unknown, sub: string): boolean {
  if (typeof command !== 'string' || !command.includes('pendingyou')) return false
  return new RegExp(`\\s${sub}(\\s|$)`).test(command)
}

const objectAt = (parent: Json, key: string): Json | null => {
  const value = parent[key]
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null
}

/** The hooks object of a settings file; an error (and no changes) when it isn't an object. */
export function hooksOf(settings: Json, where: string): Json {
  const hooks = objectAt(settings, 'hooks')
  if (settings.hooks !== undefined && hooks === null)
    throw new PlainError(`${where} has a “hooks” that isn’t an object, so I left it alone.`)
  return hooks ?? {}
}

/** Our hook for `sub` under `event`, if there is one. */
export function findHook(hooks: Json, event: string, sub: string): HookEntry | undefined {
  const groups = hooks[event]
  if (!Array.isArray(groups)) return undefined
  return (groups as HookGroup[])
    .flatMap((group) => group?.hooks ?? [])
    .find((hook) => isOurHook(hook?.command, sub))
}

/**
 * Adds our hooks, or updates them in place (a new command, a line an older version wrote, one copied from another
 * app): `lines` holds each event's command line. Returns the hooks (a copy) and whether anything changed.
 */
export function mergeHooks(
  hooks: Json,
  specs: readonly HookSpec[],
  lines: Readonly<Record<string, string>>,
  where: string,
): { hooks: Json; changed: boolean } {
  const next = structuredClone(hooks)
  let changed = false
  for (const spec of specs) {
    const wanted = lines[lineKey(spec)] ?? lines[spec.event]
    if (wanted === undefined) continue
    if (next[spec.event] !== undefined && !Array.isArray(next[spec.event]))
      throw new PlainError(`${where}’s ${spec.event} hooks aren’t a list, so I left them alone.`)
    const groups = Array.isArray(next[spec.event]) ? (next[spec.event] as HookGroup[]) : []
    const ours = groups.filter((group) =>
      (group?.hooks ?? []).some((hook) => isOurHook(hook?.command, spec.sub)),
    )
    const timeout = spec.timeout === undefined ? HOOK_TIMEOUT : spec.timeout
    if (ours.length === 0) {
      groups.push({
        ...(spec.matcher ? { matcher: spec.matcher } : {}),
        hooks: [{ type: 'command', command: wanted, ...(timeout === null ? {} : { timeout }) }],
      })
      changed = true
    }
    for (const group of ours) {
      for (const hook of group.hooks ?? [])
        if (
          isOurHook(hook.command, spec.sub) &&
          (hook.command !== wanted ||
            (timeout === null ? 'timeout' in hook : hook.timeout !== timeout))
        ) {
          hook.command = wanted
          if (timeout === null) delete hook.timeout
          else hook.timeout = timeout
          changed = true
        }
      // The matcher is ours to set only on a group that holds nothing but our hook.
      const alone = (group.hooks ?? []).every((hook) => isOurHook(hook.command, spec.sub))
      if (alone && spec.matcher && group.matcher !== spec.matcher) {
        group.matcher = spec.matcher
        changed = true
      }
    }
    next[spec.event] = groups
  }
  return { hooks: next, changed }
}

/** Takes our hooks out and leaves everything else as it was; an event left with no groups goes. */
export function removeHooks(
  hooks: Json,
  specs: readonly Pick<HookSpec, 'event' | 'sub'>[],
): { hooks: Json; changed: boolean } {
  const next = structuredClone(hooks)
  let changed = false
  for (const spec of specs) {
    if (!Array.isArray(next[spec.event])) continue
    const groups: HookGroup[] = []
    for (const group of next[spec.event] as HookGroup[]) {
      const kept = (group?.hooks ?? []).filter((hook) => !isOurHook(hook?.command, spec.sub))
      if (kept.length !== (group?.hooks ?? []).length) changed = true
      if (kept.length > 0 || !Array.isArray(group?.hooks)) groups.push({ ...group, hooks: kept })
    }
    if (groups.length) next[spec.event] = groups
    else delete next[spec.event]
  }
  return { hooks: next, changed }
}
