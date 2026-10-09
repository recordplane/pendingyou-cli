// Claude Code's permission prompts, answered on a card (0.33.0; docs/plans/2026-10-09-answer-permission-prompts.md, §3,
// approved 2026-10-09). `pendingyou channel --app claude-code` is a stdio MCP server that Claude Code starts in
// every session (init registers it at user scope as `pendingyou-permissions`, through the hooks' shim), and that it
// treats as a channel only in a session started with `pendingyou claude` (which passes
// `--dangerously-load-development-channels server:pendingyou-permissions`, PA4). There Claude Code relays every
// permission dialog it opens to it (https://code.claude.com/docs/en/channels-reference, "Relay permission prompts"):
// `notifications/claude/channel/permission_request` with a five-letter `request_id`, `tool_name`, `description` and
// `input_preview`; and it applies a `notifications/claude/channel/permission` verdict (`allow` or `deny`) for an id that
// is still open, whichever comes first, the terminal's answer or ours.
//
// - It declares `claude/channel` and `claude/channel/permission`, no tools, and never sends `notifications/claude/channel`:
//   nothing it hears reaches the model, so no card's words can steer the agent. Only verdicts go back.
// - A relayed dialog is written down on the PermissionRequest hook's prompt for it (permission.ts's recordRelay), so the
//   session's worker posts one card for it after the same grace as today (PA5), with Allow and Deny and the whole input,
//   masked (PA2), instead of the button-less card. The worker does the posting; the channel only reads the card.
// - While the dialog is open it reads the card with get_request every 2 seconds, for 30 minutes, then every 30 seconds
//   until the session ends. Allow or Deny on the card: the verdict goes to Claude Code, the prompt is settled, and the
//   card is acknowledged ("Allowed in Claude Code on build-01"). Answered in the terminal first: the hooks settle the
//   prompt as before (PostToolUse, or stopcheck after a denial) and withdraw its card (answeredHere), and the channel
//   stops reading it. A sign-in that has ended stops it too.
//
// Which hook prompt a relayed dialog is (§3.3). What the channel's process can know about its session, found on
// Claude Code 2.1.295 (2026-10-09, on a Linux computer, by reading /proc/<pid>/environ of stdio MCP servers that Claude Code
// started, names only): Claude Code gives a stdio MCP server CLAUDE_CODE_SESSION_ID (the session's id: the same as the
// hooks' `session_id` and its transcript's name), CLAUDE_PROJECT_DIR, CLAUDE_CODE_ENTRYPOINT and CLAUDECODE; its parent
// is the `claude` process. So the hook's prompt is looked for in that session's file first. The relay carries no
// tool_use id and only a display form of the input (whitespace folded, credentials masked, long fields elided), so
// within the session the match is the same tool asked within RELAY_MATCH_MS of the relay, the one whose command the
// relayed input holds when two are open at once. A session whose id changed under the channel (/clear starts a new one;
// the MCP server keeps its environment) is covered by looking in every session's file next. No hook prompt within
// RELAY_MATCH_MS (the hooks are off, or slow): the channel writes the dialog down itself.
//
// Stdout carries protocol messages and nothing else; nothing is logged (no input, ever).
import { DEFAULT_APP } from './apps/ids.ts'
import { type McpClient, McpFailure, mcpClient, SIGN_IN_ERROR } from './bridge.ts'
import type { Io } from './io.ts'
import {
  ALLOW,
  answeredOnCard,
  computerOf,
  DENY,
  promptWords,
  RELAY_MATCH_MS,
  type Relay,
  type Relayed,
  recordRelay,
  relayedPrompt,
} from './permission.ts'
import { cut, maskSecrets, redactText } from './redact.ts'
import { VERSION } from './version.ts'

type Json = Record<string, unknown>

/** The channel's name in Claude Code's MCP servers, and in `--dangerously-load-development-channels server:<it>`. */
export const CHANNEL = 'pendingyou-permissions'
/**
 * The first Claude Code whose permission relay goes only to channels the session opted in (and masks credentials in
 * what it relays): init registers the channel only there.
 */
export const CHANNEL_CLAUDE = '2.1.234'
/** How often the channel reads an open dialog's card, and for how long; then how often until the session ends. */
export const READ_MS = 2000
export const READ_FOR_MS = 30 * 60_000
export const SLOW_READ_MS = 30_000
/** How often it looks for the hook's prompt while it waits for it. */
const MATCH_STEP_MS = 500
/** How long one call to Pending You may take. */
const CALL_MS = 15_000
/** The most of a relayed input a card shows: Claude Code relays 3,500 code points of each field. */
const INPUT_MAX = 40_000
const LINES_MAX = 400
/** Claude Code's five-letter ids: a–z without l. */
const REQUEST_ID = /^[a-km-z]{5}$/
/** What Claude Code relays in place of a value it couldn't serialize (2.1.234). */
const UNSERIALIZABLE = '(value unserializable)'
/** Claude Code's description when the model gave none: it says nothing. */
const NO_DESCRIPTION = 'Run shell command'

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The instructions Claude Code gives the model about this server: it says nothing to it. */
const INSTRUCTIONS =
  'Pending You’s permission channel: it puts Claude Code’s permission prompts on the person’s Pending You card, with Allow and Deny. It sends you no messages and has no tools; ignore it.'

