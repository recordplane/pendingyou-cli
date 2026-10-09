// The two safety nets `pendingyou init` installs as Claude Code hooks (D34), for answers no hold was there to hear:
//
// - `pendingyou pickup` (SessionStart): a new or resumed session picks up answers that arrived while nothing was
//   running, for questions asked from this folder.
// - `pendingyou handoff` (UserPromptSubmit): your next message brings a waiting answer with it ("You answered in
//   Pending You: …"). While signed in, it also adds one short line (REMINDER) to every message, so an assistant
//   deep in a long conversation still puts what it needs from the person on a card, and that line names this folder's
//   cards still waiting on the person (openLine), so one they answer in chat gets cancelled with answeredHere. That's
//   one small request per message (the open cards and this folder's answers together), time-boxed short; on any
//   error, or from a server too old to list open cards, the line is the plain reminder. Until 0.10.0 it looked for
//   answers only while a hold had left an entry behind, so an answer to a card no hold ever waited on stayed unheard
//   until the next session (2026-10-04).
//
// Both also add one line when the session's pendingyou MCP server is another Pending You than the hooks' origin
// (environment.ts): its cards would go where these hooks, and maybe its person, don't look.
//
// Since 0.11.0 they run for any app's sessions (`--app`, Claude Code's when none): its own sign-in, and only its own
// cards (`source`). And a session start adds one line while Pending You says the app's setup isn't finished (setup.ts),
// from the same request. OpenCode has no session-start hook (0.12.0): its plugin runs `handoff` with each message, and
// with the session's first one names how it started (`source`: startup or resume), which adds what pickup would say.
// Pi's extension (0.12.0) runs both, with Pi's session in place of the hook's input.
//
// Whatever they print, Claude Code adds to the conversation. A hook must never get in the way: each is time-boxed,
// has a hard deadline (main.ts) after which it prints only its fallback, never refreshes the sign-in itself (api.ts),
// prints nothing when there's nothing new, never repeats an answer it handed over, and always exits 0.
//
// Since 0.14.0 they also hand over a question the person handed this assistant from another one (D21, Delegate), which
// Pending You brings to the folder of the task it went to: what it is, who asked, how its answer travels, their note,
// and to answer_delegated or hand_back. Only to one session (handed.ts): at once to a session that goes by the name it
// went to (or the one the listeners would wake), to any other session in the folder only after HANDED_GRACE_MS, and
// never to the session that asked, nor (a sign-in that only hears) one another computer's. It's claimed before it's
// printed, so no other session hears it too.
//
// Since 0.23.0 Claude Code's hooks also send the name the session goes by (from its transcript), so a question handed
// to the agent by that name comes whatever folder it went to: one handed by name to an agent whose session works in
// another folder never reached it. And the next-message hook tells a Claude Code session the wake mod doesn't run in,
// once, to have its person restart it (loaded.ts).
//
// Since 0.25.0 they hear only the session that asked (askerParams; 2026-10-06: "multiple Claudes getting
// messages and confusing them"). They asked for the folder's answers and open cards, and Pending You handed every one
// asked from that folder, or from any folder above it, to every session there: two sessions in one folder each heard the
// other's answers and listed the other's cards as theirs, and a card asked from `~` reached sessions in every folder on
// every computer. Now each says who it is: the cards the session posted (Claude Code's from its transcript, with
// whether that's all of them; the others' from what their hooks remember), the name it goes by, and this computer's
// names. Pending You hands it a card it posted, else one asked under its name, and only to a session that can say
// neither, one asked from that very folder on this computer under no agent's name of its own.
//
// Since 0.27.0 the next-message hook also says how to bring the app's pendingyou MCP server back while its headers
// helper last handed over a token that had run out (mcp-health.ts): Claude Code may have been refused it, and a
// session whose pendingyou tools fail should say so in chat rather than go quiet.
import { getJson, SignInNeeded, Unavailable } from './api.ts'
import {
  computerNames,
  hearsOnly,
  keepListening,
  markHandedTurn,
  sessionFor,
  threadCards,
  threadNames,
  touchThread,
} from './apps/codex-wake.ts'
import { APP_NAMES, type AppId, DEFAULT_APP } from './apps/ids.ts'
import { connectionMachine, readCredential } from './credentials.ts'
import { environmentWarning } from './environment.ts'
import { configDir, readJson } from './files.ts'
import {
  clip,
  type Delegated,
  delegatedOf,
  describe,
  HANDED_PREFIX,
  type Heard,
  isHandedWake,
} from './format.ts'
import { goesBy, HANDED_GRACE_MS, namesAnotherComputer } from './handed.ts'
import { herdrTarget, reportCommand } from './herdr.ts'
import { holdCommand } from './hold.ts'
import type { Io } from './io.ts'
import { linkSoon } from './link.ts'
import { unwokenLine } from './loaded.ts'
import { stuckLine } from './mcp-health.ts'
import {
  isPermissionCard,
  isPromptApp,
  POSTED_MAX,
  sessionName,
  sessionPosted,
  settlePrompts,
} from './permission.ts'
import { announce, keepPresent, readSaid, type Said } from './presence.ts'
import { setupReminder } from './setup.ts'
import { claimHanded, markHanded, momentOf, releaseHanded, wasHanded } from './state.ts'

