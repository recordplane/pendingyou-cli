// Claude Code's permission prompts, on a card (0.13.0; 2026-10-04: "Tell me: a card and a push, cleared once I
// answer in the terminal"). A Claude Code agent kept asking to remove files and sat waiting until the person noticed. Now,
// when Claude Code stops to ask for the person's OK and nobody answers within a few seconds, a card says so ("Claude Code
// is waiting for your OK: rm -rf dist/"), asked in both places (askedFirst), so it stays quiet for their hand-off
// minutes and pushes only once it has waited that long; and it goes away once they answer in Claude Code.
//
// - `pendingyou permission` is Claude Code's PermissionRequest hook (https://code.claude.com/docs/en/hooks: it runs
//   "when Claude Code is about to ask you for permission to use a tool", with `tool_name` and `tool_input`; since
//   2.0.45). It never decides: it prints nothing, so the prompt shows exactly as before, and it's done in milliseconds.
//   It writes the prompt down (a redacted title, never the tool's input: redact.ts) in the session's own file,
//   ~/.config/pendingyou/permission-cards/<session>.json, and starts the session's worker unless one is running.
// - `pendingyou permission-done` is its PostToolUse, PostToolUseFailure and SessionEnd hook: the call it asked about ran
//   (it was allowed), so that prompt is settled, or the session ended, so all of them are. The next message (handoff) and the end of a
//   turn (stopcheck) settle the session's prompts too, since a denial runs no PostToolUse. The shim skips Node
//   altogether while no session has a file here (shim.ts), so a tool call costs a few milliseconds.
// - `pendingyou permission-card --session <id> --worker <id>`, detached, is the session's one worker: it waits until a
//   prompt has waited GRACE_MS (one answered sooner gets no card), posts the card through Pending You's MCP with Claude
//   Code's own connection (whoami, match_area, post_request; create_area when nothing fits, as the guide says), changes
//   it to the newest prompt (update_request with a changeNote: one card per session, never a second), withdraws it
//   once nothing waits (cancel_request, answeredHere; without, when the session ended), and stops.
//
// Since 0.15.0 Codex's prompts too, the same way: Codex's PermissionRequest hook (it fires when Codex is about to ask for
// approval: a shell command that needs more than the sandbox gives, an apply_patch, an MCP tool; `tool_name` Bash,
// apply_patch or the MCP tool's, `tool_input` the command or arguments, and `tool_input.description` when Codex has a
// reason) through the shim with `--app codex`. Codex reads a PermissionRequest hook's output as its decision, so ours
// prints nothing and exits 0: it declines, and Codex asks as before. Its PostToolUse (every tool), next-message, Stop
// and SessionEnd hooks settle the prompts, and the card is asked with Codex's own connection, under the name the thread
// went by on Pending You's card tools (codex-threads.json), else "Codex". The Codex app's browser-use prompts run no
// PermissionRequest hook, so they get no card. Codex has no hook that says a dialog is on screen (its `notify` runs only
// when a turn completes), so what follows is Claude Code's alone.
//
// Since 0.16.0 Claude Code's Notification hook too: `pendingyou notify`, which init gives the matcher
// `permission_prompt`, so Claude Code runs it only once a dialog has waited about six seconds with nobody typing (the
// docs; 6000 ms in 2.1.289) and never for its other notifications. 2026-10-05: "I just got a dangerous request
// from Claude Code this session but it didn't hit me up in Pending You." The session ran in bypassPermissions mode, where
// Claude Code still asks for a few things (a dangerous rm, an ask rule, a safety check it can't verify), and this hook
// stopped there. But the PermissionRequest hook also runs for a call Claude Code then denies by itself, showing nothing
// ("or when it would otherwise auto-deny a call that can't prompt", the docs), so in bypassPermissions and dontAsk mode
// it proves no dialog: such a prompt is written down quiet, and its card goes up only once a Notification says a dialog
// is on screen. In the other modes the card goes up after GRACE_MS as before, or as soon as the Notification comes. A
// Notification no prompt written down explains (a sandboxed command's network request, which runs no PermissionRequest
// hook; a dialog a Claude Code ran none for) gets a card in Claude Code's words: "Claude Code is waiting for your OK",
// with “Claude needs your permission” in its summary. A background agent's prompt (`agent_id`, `agent_type`) goes on the
// session's card, saying so ("… (a background agent)"), and only that agent's own calls settle it.
//
// Since 0.32.2 a quiet prompt no longer waits on the Notification alone. On 2026-10-08 a subagent's `rm -rf $S/*`
// in a bypassPermissions session sat on Claude Code's "Dangerous rm operation on possibly-empty variable path" dialog
// for an hour (and again for four minutes) with no card, though its prompt was written down. The Notification is
// Claude Code's only word that a dialog is on screen, it comes once per dialog, it doesn't say whose (no `agent_id`),
// and which prompt it means was a guess (the newest asked 4 seconds before it): with several subagents at work, the
// guess or the one Notification could miss, and nothing else ever put that card up. Now the session's worker also looks
// at every quiet prompt once it has waited QUIET_GRACE_MS: if the asking agent's transcript has no result for that call
// yet (Claude Code writes a call it denies by itself, with its refusal, at once), its dialog is on screen and the card
// goes up; if it has one, the prompt is settled with no card. A Notification picks the newest prompt whose call is still
// unanswered the same way. A subagent's card says so: "A subagent (general-purpose) of Claude Code …, needs your
// permission to run a command", and its title ends "(a subagent)".
//
// No card for a session that can't show a prompt: `claude -p` and the Agent SDK (CLAUDE_CODE_ENTRYPOINT `sdk-…`, as
// Claude Code 2.1.289 sets it); nor without this computer's own connection for Claude Code (a sign-in that only hears
// can't post).
//
// Since 0.33.0 a prompt can be answered on its card (docs/plans/2026-10-09-answer-permission-prompts.md, PA1–PA6). In a
// session started with `pendingyou claude`, Claude Code relays each permission prompt to the channel (channel.ts), which
// writes it here beside the hook's prompt for the same dialog (`relay`: its request id and its whole input, masked).
// A relayed prompt gets a card of its own, never the session's one card: Allow and Deny, the input in a code block,
// `permissionPrompt: { app: 'claude-code', relay: true }`, after the same GRACE_MS (PA5). The channel reads the card and
// answers the dialog; answered in the terminal first, the hooks settle the prompt as before and its card is withdrawn
// (`closing`). This file then holds the masked input of a relayed prompt (0600, gone with the prompt); nothing else.
//
// Since 0.34.1 a relayed prompt has the only card for its dialog. Claude Code writes a prompted call to the transcript
// only once it's answered, so the Notification hook took a session's second Write (its transcript's newest Write an
// earlier one, answered) for a dialog no prompt explained, and put the button-less card up beside the relayed one. A
// relayed prompt is on screen (Claude Code relays only a dialog it shows), so the Notification shows it and adds
// nothing while one is open; relaying a dialog drops a Notification's prompt, and a session's card already up for that
// dialog is withdrawn (`moving`) as the relayed card goes up at once.
//
// Since 0.34.2 a quiet prompt is judged by its own call alone. Claude Code writes a prompted call to the transcript only
// once its dialog is answered, so the open call isn't there yet, and the agent's newest call of the same tool, which
// 0.32.2 fell back on, is an earlier one, answered: a subagent's second Bash dialog on screen got no card. Now only the
// prompt's own key counts (an earlier call with the same key, answered before the prompt was asked, doesn't), and a
// call not found is still waiting; a call Claude Code denied by itself is written with its refusal at once, so it's
// found, answered, and gets no card.
//
// Since 0.34.0 Codex can ask on the person's phone first (§4, PA7), once they set a wait with `npx pendingyou
// codex-answers --wait <minutes>` (codex-answers.ts). Codex runs its PermissionRequest hook before it shows anything,
// so while the hook waits nothing else is asking: the hook posts the card at once (no grace), with Allow and Deny, the
// whole input masked and `permissionPrompt: { app: 'codex', relay: true }`, reads it every 2 seconds for the wait, and
// prints Codex's decision for a tap (allow, or deny with "Denied in Pending You."), then acknowledges the card. With no
// tap in time it withdraws the card, saying the terminal is asking now, and prints nothing: Codex asks as usual. Its
// stdout holds that decision and nothing else, ever. A card it can't post leaves the prompt to today's hooks.
import { createHash, randomBytes } from 'node:crypto'
import { open, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { threadNames } from './apps/codex-wake.ts'
import { APP_NAMES, type AppId } from './apps/ids.ts'
import { DEFAULT_ORIGIN } from './args.ts'
import { type McpClient, McpFailure, mcpClient, SIGN_IN_ERROR, ToolRefused } from './bridge.ts'
import { minutes, readAnswerWait } from './codex-answers.ts'
import { sessionLink } from './confirm.ts'
import { connectionMachine, readCredential } from './credentials.ts'
import { claudeDir, configDir, PERMISSION_FOLDER, readJson, withLock, writeWhole } from './files.ts'
import type { Io } from './io.ts'
import {
  BLANK,
  cut,
  maskSecrets,
  redactCommand,
  redactText,
  redactUrl,
  shortPath,
} from './redact.ts'
import { machineOf } from './remote.ts'

type Json = Record<string, unknown>

/** How long a prompt waits before its card goes up: one answered sooner was answered by someone at the terminal. */
export const GRACE_MS = 10_000
/** The longest a card's title is (the guide's "under 90 characters"). */
export const TITLE_MAX = 90
/** What every Claude Code card's title starts with. */
export const WAITING = 'Claude Code is waiting for your OK'
/** What a subagent's card's title ends with (0.16.0; 0.32.2's words): the prompt is one of the session's agents'. */
export const SUBAGENT = ' (a subagent)'
/**
 * The permission modes where Claude Code may deny a call by itself after the PermissionRequest hook ran, showing
 * nothing (0.16.0): a prompt asked there gets a card once a Notification says its dialog is on screen, or (0.32.2) once
 * it has waited QUIET_GRACE_MS with its call still unanswered.
 */
const QUIET_MODES: ReadonlySet<string> = new Set(['bypassPermissions', 'dontAsk'])
/**
 * How long a quiet prompt waits before the worker looks for its call's result in the asking agent's transcript
 * (0.32.2): none by then, and its dialog is on screen, so its card goes up. Claude Code writes a call it denies by
 * itself, with its refusal, at once; a dialog's Notification comes after about six seconds, sooner than this.
 */
export const QUIET_GRACE_MS = 20_000
/**
 * How long before a Notification a prompt must have been asked to be the dialog it means (0.16.0): Claude Code says so
 * about six seconds after a dialog appears, so a prompt asked since is another's.
 */
export const NOTICE_MS = 4000
/**
 * A prompt an agent asked at least this long before its next call isn't one of a batch Claude Code checked with that
 * call: the agent went on, so it isn't waiting any more (0.16.0).
 */
const BATCH_MS = 1000
/** The apps whose permission prompts get a card: Claude Code (0.13.0) and Codex (0.15.0). */
export type PromptApp = Extract<AppId, 'claude-code' | 'codex'>
export const PROMPT_APPS: readonly PromptApp[] = ['claude-code', 'codex']
const CLAUDE: PromptApp = 'claude-code'
export const isPromptApp = (app: AppId): app is PromptApp =>
  (PROMPT_APPS as readonly AppId[]).includes(app)
/** What an app's card's title starts with: "Codex is waiting for your OK". */
export const waitingFor = (app: PromptApp) => `${APP_NAMES[app]} is waiting for your OK`
/**
 * Whether a card is one of these (by its title): the hooks' own, which closes by itself, so the hand-off neither names
 * it among the agent's open cards nor hands an agent a Done the person pressed on it.
 */
export const isPermissionCard = (title: unknown) =>
  typeof title === 'string' &&
  PROMPT_APPS.some(
    (app) =>
      title.startsWith(waitingFor(app)) ||
      title.startsWith(`${APP_NAMES[app]} is waiting for your answer`) ||
      // A relayed prompt's card (0.33.0): "Allow Claude Code (billing-webhooks) to run a command?"
      title.startsWith(`Allow ${APP_NAMES[app]} `) ||
      title.startsWith(`Allow a subagent of ${APP_NAMES[app]}`),
  )

/** The name a Claude Code card is asked under when the session never told Pending You its own. */
export const DEFAULT_NAME = 'Claude Code'
/** The name an app's card is asked under when the session never told Pending You its own: the app's. */
const defaultName = (app: PromptApp) => APP_NAMES[app]

/** A worker whose lease is older than this has died; the next event starts another. */
const LEASE_STALE_MS = 120_000
/** How long a worker keeps going at most; the next event starts another. */
const WORKER_MS = 60 * 60_000
/**
 * The longest one sleep of the worker: it looks at the session's file again this often, so a Notification that makes a
 * card due sooner (the worker already has the session) is acted on within a second (0.32.2), and its lease stays fresh.
 */
const NAP_MS = 1000
/** How long one call to Pending You may take. */
const CALL_MS = 15_000
/** Pauses after a failed call, then it gives that step up. */
const BACKOFF_MS = [2000, 5000, 10_000, 20_000]
/** The most prompts a session's file keeps (queued subagents' prompts): the newest. */
const MAX_PROMPTS = 20
/** A session's file untouched this long is left from a session that never ended cleanly. */
const KEEP_MS = 7 * 24 * 60 * 60_000
/** The most of a hook's stdin read: a Write's whole file can be in it. */
const STDIN_MAX = 8_000_000
/** The most of a transcript read, from its end, for the session's name. */
const TRANSCRIPT_CAP = 4 * 1024 * 1024
/** A session's id, as Claude Code gives it (a UUID): also its file's name. */
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/
/** Pending You's tools that carry the asking session's name, under any server name (the plugin's too). */
const NAMED_TOOL =
  /^mcp__.*pendingyou.*__(whoami|post_request|update_request|cancel_request|reply_in_thread|get_request|ack_answer|list_pending|get_attachment)$/i

/** One prompt the person hasn't answered: its card's words, which agent asked (a subagent's id), and when. */
export interface Prompt {
  /** A hash of the tool and its input (and a subagent's id): PostToolUse for the same call settles it. */
  key: string
  /**
   * The tool's name (0.15.0): for the card's words; a Codex call that ran settles a prompt for the same tool, and a
   * relayed dialog (0.33.0) is matched to a prompt by it. Never to find a Claude Code call in a transcript (0.34.2).
   */
  tool?: string
  /**
   * Why it asks, redacted, for the card's summary: Codex's reason (`tool_input.description`, 0.15.0), or a notice's
   * words from Claude Code (0.16.0).
   */
  reason?: string
  /** The card's title for it. */
  title: string
  /** What it asks, short ("rm -rf dist/"): the changeNote's words. */
  what: string
  /** What Claude Code is waiting for, for the card's summary ("to run a command"); empty for a notice. */
  doing: string
  /** The subagent that asked (its agent_id); none for the session itself. */
  agent?: string
  /** The subagent's type ("general-purpose", "Explore"), for the card's summary (0.16.0). */
  agentType?: string
  at: number
  /**
   * Asked in bypassPermissions or dontAsk mode (0.16.0), where Claude Code may deny the call by itself without a
   * dialog: it gets a card once a Notification shows it (`shown`) or its call is still unanswered after QUIET_GRACE_MS
   * (`waited`, 0.32.2), never after GRACE_MS alone.
   */
  quiet?: true
  /** When a Notification said its dialog was on screen (0.16.0): its card is due then, if not sooner. */
  shown?: number
  /**
   * When the worker found a quiet prompt's call still unanswered in its agent's transcript, QUIET_GRACE_MS after it was
   * asked (0.32.2): its dialog is on screen, so its card is due then.
   */
  waited?: number
  /**
   * Known only from a Notification that no prompt written down explains (0.16.0): a dialog no PermissionRequest hook ran
   * for. Whose it is isn't known, so only a turn that ends with no subagent running, or the session's end, settles it.
   */
  notice?: true
  /** Posting its card failed again and again: it's given up. */
  failed?: true
  /** Claude Code relayed this dialog to the channel (0.33.0, channel.ts): its card can answer it. */
  relay?: Relay
  /** A relayed prompt's own card (0.33.0), once posted: never the session's one card. */
  card?: Card
}

/**
 * A permission prompt as Claude Code relayed it to the channel (0.33.0): the dialog's id, and what the card shows of it.
 * Claude Code's `input_preview` comes with recognisable credentials masked; maskSecrets (redact.ts) masks it again.
 */
export interface Relay {
  /** Claude Code's five-letter request id: the verdict carries it. */
  id: string
  /** When the channel heard it. */
  at: number
  /** Claude Code's description of the call, redacted and short; empty when it gave only its constant. */
  description: string
  /** The whole input, masked, as the card's code block shows it. */
  lines: string[]
  lang: 'shell' | 'json' | 'text'
  /** Part of the input Claude Code couldn't serialize: the card offers no Allow (§7). */
  unserializable?: true
  /** No hook wrote this dialog down (0.33.0): the channel did, and the same tool's next call settles it. */
  own?: true
}

/** The session's card, as posted: whose it is (the name it was asked under) and the prompt it shows. */
interface Card {
  requestId: string
  version: number
  key: string
  name: string
  /**
   * The session's card shows a dialog that has a relayed card now (0.34.1): that card goes up at once, and this one is
   * withdrawn, saying so (never left beside it, never "answered").
   */
  moving?: true
}

/** A session's file. Ids, hashes and the cards' redacted words: never a tool's input. */
export interface SessionState {
  version: 1
  origin: string
  /** Whose session it is (0.15.0); Claude Code's when it doesn't say. */
  app?: PromptApp
  session: string
  /** The session's folder. */
  cwd: string
  /** Its transcript, where the name it gave Pending You is. */
  transcript?: string
  /** Its link on claude.ai, while Remote Control is on (confirm.ts's sessionLink). */
  link?: string
  prompts: Prompt[]
  card?: Card
  /** Relayed prompts' cards still to withdraw (0.33.0): their prompts were settled, and how. */
  closing?: (Card & { how: 'answered' | 'ended' })[]
  /** How the last prompts were settled: answered in Claude Code, or the session ended (the cancel's words). */
  settled?: 'answered' | 'ended'
  /** The area its cards go in, once found. */
  areaId?: string
  /** The worker that has the session (its lease, renewed as it goes). */
  worker?: { id: string; at: number }
  at: number
}

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const folderOf = (io: Pick<Io, 'env' | 'home'>) => join(configDir(io), PERMISSION_FOLDER)
const pathOf = (io: Pick<Io, 'env' | 'home'>, session: string) =>
  join(folderOf(io), `${session}.json`)

/** JSON with its keys in order, so the same input always hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/** Tools whose input comes back with the person's answer in it: their prompt is the tool's, whatever the input. */
const ANSWERED_IN_INPUT = new Set(['AskUserQuestion', 'ExitPlanMode'])

/**
 * Which call a prompt is about: PermissionRequest's tool and input, which PostToolUse repeats for the same call; and,
 * for a subagent's (0.16.0), which agent asked, so its own call settles it and the session's or another agent's doesn't.
 * The session's own keys are as before, so prompts an older version wrote down still settle.
 */
export function promptKey(tool: string, input: unknown, agent?: string): string {
  const what = ANSWERED_IN_INPUT.has(tool) ? '' : canonical(input ?? {})
  const whose = agent ? `${agent}\n` : ''
  return createHash('sha256').update(`${whose}${tool}\n${what}`).digest('hex').slice(0, 32)
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** A command as a hook gives it: a line, or (Codex's shell) its words, joined as a shell would read them. */
function commandText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value) || !value.every((word) => typeof word === 'string')) return ''
  return value
    .map((word: string) =>
      /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`,
    )
    .join(' ')
}

/** The files an apply_patch changes, as its `*** Add/Update/Delete File:` lines name them. */
export function patchFiles(patch: string): string[] {
  const files: string[] = []
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    const file = (match[1] as string).trim()
    if (file && !files.includes(file)) files.push(file)
  }
  return files
}

/** A tool's name as a card may say it: letters, digits and a few marks. */
const toolName = (tool: string) => cut(tool.replace(/[^\w.:-]/g, ''), 40) || 'a tool'

/**
 * What a card says about a prompt: its title (WAITING and what it's for, at most TITLE_MAX characters), what it asks
 * in short, and what Claude Code waits for. Every command, path, address and question goes through redact.ts.
 */
export function promptWords(
  tool: string,
  input: Json,
  home: string,
  app: PromptApp = CLAUDE,
): { title: string; what: string; doing: string } {
  const path = (value: unknown) => shortPath(text(value), home, 50)
  const said = (what: string, doing: string) => ({
    title: cut(`${waitingFor(app)}: ${what}`, TITLE_MAX),
    what,
    doing,
  })
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return said(redactCommand(commandText(input.command), tool).text, 'to run a command')
    case 'apply_patch': {
      // Codex's file edits: the patch's own lines name the files (`*** Update File: src/a.ts`).
      const files = patchFiles(commandText(input.command) || text(input.patch))
      const first = files[0]
      return said(
        first === undefined
          ? 'edit files'
          : files.length === 1
            ? `edit ${path(first)}`
            : `edit ${path(first)} and ${files.length - 1} more`,
        files.length > 1 ? 'to edit files' : 'to edit a file',
      )
    }
    case 'Edit':
    case 'MultiEdit':
      return said(`edit ${path(input.file_path)}`, 'to edit a file')
    case 'Write':
      return said(`write ${path(input.file_path)}`, 'to write a file')
    case 'NotebookEdit':
      return said(`edit ${path(input.notebook_path)}`, 'to edit a notebook')
    case 'Read':
      return said(`read ${path(input.file_path)}`, 'to read a file')
    case 'Glob':
    case 'Grep':
    case 'LS':
      return said(input.path ? `search ${path(input.path)}` : 'search files', 'to search files')
    case 'WebFetch': {
      const address = redactUrl(text(input.url).trim()).replace(/^https?:\/\//i, '')
      return said(`fetch ${cut(redactText(address, 60), 60)}`, 'to fetch a page')
    }
    case 'WebSearch':
      return said(`search the web for “${redactText(text(input.query), 40)}”`, 'to search the web')
    case 'ExitPlanMode':
      return { title: `${waitingFor(app)} on its plan`, what: 'its plan', doing: 'on its plan' }
    case 'AskUserQuestion': {
      const first = Array.isArray(input.questions) ? input.questions[0] : undefined
      const question = redactText(text(isObject(first) ? first.question : ''), 80) || 'a question'
      return {
        title: cut(`${APP_NAMES[app]} is waiting for your answer: ${question}`, TITLE_MAX),
        what: question,
        doing: 'to answer its question',
      }
    }
    case 'Skill':
      return said(`use the ${toolName(text(input.skill))} skill`, 'to use a skill')
    case 'Task':
    case 'Agent':
      return said('start an agent', 'to start an agent')
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (mcp) {
    const [, server = '', name = ''] = mcp
    return said(
      `${toolName(name)} on ${toolName(server)}`,
      `to use ${toolName(server)}’s ${toolName(name)}`,
    )
  }
  return said(toolName(tool), `to use ${toolName(tool)}`)
}

/** A subagent's title (0.16.0): the prompt's, cut to leave room for saying whose it is. */
export const fromAgent = (title: string) =>
  `${cut(title, TITLE_MAX - [...SUBAGENT].length)}${SUBAGENT}`

/** A Notification's words (0.16.0), as a card may show them: redacted, one line, short. */
const noticeWords = (message: unknown) => redactText(text(message), 120)

/** A prompt known only from a Notification (0.16.0): Claude Code is waiting, in its own words. */
function noticeOf(message: string, now: number): Prompt {
  return {
    key: promptKey('Notification', { message }),
    title: cut(WAITING, TITLE_MAX),
    what: message || 'a dialog in Claude Code',
    doing: '',
    ...(message ? { reason: message } : {}),
    notice: true,
    shown: now,
    at: now,
  }
}

async function load(io: Pick<Io, 'env' | 'home'>, session: string): Promise<SessionState | null> {
  const file = await readJson<SessionState>(pathOf(io, session)).catch(() => null)
  if (!isObject(file) || !Array.isArray(file.prompts) || typeof file.origin !== 'string')
    return null
  return file
}

/** Changes a session's file under its lock: `edit` returns the new state, or null to remove the file. */
async function change(
  io: Pick<Io, 'env' | 'home' | 'now' | 'sleep'>,
  session: string,
  edit: (state: SessionState | null) => SessionState | null,
): Promise<SessionState | null> {
  const path = pathOf(io, session)
  return withLock(path, io, async () => {
    const next = edit(await load(io, session))
    if (next) await writeWhole(path, `${JSON.stringify(next, null, 2)}\n`, { secret: true })
    else await rm(path, { force: true })
    return next
  })
}

const alive = (state: SessionState, now: number) =>
  Boolean(state.worker && now - state.worker.at < LEASE_STALE_MS)

/**
 * Whether a prompt can have a card (0.16.0): one that isn't quiet, one a Notification showed, or one whose call was
 * still unanswered after QUIET_GRACE_MS (0.32.2).
 */
const seen = (prompt: Prompt) =>
  !prompt.quiet ||
  prompt.shown !== undefined ||
  prompt.waited !== undefined ||
  // A relayed prompt (0.33.0): Claude Code relays only a dialog it shows.
  prompt.relay !== undefined

/** A quiet prompt nothing has shown yet (0.32.2): the worker looks at its call once it has waited QUIET_GRACE_MS. */
const unchecked = (prompt: Prompt) => !seen(prompt) && !prompt.notice

/** Hands the session to a new worker unless one is alive: its id, to start it with, or null. */
function claim(state: SessionState, now: number): string | null {
  if (alive(state, now)) return null
  const id = randomBytes(8).toString('hex')
  state.worker = { id, at: now }
  return id
}

/** Starts the session's worker, detached: it outlives the hook, prints nowhere, and nobody waits for it. */
function startWorker(io: Io, origin: string, session: string, worker: string): void {
  io.background([
    'permission-card',
    '--session',
    session,
    '--worker',
    worker,
    ...(origin === DEFAULT_ORIGIN ? [] : ['--origin', origin]),
  ])
}

/** A Claude Code subagent's own transcript, in its session's folder: `…/<session>/subagents/agent-<id>.jsonl`. */
const SUBAGENT_TRANSCRIPT =
  /^(.*)([/\\])([A-Za-z0-9][A-Za-z0-9_-]{0,99})[/\\]subagents[/\\][^/\\]+\.jsonl$/

/**
 * The session an event is for, and that session's transcript: the hook's `session_id`. A subagent's hooks carry its
 * session's (Claude Code's docs say so of SubagentStop's `transcript_path`), but they don't promise it: a subagent's
 * event naming a session of its own, with its transcript in its session's `subagents` folder, is that session's
 * (0.16.0), so its prompt goes on the session's card.
 */
function whereOf(input: Json): { session: string; transcript: string } | null {
  const transcript = text(input.transcript_path)
  const parent = text(input.agent_id) ? SUBAGENT_TRANSCRIPT.exec(transcript) : null
  if (parent) {
    const [, folder = '', slash = '/', session = ''] = parent
    return { session, transcript: `${folder}${slash}${session}.jsonl` }
  }
  const session = text(input.session_id)
  return SESSION.test(session) ? { session, transcript } : null
}

/** The subagent an event comes from (its `agent_id`); empty for the session itself. */
const agentOf = (input: Json) => text(input.agent_id).slice(0, 100)

/** A subagent's type, as a card may say it ("general-purpose", "my-plugin:reviewer"). */
const agentTypeOf = (input: Json) => cut(text(input.agent_type).replace(/[^\w.:-]/g, ''), 40)

/**
 * What a prompt's key is made of: the tool's input, less Codex's `description` (its reason for asking, which the call
 * that runs after doesn't repeat).
 */
const keyInput = (app: PromptApp, input: unknown) => {
  if (app !== 'codex' || !isObject(input) || !('description' in input)) return input
  const { description: _, ...rest } = input
  return rest
}

/** Codex's reason for asking, as a card may show it: redacted, one line, short. */
function reasonOf(app: PromptApp, input: unknown): string | null {
  if (app !== 'codex' || !isObject(input)) return null
  const reason = redactText(text(input.description).replace(/\s+/g, ' ').trim(), 120)
  return reason || null
}

/**
 * A quiet prompt of the agent that has just gone on (0.16.0): asked a while before its next call (not in the same
 * batch), so that call means it isn't waiting any more. Claude Code denied it, by itself or with the person; or it ran.
 */
const wentOn = (agent: string, now: number) => (prompt: Prompt) =>
  Boolean(prompt.quiet) && (prompt.agent ?? '') === agent && prompt.at <= now - BATCH_MS

/** Relayed prompts' cards go to be withdrawn once their prompts are settled (0.33.0). */
function closeCards(
  state: SessionState,
  settled: readonly Prompt[],
  how: 'answered' | 'ended',
): void {
  const cards = settled.flatMap((prompt) => (prompt.card ? [{ ...prompt.card, how }] : []))
  if (cards.length) state.closing = [...(state.closing ?? []), ...cards]
}

/** Keeps a session's newest MAX_PROMPTS prompts; a relayed one let go has its card withdrawn. */
function keepNewest(state: SessionState): void {
  closeCards(state, state.prompts.slice(0, -MAX_PROMPTS), 'answered')
  state.prompts = state.prompts.slice(-MAX_PROMPTS)
}

/**
 * The session's card moves to a relayed one (0.34.1) when the dialog it shows has been relayed: its prompt was, or it
 * showed a Notification's words (or a prompt since settled) and a relayed prompt explains the dialog now.
 */
function markMoving(state: SessionState): void {
  const card = state.card
  if (!card) return
  const shown = state.prompts.find((prompt) => prompt.key === card.key && !prompt.notice)
  if (shown ? shown.relay : state.prompts.some((prompt) => prompt.relay)) card.moving = true
}

/**
 * A dialog was relayed (0.34.1): a Notification's prompt is that dialog (Claude Code shows one at a time and says so of
 * the one on screen), or one already gone, so it goes; a session's card already up for it moves to the relayed card.
 */
function relayed(state: SessionState): void {
  state.prompts = state.prompts.filter((prompt) => !prompt.notice)
  markMoving(state)
}

/** How long after the channel wrote a dialog down itself a hook's late prompt for the same tool is that dialog. */
const ADOPT_MS = 30_000

/**
 * A hook's prompt for a dialog the channel already wrote down itself (0.33.0: the hook came more than RELAY_MATCH_MS
 * late): the channel's prompt takes the hook's key and words, so the call's PostToolUse settles it, and there's still
 * one card. True when it did.
 */
function adopt(state: SessionState, prompt: Prompt): boolean {
  const own = state.prompts.find(
    (each) =>
      each.relay?.own &&
      each.tool === prompt.tool &&
      Math.abs(prompt.at - each.relay.at) <= ADOPT_MS,
  )
  if (!own?.relay) return false
  const { at: _at, quiet: _quiet, ...hook } = prompt
  Object.assign(own, hook)
  delete own.relay.own
  return true
}

/** PermissionRequest: writes the prompt down and makes sure the session's worker is going (once it can post). */
async function asked(io: Io, origin: string, input: Json, app: PromptApp): Promise<void> {
  if (io.platform === 'win32') return
  // `claude -p` and the Agent SDK: nobody sees a prompt, and Claude Code denies the call itself.
  if (app === 'claude-code' && /^sdk-/.test(io.env.CLAUDE_CODE_ENTRYPOINT ?? '')) return
  const where = whereOf(input)
  const tool = text(input.tool_name)
  if (!where || !tool) return
  // Only this computer's own connection for the app can post a card; a sign-in that only hears can't.
  if ((await readCredential(io, origin, app))?.kind !== 'connection') return
  const now = io.now()
  const agent = agentOf(input)
  // A Claude Code background agent's prompt (0.16.0): known by the agent too, and its card says so.
  const subagent = app === 'claude-code' ? agent : ''
  const agentType = subagent ? agentTypeOf(input) : ''
  // bypassPermissions and dontAsk (0.16.0): the hook may run for a call Claude Code then denies by itself, so the prompt
  // waits, quiet, for a Notification to say its dialog is on screen, or for its call to stay unanswered (0.32.2).
  const quiet = app === 'claude-code' && QUIET_MODES.has(text(input.permission_mode))
  const words = promptWords(tool, isObject(input.tool_input) ? input.tool_input : {}, io.home, app)
  const prompt: Prompt = {
    key: promptKey(tool, keyInput(app, input.tool_input), subagent || undefined),
    tool: tool.slice(0, 100),
    ...(reasonOf(app, input.tool_input)
      ? { reason: reasonOf(app, input.tool_input) as string }
      : {}),
    ...words,
    ...(subagent ? { title: fromAgent(words.title) } : {}),
    ...(agent ? { agent } : {}),
    ...(agentType ? { agentType } : {}),
    ...(quiet ? { quiet: true as const } : {}),
    at: now,
  }
  const cwd = text(input.cwd) || io.cwd
  // Remote Control's link is Claude Code's alone.
  const link = app === 'claude-code' ? sessionLink(io.env) : null
  let worker: string | null = null
  await change(io, where.session, (state) => {
    const next: SessionState = state ?? {
      version: 1,
      origin,
      session: where.session,
      cwd,
      prompts: [],
      at: now,
    }
    next.origin = origin
    if (app === 'claude-code') delete next.app
    else next.app = app
    // A background agent works in a folder of its own (its worktree): the session's stays the card's.
    if (!state || !subagent) next.cwd = cwd
    if (where.transcript && (!subagent || !next.transcript)) next.transcript = where.transcript
    if (link) next.link = link
    // The agent asked again a while after a quiet prompt: that one isn't waiting any more (0.16.0).
    const kept =
      app === 'claude-code'
        ? next.prompts.filter((each) => !wentOn(agent, now)(each))
        : next.prompts
    closeCards(
      next,
      next.prompts.filter((each) => !kept.includes(each)),
      'answered',
    )
    next.prompts = kept
    // The same call asked again (the hook run twice) is still the one prompt.
    const adopted = app === 'claude-code' ? adopt(next, prompt) : false
    if (!adopted && !next.prompts.some((each) => each.key === prompt.key)) next.prompts.push(prompt)
    keepNewest(next)
    delete next.settled
    next.at = now
    // Every prompt has the worker (0.32.2): a quiet one's card goes up once a Notification shows it, or once it has
    // waited QUIET_GRACE_MS with its call unanswered.
    worker = claim(next, now)
    return next
  })
  if (worker) startWorker(io, origin, where.session, worker)
}

/**
 * Settles the session's prompts that `which` picks: answered in Claude Code, or the session ended. Starts the worker
 * when there's a card to change or withdraw; a file with nothing left in it goes (unless a worker is busy with it).
 */
async function settle(
  io: Io,
  session: string,
  which: (prompt: Prompt) => boolean,
  how: 'answered' | 'ended',
): Promise<void> {
  const before = await load(io, session)
  if (!before?.prompts.some(which)) return
  const now = io.now()
  let worker: string | null = null
  let origin = before.origin
  await change(io, session, (state) => {
    if (!state) return null
    origin = state.origin
    const left = state.prompts.filter((prompt) => !which(prompt))
    if (left.length === state.prompts.length) return state
    // A relayed prompt's own card goes with it (0.33.0).
    closeCards(
      state,
      state.prompts.filter((prompt) => !left.includes(prompt)),
      how,
    )
    state.prompts = left
    state.settled = how
    state.at = now
    // No card, and nothing left: no worker.
    if (!state.card && !state.closing?.length && left.length === 0)
      return alive(state, now) ? state : null
    worker = claim(state, now)
    return state
  })
  if (worker) startWorker(io, origin, session, worker)
}

/**
 * PostToolUse (and PostToolUseFailure): the call ran, so its prompt was answered. Quick when there's none. Codex asks
 * one approval at a time, and may give the call that ran its input in another form: there, any prompt for the same tool
 * is answered when none matches exactly. In Claude Code (0.16.0) the agent that ran a call isn't waiting on a quiet
 * prompt it asked a while before: Claude Code denied that one, by itself or with the person.
 */
async function ran(io: Io, input: Json, app: PromptApp): Promise<void> {
  const where = whereOf(input)
  const tool = text(input.tool_name)
  if (!where || !tool) return
  const agent = agentOf(input)
  const key = promptKey(
    tool,
    keyInput(app, input.tool_input),
    app === 'claude-code' ? agent || undefined : undefined,
  )
  const before = await load(io, where.session)
  if (!before?.prompts.length) return
  const exact = before.prompts.some((prompt) => prompt.key === key)
  const movedOn = wentOn(agent, io.now())
  await settle(
    io,
    where.session,
    (prompt) =>
      prompt.key === key ||
      (app === 'codex'
        ? !exact && prompt.tool === tool
        : movedOn(prompt) ||
          // A dialog only the channel wrote down (0.33.0): the session's next call of its tool is it, or after it.
          (!exact && Boolean(prompt.relay?.own) && prompt.tool === tool && !agent)),
    'answered',
  )
}

/** A session ended (0.15.0: the presence hook's SessionEnd, Codex's too): every prompt it had is settled. */
export async function endPrompts(io: Io, session: string): Promise<void> {
  try {
    if (SESSION.test(session)) await settle(io, session, () => true, 'ended')
  } catch {}
}

/**
 * The person's next message (handoff) or the end of a turn (stopcheck): the session's own prompts are settled (a
 * denied call runs no PostToolUse). A subagent's are too at the end of a turn, unless a subagent is still running in
 * the background (the Stop hook's `background_tasks`), which may still be waiting on one; so is a notice's (0.16.0),
 * which may be any agent's. Quick when there's none.
 */
export async function settlePrompts(
  io: Io,
  input: { session: string | null; event: 'prompt' | 'stop'; subagents?: boolean },
): Promise<void> {
  try {
    if (!input.session || !SESSION.test(input.session)) return
    const subagentsDone = input.event === 'stop' && !input.subagents
    await settle(
      io,
      input.session,
      (prompt) => (!prompt.agent && !prompt.notice) || subagentsDone,
      'answered',
    )
  } catch {}
}

/** Whether the Stop hook's input says a subagent is still running in the background (its `background_tasks`). */
export function subagentsRunning(input: unknown): boolean {
  if (!isObject(input) || !Array.isArray(input.background_tasks)) return false
  return input.background_tasks.some(
    (task) =>
      isObject(task) &&
      task.type === 'subagent' &&
      !['completed', 'failed', 'killed', 'cancelled', 'stopped'].includes(text(task.status)),
  )
}

/** How long before a Notification a prompt must have been asked: NOTICE_MS, or PENDINGYOU_PERMISSION_NOTICE_MS (tests). */
function noticeMsOf(env: Record<string, string | undefined>): number {
  const given = Number(env.PENDINGYOU_PERMISSION_NOTICE_MS)
  return Number.isInteger(given) && given >= 0 ? given : NOTICE_MS
}

/**
 * Notification (0.16.0; init's matcher runs it only for `permission_prompt`): a dialog has waited about six seconds
 * with nobody typing. It shows the newest prompt written down that was asked long enough before to be that dialog and
 * whose call is still unanswered (0.32.2); with none, and none shown yet, it's a dialog no PermissionRequest hook ran
 * for, and it gets a card in Claude Code's words.
 */
async function notified(io: Io, origin: string, input: Json): Promise<void> {
  if (io.platform === 'win32') return
  if (/^sdk-/.test(io.env.CLAUDE_CODE_ENTRYPOINT ?? '')) return
  if (input.notification_type !== 'permission_prompt') return
  const where = whereOf(input)
  if (!where) return
  if ((await readCredential(io, origin, CLAUDE))?.kind !== 'connection') return
  const now = io.now()
  const before = now - noticeMsOf(io.env)
  const message = noticeWords(input.message)
  const cwd = text(input.cwd) || io.cwd
  const link = sessionLink(io.env)
  // The prompt it shows (0.32.2): the newest asked long enough before it whose call is still unanswered, as its agent's
  // transcript says; not another agent's call Claude Code denied by itself, or one that ran.
  const known = await load(io, where.session)
  let picked: string | null = null
  for (const prompt of (known?.prompts ?? []).slice().reverse()) {
    if (prompt.shown !== undefined || prompt.notice || prompt.at > before) continue
    // A relayed prompt's dialog is on screen (0.34.1): Claude Code relays only a dialog it shows, and writes a prompted
    // call to its transcript only once it's answered, so the transcript can't say (its newest call of the same tool is
    // an earlier one, answered).
    if (prompt.relay || (await stillAsked(known as SessionState, prompt))) {
      picked = promptId(prompt)
      break
    }
  }
  let worker: string | null = null
  await change(io, where.session, (state) => {
    const next: SessionState = state ?? {
      version: 1,
      origin,
      session: where.session,
      cwd,
      prompts: [],
      at: now,
    }
    // A Notification is the session's own: its folder and transcript are the session's.
    next.origin = origin
    delete next.app
    next.cwd = cwd
    if (where.transcript) next.transcript = where.transcript
    if (link) next.link = link
    const shows = picked
      ? next.prompts.find((prompt) => prompt.shown === undefined && promptId(prompt) === picked)
      : undefined
    if (shows) {
      shows.shown = now
      // A dialog on screen is worth another try at a card that kept failing.
      delete shows.failed
    } else if (next.prompts.some((prompt) => prompt.shown !== undefined || prompt.relay)) {
      // A dialog a shown or relayed prompt explains (one waiting behind it, or the same one again): its card is up, or
      // going up. Never a notice's card beside a relayed one (0.34.1).
      return state
    } else next.prompts = [...next.prompts, noticeOf(message, now)].slice(-MAX_PROMPTS)
    delete next.settled
    next.at = now
    worker = claim(next, now)
    return next
  })
  if (worker) startWorker(io, origin, where.session, worker)
}

/**
 * `pendingyou permission`, `permission-done` and `notify` (0.16.0): Claude Code's PermissionRequest, PostToolUse,
 * PostToolUseFailure, SessionEnd and Notification hooks (Codex's first three). Prints nothing (a PermissionRequest
 * hook's output decides the prompt), but for Codex's decision once the person tapped Allow or Deny on its card, with a
 * wait set (0.34.0, askFirst), and exits 0.
 */
export async function permissionHook(
  io: Io,
  options: { origin: string; app?: PromptApp },
): Promise<number> {
  const app = options.app ?? CLAUDE
  try {
    const input: unknown = JSON.parse(await io.readStdin(1000, STDIN_MAX))
    if (!isObject(input)) return 0
    switch (input.hook_event_name) {
      case 'PermissionRequest':
        // Codex with a wait set (0.34.0): the card first, and the decision from it; else as before.
        if (app === 'codex') {
          const wait = await readAnswerWait(io)
          if (wait > 0 && (await askFirst(io, options.origin, input, wait))) break
        }
        await asked(io, options.origin, input, app)
        break
      case 'PostToolUse':
      case 'PostToolUseFailure':
        await ran(io, input, app)
        break
      case 'Notification':
        // Codex has no Notification hook.
        if (app === CLAUDE) await notified(io, options.origin, input)
        break
      case 'SessionEnd': {
        const where = whereOf(input)
        if (where) await settle(io, where.session, () => true, 'ended')
        break
      }
    }
  } catch {}
  return 0
}

/** What the worker does next for a session. */
type Plan =
  | { kind: 'done' }
  | { kind: 'wait'; ms: number }
  | { kind: 'check' }
  | { kind: 'post'; prompt: Prompt }
  | { kind: 'update'; prompt: Prompt }
  /** Withdraw the session's card: its prompts were settled, or (`moved`, 0.34.1) its dialog has a relayed card now. */
  | { kind: 'cancel'; moved?: true }
  /** A relayed prompt's own card (0.33.0): Allow and Deny. */
  | { kind: 'relay'; prompt: Prompt }
  /** A relayed prompt's card whose prompt was settled (0.33.0). */
  | { kind: 'close'; card: Card & { how: 'answered' | 'ended' } }

/**
 * When a prompt's card is due: once it has waited `grace`, or as soon as a Notification showed its dialog (0.16.0); a
 * quiet prompt only then, or once its call was found still unanswered (0.32.2).
 */
const dueOf = (prompt: Prompt, grace: number) =>
  Math.min(
    prompt.quiet ? (prompt.waited ?? Number.POSITIVE_INFINITY) : prompt.at + grace,
    prompt.shown ?? Number.POSITIVE_INFINITY,
  )

/** The prompt a card shows: the newest, but a notice's words only when there's no prompt it can name (0.16.0). */
const shownOf = (prompts: readonly Prompt[]) =>
  (prompts.filter((prompt) => !prompt.notice).at(-1) ?? prompts.at(-1)) as Prompt

/**
 * The next step: withdraw the card once nothing waits; post one once the first prompt is due (it has waited `grace`, or
 * a Notification showed it), showing the newest; change it to the newest once that one is due too; otherwise wait, or
 * nothing (in step). A quiet prompt no Notification showed is as good as not there (0.16.0): it may never have been on
 * screen; but once it has waited `quietGrace` (0.32.2) the worker looks whether its call is still unanswered, first.
 */
export function planFor(
  state: SessionState,
  now: number,
  grace: number,
  quietGrace: number = QUIET_GRACE_MS,
): Plan {
  const plan = relayPlan(state, now, grace, cardPlan(state, now, grace))
  const pending = state.prompts.filter(unchecked)
  if (pending.length === 0) return plan
  const check = Math.min(...pending.map((prompt) => prompt.at + quietGrace)) - now
  if (check <= 0) return { kind: 'check' }
  if (plan.kind === 'done') return { kind: 'wait', ms: check }
  if (plan.kind === 'wait') return { kind: 'wait', ms: Math.min(plan.ms, check) }
  return plan
}

/**
 * Relayed prompts' own cards come first (0.33.0): a card whose prompt was settled is withdrawn; a relayed prompt's card
 * goes up once it has waited `grace`, as any prompt's does (PA5), or a Notification showed it. Otherwise `then`, the
 * session card's step, or whichever wait is shorter.
 */
function relayPlan(state: SessionState, now: number, grace: number, then: Plan): Plan {
  const closing = state.closing?.[0]
  if (closing) return { kind: 'close', card: closing }
  const waiting = state.prompts.filter((prompt) => prompt.relay && !prompt.card && !prompt.failed)
  if (waiting.length === 0) return then
  // The session's card shows the dialog already (0.34.1): the relayed card takes its place at once.
  const dueAt = (prompt: Prompt) =>
    state.card?.moving
      ? now
      : Math.min(
          Math.min(prompt.at, (prompt.relay as Relay).at) + grace,
          prompt.shown ?? Number.POSITIVE_INFINITY,
        )
  const first = waiting.reduce((soonest, prompt) =>
    dueAt(prompt) < dueAt(soonest) ? prompt : soonest,
  )
  const due = dueAt(first) - now
  if (due <= 0) return { kind: 'relay', prompt: first }
  if (then.kind === 'done') return { kind: 'wait', ms: due }
  if (then.kind === 'wait') return { kind: 'wait', ms: Math.min(then.ms, due) }
  return then
}

/** The next step for the session's card, from the prompts that can have one: never a relayed one (0.33.0). */
function cardPlan(state: SessionState, now: number, grace: number): Plan {
  const prompts = state.prompts.filter((prompt) => seen(prompt) && !prompt.relay)
  if (prompts.length === 0)
    return state.card
      ? { kind: 'cancel', ...(state.card.moving ? { moved: true as const } : {}) }
      : { kind: 'done' }
  if (state.card) {
    const newest = shownOf(prompts)
    if (state.card.key === newest.key) return { kind: 'done' }
    const due = dueOf(newest, grace) - now
    return due > 0 ? { kind: 'wait', ms: due } : { kind: 'update', prompt: newest }
  }
  const live = prompts.filter((prompt) => !prompt.failed)
  if (live.length === 0) return { kind: 'done' }
  const due = Math.min(...live.map((prompt) => dueOf(prompt, grace))) - now
  return due > 0 ? { kind: 'wait', ms: due } : { kind: 'post', prompt: shownOf(live) }
}

/** How long a prompt waits for its card: GRACE_MS, or PENDINGYOU_PERMISSION_GRACE_MS (for tests). */
function graceOf(env: Record<string, string | undefined>): number {
  const given = Number(env.PENDINGYOU_PERMISSION_GRACE_MS)
  return Number.isInteger(given) && given >= 0 ? given : GRACE_MS
}

/** The computer as Pending You names it ("Claude Code on Sam’s MacBook Pro"). */
export async function computerOf(io: Io, origin: string, app: PromptApp): Promise<string> {
  const named = await connectionMachine(io, origin, app).catch(() => null)
  return cut(named ?? (machineOf(io.host) || 'this computer'), 60)
}

/** The folder as the person reads it: under ~. */
const tilde = (io: Pick<Io, 'home'>, path: string) => shortPath(path, io.home, 200)

/**
 * The name the session gave Pending You, as its transcript says: the latest of its Pending You calls with a `name`
 * (whoami's, a card tool's) or post_request's `session.label`. Null when it never gave one (or it can't be read).
 */
export async function sessionName(path: string | undefined): Promise<string | null> {
  if (!path) return null
  let file: Awaited<ReturnType<typeof open>>
  try {
    file = await open(path, 'r')
  } catch {
    return null
  }
  try {
    const size = (await file.stat()).size
    let position = size
    let carry = Buffer.alloc(0)
    const nameIn = (line: string): string | null => {
      if (!line.includes('pendingyou')) return null
      let entry: unknown
      try {
        entry = JSON.parse(line)
      } catch {
        return null
      }
      if (!isObject(entry) || entry.type !== 'assistant' || entry.isSidechain === true) return null
      const message = isObject(entry.message) ? entry.message : {}
      const blocks = Array.isArray(message.content) ? message.content : []
      for (const block of [...blocks].reverse()) {
        if (!isObject(block) || block.type !== 'tool_use' || !NAMED_TOOL.test(text(block.name)))
          continue
        const args = isObject(block.input) ? block.input : {}
        const session = isObject(args.session) ? args.session : {}
        const name = (text(args.name) || text(session.label)).trim()
        if (name && [...name].length <= 40) return name
      }
      return null
    }
    while (position > 0 && size - position < TRANSCRIPT_CAP) {
      const length = Math.min(64 * 1024, position)
      position -= length
      const chunk = Buffer.alloc(length)
      await file.read(chunk, 0, length, position)
      let buffer = Buffer.concat([chunk, carry])
      let newline = buffer.lastIndexOf(10)
      while (newline !== -1) {
        const found = nameIn(buffer.subarray(newline + 1).toString('utf8'))
        if (found) return found
        buffer = buffer.subarray(0, newline)
        newline = buffer.lastIndexOf(10)
      }
      carry = buffer
    }
    return position === 0 ? nameIn(carry.toString('utf8')) : null
  } catch {
    return null
  } finally {
    await file.close().catch(() => {})
  }
}

/** Pending You's post_request, under any server name (the plugin's too). */
const POST_TOOL = /^mcp__.*pendingyou.*__post_request$/i
/** The card a post_request's result names. */
const POSTED_ID = /"requestId"\s*:\s*"(req_[A-Za-z0-9-]{1,40})"/
/** The most cards a session names as its own (the server's hear_answers `posted` takes as many). */
export const POSTED_MAX = 50

/** The words of a tool result as a transcript keeps them: its text, or its blocks' text. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => (isObject(block) ? text(block.text) : '')).join('\n')
}

/**
 * The cards this very session posted (CLI 0.25.0), as its transcript says: each post_request of its own (never a
 * subagent's) and the request id its result named, newest first, at most POSTED_MAX. `whole` when that's every one: the
 * transcript was read to its start and held no more, or there's none yet (a session just started has posted nothing).
 * Null when it can't be read.
 */
export async function sessionPosted(
  path: string | undefined,
): Promise<{ posted: string[]; whole: boolean } | null> {
  if (!path) return null
  let file: Awaited<ReturnType<typeof open>>
  try {
    file = await open(path, 'r')
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? { posted: [], whole: true } : null
  }
  try {
    const size = (await file.stat()).size
    let position = size
    let carry = Buffer.alloc(0)
    // Read from the end: a call's result comes after it, so each result waits here for its call.
    const results = new Map<string, string>()
    const posted: string[] = []
    let more = false
    const read = (line: string) => {
      const asResult = line.includes('tool_result') && line.includes('req_')
      const asCall = line.includes('post_request')
      if (!asResult && !asCall) return
      let entry: unknown
      try {
        entry = JSON.parse(line)
      } catch {
        return
      }
      if (!isObject(entry) || entry.isSidechain === true) return
      const message = isObject(entry.message) ? entry.message : {}
      const blocks = Array.isArray(message.content) ? message.content : []
      for (const block of [...blocks].reverse()) {
        if (!isObject(block)) continue
        if (entry.type === 'user' && block.type === 'tool_result' && block.is_error !== true) {
          const id = POSTED_ID.exec(resultText(block.content))?.[1]
          if (id && text(block.tool_use_id)) results.set(text(block.tool_use_id), id)
        } else if (
          entry.type === 'assistant' &&
          block.type === 'tool_use' &&
          POST_TOOL.test(text(block.name))
        ) {
          const id = results.get(text(block.id))
          if (!id || posted.includes(id)) continue
          if (posted.length < POSTED_MAX) posted.push(id)
          else more = true
        }
      }
    }
    while (position > 0 && size - position < TRANSCRIPT_CAP) {
      const length = Math.min(64 * 1024, position)
      position -= length
      const chunk = Buffer.alloc(length)
      await file.read(chunk, 0, length, position)
      let buffer = Buffer.concat([chunk, carry])
      let newline = buffer.lastIndexOf(10)
      while (newline !== -1) {
        read(buffer.subarray(newline + 1).toString('utf8'))
        buffer = buffer.subarray(0, newline)
        newline = buffer.lastIndexOf(10)
      }
      carry = buffer
    }
    if (position === 0) read(carry.toString('utf8'))
    return { posted, whole: position === 0 && !more }
  } catch {
    return null
  } finally {
    await file.close().catch(() => {})
  }
}

/** A Claude Code agent's id as its transcript's file name carries it (`agent-<id>.jsonl`). */
const AGENT_ID = /^[A-Za-z0-9_-]{1,100}$/

/** Where an agent's calls are written, and which of a file's entries are that agent's. */
interface Calls {
  path: string
  mine: (entry: Json) => boolean
}

/**
 * Where the agent that asked a prompt writes its calls (0.32.2): a subagent's own transcript, in its session's folder
 * (`<session>/subagents/agent-<id>.jsonl`), else its entries in the session's transcript (as older Claude Code wrote
 * them); the session's own calls are the session transcript's, less its subagents'.
 */
function callsOf(state: SessionState, prompt: Prompt): Calls[] {
  const transcript = state.transcript
  if (!transcript) return []
  const agent = prompt.agent
  if (!agent) return [{ path: transcript, mine: (entry) => entry.isSidechain !== true }]
  if (!AGENT_ID.test(agent)) return []
  const folder = join(dirname(transcript), basename(transcript, '.jsonl'))
  return [
    { path: join(folder, 'subagents', `agent-${agent}.jsonl`), mine: () => true },
    { path: transcript, mine: (entry) => entry.isSidechain === true && entry.agentId === agent },
  ]
}

/**
 * Whether a prompt's call is still waiting, as the transcript says (0.32.2): its own tool_use, found by the prompt's key
 * (the tool, its input and the agent), with no tool_result yet. Claude Code writes a call it denies by itself with its
 * refusal at once, and one that ran with what it gave.
 *
 * Since 0.34.2 only the prompt's own call counts. Claude Code (2.1.295) writes a prompted call to the transcript only
 * once its dialog is answered, and nothing about it while the dialog is open, so the open call isn't there at all. Its
 * agent's newest call of the same tool, which 0.32.2 fell back on, is then an earlier one, answered: a second Bash's
 * dialog on screen was settled with no card. The same key can be an earlier call too (the same command asked again, or
 * a tool whose prompt is the tool's whatever the input), so a match whose result was written before the prompt was
 * asked is that earlier call and is passed over. A call denied by itself is written with its refusal after the hook
 * ran, so it's found and answered. A call not found is taken as waiting: better a card for a dialog nobody needs (a
 * refused call whose input reads differently in the transcript) than none for one that waits. Null when the file
 * can't be read.
 */
async function callState(calls: Calls, prompt: Prompt): Promise<'waiting' | 'answered' | null> {
  let file: Awaited<ReturnType<typeof open>>
  try {
    file = await open(calls.path, 'r')
  } catch {
    return null
  }
  try {
    const size = (await file.stat()).size
    let position = size
    let carry = Buffer.alloc(0)
    // Read from the end: a call's result comes after it, so each result is known before its call, with when it was
    // written (NaN when the transcript doesn't say).
    const results = new Map<string, number>()
    let found: 'waiting' | 'answered' | null = null
    const read = (line: string) => {
      if (!line.includes('tool_')) return
      let entry: unknown
      try {
        entry = JSON.parse(line)
      } catch {
        return
      }
      if (!isObject(entry) || !calls.mine(entry)) return
      const message = isObject(entry.message) ? entry.message : {}
      const blocks = Array.isArray(message.content) ? message.content : []
      for (const block of [...blocks].reverse()) {
        if (!isObject(block)) continue
        const id = text(block.tool_use_id) || text(block.id)
        if (block.type === 'tool_result' && id) results.set(id, Date.parse(text(entry.timestamp)))
        else if (
          block.type === 'tool_use' &&
          entry.type === 'assistant' &&
          found === null &&
          promptKey(text(block.name), block.input, prompt.agent) === prompt.key
        ) {
          const answered = results.get(id)
          // Answered before the prompt was asked: an earlier call with the same key, never this one.
          if (answered === undefined) found = 'waiting'
          else if (!(answered < prompt.at)) found = 'answered'
        }
      }
    }
    while (found === null && position > 0 && size - position < TRANSCRIPT_CAP) {
      const length = Math.min(64 * 1024, position)
      position -= length
      const chunk = Buffer.alloc(length)
      await file.read(chunk, 0, length, position)
      let buffer = Buffer.concat([chunk, carry])
      let newline = buffer.lastIndexOf(10)
      while (found === null && newline !== -1) {
        read(buffer.subarray(newline + 1).toString('utf8'))
        buffer = buffer.subarray(0, newline)
        newline = buffer.lastIndexOf(10)
      }
      carry = buffer
    }
    if (found === null && position === 0) read(carry.toString('utf8'))
    return found ?? 'waiting'
  } catch {
    return null
  } finally {
    await file.close().catch(() => {})
  }
}

/** Whether a prompt's call is still waiting (0.32.2): its agent's transcript says so, or can't say otherwise. */
async function stillAsked(state: SessionState, prompt: Prompt): Promise<boolean> {
  for (const calls of callsOf(state, prompt)) {
    const found = await callState(calls, prompt)
    if (found) return found === 'waiting'
  }
  return true
}

/** A prompt as one of a session's: the same call asked again later is another. */
const promptId = (prompt: Prompt) => `${prompt.key}:${prompt.at}`

/** The folder's git remote as match_area takes it (github.com/org/repo): never a user name, password or port. */
export function remoteOf(url: string): string | null {
  const plain = url
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):\d+\//, '$1/')
    .replace(/^([^/:]+):/, '$1/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  return /^[\w.-]+\/[\w./-]+$/.test(plain) ? plain : null
}

async function gitRemote(io: Io, cwd: string): Promise<string | null> {
  const result = await io.run('git', ['-C', cwd, 'remote', 'get-url', 'origin'], 3000)
  return result.code === 0 ? remoteOf(result.stdout.split('\n')[0] ?? '') : null
}

const idOf = (result: Json, field: string, prefix: string) => {
  const id = result[field]
  return typeof id === 'string' && id.startsWith(prefix) ? id : null
}

/** Whose session a file is: Claude Code's unless it says. */
const appOf = (state: SessionState): PromptApp => (state.app === 'codex' ? 'codex' : CLAUDE)

/**
 * The name the session goes by with Pending You: Claude Code's from its transcript, a Codex thread's from what its
 * hooks remember (codex-threads.json); else the app's own.
 */
async function nameOf(io: Io, state: SessionState): Promise<string> {
  const app = appOf(state)
  if (app === 'claude-code') return (await sessionName(state.transcript)) ?? DEFAULT_NAME
  const names = await threadNames(io, app, state.session).catch(() => [])
  const name = names.at(-1)?.trim()
  return name && [...name].length <= 40 ? name : defaultName(app)
}

/** The area the session's cards go in: match_area's pick, or one made for the work when nothing fits (the guide). */
async function areaFor(io: Io, client: McpClient, state: SessionState, name: string) {
  const app = appOf(state)
  const remote = await gitRemote(io, state.cwd)
  const match = await client.call('match_area', {
    cwd: cut(state.cwd, 300),
    ...(remote ? { remote: cut(remote, 300) } : {}),
    ...(name !== defaultName(app) ? { task: cut(name, 60) } : {}),
  })
  const suggestions = Array.isArray(match.suggestions) ? match.suggestions.filter(isObject) : []
  const top = suggestions[0] ? idOf(suggestions[0], 'areaId', 'prj_') : null
  if (match.decision !== 'create' && top) return top
  const group = isObject(match.proposedGroup) ? idOf(match.proposedGroup, 'id', 'agr_') : null
  const proposed = text(match.proposedName).trim()
  const created = await client.call('create_area', {
    idempotencyKey: `${app}-area:${createHash('sha256').update(state.cwd).digest('hex').slice(0, 32)}`,
    name: cut(proposed || basename(state.cwd) || 'Inbox', 40),
    description: cut(`Work in ${remote ?? tilde(io, state.cwd)}`, 160),
    tint: text(match.proposedTint) || 'sky',
    ...(group ? { group } : {}),
    repo: remote ? { remote } : { path: state.cwd },
  })
  const areaId = idOf(created, 'areaId', 'prj_')
  if (!areaId) throw new McpFailure(-32000, 'Pending You made no area.')
  return areaId
}

/** Whether a prompt is a Claude Code subagent's (0.16.0), which its card says. */
const byAgent = (state: SessionState, prompt: Prompt) =>
  appOf(state) === 'claude-code' && Boolean(prompt.agent)

/** What the card's change says when it moves to a newer prompt. */
function changeNoteOf(state: SessionState, prompt: Prompt): string {
  if (prompt.doing === 'to answer its question')
    return cut(`Now waiting for your answer: ${prompt.what}`, 120)
  const agent = byAgent(state, prompt) ? SUBAGENT : ''
  return `${cut(`Now waiting for your OK: ${prompt.what}`, 120 - [...agent].length)}${agent}`
}

/**
 * The card's summary and its one step: the folder and the computer, and where to answer. A subagent's prompt (0.16.0)
 * says which kind of agent asked, and that it's one of the session's: "A subagent (general-purpose) of Claude Code …
 * needs your permission to run a command" (0.32.2).
 */
function cardWords(io: Io, state: SessionState, prompt: Prompt, name: string, machine: string) {
  const app = appOf(state)
  const who = name === defaultName(app) ? APP_NAMES[app] : `${APP_NAMES[app]} (${name})`
  const waiting =
    prompt.doing === 'to answer its question'
      ? 'is waiting for your answer to its question'
      : `is waiting for your OK${prompt.doing ? ` ${prompt.doing}` : ''}`
  const why = prompt.reason ? ` It says: “${prompt.reason}”.` : ''
  const where = `in ${tilde(io, state.cwd)} on ${machine}`
  const subagent = byAgent(state, prompt)
  const asker = subagent
    ? `A subagent${prompt.agentType ? ` (${prompt.agentType})` : ''} of ${who}, ${where},`
    : `${who} ${where}`
  const needs = !subagent
    ? waiting
    : prompt.doing === 'to answer its question'
      ? 'needs your answer to its question'
      : `needs your permission${prompt.doing ? ` ${prompt.doing}` : ''}`
  const summary = cut(`${asker} ${needs}.${why} It goes on once you answer it there.`, 400)
  const place = `${APP_NAMES[app]} on ${machine}`
  const linked = state.link ? `${place}, ${state.link}` : place
  return {
    summary,
    action: {
      where: linked.length <= 120 ? linked : cut(place, 120),
      steps: [
        {
          text: state.link
            ? `Answer it in ${place}, or open the session’s link and answer it there.`
            : `Answer it in ${place}.`,
        },
      ],
      done: 'This card closes by itself once you answer there.',
    },
  }
}

/**
 * The card's context, which post_request requires (0.32.3): without it Pending You refused every card, and the worker
 * gave its prompts up in silence. Only what the card already says: the prompt, and the session's link.
 */
function contextOf(state: SessionState, prompt: Prompt) {
  const app = appOf(state)
  return {
    background: `${APP_NAMES[app]} asked in its terminal; this card stands in for that dialog.`,
    trace: [{ state: 'paused' as const, text: prompt.title }],
    filesTouched: [],
    tried: [],
    links: state.link ? [{ label: `The ${APP_NAMES[app]} session`, url: state.link }] : [],
  }
}

/** Records what the worker did, while the session is still its own; false when it isn't any more. */
async function record(
  io: Io,
  session: string,
  worker: string,
  edit: (state: SessionState) => void,
): Promise<boolean> {
  let ours = false
  await change(io, session, (state) => {
    if (!state || state.worker?.id !== worker) return state
    ours = true
    edit(state)
    state.worker = { id: worker, at: io.now() }
    return state
  })
  return ours
}

/** Posts the session's card for its newest prompt. A card it can't record (the session moved on) is withdrawn. */
async function post(
  io: Io,
  client: McpClient,
  state: SessionState,
  prompt: Prompt,
  worker: string,
) {
  const name = await nameOf(io, state)
  await client.call('whoami', { name })
  const areaId = state.areaId ?? (await areaFor(io, client, state, name))
  const machine = await computerOf(io, state.origin, appOf(state))
  const result = await client.call('post_request', {
    idempotencyKey: `${appOf(state)}-permission:${state.session}:${prompt.key}:${prompt.at}`,
    areaId,
    session: { label: name, machine, cwd: cut(tilde(io, state.cwd), 300) },
    kind: 'action',
    title: prompt.title,
    ...cardWords(io, state, prompt, name, machine),
    context: contextOf(state, prompt),
    blocking: false,
    urgency: 'now',
    askedFirst: { where: 'terminal', askedAt: new Date(prompt.at).toISOString() },
    // A permission prompt's card without buttons (0.33.0): it's answered only in the app that asked.
    permissionPrompt: { app: appOf(state), relay: false },
  })
  const requestId = idOf(result, 'requestId', 'req_')
  const version = typeof result.version === 'number' ? result.version : 1
  if (!requestId) throw new McpFailure(-32000, 'Pending You posted no card.')
  const card: Card = { requestId, version, key: prompt.key, name }
  const kept = await record(io, state.session, worker, (state) => {
    state.card = card
    state.areaId = areaId
    // Its dialog was relayed while it was posted (0.34.1): the relayed card takes its place.
    markMoving(state)
  })
  if (!kept) await withdraw(io, client, card, state, 'answered').catch(() => {})
}

/** The options of a relayed prompt's card: Allow and Deny; only Deny when part of its input couldn't be shown (§7). */
export const ALLOW = 'allow'
export const DENY = 'deny'
export const IN_TERMINAL = 'terminal'

/** What a relayed prompt's card asks (0.33.0): "Allow Claude Code (billing-webhooks) to run a command?" */
export function relayTitle(state: SessionState, prompt: Prompt, name: string): string {
  const app = appOf(state)
  const who = name === defaultName(app) ? APP_NAMES[app] : `${APP_NAMES[app]} (${name})`
  const subject = byAgent(state, prompt) ? `a subagent of ${who}` : who
  const doing = prompt.doing.startsWith('to ')
    ? prompt.doing
    : `to use ${toolName(prompt.tool ?? '')}`
  return cut(`Allow ${subject} ${doing}?`, TITLE_MAX)
}

/**
 * Posts a relayed prompt's own card (0.33.0): Allow and Deny, the whole input in a code block (PA2), asked in both
 * places, marked as a relayed permission prompt. A card it can't record (the prompt was settled meanwhile) is withdrawn.
 */
async function postRelay(
  io: Io,
  client: McpClient,
  state: SessionState,
  prompt: Prompt,
  worker: string,
) {
  const relay = prompt.relay as Relay
  const app = appOf(state)
  const name = await nameOf(io, state)
  await client.call('whoami', { name })
  const areaId = state.areaId ?? (await areaFor(io, client, state, name))
  const machine = await computerOf(io, state.origin, app)
  const title = relayTitle(state, prompt, name)
  const who = name === defaultName(app) ? APP_NAMES[app] : `${APP_NAMES[app]} (${name})`
  const where = `in ${tilde(io, state.cwd)} on ${machine}`
  const asker = byAgent(state, prompt)
    ? `A subagent${prompt.agentType ? ` (${prompt.agentType})` : ''} of ${who}, ${where},`
    : `${who} ${where}`
  const wants = prompt.doing.startsWith('to ')
    ? `wants your OK ${prompt.doing}`
    : `wants your OK to use ${toolName(prompt.tool ?? '')}`
  const why = relay.description ? ` It says: “${relay.description}”.` : ''
  const answer = relay.unserializable
    ? `Part of it couldn’t be shown, so only Deny is here; to allow it, answer in ${APP_NAMES[app]} on ${machine}.`
    : `Allow or Deny here, or answer in ${APP_NAMES[app]} on ${machine}: the first answer wins.`
  const session = createHash('sha256').update(state.session).digest('hex').slice(0, 24)
  const result = await client.call('post_request', {
    idempotencyKey: `${app}-relay:${session}:${relay.id}:${relay.at}`,
    areaId,
    session: { label: name, machine, cwd: cut(tilde(io, state.cwd), 300) },
    kind: 'choice',
    intent: 'approve',
    title,
    summary: cut(`${asker} ${wants}.${why} ${answer}`, 400),
    options: relay.unserializable
      ? [
          { id: DENY, label: 'Deny' },
          { id: IN_TERMINAL, label: `I’ll answer in ${APP_NAMES[app]}` },
        ]
      : [
          { id: ALLOW, label: 'Allow', detail: 'This call only. Nothing is allowed after it.' },
          { id: DENY, label: 'Deny' },
        ],
    artifacts: [
      {
        kind: 'code',
        title: prompt.tool === 'Bash' ? 'The command' : `${toolName(prompt.tool ?? '')}’s input`,
        ref: `permission-${relay.id}`,
        lang: relay.lang,
        lines: relay.lines,
      },
    ],
    context: { ...contextOf(state, prompt), trace: [{ state: 'paused' as const, text: title }] },
    blocking: false,
    urgency: 'now',
    askedFirst: { where: 'terminal', askedAt: new Date(prompt.at).toISOString() },
    // A relayed permission prompt's card: Pending You takes it only from the app's own connection.
    permissionPrompt: { app, relay: true },
  })
  const requestId = idOf(result, 'requestId', 'req_')
  const version = typeof result.version === 'number' ? result.version : 1
  if (!requestId) throw new McpFailure(-32000, 'Pending You posted no card.')
  const card: Card = { requestId, version, key: prompt.key, name }
  const id = promptId(prompt)
  let kept = false
  const ours = await record(io, state.session, worker, (state) => {
    const now = state.prompts.find((each) => promptId(each) === id && each.relay?.id === relay.id)
    if (!now) return
    now.card = card
    state.areaId = areaId
    kept = true
  })
  if (!ours || !kept) await withdraw(io, client, card, state, 'answered').catch(() => {})
}

/** Whether the card is still in front of the person (get_request), with its version; null when it's closed. */
async function stillOpen(client: McpClient, card: Card): Promise<number | null> {
  const now = await client.call('get_request', { requestId: card.requestId, name: card.name })
  const open =
    ['pending', 'snoozed', 'delegated'].includes(text(now.status)) && now.turn !== 'agent'
  return open && typeof now.version === 'number' ? now.version : null
}

/** Changes the card to the newest prompt; a card that closed meanwhile is let go, and the next step posts anew. */
async function update(
  io: Io,
  client: McpClient,
  state: SessionState,
  prompt: Prompt,
  worker: string,
) {
  const card = state.card as Card
  const machine = await computerOf(io, state.origin, appOf(state))
  const words = cardWords(io, state, prompt, card.name, machine)
  const change = (expectedVersion: number) =>
    client.call('update_request', {
      requestId: card.requestId,
      name: card.name,
      expectedVersion,
      changeNote: changeNoteOf(state, prompt),
      title: prompt.title,
      summary: words.summary,
      action: words.action,
    })
  let result: Json
  try {
    result = await change(card.version)
  } catch (error) {
    if (!(error instanceof ToolRefused)) throw error
    const version = await stillOpen(client, card)
    if (version === null) {
      await record(io, state.session, worker, (state) => {
        if (state.card?.requestId === card.requestId) delete state.card
      })
      return
    }
    result = await change(version)
  }
  const version = typeof result.version === 'number' ? result.version : card.version + 1
  await record(io, state.session, worker, (state) => {
    if (state.card?.requestId === card.requestId) {
      const { moving: _, ...shown } = card
      state.card = { ...shown, version, key: prompt.key }
    }
  })
}

/** Why the session's card goes when its dialog has a relayed card now (0.34.1). */
const MOVED = 'It has a card of its own now, with Allow and Deny.'

/**
 * Withdraws a card: answered in Claude Code (answeredHere), the session ended before anyone answered, or (0.34.1) its
 * dialog has a relayed card now.
 */
async function withdraw(
  io: Io,
  client: McpClient,
  card: Card,
  state: SessionState,
  how: 'answered' | 'ended' | 'moved',
): Promise<void> {
  const machine = await computerOf(io, state.origin, appOf(state))
  try {
    await client.call('cancel_request', {
      requestId: card.requestId,
      name: card.name,
      reason:
        how === 'moved'
          ? MOVED
          : how === 'answered'
            ? cut(`Answered in ${APP_NAMES[appOf(state)]} on ${machine}.`, 200)
            : cut(
                `That ${APP_NAMES[appOf(state)]} session on ${machine} ended, so it isn’t waiting any more.`,
                200,
              ),
      ...(how === 'answered' ? { answeredHere: true } : {}),
    })
  } catch (error) {
    if (!(error instanceof ToolRefused)) throw error
    // Closed already. One they pressed Done on waits for its agent to acknowledge it: done here, so nobody is told.
    const now = await client
      .call('get_request', { requestId: card.requestId, name: card.name })
      .catch(() => null)
    if (now?.status === 'answered' && typeof now.version === 'number')
      await client
        .call('ack_answer', {
          requestId: card.requestId,
          name: card.name,
          expectedVersion: now.version,
          outcome: cut(`Answered in ${APP_NAMES[appOf(state)]} on ${machine}.`, 200),
        })
        .catch(() => {})
  }
}

/**
 * Looks at each quiet prompt that has waited QUIET_GRACE_MS (0.32.2): one whose call is still unanswered in its agent's
 * transcript has a dialog on screen, so its card is due; one whose call has its result was denied by Claude Code by
 * itself (or ran, or was answered), so it's settled with no card.
 */
async function check(io: Io, state: SessionState, worker: string): Promise<void> {
  const now = io.now()
  const due = state.prompts.filter(
    (prompt) => unchecked(prompt) && prompt.at + QUIET_GRACE_MS <= now,
  )
  const waiting = new Map<string, boolean>()
  for (const prompt of due) waiting.set(promptId(prompt), await stillAsked(state, prompt))
  await record(io, state.session, worker, (state) => {
    const left = state.prompts.filter((prompt) => waiting.get(promptId(prompt)) !== false)
    if (left.length < state.prompts.length) {
      state.prompts = left
      state.settled = 'answered'
      state.at = now
    }
    for (const prompt of left)
      if (unchecked(prompt) && waiting.get(promptId(prompt))) prompt.waited = now
  })
}

/** Renews the worker's lease; false once the session isn't its own. */
const renew = (io: Io, session: string, worker: string) => record(io, session, worker, () => {})

/**
 * Lets the session go once nothing is left to do, under its lock, so an event written meanwhile is never missed: true
 * when it's let go (and the file removed when nothing is in it), false when there's more to do.
 */
async function letGo(io: Io, session: string, worker: string, grace: number): Promise<boolean> {
  let done = true
  await change(io, session, (state) => {
    if (!state || state.worker?.id !== worker) return state
    if (planFor(state, io.now(), grace).kind !== 'done') {
      done = false
      return state
    }
    delete state.worker
    return state.prompts.length === 0 && !state.card && !state.closing?.length ? null : state
  })
  return done
}

/** Removes files left by sessions that never ended cleanly. */
async function prune(io: Io): Promise<void> {
  const folder = folderOf(io)
  const names = await readdir(folder).catch(() => [] as string[])
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(folder, name)
    const info = await stat(path).catch(() => null)
    if (info && Date.now() - info.mtimeMs > KEEP_MS) await rm(path, { force: true })
  }
}

/**
 * `pendingyou permission-card --session <id> --worker <id>`: the session's worker, detached and quiet. Posts, changes
 * and withdraws the session's one card until nothing is left to do, then lets the session go. A step that keeps
 * failing is given up (a post: its prompts get no card; a withdrawal: the card is forgotten); a sign-in that has ended
 * gives everything up.
 */
export async function permissionWorker(
  io: Io,
  options: { origin: string; session: string; worker: string },
): Promise<number> {
  const { session, worker } = options
  if (!SESSION.test(session)) return 0
  const started = io.now()
  const grace = graceOf(io.env)
  let client: McpClient | null = null
  let failures = 0
  try {
    while (!io.signal.aborted && io.now() - started < WORKER_MS) {
      const state = await load(io, session)
      if (!state || state.worker?.id !== worker) return 0
      const plan = planFor(state, io.now(), grace)
      if (plan.kind === 'done') {
        if (await letGo(io, session, worker, grace)) {
          await prune(io).catch(() => {})
          return 0
        }
        continue
      }
      if (!(await renew(io, session, worker))) return 0
      if (plan.kind === 'wait') {
        await io.sleep(Math.min(plan.ms, NAP_MS), io.signal)
        continue
      }
      if (plan.kind === 'check') {
        await check(io, state, worker)
        continue
      }
      try {
        client ??= await mcpClient(io, state.origin, appOf(state), CALL_MS)
        if (plan.kind === 'post') await post(io, client, state, plan.prompt, worker)
        else if (plan.kind === 'update') await update(io, client, state, plan.prompt, worker)
        else if (plan.kind === 'relay') await postRelay(io, client, state, plan.prompt, worker)
        else if (plan.kind === 'close') {
          const card = plan.card
          await withdraw(io, client, card, state, card.how)
          await record(io, session, worker, (state) => {
            state.closing = state.closing?.filter((each) => each.requestId !== card.requestId)
            if (!state.closing?.length) delete state.closing
          })
        } else {
          const card = state.card as Card
          await withdraw(
            io,
            client,
            card,
            state,
            plan.moved ? 'moved' : (state.settled ?? 'answered'),
          )
          await record(io, session, worker, (state) => {
            if (state.card?.requestId === card.requestId) delete state.card
          })
        }
        failures = 0
      } catch (error) {
        client = null
        // The sign-in has ended: nothing here can reach Pending You until init runs again.
        if (error instanceof McpFailure && error.code === SIGN_IN_ERROR) {
          await change(io, session, (state) => (state?.worker?.id === worker ? null : state))
          return 0
        }
        if (failures >= BACKOFF_MS.length) {
          failures = 0
          await record(io, session, worker, (state) => {
            if (plan.kind === 'relay') {
              const id = promptId(plan.prompt)
              state.prompts = state.prompts.map((prompt) =>
                promptId(prompt) === id ? { ...prompt, failed: true } : prompt,
              )
            } else if (plan.kind === 'close') {
              state.closing = state.closing?.filter(
                (each) => each.requestId !== plan.card.requestId,
              )
              if (!state.closing?.length) delete state.closing
            } else if (plan.kind === 'post')
              state.prompts = state.prompts.map((prompt) =>
                prompt.relay ? prompt : { ...prompt, failed: true },
              )
            else if (plan.kind === 'update' && state.card)
              state.card = { ...state.card, key: plan.prompt.key }
            else delete state.card
          })
          continue
        }
        await io.sleep(BACKOFF_MS[failures++] as number, io.signal)
      }
    }
    return 0
  } finally {
    await client?.close().catch(() => {})
  }
}

/**
 * How far apart a relayed dialog and a hook's prompt may be to be the same one (0.33.0): Claude Code runs the
 * PermissionRequest hook and relays the dialog as it opens it, within milliseconds of each other.
 */
export const RELAY_MATCH_MS = 5000

/** What the channel heard (0.33.0): the dialog, the tool, and the card's words for it should no hook write it down. */
export interface Relayed {
  relay: Relay
  tool: string
  /** promptWords for the relayed input, for a prompt the channel writes down itself. */
  words: { title: string; what: string; doing: string }
}

/**
 * How well a hook's prompt fits a relayed dialog: null when it can't be it (another tool, too far apart in time,
 * relayed already, a Notification's); else how many of the prompt's own words (its `what`, redacted, in the pieces
 * between what redact.ts took out) are in the relayed input. Of two dialogs for the same tool at once, the one whose
 * command it is wins.
 */
function fit(prompt: Prompt, heard: Relayed): number | null {
  if (prompt.relay || prompt.notice || prompt.tool !== heard.tool) return null
  if (Math.abs(prompt.at - heard.relay.at) > RELAY_MATCH_MS) return null
  const input = heard.relay.lines.join(' ').replace(/\s+/g, ' ')
  return prompt.what
    .split(BLANK)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter((part) => part.length >= 3 && input.includes(part)).length
}

/** The prompt among a session's that a relayed dialog is: the best fit, the nearest in time of equals. */
function bestFit(prompts: readonly Prompt[], heard: Relayed): Prompt | null {
  let best: { prompt: Prompt; score: number } | null = null
  for (const prompt of prompts) {
    const score = fit(prompt, heard)
    if (score === null) continue
    const apart = Math.abs(prompt.at - heard.relay.at)
    if (
      !best ||
      score > best.score ||
      (score === best.score && apart < Math.abs(best.prompt.at - heard.relay.at))
    )
      best = { prompt, score }
  }
  return best?.prompt ?? null
}

/** Sessions with a file here, the given one first: where a relayed dialog's prompt may be. */
async function sessionsFrom(io: Pick<Io, 'env' | 'home'>, first: string | null): Promise<string[]> {
  const names = await readdir(folderOf(io)).catch(() => [] as string[])
  const others = names
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((session) => SESSION.test(session) && session !== first)
  return first ? [first, ...others] : others
}

/** A Claude Code session's transcript where Claude Code keeps it: `<claude>/projects/<folder, dashed>/<session>.jsonl`. */
const transcriptOf = (io: Pick<Io, 'env' | 'home'>, cwd: string, session: string) =>
  join(claudeDir(io), 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'), `${session}.jsonl`)

/**
 * The channel heard a dialog (0.33.0, channel.ts): it's written down on the hook's prompt for it, so that prompt's card
 * is this one, with Allow and Deny. `session` is the channel's own Claude Code session (CLAUDE_CODE_SESSION_ID); the
 * prompt is looked for there first, then in every session's file (a session id that changed under the channel, after
 * /clear). With none found and `last` (it has waited RELAY_MATCH_MS for the hook), the channel writes the dialog down
 * itself, in its session's file. Starts the session's worker unless one is running. Returns the session it's written
 * down in, or null when it isn't (yet).
 */
export async function recordRelay(
  io: Io,
  origin: string,
  heard: Relayed,
  options: { session: string | null; cwd: string; last: boolean },
): Promise<string | null> {
  if (io.platform === 'win32') return null
  if ((await readCredential(io, origin, CLAUDE))?.kind !== 'connection') return null
  for (const session of await sessionsFrom(io, options.session)) {
    const before = await load(io, session)
    if (!before || !bestFit(before.prompts, heard)) continue
    let worker: string | null = null
    let matched = false
    const state = await change(io, session, (state) => {
      const prompt = state ? bestFit(state.prompts, heard) : null
      if (!state || !prompt) return state
      prompt.relay = heard.relay
      delete prompt.failed
      relayed(state)
      matched = true
      delete state.settled
      worker = claim(state, io.now())
      return state
    })
    if (!matched || !state) continue
    if (worker) startWorker(io, state.origin, session, worker)
    return session
  }
  if (!options.last) return null
  const session = options.session ?? `channel-${io.ppid ?? process.pid}`
  const now = io.now()
  const prompt: Prompt = {
    key: promptKey(heard.tool, { relay: heard.relay.id }),
    tool: heard.tool.slice(0, 100),
    ...heard.words,
    at: heard.relay.at,
    relay: { ...heard.relay, own: true },
  }
  let worker: string | null = null
  await change(io, session, (state) => {
    const next: SessionState = state ?? {
      version: 1,
      origin,
      session,
      cwd: options.cwd,
      ...(options.session ? { transcript: transcriptOf(io, options.cwd, options.session) } : {}),
      prompts: [],
      at: now,
    }
    if (next.prompts.some((each) => each.relay?.id === heard.relay.id)) return next
    next.prompts.push(prompt)
    relayed(next)
    keepNewest(next)
    delete next.settled
    next.at = now
    worker = claim(next, now)
    return next
  })
  if (worker) startWorker(io, origin, session, worker)
  return session
}

/** A relayed dialog's prompt as its session's file has it now (0.33.0); null once it's settled (or the file's gone). */
export async function relayedPrompt(
  io: Pick<Io, 'env' | 'home'>,
  session: string,
  id: string,
): Promise<{ state: SessionState; prompt: Prompt } | null> {
  const state = await load(io, session)
  const prompt = state?.prompts.find((each) => each.relay?.id === id)
  return state && prompt ? { state, prompt } : null
}

/**
 * The person answered a relayed dialog on its card and the channel passed it on (0.33.0): its prompt is settled, and
 * its card answered there, so there's nothing to withdraw. A file with nothing left in it goes (unless a worker has it).
 */
export async function answeredOnCard(io: Io, session: string, id: string): Promise<void> {
  await change(io, session, (state) => {
    if (!state) return null
    const left = state.prompts.filter((prompt) => prompt.relay?.id !== id)
    if (left.length === state.prompts.length) return state
    state.prompts = left
    state.at = io.now()
    if (left.length === 0 && !state.card && !state.closing?.length && !alive(state, io.now()))
      return null
    return state
  })
}

/** What uninstall says it took away, when there was anything. */
export async function removePermissionFiles(io: Pick<Io, 'env' | 'home'>): Promise<boolean> {
  const folder = folderOf(io)
  const there = await stat(folder).then(
    () => true,
    () => false,
  )
  await rm(folder, { recursive: true, force: true })
  return there
}

/** How often Codex's hook reads its card while it waits (0.34.0): as the channel reads Claude Code's. */
export const ANSWER_READ_MS = 2000
/** How long one call to Pending You may take while Codex waits: short, so a withdrawal fits in the hook's margin. */
const ANSWER_CALL_MS = 8000
/** The most of an input a card shows (as the channel's): past it, only Deny is offered there. */
const ANSWER_INPUT_MAX = 40_000
const ANSWER_LINES_MAX = 400
/** The longest line a card shows (masking a longer one takes too long for a hook): past it, the input is cut there. */
const ANSWER_LINE_MAX = 2000
/** What Codex is told when the person taps Deny on the card. */
export const DENIED = 'Denied in Pending You.'

/** Codex's decision for a tap (0.34.0), as its PermissionRequest hook prints it: the hook's stdout and nothing else. */
export function codexDecision(verdict: 'allow' | 'deny'): string {
  const decision =
    verdict === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: DENIED }
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
  })
}

/**
 * A Codex prompt's input as its card shows it (0.34.0): the command for a shell call, the patch for apply_patch, else
 * each field on its own line; secrets masked (redact.ts's maskSecrets), Codex's reason left for the summary. `cut` when
 * it was too long to show whole: the card then offers no Allow.
 */
export function codexInputLines(
  tool: string,
  input: Json,
): { lines: string[]; lang: Relay['lang']; cut: boolean } {
  const { description: _, ...rest } = input
  const command = commandText(rest.command)
  const patch = command || text(rest.patch) || text(rest.input)
  let lines: string[]
  let lang: Relay['lang'] = 'text'
  if (tool === 'apply_patch' && patch) lines = patch.split('\n')
  else if (command) {
    lines = command.split('\n')
    lang = 'shell'
  } else
    lines = Object.entries(rest).flatMap(([key, value]) =>
      `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`.split('\n'),
    )
  // Cut before masking, and only between whole lines: a line too long is left out whole, never half a secret shown.
  const kept: string[] = []
  let size = 0
  for (const line of lines) {
    if (
      kept.length >= ANSWER_LINES_MAX ||
      line.length > ANSWER_LINE_MAX ||
      size + line.length > ANSWER_INPUT_MAX
    ) {
      kept.push('… (cut here: too long to show whole)')
      return { lines: kept, lang, cut: true }
    }
    kept.push(maskSecrets(line))
    size += line.length
  }
  return { lines: kept.length ? kept : [''], lang, cut: false }
}

/** What a Codex card's answer says (0.34.0): Allow or Deny tapped, the terminal chosen, or not answered. */
function tapOf(card: Json, partial: boolean): 'allow' | 'deny' | 'terminal' | null {
  if (!['answered', 'resolved'].includes(text(card.status))) return null
  const answer = isObject(card.answer) ? card.answer : null
  const picked = Array.isArray(answer?.choiceIds) ? answer.choiceIds : []
  if (picked.length !== 1) return 'terminal'
  if (picked[0] === DENY) return 'deny'
  if (picked[0] === ALLOW && !partial) return 'allow'
  return 'terminal'
}

/**
 * Codex's PermissionRequest with a wait set (0.34.0, PA7): posts the prompt's card at once, waits up to `wait` minutes
 * for Allow or Deny on it (reading it every ANSWER_READ_MS), prints Codex's decision and acknowledges the card; with no
 * tap in time, withdraws the card and prints nothing, so Codex asks in its terminal. True once the card was posted (the
 * prompt is this one's); false when it couldn't be, and today's hooks take the prompt.
 */
async function askFirst(io: Io, origin: string, input: Json, wait: number): Promise<boolean> {
  if (io.platform === 'win32') return false
  const where = whereOf(input)
  const tool = text(input.tool_name)
  if (!where || !tool) return false
  if ((await readCredential(io, origin, 'codex'))?.kind !== 'connection') return false
  const started = io.now()
  const toolInput = isObject(input.tool_input) ? input.tool_input : {}
  const cwd = text(input.cwd) || io.cwd
  const known = await load(io, where.session).catch(() => null)
  const state: SessionState = {
    version: 1,
    origin,
    app: 'codex',
    session: where.session,
    cwd,
    prompts: [],
    ...(known?.areaId && known.cwd === cwd ? { areaId: known.areaId } : {}),
    at: started,
  }
  const prompt: Prompt = {
    key: promptKey(tool, keyInput('codex', toolInput)),
    tool: tool.slice(0, 100),
    ...promptWords(tool, toolInput, io.home, 'codex'),
    at: started,
  }
  const shown = codexInputLines(tool, toolInput)
  let client: McpClient | null = null
  let card: Card
  let machine: string
  try {
    client = await mcpClient(io, origin, 'codex', ANSWER_CALL_MS)
    const name = await nameOf(io, state)
    await client.call('whoami', { name })
    const areaId = state.areaId ?? (await areaFor(io, client, state, name))
    machine = await computerOf(io, origin, 'codex')
    const title = relayTitle(state, prompt, name)
    const who = name === defaultName('codex') ? APP_NAMES.codex : `${APP_NAMES.codex} (${name})`
    const wants = prompt.doing.startsWith('to ')
      ? `wants your OK ${prompt.doing}`
      : `wants your OK to use ${toolName(tool)}`
    const reason = reasonOf('codex', toolInput)
    const why = reason ? ` It says: “${reason}”.` : ''
    const answer = shown.cut
      ? ' It’s too long to show whole, so only Deny is here; to allow it, choose “I’ll answer in Codex” and answer in its terminal.'
      : ` Allow or Deny here: Codex waits up to ${minutes(wait)} for you, showing nothing, then asks in its terminal.`
    const session = createHash('sha256').update(where.session).digest('hex').slice(0, 24)
    const result = await client.call('post_request', {
      idempotencyKey: `codex-ask:${session}:${prompt.key}:${started}`,
      areaId,
      session: { label: name, machine, cwd: cut(tilde(io, cwd), 300) },
      kind: 'choice',
      intent: 'approve',
      title,
      summary: cut(`${who} in ${tilde(io, cwd)} on ${machine} ${wants}.${why}${answer}`, 400),
      options: shown.cut
        ? [
            { id: DENY, label: 'Deny' },
            { id: IN_TERMINAL, label: `I’ll answer in ${APP_NAMES.codex}` },
          ]
        : [
            { id: ALLOW, label: 'Allow', detail: 'This call only. Nothing is allowed after it.' },
            { id: DENY, label: 'Deny' },
          ],
      artifacts: [
        {
          kind: 'code',
          title: shown.lang === 'shell' ? 'The command' : `${toolName(tool)}’s input`,
          ref: `permission-${prompt.key.slice(0, 16)}`,
          lang: shown.lang,
          lines: shown.lines,
        },
      ],
      context: { ...contextOf(state, prompt), trace: [{ state: 'paused' as const, text: title }] },
      blocking: false,
      urgency: 'now',
      // Answered on the card only: Codex shows nothing while its hook waits.
      permissionPrompt: { app: 'codex', relay: true },
    })
    const requestId = idOf(result, 'requestId', 'req_')
    if (!requestId) throw new McpFailure(-32000, 'Pending You posted no card.')
    card = {
      requestId,
      version: typeof result.version === 'number' ? result.version : 1,
      key: prompt.key,
      name,
    }
  } catch {
    await client?.close().catch(() => {})
    return false
  }
  const pending = client
  const read = () => pending.call('get_request', { requestId: card.requestId, name: card.name })
  const say = async (tap: 'allow' | 'deny' | 'terminal', now: Json) => {
    if (tap !== 'terminal') io.out(`${codexDecision(tap)}\n`)
    if (now.status !== 'answered' || typeof now.version !== 'number') return
    await pending
      .call('ack_answer', {
        requestId: card.requestId,
        name: card.name,
        expectedVersion: now.version,
        outcome: cut(
          tap === 'allow'
            ? `Allowed in Codex on ${machine}.`
            : tap === 'deny'
              ? `Denied in Codex on ${machine}.`
              : `Not allowed or denied here: Codex asks in its terminal on ${machine} now.`,
          200,
        ),
      })
      .catch(() => {})
  }
  const until = started + wait * 60_000
  try {
    while (!io.signal.aborted && io.now() < until) {
      await io.sleep(Math.min(ANSWER_READ_MS, until - io.now()), io.signal)
      if (io.signal.aborted) return true
      let now: Json
      try {
        now = await read()
      } catch (error) {
        if (error instanceof McpFailure && error.code === SIGN_IN_ERROR) break
        continue
      }
      if (['pending', 'snoozed', 'delegated'].includes(text(now.status))) continue
      // Closed some other way (withdrawn, expired): nothing to say, and Codex asks in its terminal.
      const tap = tapOf(now, shown.cut)
      if (tap) await say(tap, now)
      return true
    }
    if (io.signal.aborted) return true
    // No tap in time: the card goes, and Codex asks in its terminal.
    try {
      await pending.call('cancel_request', {
        requestId: card.requestId,
        name: card.name,
        reason: cut(
          `No answer here in ${minutes(wait)}, so Codex is asking in its terminal on ${machine} now.`,
          200,
        ),
      })
    } catch (error) {
      if (!(error instanceof ToolRefused)) return true
      // Tapped just as the wait ran out: that answer still counts.
      const now = await read().catch(() => null)
      const tap = now ? tapOf(now, shown.cut) : null
      if (now && tap) await say(tap, now)
    }
    return true
  } finally {
    await pending.close().catch(() => {})
  }
}
