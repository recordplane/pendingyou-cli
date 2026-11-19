// Antigravity's hooks: what `pendingyou <pickup|handoff|posted|stopcheck> --app antigravity` reads from agy and prints
// back. agy (1.5.12) runs each hook of Pending You's plugin (hooks.json at the plugin's root, antigravity.ts) with sh,
// its input one JSON object on stdin in camelCase, and reads one JSON object from stdout, always, even `{}`. So these
// commands read agy's input into the shape the other apps' hooks give (session_id, cwd, prompt, turn_id, tool_name,
// tool_input, stop_hook_active…), run the command as they do, and put what it printed into agy's shapes:
//
// - SessionStart (pickup): fires once, at a conversation's first message, before the first model call (not as agy
//   starts). `conversationId` is the session; it counts as a session start (`startup`). What pickup says goes back as
//   `{"injectSteps":[{"systemMessage":{"systemMessage":"…"}}]}`, which the model reads.
// - PreInvocation (handoff): before every model call. Only a turn's first (`invocationNum` 0: agy counts them again from
//   0 with each turn) runs the hand-off; any other prints `{}` at once, with no request. That first call also notes the
//   turn, `<conversationId>:<initialNumSteps>` read at that moment (it isn't the same at the turn's later calls), as the
//   conversation's turn now, for the card calls and the Stop check after it. A turn a finished background command
//   started (a hold's wake: seen live, its `lastUserInput` is the turn before's, since the person typed nothing) isn't
//   a message of theirs: its `prompt` is left out and it's marked `woken`, so it reads none of their answers and the
//   Stop check doesn't take it as their question. The hold already said what it heard, and marked it handed over.
//   How a wake is told (0.45.0): its `lastUserInput` is the turn before's (by a hash, never the words), and the turn
//   before didn't end idle. agy's Stop says `fullyIdle` false while a command of the turn's still runs in the
//   background (seen live: the hold's turn ended so, every other turn true), and only such a command can start a turn
//   by itself. So the person sending the same message twice reads as a wake only when the turn before left a command
//   running; a Stop that says nothing of it leaves the hash alone to tell. Nothing else in the payloads tells the two
//   apart: PreInvocation and SessionStart carry the same keys for both, and `initialNumSteps` counts the steps before
//   the call either way. Two stronger signs were seen and left: the finished command's PostToolUse arrives between the
//   Stop and the wake's first model call (it fires when a background command ends, not when it starts), but only with
//   a matcher that runs the hook after every shell command; and the transcript's step before a wake is a
//   SYSTEM_MESSAGE where the person's is a USER_INPUT, but the wake's step isn't counted yet at its first model call.
// - PostToolUse (posted): a Pending You call, by the name agy gives it (agyToolCall: seen live, `call_mcp_tool` with
//   `ServerName` "pendingyou_pendingyou", `ToolName` and `Arguments` for a tool loaded lazily, and
//   `mcp_pendingyou_pendingyou_<tool>` with the tool's own arguments for an eager one), named as the other apps' hooks
//   name it (`mcp__pendingyou__post_request`). agy hands a PostToolUse hook no result, so a card's request id is known
//   only when the call gave one (update_request, reply_in_thread…); a failed call is nothing. So after a post_request
//   (0.45.0) it asks Pending You for the session's open cards, as the Stop check does (the same request and 1.5
//   seconds), and the one with the call's title that the session didn't know yet is the card just posted: the session's
//   cards, its hold and its Herdr badges know it at once. Not reached in time, nothing is learned and nothing fails.
//   post_answer's card isn't learned so: Pending You leaves answers out of the open cards. Prints `{}`.
// - Stop (stopcheck): never for a go a Stop hook asked for (seen live: the second Stop has `executionNum` 1, and
//   `continuationActive` false, whatever agy's docs say; either counts), nor for a turn the person cancelled or that
//   ended in an error. What it asks goes back as `{"decision":"continue","reason":"…"}`, which agy reads as one more
//   model call with the reason as a system message; else `{}`. agy hands a Stop hook no final message, so (0.45.0) it
//   is read from the tail of the transcript (agyFinalMessage), never more than AGY_TRANSCRIPT_CAP bytes; a turn whose
//   final message can't be read there (no file, a line still being written) ends. Each Stop also notes whether the
//   turn ended idle, for telling the next turn's wake.
//
// There's no session-end hook: the keeper (presence.ts) says closed once the agy process is gone. Whatever goes wrong,
// the hook prints `{}` and exits 0 (the hook line's `|| echo '{}'`, and the shim without a Node, cover the rest).
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { DEFAULT_ORIGIN } from '../args.ts'
import { configDir, readJson, withLock, writeWhole } from '../files.ts'
import { isHandedWake } from '../format.ts'
import type { Io } from '../io.ts'