/** Each request's own limit, inside the hook's 3-second deadline (main.ts). */
const TIME_BOX_MS = { pickup: 2500, handoff: 2000 }

/**
 * How many of a folder's answers it asks for (the server's most), and how many it hands over at once. The server sends
 * the newest; the ones already handed over are left out here, so it asks for more than it shows: asking for five, a
 * session with five newer answers it hadn't acknowledged yet never heard an older one (2026-10-06, CLI 0.20.1).
 */
export const ANSWERS_ASKED = 20
export const ANSWERS_SHOWN = 5

/** What a hook prints if it reaches its deadline (main.ts) before printing anything itself. */
export interface HookRun {
  fallback: string
}

/** What every message carries while signed in (about 18 tokens). */
export const REMINDER = 'Pending You: anything you need from your person also goes on a card.'
/**
 * What a hook says when it couldn't look for answers (0.26.0): Pending You unreachable, or the sign-in still being
 * refreshed at its deadline. The plain reminder alone hid it, so an answered card went unannounced (2026-10-06).
 */
export const UNCHECKED =
  "Pending You couldn't check for answers just now: call list_pending before you go on."
/** The most open cards the line names, and how much of each title. */
export const OPEN_SHOWN = 3
export const OPEN_TITLE = 50
/** How much of the asking session's name each card shows. */
export const OPEN_NAME = 24

interface Open {
  /** `name`: the session that asked it (servers from guide 2.5 on), which alone may cancel or change it. */
  requests: { requestId: string; title: string; name?: string }[]
  total: number
}

/**
 * The reminder, naming this folder's open cards still waiting on the person when there are any (about 45 tokens plus
 * 20 a card): `… Your open cards here: "Which DNS host?" (req_…); … +2 more. If this message answers …`.
 */
export function openLine(open: unknown): string {
  if (typeof open !== 'object' || open === null) return REMINDER
  const { requests, total } = open as Partial<Open>
  if (!Array.isArray(requests)) return REMINDER
  const valid = requests.filter(
    (card): card is Open['requests'][number] =>
      typeof card?.requestId === 'string' &&
      /^req_[A-Za-z0-9-]{1,40}$/.test(card.requestId) &&
      typeof card.title === 'string',
  )
  // A permission prompt's card is the hooks' own, and closes by itself (0.13.0, permission.ts): not the agent's to settle.
  const theirs = valid.filter((card) => !isPermissionCard(card.title))
  const cards = theirs.slice(0, OPEN_SHOWN)
  if (cards.length === 0) return REMINDER
  const waiting = typeof total === 'number' ? total - (valid.length - theirs.length) : 0
  const more = waiting > cards.length ? waiting - cards.length : 0
  const named = cards
    .map((card) => {
      const by =
        typeof card.name === 'string' && card.name.trim()
          ? `, by ${clip(card.name.replaceAll('"', "'"), OPEN_NAME).text}`
          : ''
      return `"${clip(card.title.replaceAll('"', "'"), OPEN_TITLE).text}" (${card.requestId}${by})`
    })
    .join('; ')
  return `${REMINDER} Your open cards here: ${named}${more ? ` +${more} more` : ''}. If this message answers or settles one of yours, cancel_request it with answeredHere and your name (or update_request if it changed).`
}

