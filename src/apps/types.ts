// What every app module (claude-code.ts, codex.ts, and the follow-ups' opencode.ts and pi.ts) gives `pendingyou init`,
// `status` and `uninstall` (0.11.0). The core (main.ts) finds the apps on this computer, asks each what it needs before
// anyone signs in, signs them all in with one approval, puts the shared parts in place (the private copy, the hooks'
// shim, the headers helper), then has each set itself up. docs/apps.md says the same for whoever adds an app.
import type { Installed } from '../install.ts'
import type { Io } from '../io.ts'
import type { AppId } from './ids.ts'

/** One thing init (or uninstall) did, or couldn't: `ok` false prints `check` and makes the exit code 1. */
export interface Step {
  ok: boolean
  text: string
}

/** What `detect` found: the app's version, as `<command> --version` says it. */
export interface Detected {
  version: string
  /**
   * The program to run for it when it isn't the command on PATH: the Codex app's own codex, by its full path (0.13.0,
   * codex-app.ts).
   */
  command?: string
  /** Where it was found, when that isn't PATH, as init names it: "the Codex app's". */
  from?: string
}

/** What every app is told: the Pending You it's for, and how init was asked to run. */
export interface AppContext {
  origin: string
  /** `--yes`: switch or replace a pendingyou MCP server without asking. */
  yes: boolean
  /** `--oauth`: the app's MCP server signs in by itself (the app's own OAuth), as before 0.11.0. */
  oauth: boolean
  /** Why this computer counts as having no browser (an SSH session, Linux with no display); null when it has one. */
  headless: string | null
  /**
   * `--permission-cards` (true) or `--no-permission-cards` (false), 0.13.0: Claude Code's permission prompts on a card.
   * Left out: as the person chose before.
   */
  permissionCards?: boolean
  /** Said as it happens: "Adding the pendingyou MCP server to Claude Code (this can take a minute)…". */
  progress(text: string): void
}

/**
 * The sign-in an app's hooks (and, through the helper, its MCP server) use, one per app per computer:
 * - `connection`: the app's own connection on Pending You ("Codex on build-01"), from a device sign-in; its MCP server
 *   signs in through the headers helper, and its hooks hear its cards with the same grant.
 * - `hear`: a sign-in that only hears answers, for an app whose MCP server signs in by itself (OAuth): the hooks need
 *   one to hear its cards.
 */
export type SignInKind = 'connection' | 'hear'

/** What init does for one app once everyone has signed in: its MCP server, skill, hooks and anything of its own. */
export interface InstallContext extends AppContext {
  /** Each step, printed as it's done. */
  report(step: Step): void
  /** The private copy of this version the hooks and the helper run; null when it couldn't be made. */
  copy: Installed | null
  /** A hook's command line for this app: `"<config>/bin/pendingyou-hook" <sub> --app <id> || true`. */
  hookLine(sub: string): string
  /** The headers helper's command line for this app's MCP server; null when there's none (no private copy). */
  helper: string | null
  /**
   * What this app's MCP server runs to reach Pending You through the stdio bridge (0.12.0, bridge.ts), as a program and
   * its arguments: `["<config>/bin/pendingyou-mcp", "--app", "<id>"]`, with `--origin` off production. Null when the
   * app didn't ask for it (`Prepared.bridged`) or there's no private copy for the launcher to run.
   */
  bridge: string[] | null
  /** Whether the app's sign-in is in place now (signed in, or already was); false after --no-login or a refusal. */
  signedIn: boolean
}

/** What an app's section of `pendingyou status` says, and whether it hears answers right away. */
export interface AppStatus {
  /** The section's lines, header first: `Pending You for Codex · https://www.pendingyou.com`. */
  lines: string[]
  /** Everything it needs is there: the exit code is 0 only when every app's is. */
  ready: boolean
}

/** What a status check is told: the app's sign-in, as Pending You answered for it (one request per app). */
export interface StatusContext {
  origin: string
  /** `ok` with `for` (the connection it hears for) and, from servers with setup state, how setup stands. */
  signIn: SignInCheck
}