/** A relayed input as the card shows it: the command for Bash, else each field on its own line; secrets masked. */
export function inputLines(
  tool: string,
  preview: string,
): { lines: string[]; lang: Relay['lang']; input: Json } {
  let parsed: unknown = null
  try {
    parsed = JSON.parse(preview)
  } catch {}
  const input = isObject(parsed) ? parsed : {}
  let lines: string[]
  let lang: Relay['lang'] = 'text'
  if (
    isObject(parsed) &&
    (tool === 'Bash' || tool === 'PowerShell') &&
    typeof parsed.command === 'string'
  ) {
    lines = maskSecrets(parsed.command).split('\n')
    lang = 'shell'
  } else if (isObject(parsed))
    lines = Object.entries(parsed).flatMap(([key, value]) =>
      maskSecrets(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).split(
        '\n',
      ),
    )
  else lines = maskSecrets(preview).split('\n')
  // Long inputs are cut at the end, saying so.
  const kept: string[] = []
  let size = 0
  for (const line of lines) {
    if (kept.length >= LINES_MAX || size + line.length > INPUT_MAX) {
      kept.push('… (cut here: the rest is in Claude Code’s dialog)')
      break
    }
    kept.push(line)
    size += line.length
  }
  return { lines: kept.length ? kept : [''], lang, input }
}

/** What the channel makes of a relay notification's params; null when they aren't Claude Code's shape. */
export function heardOf(io: Pick<Io, 'home' | 'now'>, params: unknown): Relayed | null {
  if (!isObject(params)) return null
  const { request_id: id, tool_name: tool, description, input_preview: preview } = params
  if (typeof id !== 'string' || !REQUEST_ID.test(id)) return null
  if (typeof tool !== 'string' || !tool || tool.length > 200) return null
  const text = typeof preview === 'string' ? preview : ''
  const said = typeof description === 'string' ? description.trim() : ''
  const shown = inputLines(tool, text)
  return {
    tool,
    words: promptWords(tool, shown.input, io.home),
    relay: {
      id,
      at: io.now(),
      description: said && said !== NO_DESCRIPTION ? redactText(said, 160) : '',
      lines: shown.lines,
      lang: shown.lang,
      ...(text.includes(UNSERIALIZABLE) ? { unserializable: true as const } : {}),
    },
  }
}

/** The verdict a card's answer gives: Allow or Deny picked on it; null for anything else ("I'll handle it", a note). */
export function verdictOf(card: Json, relay: Relay): 'allow' | 'deny' | null {
  if (!['answered', 'resolved'].includes(String(card.status))) return null
  const answer = isObject(card.answer) ? card.answer : null
  const picked = Array.isArray(answer?.choiceIds) ? answer.choiceIds : []
  if (picked.length !== 1) return null
  if (picked[0] === DENY) return 'deny'
  if (picked[0] === ALLOW && !relay.unserializable) return 'allow'
  return null
}

/**
 * `pendingyou channel --app claude-code`: the channel, until stdin closes (Claude Code ended the session) or it's
 * stopped. Exits 0.
 */