/**
 * What the agent tells a hook on stdin: the session's folder (or where this runs), how it started, and its id; and
 * (0.14.0) its transcript (Claude Code's, where the name it gave Pending You is), and the message and turn a
 * next-message hook runs for (Codex's, as its hooks give them).
 */
async function hookInput(io: Io): Promise<{
  cwd: string
  given: boolean
  source: string | null
  session: string | null
  transcript: string | null
  prompt: string | null
  turn: string | null
}> {
  const text = await io.readStdin(500).catch(() => '')
  let input: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) input = parsed
  } catch {}
  const string = (value: unknown) => (typeof value === 'string' && value ? value : null)
  return {
    cwd: string(input.cwd) ?? io.cwd,
    given: string(input.cwd) !== null,
    source: typeof input.source === 'string' ? input.source : null,
    session: typeof input.session_id === 'string' ? input.session_id : null,
    transcript: string(input.transcript_path),
    prompt: string(input.prompt),
    turn: string(input.turn_id),
  }
}

/**
 * Whether this session takes a question handed to the app's assistants now (handed.ts): never one another computer's
 * (`elsewhere`, for a sign-in that only hears); at once when it goes by the name it went to, or (Codex, OpenCode, Pi)
 * it's the session the listeners would wake; never when it's the one that asked; otherwise once the one it went to has
 * had HANDED_GRACE_MS to hear it.
 */
async function takesHanded(
  io: Io,
  context: {
    app: AppId
    session: string | null
    elsewhere: (heard: Heard) => Promise<boolean>
    names: () => Promise<string[]>
  },
  heard: Heard,
  delegated: Delegated,
): Promise<boolean> {
  if (await context.elsewhere(heard)) return false
  const names = await context.names()
  if (goesBy(names, heard.sessionLabel)) return true
  if (goesBy(names, delegated.from)) return false
  const waited = io.now() - Date.parse(heard.changedAt)
  if (context.app !== DEFAULT_APP && context.session) {
    const chosen = await sessionFor(io, context.app, heard)
    // None the listeners could wake: this one, now.
    if (chosen === null || chosen === context.session) return true
  }
  return !(waited < HANDED_GRACE_MS)
}

/** The first line of what a hook hands over: answers, handed questions, or both. */
function headerOf(starts: boolean, answers: number, handed: number): string {
  const when = starts ? 'while no session was listening' : 'since your last turn'
  const questions =
    handed === 1 ? 'a question from another assistant' : `${handed} questions from other assistants`
  if (handed === 0)
    return starts
      ? 'Pending You: your person answered while no session was listening.'
      : 'Pending You: your person answered in Pending You since your last turn.'
  if (answers === 0) return `${HANDED_PREFIX} ${questions} ${when}.`
  return `Pending You: your person answered, and handed you ${questions}, ${when}.`
}

/** The last line of what a hook hands over: what to tell the person first. */
function closingOf(answers: number, handed: readonly Delegated[]): string {
  const said = [
    ...(answers ? ['“You answered in Pending You: …”'] : []),
    ...(handed[0] ? [`“You handed me a question from ${clip(handed[0].from, 60).text}: …”`] : []),
  ]
  return `Tell them in one line first (${said.join('; ')}), then act.`
}

/** When init last set an app up (its manifest's `setup.since`), for the session start's setup reminder. */
async function setupSince(io: Io, app: AppId): Promise<string | null> {
  const manifest = await readJson<{ setup?: { since?: unknown } }>(
    `${configDir(io)}/${app}.json`,
  ).catch(() => null)
  return typeof manifest?.setup?.since === 'string' ? manifest.setup.since : null
}