/** How a setup stands on Pending You (hear_answers' `for.setup`), when the server says. */
export interface SetupState {
  reported: boolean
  verified: boolean
  /** The test question the setup sent: whose turn it is, and the name of the session that asked it. */
  test?: { requestId: string; turn: 'you' | 'agent'; name?: string }
}

/** The connection a sign-in hears for, as Pending You keeps it: "Codex" on "build-01". */
export interface HeardFor {
  name: string
  source?: string
  machine?: string
  /** The key Pending You knows its computer by (0.18.0): its RFC 7638 thumbprint, when it knows one. */
  machineKey?: string
  setup?: SetupState
}

export type SignInCheck =
  | { state: 'ok'; connections: number; for?: HeardFor }
  | { state: 'none' | 'ended' | 'unreachable' }

/**
 * What the person does next, once init has set an app up: init's last lines. The sentence they say to the app
 * (setup.ts's FINISH_SAY) ends them, on a line of its own, ready to copy.
 */
export interface NextStep {
  /** The lines when it's the only app init set up, the sentence included when it needs one. */
  lines: string[]
  /** One line among several apps' ("- Codex: start codex here…"), before the sentence they share. */
  together: string
  /** Whether the person may need to say the sentence to it (always for Codex; a fallback for Claude Code). */
  say: boolean
}

/**
 * An app, decided on before anyone signs in (prepare): how its MCP server will sign in, and what init does there.
 * `signIn` null leaves the app as it is: `skipped` says why (the person kept a server at another Pending You), and
 * whether that's a problem (`ok` false makes init's exit code 1).
 */
export interface Prepared {
  app: AppModule
  detected: Detected
  signIn: SignInKind | null
  skipped?: Step
  /**
   * Its MCP server runs the stdio bridge (`pendingyou mcp`, 0.12.0) with its `connection`: init writes the bridge's
   * launcher and hands `install` its command (`InstallContext.bridge`).
   */
  bridged?: boolean
  /** Sets it up: idempotent, each step reported as it's done. Runs after the sign-in. */
  install(ctx: InstallContext): Promise<Step[]>
  /**
   * What to do next; null when there's nothing to start (it isn't set up, or nothing changed that needs it). Asked
   * after any wait for its hooks' trust (trust.ts), so it can say what's left.
   */
  next(ctx: InstallContext, steps: readonly Step[]): NextStep | null | Promise<NextStep | null>
}

/** Hooks an app runs only once the person trusts them in the app itself (Codex, 0.22.0, trust.ts). */
export interface HookTrust {
  /** How to trust them: what to run, and what to do there. */
  lines: string[]
  /** Whether every one of them is trusted now (or turned off by the person). */
  trusted(): Promise<boolean>
}

export interface AppModule {
  id: AppId
  /** As people know it: "Claude Code". */
  name: string
  /** The oldest version init sets up ("2.1.0"); an older one is named, and skipped. */
  minVersion: string
  /** Whether it's installed here (its command answers `--version`), and which version; null when it isn't. */
  detect(io: Io): Promise<Detected | null>
  /**
   * Everything decided before signing in, so a question never comes after an approval and Cancel changes nothing:
   * which sign-in it needs, and what happens to a pendingyou MCP server that's there (kept, switched, replaced). Asks
   * the person at a terminal; `--yes` decides without asking; with nobody to ask, it keeps what's there and says how
   * to switch.
   */
  prepare(io: Io, ctx: AppContext, detected: Detected): Promise<Prepared>
  /** Whether init set it up here before: it has a manifest (~/.config/pendingyou/<id>.json). */
  installed(io: Io): Promise<boolean>
  /** What's set up and what's missing, each with the command that fixes it. */
  status(io: Io, ctx: StatusContext): Promise<AppStatus>
  /** Removes exactly what init added (its manifest says what). The sign-in is the core's to end. */
  uninstall(io: Io, ctx: AppContext): Promise<Step[]>
  /** Whether its MCP server signs in through this computer's own sign-in (the helper) for `origin`. */
  usesHelper(io: Io, origin: string): Promise<boolean>
  /**
   * Hooks of its own installed here that it won't run until the person trusts them in the app, and how to (0.22.0,
   * trust.ts); null when there are none. Read only: trust is the person's to give.
   */
  untrustedHooks?(io: Io): Promise<HookTrust | null>
}