type Json = Record<string, unknown>

/** The commands Antigravity's hooks run, and each one's event. */
export const AGY_HOOK_EVENTS = {
  pickup: 'SessionStart',
  handoff: 'PreInvocation',
  posted: 'PostToolUse',
  stopcheck: 'Stop',
} as const
export type AgyHookCommand = keyof typeof AGY_HOOK_EVENTS
export const isAgyHook = (name: string): name is AgyHookCommand => name in AGY_HOOK_EVENTS

/**
 * The tool agy names a lazily loaded MCP tool's call by (seen live, 1.5.12: `call_mcp_tool`, with `ServerName`,
 * `ToolName` and `Arguments`). `mcp_tool` as well, the name agy's docs say a step type gives (CORTEX_STEP_TYPE_MCP_TOOL).
 */
export const AGY_MCP_CALLERS: ReadonlySet<string> = new Set(['call_mcp_tool', 'mcp_tool'])
/**
 * How agy names an eagerly loaded tool (seen live, 1.5.12: `mcp_<plugin folder>_<server>_<tool>`,
 * `mcp_pendingyou_pendingyou_post_request`); one or two underscores and no `mcp` taken too. Only Pending You's.
 */
export const AGY_EAGER_TOOL =
  /^(?:mcp_{1,2})?([A-Za-z0-9-]*pendingyou[A-Za-z0-9_-]*?)_{1,2}(post_request|post_answer|update_request|reply_in_thread|cancel_request|answer_delegated|hand_back|whoami|list_pending|get_request)$/i
/**
 * The PostToolUse matcher (a regex on the tool's name), wide enough for both forms above; the code keeps only Pending
 * You's. agy starts the hook for each call it matches, so not every tool (`.*`, which would run it after every shell
 * command and file read too). UNCONFIRMED: that agy matches a `|` of two patterns, as its docs' `run_command\|view_file`.
 */
export const AGY_POST_TOOL_MATCHER = '.*mcp.*|.*pendingyou.*'
/**
 * The most of agy's transcript the Stop hook reads, from its end, as much as Claude Code's (stopcheck.ts's READ_CAP):
 * the turn's final message and the step before it, which may be a tool's long result. Past it, the turn ends.
 */
export const AGY_TRANSCRIPT_CAP = 4 * 1024 * 1024
const CHUNK = 64 * 1024
/** Stop's ends that aren't a turn settling: the person stopped it, or it failed. */
const NOT_SETTLED = new Set(['USER_CANCELED', 'ERROR'])

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null)

/** A Pending You call as the other apps' hooks name it, with its arguments; null for any other tool. */
export function agyToolCall(toolCall: unknown): { name: string; input: Json } | null {
  if (!isObject(toolCall) || typeof toolCall.name !== 'string') return null
  const args = isObject(toolCall.args) ? toolCall.args : {}
  let server: string | null = null
  let tool: string | null = null
  let input: unknown = args
  if (AGY_MCP_CALLERS.has(toolCall.name)) {
    server = text(args.ServerName ?? args.serverName ?? args.server_name ?? args.server)
    tool = text(args.ToolName ?? args.toolName ?? args.tool_name ?? args.tool)
    input = args.Arguments ?? args.arguments ?? {}
  } else {
    const eager = AGY_EAGER_TOOL.exec(toolCall.name)
    if (eager) {
      server = eager[1] ?? null
      tool = eager[2] ?? null
      input = args.Arguments ?? args.arguments ?? args
    }
  }
  if (!server || !tool || !/pendingyou/i.test(server) || !/^[a-z_]{1,40}$/.test(tool)) return null
  if (typeof input === 'string')
    try {
      input = JSON.parse(input)
    } catch {
      input = {}
    }
  if (!isObject(input)) return { name: `mcp__pendingyou__${tool}`, input: {} }
  // What agy adds to an eager tool's arguments for its own display: not the card's words.
  const { toolSummary: _summary, ...own } = input
  return { name: `mcp__pendingyou__${tool}`, input: own }
}