/** The folder as sessions may have reported it: as it is, and under ~. */
export function folderForms(cwd: string, home: string): string[] {
  const forms = [cwd]
  const base = home.replace(/\/+$/, '')
  if (base && (cwd === base || cwd.startsWith(`${base}/`))) forms.push(`~${cwd.slice(base.length)}`)
  return forms
}

/**
 * Who the session asking for its folder's answers is (0.25.0), as /mcp/cli/answers takes it: the cards it posted
 * (`posted`), `own` when that's every one (Claude Code's whole transcript was read), the name it goes by, and this
 * computer's names (`machine`). Pending You hands it only its own; only a session that can say none of it falls back to
 * its folder, on this computer, for a card asked under its app's name.
 */
export async function askerParams(
  io: Io,
  origin: string,
  app: AppId,
  session: { id: string | null; transcript: string | null; name?: string | null },
): Promise<[string, string][]> {
  let name = session.name ?? undefined
  let posted: string[] = []
  let own = false
  if (app === DEFAULT_APP) {
    const record = await sessionPosted(session.transcript ?? undefined)
    if (record) {
      posted = record.posted
      own = record.whole
    }
  } else if (session.id) {
    name ??= (await threadNames(io, app, session.id).catch(() => [])).at(-1)
    posted = (await threadCards(io, app, session.id).catch(() => [])).slice(0, POSTED_MAX)
  }
  const machine = await connectionMachine(io, origin, app).catch(() => null)
  const machines = [...new Set([io.host, machine].filter((each): each is string => Boolean(each)))]
  return [
    ...(name ? [['name', name] as [string, string]] : []),
    ...posted.map((id) => ['posted', id] as [string, string]),
    ...(own ? [['own', '1'] as [string, string]] : []),
    ...machines.slice(0, 4).map((each) => ['machine', each] as [string, string]),
  ]
}