export async function channel(io: Io, options: { origin: string; app?: string }): Promise<number> {
  const app = options.app ?? DEFAULT_APP
  const controller = new AbortController()
  const stop = () => controller.abort()
  if (io.signal.aborted) stop()
  io.signal.addEventListener('abort', stop, { once: true })
  const write = (message: Json) => io.out(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const session = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(io.env.CLAUDE_CODE_SESSION_ID ?? '')
    ? (io.env.CLAUDE_CODE_SESSION_ID as string)
    : null
  const cwd = io.env.CLAUDE_PROJECT_DIR || io.cwd
  const following = new Set<Promise<void>>()
  const lines = io.lines()[Symbol.asyncIterator]()
  const stopped = new Promise<IteratorResult<string>>((resolve) => {
    const done = () => resolve({ done: true, value: undefined })
    if (controller.signal.aborted) done()
    else controller.signal.addEventListener('abort', done, { once: true })
  })
  // One connection to Pending You for every dialog's reads, made when it's first needed.
  let client: McpClient | null = null
  const pending = {
    async call(name: string, args: Json): Promise<Json> {
      try {
        client ??= await mcpClient(io, options.origin, 'claude-code', CALL_MS)
        return await client.call(name, args)
      } catch (error) {
        if (error instanceof McpFailure) client = null
        throw error
      }
    },
  }
  try {
    for (;;) {
      const next = await Promise.race([lines.next(), stopped])
      if (next.done) break
      let message: unknown
      try {
        message = JSON.parse(next.value)
      } catch {
        continue
      }
      if (!isObject(message) || typeof message.method !== 'string') continue
      const id = message.id
      const asked = typeof id === 'string' || typeof id === 'number'
      switch (message.method) {
        case 'initialize': {
          const params = isObject(message.params) ? message.params : {}
          if (asked)
            write({
              id,
              result: {
                protocolVersion:
                  typeof params.protocolVersion === 'string'
                    ? params.protocolVersion
                    : '2025-06-18',
                capabilities: {
                  experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
                },
                serverInfo: { name: CHANNEL, version: VERSION },
                instructions: INSTRUCTIONS,
              },
            })
          break
        }
        case 'ping':
          if (asked) write({ id, result: {} })
          break
        case 'tools/list':
          if (asked) write({ id, result: { tools: [] } })
          break
        case 'notifications/claude/channel/permission_request': {
          if (app !== 'claude-code') break
          const heard = heardOf(io, message.params)
          if (!heard) break
          const task = follow(io, options.origin, heard, {
            session,
            cwd,
            signal: controller.signal,
            pending,
            verdict: (behavior) =>
              write({
                method: 'notifications/claude/channel/permission',
                params: { request_id: heard.relay.id, behavior },
              }),
          }).catch(() => {})
          following.add(task)
          task.then(() => following.delete(task))
          break
        }
        default:
          if (asked) write({ id, error: { code: -32601, message: 'Method not found' } })
      }
    }
  } finally {
    // The session ended: its hooks settle its prompts and withdraw their cards.
    controller.abort()
    io.signal.removeEventListener('abort', stop)
    lines.return?.().catch(() => undefined)
    await Promise.allSettled([...following])
    await (client as McpClient | null)?.close().catch(() => {})
  }
  await io.flush()
  return 0
}

/**
 * One relayed dialog: written down on its hook's prompt (waiting up to RELAY_MATCH_MS for the hook), then its card read
 * until it's answered there, answered in the terminal, or the session ends.
 */
async function follow(
  io: Io,
  origin: string,
  heard: Relayed,
  options: {
    session: string | null
    cwd: string
    signal: AbortSignal
    pending: { call(name: string, args: Json): Promise<Json> }
    verdict(behavior: 'allow' | 'deny'): void
  },
): Promise<void> {
  const { signal } = options
  const id = heard.relay.id
  let where: string | null = null
  const waitFrom = io.now()
  for (;;) {
    const last = io.now() - waitFrom >= RELAY_MATCH_MS
    where = await recordRelay(io, origin, heard, {
      session: options.session,
      cwd: options.cwd,
      last,
    })
    if (where || last || signal.aborted) break
    await io.sleep(MATCH_STEP_MS, signal)
  }
  if (!where) return
  const started = io.now()
  while (!signal.aborted) {
    await io.sleep(io.now() - started < READ_FOR_MS ? READ_MS : SLOW_READ_MS, signal)
    if (signal.aborted) return
    const now = await relayedPrompt(io, where, id)
    // Settled: answered in the terminal, the session ended, or its sign-in did.
    if (!now) return
    const card = now.prompt.card
    if (!card) continue
    let read: Json
    try {
      read = await options.pending.call('get_request', {
        requestId: card.requestId,
        name: card.name,
      })
    } catch (error) {
      if (error instanceof McpFailure && error.code === SIGN_IN_ERROR) return
      continue
    }
    const status = String(read.status)
    if (['pending', 'snoozed', 'delegated'].includes(status)) continue
    const verdict = verdictOf(read, heard.relay)
    // Closed some other way (withdrawn, expired), or answered with something that isn't Allow or Deny: the dialog
    // waits in the terminal, and the hooks settle it from there.
    if (!verdict) {
      if (status === 'answered' && typeof read.version === 'number') {
        const machine = await computerOf(io, origin, 'claude-code')
        await options.pending
          .call('ack_answer', {
            requestId: card.requestId,
            name: card.name,
            expectedVersion: read.version,
            outcome: cut(
              `Not allowed or denied: it waits for your answer in Claude Code on ${machine}.`,
              200,
            ),
          })
          .catch(() => {})
      }
      return
    }
    options.verdict(verdict)
    await answeredOnCard(io, where, id)
    if (status === 'answered' && typeof read.version === 'number') {
      const machine = await computerOf(io, origin, 'claude-code')
      await options.pending
        .call('ack_answer', {
          requestId: card.requestId,
          name: card.name,
          expectedVersion: read.version,
          outcome: cut(
            `${verdict === 'allow' ? 'Allowed' : 'Denied'} in Claude Code on ${machine}.`,
            200,
          ),
        })
        .catch(() => {})
    }
    return
  }
}