/** Each conversation's turn now, as its first model call noted it: `<config>/antigravity-turns.json`. */
const turnsPath = (io: Pick<Io, 'env' | 'home'>) => join(configDir(io), 'antigravity-turns.json')
/** How long a conversation's turn is kept, and the most kept. */
const KEEP_TURN_MS = 24 * 60 * 60_000
const KEEP_TURNS = 200

/**
 * A conversation's turn now: its id, when it began, its person's message (a hash), whether a wake started it, and
 * whether its Stop said it ended idle (`fullyIdle`: no command of it still running in the background).
 */
interface Turn {
  turn: string
  at: number
  input?: string
  woken?: boolean
  idle?: boolean
}
interface Turns {
  version: 1
  conversations: Record<string, Turn>
}

async function readTurns(io: Pick<Io, 'env' | 'home'>): Promise<Turns['conversations']> {
  const file = await readJson<Partial<Turns>>(turnsPath(io)).catch(() => null)
  const found: Turns['conversations'] = {}
  if (isObject(file?.conversations))
    for (const [id, value] of Object.entries(file.conversations))
      if (isObject(value) && typeof value.turn === 'string' && typeof value.at === 'number')
        found[id] = {
          turn: value.turn,
          at: value.at,
          ...(typeof value.input === 'string' ? { input: value.input } : {}),
          ...(value.woken === true ? { woken: true } : {}),
          ...(value.idle === true ? { idle: true } : {}),
        }
  return found
}

/** Writes the conversations' turns, the newest KEEP_TURNS of the last KEEP_TURN_MS. */
async function writeTurns(io: Io, conversations: Turns['conversations']): Promise<void> {
  const now = io.now()
  const kept = Object.entries(conversations)
    .filter(([, each]) => now - each.at < KEEP_TURN_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, KEEP_TURNS)
  await writeWhole(
    turnsPath(io),
    `${JSON.stringify({ version: 1, conversations: Object.fromEntries(kept) }, null, 2)}\n`,
    { secret: true },
  )
}

/** A message's hash, never its words. */
const hashOf = (words: string) => createHash('sha256').update(words).digest('hex').slice(0, 32)

/**
 * Notes a conversation's turn now, and says whether a wake started it: the same person's message as the turn before (a
 * finished background command starts a turn with the last one's `lastUserInput`), after a turn that didn't end idle (a
 * turn that did left no command running to start one). Never throws (then: not a wake).
 */
async function noteTurn(
  io: Io,
  conversation: string,
  turn: string,
  prompt: string | null,
): Promise<boolean> {
  let woken = false
  try {
    const path = turnsPath(io)
    await withLock(path, io, async () => {
      const conversations = await readTurns(io)
      const now = io.now()
      const before = conversations[conversation]
      const input = prompt === null ? undefined : hashOf(prompt)
      woken = Boolean(
        before && before.turn !== turn && input && before.input === input && before.idle !== true,
      )
      conversations[conversation] = {
        turn,
        at: now,
        ...(input ? { input } : {}),
        ...(woken ? { woken: true } : {}),
      }
      await writeTurns(io, conversations)
    })
  } catch {}
  return woken
}

/**
 * Notes what a Stop said of its turn's end: idle (`fullyIdle` true), or with a command still running in the
 * background (false). A Stop that says neither changes nothing. Never throws.
 */
async function noteStop(io: Io, conversation: string, fullyIdle: unknown): Promise<void> {
  if (typeof fullyIdle !== 'boolean') return
  try {
    const path = turnsPath(io)
    await withLock(path, io, async () => {
      const conversations = await readTurns(io)
      const now = conversations[conversation]
      if (!now || (now.idle === true) === fullyIdle) return
      const { idle: _idle, ...rest } = now
      conversations[conversation] = { ...rest, ...(fullyIdle ? { idle: true } : {}) }
      await writeTurns(io, conversations)
    })
  } catch {}
}

/** The conversation's turn now, as its first model call noted it; null when none was. */
async function turnOf(io: Io, conversation: string): Promise<Turn | null> {
  const found = (await readTurns(io).catch(() => ({}) as Turns['conversations']))[conversation]
  return found && io.now() - found.at < KEEP_TURN_MS ? found : null
}

/** What uninstall takes away for Antigravity's hooks. */
export const agyHookFiles = (io: Pick<Io, 'env' | 'home'>) => [turnsPath(io)]