export async function pickup(
  io: Io,
  options: { origin: string; mode: 'pickup' | 'handoff'; app?: AppId },
  hook: HookRun = { fallback: '' },
): Promise<number> {
  const { origin, mode } = options
  const app = options.app ?? DEFAULT_APP
  // The hand-off's line, printed at the end unless something else was printed with it.
  let line: string | null = null
  // Said by either hook, signed in or not, when the session's MCP server is another Pending You (environment.ts).
  let warning: string | null = null
  // A session start's line while the app's setup isn't finished (setup.ts).
  let reminder: string | null = null
  // The next message's line, once, for a Claude Code session the wake mod doesn't run in (0.23.0, loaded.ts).
  let unwoken: string | null = null
  // The next message's line while the app's pendingyou MCP server may be stuck: its helper last handed over a token that
  // had run out (0.27.0, mcp-health.ts).
  let stuck: string | null = null
  try {
    const input = await hookInput(io)
    const { cwd } = input
    // This computer's sign-ins linked to it by its key, every few hours, in the background (0.29.0, link.ts).
    await linkSoon(io, origin)
    // The person wrote: whatever Claude Code (0.13.0) or Codex (0.15.0) asked their OK for there is answered
    // (permission.ts).
    if (mode === 'handoff' && isPromptApp(app))
      await settlePrompts(io, { session: input.session, event: 'prompt' })
    // What this computer knew of the session before this message's own presence (0.23.0, loaded.ts).
    const known =
      mode === 'handoff' && app === DEFAULT_APP && input.session
        ? (await readSaid(io, app).catch(() => ({}) as Record<string, Said>))[input.session]
        : undefined
    // Presence (0.15.0, presence.ts), started in the background: Claude Code's session start says live (and, for a
    // Claude Code without the wake mod, its messages now and then); a Codex thread gets its keeper.
    if (app === 'codex') await keepPresent(io, origin, input.session, input.given ? cwd : null)
    else if (app === DEFAULT_APP && (mode === 'pickup' || input.session))
      await announce(io, origin, app, {
        state: 'live',
        session: input.session,
        cwd: input.given ? cwd : null,
        transcript: input.transcript,
        again: mode === 'handoff',
      })
    // Herdr (0.17.0, herdr.ts): a Claude Code session starting in a Herdr pane names itself there, in the background
    // (the name from its transcript, when it gave one); the wake mod writes its cards.
    if (app === DEFAULT_APP && mode === 'pickup' && input.session && (await herdrTarget(io)))
      io.background(
        reportCommand(app, {
          session: input.session,
          transcript: input.transcript,
          at: io.now(),
        }),
      )
    warning = await environmentWarning(io, cwd, origin, app)
    if (warning) hook.fallback = `${warning}\n`
    // The hand-off asks for this folder's answers and its open cards in one request, whether or not a hold ran.
    if (mode === 'handoff') {
      if ((await readCredential(io, origin, app)) === null) return 0
      line = REMINDER
      hook.fallback = `${[REMINDER, warning].filter(Boolean).join('\n')}\n`
      if (app === DEFAULT_APP) unwoken = await unwokenLine(io, origin, input.session, known)
      stuck = await stuckLine(io, origin, app)
    }
    if (app !== DEFAULT_APP && input.session) {
      // The session is active now, in this folder: the one a question handed to its app most likely goes to (0.14.0).
      await touchThread(io, app, input.session, input.given ? input.cwd : null)
      // A turn that starts with a question the person handed it isn't asked to put its words on a card of its own.
      if (app === 'codex' && input.turn && isHandedWake(input.prompt ?? ''))
        await markHandedTurn(io, input.turn, app).catch(() => {})
    }
    // A Codex thread whose cards still wait on the person is woken when they answer (apps/codex-wake.ts), and one that
    // may be handed a question when it is.
    if (app === 'codex' && input.session) await keepListening(io, origin, input.session)
    // Claude Code's name, from its transcript (0.23.0): a question handed to its agent by that name comes from any
    // folder. Read once, and used again below.
    const claudeNames =
      app === DEFAULT_APP
        ? sessionName(input.transcript ?? undefined).then((name) => (name ? [name] : []))
        : null
    const named = claudeNames ? (await claudeNames)[0] : undefined
    const query = new URLSearchParams([
      ...folderForms(cwd, io.home).map((form) => ['cwd', form] as [string, string]),
      ['limit', String(ANSWERS_ASKED)],
      ...(mode === 'handoff' ? [['open', String(OPEN_SHOWN)] as [string, string]] : []),
      ['source', app],
      // Only this session's own answers and open cards (0.25.0).
      ...(await askerParams(io, origin, app, {
        id: input.session,
        transcript: input.transcript,
        name: named ?? null,
      })),
    ])
    const { status, body } = await getJson<{
      ok?: boolean
      requests?: Heard[]
      open?: unknown
      for?: unknown
    }>(io, origin, `/mcp/cli/answers?${query}`, TIME_BOX_MS[mode], io.signal, {
      hook: true,
      patient: true,
      app,
    })
    if (status !== 200) return 0
    if (mode === 'handoff') line = openLine(body.open)
    // A session start, or (OpenCode's plugin) a session's first message, which says how the session started.
    const starts = mode === 'pickup' || input.source !== null
    if (starts)
      reminder = await setupReminder(io, {
        origin,
        app,
        source: input.source,
        since: await setupSince(io, app),
        heard: body.for,
      })
    if (!Array.isArray(body.requests)) return 0
    const fresh: Heard[] = []
    const handed: { heard: Heard; delegated: Delegated }[] = []
    // This session's names, and whether this sign-in hears other computers' (and this computer's names), read once and
    // only when a question was handed to the app (0.14.0): Claude Code's names from its transcript, the others' from
    // what their hooks remember. No Tailscale here: it could take a second of the hook's three.
    let names: Promise<string[]> | null = null
    let others: Promise<string[] | null> | null = null
    const context = {
      app,
      session: input.session,
      elsewhere: async (heard: Heard) => {
        others ??= hearsOnly(io, origin, app).then((only) =>
          only ? computerNames(io, origin, { tailscale: false }) : null,
        )
        const computers = await others
        return computers !== null && namesAnotherComputer(heard.machine, computers)
      },
      names: () => {
        names ??= claudeNames ?? threadNames(io, app, input.session)
        return names
      },
    }
    // The message this hook runs for is a wake for handed questions (the wake mod's prompt, `codex queue`'s message):
    // those it names are this session's already, so they're claimed for it and not said twice.
    const woke = isHandedWake(input.prompt ?? '') ? input.prompt : null
    const told: Heard[] = []
    for (const heard of body.requests) {
      if (isPermissionCard(heard.title)) continue
      const delegated = delegatedOf(heard)
      if (await wasHanded(io, origin, heard.requestId, momentOf(heard))) continue
      // The newest first; the rest wait for the next message, not handed over yet.
      if (!delegated) {
        if (fresh.length < ANSWERS_SHOWN) fresh.push(heard)
      } else if (woke?.includes(`(${heard.requestId})`)) told.push(heard)
      else if (await takesHanded(io, context, heard, delegated)) handed.push({ heard, delegated })
    }
    for (const heard of told) await claimHanded(io, origin, heard.requestId, momentOf(heard))
    // A handed question goes to one session: claimed before it's printed, and given back if it can't be.
    const claimed: typeof handed = []
    for (const each of handed)
      if (await claimHanded(io, origin, each.heard.requestId, momentOf(each.heard)))
        claimed.push(each)
    if (fresh.length === 0 && claimed.length === 0) return 0
    if (io.signal.aborted) {
      for (const { heard } of claimed)
        await releaseHanded(io, origin, heard.requestId, momentOf(heard)).catch(() => {})
      return 0
    }
    // Claude Code without the wake mod waits on a hold; a Codex thread, or an OpenCode or Pi session, is woken by its
    // listener.
    const again = (id: string) =>
      app === DEFAULT_APP
        ? `run \`${holdCommand(id, origin)}\` in the background`
        : `carry on: Pending You wakes this ${app === 'codex' ? 'thread' : 'session'} when they write back`
    // One write, the line included: at the deadline a hook has printed all of this or none of it. Printed before it's
    // marked as handed over, so a hook cut off in between repeats an answer rather than losing it.
    io.out(
      `${[
        headerOf(starts, fresh.length, claimed.length),
        '',
        ...[...fresh, ...claimed.map(({ heard }) => heard)].flatMap((heard) => [
          ...describe(heard, again(heard.requestId)),
          '',
        ]),
        closingOf(
          fresh.length,
          claimed.map(({ delegated }) => delegated),
        ),
        ...(line ? [line] : []),
        ...(warning ? [warning] : []),
        ...(reminder ? [reminder] : []),
        ...(unwoken ? [unwoken] : []),
        ...(stuck ? [stuck] : []),
      ].join('\n')}\n`,
    )
    line = null
    warning = null
    reminder = null
    unwoken = null
    stuck = null
    await markHanded(
      io,
      origin,
      fresh.map((heard) => ({ requestId: heard.requestId, moment: momentOf(heard) })),
    )
    return 0
  } catch (error) {
    if (mode === 'pickup' && error instanceof SignInNeeded && error.ended)
      io.out(
        `Pending You: this computer’s pendingyou sign-in has ended, so answers can’t wake ${APP_NAMES[app]}. Ask your person to run \`npx pendingyou login${app === DEFAULT_APP ? '' : ` --app ${app}`}\`.\n`,
      )
    if (error instanceof SignInNeeded) line = null
    // Never silent (0.26.0): the session looks for itself.
    if (error instanceof Unavailable) line = [line, UNCHECKED].filter(Boolean).join('\n')
    return 0
  } finally {
    const last = [line, warning, reminder, unwoken, stuck].filter(Boolean)
    if (last.length) io.out(`${last.join('\n')}\n`)
  }
}