/**
 * The turn's final message, from agy's transcript (`transcriptPath`, seen live as
 * `…/brain/<conversation>/.system_generated/logs/transcript_full.jsonl`: one JSON object a step, each with `step_index`,
 * `source`, `type`, `status` and `created_at`; the person's message a USER_INPUT with its `content`, a model call's a
 * PLANNER_RESPONSE with its `content` and any `tool_calls`, a tool's result GENERIC, agy's own notes SYSTEM_MESSAGE):
 * the words of the model's responses after the turn's last tool call, read back from the end, line by line, until a
 * step that isn't one of those responses. Never more than `cap` bytes. Null when there's none or it can't be told: no
 * file, a newest line still being written, a final message longer than the cap.
 */
export async function agyFinalMessage(
  path: string,
  cap = AGY_TRANSCRIPT_CAP,
): Promise<string | null> {
  let file: Awaited<ReturnType<typeof open>>
  try {
    file = await open(path, 'r')
  } catch {
    return null
  }
  try {
    let position = (await file.stat()).size
    let bytesRead = 0
    let carry = Buffer.alloc(0)
    const texts: string[] = []
    let newest = true
    // One line, newest first: whether to read on, the final message is whole, or it can't be told.
    const take = (raw: string): 'more' | 'whole' | 'unknown' => {
      if (!raw.trim()) return 'more'
      let step: unknown
      try {
        step = JSON.parse(raw)
      } catch {
        // The newest line half-written: its words aren't all there yet.
        return newest ? 'unknown' : 'whole'
      }
      newest = false
      if (!isObject(step) || step.type !== 'PLANNER_RESPONSE') return 'whole'
      if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) return 'whole'
      if (typeof step.content === 'string' && step.content.trim()) texts.unshift(step.content)
      return 'more'
    }
    const said = () => texts.join('\n').trim() || null
    while (position > 0 && bytesRead < cap) {
      const length = Math.min(CHUNK, position, cap - bytesRead)
      position -= length
      const chunk = Buffer.alloc(length)
      await file.read(chunk, 0, length, position)
      bytesRead += length
      let buffer = Buffer.concat([chunk, carry])
      let newline = buffer.lastIndexOf(10)
      while (newline !== -1) {
        const taken = take(buffer.subarray(newline + 1).toString('utf8'))
        if (taken === 'unknown') return null
        if (taken === 'whole') return said()
        buffer = buffer.subarray(0, newline)
        newline = buffer.lastIndexOf(10)
      }
      carry = buffer
    }
    if (position > 0) return null
    const taken = take(carry.toString('utf8'))
    return taken === 'unknown' ? null : said()
  } catch {
    return null
  } finally {
    await file.close().catch(() => {})
  }
}

/** A title as it's compared: its words, with the spaces between them made one. */
const squash = (value: unknown) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''

/**
 * The card a post_request just made (0.45.0): agy hands PostToolUse no result, so the session's open cards are asked
 * for as the Stop check asks (the same request and time box), and the one with the call's title that the session
 * didn't know yet is it. Null when there's none, more than one could be, or Pending You can't say in time. Never
 * throws.
 */
async function postedCard(
  io: Io,
  origin: string,
  session: string,
  cwd: string,
  args: Json,
): Promise<string | null> {
  try {
    const title = squash(args.title)
    if (!title) return null
    // Loaded only here: the Stop check's request, and the threads' record, which the other hooks never need.
    const [{ openCards }, { threadCards }] = await Promise.all([
      import('../stopcheck.ts'),
      import('./codex-wake.ts'),
    ])
    const label = isObject(args.session) ? text(args.session.label) : null
    const name = label ?? text(args.name)
    const open = await openCards(
      io,
      origin,
      cwd,
      'antigravity',
      { id: session, transcript: null, name },
      'none',
    )
    if (!open?.length) return null
    const known = new Set(await threadCards(io, 'antigravity', session).catch(() => []))
    const fresh = open.filter(
      (card) => card.requestId && !known.has(card.requestId) && squash(card.title) === title,
    )
    return fresh.length === 1 ? (fresh[0]?.requestId ?? null) : null
  } catch {
    return null
  }
}

/**
 * agy's input in the shape the command reads (the other apps' hooks'), or null when the hook has nothing to do: a model
 * call that isn't its turn's first, a tool that isn't Pending You's (or failed), a Stop that's not to be asked.
 */
export async function agyInput(
  io: Io,
  command: AgyHookCommand,
  input: Json,
  origin: string = DEFAULT_ORIGIN,
): Promise<Json | null> {
  const session = text(input.conversationId)
  const folders = Array.isArray(input.workspacePaths) ? input.workspacePaths : []
  const cwd = text(input.cwd) ?? text(folders[0])
  const prompt = text(input.lastUserInput)
  const common = {
    ...(session ? { session_id: session } : {}),
    ...(cwd ? { cwd } : {}),
  }
  switch (command) {
    case 'pickup':
      return { ...common, source: 'startup', ...(prompt ? { prompt } : {}) }
    case 'handoff': {
      // protojson leaves a zero out: no invocationNum is the first.
      const call = typeof input.invocationNum === 'number' ? input.invocationNum : 0
      if (call !== 0) return null
      const steps = typeof input.initialNumSteps === 'number' ? input.initialNumSteps : 0
      const turn = session ? `${session}:${steps}` : null
      const woken = session && turn ? await noteTurn(io, session, turn, prompt) : false
      return {
        ...common,
        ...(prompt && !woken ? { prompt } : {}),
        ...(woken ? { woken: true } : {}),
        ...(turn ? { turn_id: turn } : {}),
      }
    }
    case 'posted': {
      if (text(input.error)) return null
      const call = agyToolCall(input.toolCall)
      if (!call || !session) return null
      const turn = await turnOf(io, session)
      // The card it made, as the result agy doesn't hand over would have said (codex-wake.ts's resultOf).
      const card =
        call.name === 'mcp__pendingyou__post_request' && cwd
          ? await postedCard(io, origin, session, cwd, call.input)
          : null
      return {
        ...common,
        ...(turn ? { turn_id: turn.turn } : {}),
        tool_name: call.name,
        tool_input: call.input,
        ...(card ? { tool_response: { structuredContent: { requestId: card } } } : {}),
      }
    }
    case 'stopcheck': {
      if (session) await noteStop(io, session, input.fullyIdle)
      if (NOT_SETTLED.has(String(input.terminationReason ?? ''))) return null
      const turn = session ? await turnOf(io, session) : null
      const active =
        input.continuationActive === true ||
        (typeof input.executionNum === 'number' && input.executionNum > 0)
      // The final message, from the transcript's tail: never for a go a Stop hook asked for, which always ends.
      const path = text(input.transcriptPath)
      const final =
        !active && path && isAbsolute(path) && path.endsWith('.jsonl')
          ? await agyFinalMessage(path)
          : null
      // The person's message, unless a wake started the turn (theirs is the turn before's).
      const own = turn?.woken ? null : prompt
      return {
        ...common,
        ...(turn ? { turn_id: turn.turn } : {}),
        stop_hook_active: active,
        ...(final ? { last_assistant_message: final } : {}),
        ...(own ? { prompt: own } : {}),
        handed: own !== null && isHandedWake(own),
      }
    }
  }
}

/** What the command printed, as agy reads a hook's answer for its event. */
export function agyOutput(command: AgyHookCommand, printed: string): Json {
  const said = printed.trim()
  if (!said) return {}
  if (command === 'pickup' || command === 'handoff')
    return { injectSteps: [{ systemMessage: { systemMessage: said } }] }
  if (command === 'stopcheck')
    for (const line of said.split('\n'))
      try {
        const parsed: unknown = JSON.parse(line)
        if (isObject(parsed) && parsed.decision === 'block' && typeof parsed.reason === 'string')
          return { decision: 'continue', reason: parsed.reason }
      } catch {}
  return {}
}

/**
 * Runs one of Antigravity's hooks: reads agy's input, runs the command with it read as the other apps' (`run`, the
 * hook with its deadline, main.ts), and prints agy's answer, one JSON object, whatever happens. Exits 0.
 */
export async function antigravityHook(
  io: Io,
  command: AgyHookCommand,
  origin: string,
  run: (io: Io) => Promise<number>,
): Promise<number> {
  let answer: Json = {}
  try {
    const raw = await io.readStdin(1000).catch(() => '')
    let input: Json = {}
    try {
      const parsed: unknown = JSON.parse(raw)
      if (isObject(parsed)) input = parsed
    } catch {}
    const read = await agyInput(io, command, input, origin)
    if (read) {
      let printed = ''
      await run({
        ...io,
        readStdin: async () => JSON.stringify(read),
        out: (said) => {
          printed += said
        },
      })
      answer = agyOutput(command, printed)
    }
  } catch {}
  io.out(`${JSON.stringify(answer)}\n`)
  return 0
}
