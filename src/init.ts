// `pendingyou init`, `status` and `uninstall` across every app (0.11.0). `npx -y pendingyou@latest init` is the one
// setup for terminal agents: it finds the apps on this computer (or the ones `--app` names), decides for each what to do
// with what's there before anyone signs in, signs them all in with one approval (signin.ts), puts the shared parts in
// place (this version's private copy, the hooks' shim, the headers helper), then has each app set itself up (its module
// in apps/). It ends with what to do next: restart the app, which finishes setting up by itself (setup.ts), and the
// sentence to say to it when it doesn't.
//
// This computer's key (0.18.0, machine.ts): init makes it the first time, every sign-in it starts proves it, and each
// connection already signed in proves it with its own sign-in (POST /mcp/cli/machine), with nothing to approve. So a
// computer set up before 0.18.0 gets its key on its next init; its assistants' sign-ins stay exactly as they were.
import { APP_IDS, type AppId, DEFAULT_APP, namesOf } from './apps/ids.ts'
import { APPS, appModule, atLeast } from './apps/registry.ts'
import type {
  AppContext,
  AppModule,
  Detected,
  InstallContext,
  NextStep,
  Prepared,
  Step,
} from './apps/types.ts'
import { bridgeCommand, removeBridge, writeBridge } from './bridge.ts'
import { hookCommand } from './claude.ts'
import { readCredential, saveConnectionClient } from './credentials.ts'
import { hookLine, originArgs } from './hooks.ts'
import { type Installed, installCli, pruneCli, removeCli } from './install.ts'
import type { Io } from './io.ts'
import { linkClients } from './link.ts'
import { keyForSignIn, proveConnections } from './machine.ts'
import { headlessReason, helperCommand, removeHelper, writeHelper } from './remote.ts'
import { FINISH_SAY } from './setup.ts'
import { removeShim, shimPath, writeShim } from './shim.ts'
import { checkSignIn, logout, type SignedIn, signInApps, titleFrom, titleHere } from './signin.ts'
import { markLinked } from './state.ts'
import { trustHooks } from './trust.ts'
import { VERSION } from './version.ts'

/** Each step as init prints it: `ok` or `check`, then what happened. */
const line = (step: Step) => `  ${step.ok ? 'ok     ' : 'check  '} ${step.text}\n`

/** The apps on this computer init can set up (or the ones asked for), and why any other was left out. */
async function findApps(
  io: Io,
  wanted: readonly AppId[] | undefined,
): Promise<{ found: { app: AppModule; detected: Detected }[]; problems: string[] }> {
  const found: { app: AppModule; detected: Detected }[] = []
  const problems: string[] = []
  for (const app of APPS) {
    if (wanted && !wanted.includes(app.id)) continue
    const detected = await app.detect(io)
    if (!detected) {
      if (wanted)
        problems.push(`${app.name} isn’t on this computer’s PATH. Install it, then run init again.`)
      continue
    }
    if (/^\d+\.\d+/.test(detected.version) && !atLeast(detected.version, app.minVersion)) {
      problems.push(
        `Found ${app.name} ${detected.version}, but Pending You needs ${app.minVersion} or later. Update it, then run init again.`,
      )
      continue
    }
    found.push({ app, detected })
  }
  return { found, problems }
}

export interface InitOptions {
  origin: string
  login: boolean
  browser: boolean
  device: boolean | null
  yes: boolean
  machine?: string
  oauth?: boolean
  apps?: AppId[]
  permissionCards?: boolean
}

/**
 * The shared parts every app's hooks and MCP server use: this version's private copy, the shim, the helper (for an app
 * whose MCP server signs in through it) and the stdio bridge's launcher (for one that runs the bridge).
 */
async function installShared(
  io: Io,
  helped: boolean,
  bridged: boolean,
  report: (step: Step) => void,
): Promise<{ copy: Installed | null; helper: boolean; bridge: boolean }> {
  let copy: Installed | null = null
  // The hooks' own copy of this version, unless PENDINGYOU_SELF says what they run.
  if (!io.env.PENDINGYOU_SELF) {
    const cli = await installCli(io, (text) => io.out(text))
    copy = cli.installed
    report(
      cli.installed
        ? {
            ok: true,
            text: `${cli.installed.how === 'kept' ? `pendingyou ${VERSION} for the hooks was already in` : `Installed pendingyou ${VERSION} for the hooks in`} ${cli.installed.prefix} (they run it with ${cli.installed.node}, no npx).`,
          }
        : {
            ok: !helped,
            text: `Couldn’t install pendingyou for the hooks (${cli.error}), so they run it through npx, which is slower. Run init again to retry.`,
          },
    )
  }
  if (io.platform !== 'win32') {
    const shim = await writeShim(
      io,
      copy
        ? copy
        : io.env.PENDINGYOU_SELF
          ? { self: io.env.PENDINGYOU_SELF }
          : { npx: `npx -y --prefer-offline pendingyou@${VERSION}` },
    ).catch(() => null)
    if (!shim)
      report({
        ok: false,
        text: `Couldn’t write the hooks’ shim to ${shimPath(io)}. Run init again.`,
      })
  }
  if (!copy) return { copy, helper: false, bridge: false }
  let helper = false
  if (helped) {
    const written = await writeHelper(io, copy).catch(() => null)
    helper = written !== null
    report(
      written
        ? {
            ok: true,
            text: written.changed
              ? `Saved the sign-in helper your agents’ MCP servers sign in through: ${written.path}.`
              : 'The sign-in helper was already in place.',
          }
        : {
            ok: false,
            text: 'Couldn’t write the sign-in helper your agents’ MCP servers sign in through. Run init again.',
          },
    )
  }
  let bridge = false
  if (bridged) {
    const written = await writeBridge(io, copy).catch(() => null)
    bridge = written !== null
    report(
      written
        ? {
            ok: true,
            text: written.changed
              ? `Saved the bridge your agents’ MCP servers reach Pending You through: ${written.path}.`
              : 'The bridge was already in place.',
          }
        : {
            ok: false,
            text: 'Couldn’t write the bridge your agents’ MCP servers reach Pending You through. Run init again.',
          },
    )
  }
  return { copy, helper, bridge }
}

/** init's last lines: one app's own, or a line each and the sentence they share. */
function closing(steps: readonly NextStep[]): string[] {
  const [only] = steps
  if (!only) return []
  if (steps.length === 1) return only.lines
  return [
    'Next:',
    ...steps.map((step) => step.together),
    ...(steps.some((step) => step.say) ? ['', FINISH_SAY] : []),
  ]
}

export async function init(io: Io, options: InitOptions): Promise<number> {
  const flag = originArgs(options.origin)
  const { found, problems } = await findApps(io, options.apps)
  // Asked for by name and not here: nothing is signed in or changed.
  if (options.apps && problems.length) {
    for (const problem of problems) io.out(`${problem}\n`)
    return 1
  }
  if (found.length === 0) {
    for (const problem of problems) io.out(`${problem}\n`)
    io.out(
      `Didn’t find ${namesOf([...APP_IDS], 'or')} on this computer’s PATH. Install one, then run: npx -y pendingyou@latest init${flag}\n`,
    )
    return 1
  }
  const versions = found.map(
    ({ app, detected }) =>
      `${app.name} ${detected.version}${detected.from ? ` (${detected.from})` : ''}`,
  )
  io.out(
    `Setting up Pending You (${options.origin}) for ${versions.length > 1 ? `${versions.slice(0, -1).join(', ')} and ${versions.at(-1)}` : versions[0]}.\n`,
  )
  for (const problem of problems) io.out(`${problem}\n`)
  const ctx: AppContext = {
    origin: options.origin,
    yes: options.yes,
    oauth: Boolean(options.oauth),
    headless: headlessReason(io),
    progress: (text) => io.out(text),
    ...(options.permissionCards === undefined ? {} : { permissionCards: options.permissionCards }),
  }
  // Everything decided before anyone signs in: Cancel then changes nothing.
  const prepared: Prepared[] = []
  for (const { app, detected } of found) prepared.push(await app.prepare(io, ctx, detected))
  for (const each of prepared) if (each.skipped) io.out(line(each.skipped))
  const going = prepared.filter((each) => each.signIn !== null)
  if (going.length === 0) return 1

  let signed = new Map<AppId, SignedIn>()
  if (options.login) {
    if (ctx.headless && !options.device)
      io.out(`No browser here (${ctx.headless}), so you approve with a code on your phone.\n`)
    // This computer's key: made the first time, and proven by every sign-in below.
    const key = await keyForSignIn(io)
    signed = await signInApps(
      io,
      going.map((each) => ({ app: each.app.id, kind: each.signIn as 'connection' | 'hear' })),
      {
        origin: options.origin,
        device: options.device,
        browser: options.browser,
        ...(options.machine ? { machine: options.machine } : {}),
        key,
      },
    )
    // The connections that were signed in already prove it with their own sign-ins: nothing to approve. Quiet; what
    // doesn't go through waits for the next init.
    if (key) {
      await proveConnections(
        io,
        options.origin,
        [...signed].flatMap(([app, how]) => (how === 'already' ? [app] : [])),
        key,
      )
      // The apps' own sign-ins here (0.29.0, link.ts): Claude Code's /mcp Authenticate, the plugin's server.
      const linked = await linkClients(io, options.origin, key)
      await markLinked(io, options.origin).catch(() => {})
      if (linked.joined)
        io.out(
          `Linked ${linked.joined === 1 ? 'a sign-in' : `${linked.joined} sign-ins`} your apps made on this computer to it, so Pending You names them by this computer.\n`,
        )
    }
  } else
    io.out(
      going.length === 1
        ? `Skipped signing in. Run npx pendingyou login${going[0]?.app.id === DEFAULT_APP ? '' : ` --app ${going[0]?.app.id}`}${flag} when you’re ready.\n`
        : `Skipped signing in. Run npx -y pendingyou@latest init${flag} again when you’re ready: one approval signs them all in.\n`,
    )
  // An app whose sign-in someone cancelled isn't set up.
  const setUp = going.filter((each) => {
    const how = signed.get(each.app.id)
    return how !== 'denied' && how !== 'failed'
  })
  if (setUp.length === 0) return 1

  const steps: Step[] = []
  const report = (step: Step) => {
    steps.push(step)
    io.out(line(step))
  }
  // The helper for an app whose MCP server signs in through it; the bridge for one that runs it instead.
  const helped = setUp.some((each) => each.signIn === 'connection' && !each.bridged)
  const bridged = setUp.some((each) => each.bridged)
  const shared = await installShared(io, helped, bridged, report)
  const installed: { each: Prepared; ictx: InstallContext; done: Step[] }[] = []
  for (const each of setUp) {
    if (setUp.length > 1) io.out(`${each.app.name}:\n`)
    const how = signed.get(each.app.id)
    const ictx: InstallContext = {
      ...ctx,
      report,
      copy: shared.copy,
      hookLine: (sub) =>
        io.platform === 'win32'
          ? hookCommand(io, options.origin, sub, shared.copy)
          : hookLine(shimPath(io), options.origin, each.app.id, sub),
      helper: shared.helper ? helperCommand(io, options.origin, each.app.id) : null,
      bridge: shared.bridge && each.bridged ? bridgeCommand(io, options.origin, each.app.id) : null,
      signedIn: how === 'signed-in' || how === 'already',
    }
    installed.push({ each, ictx, done: await each.install(ictx) })
  }
  // The hooks run this version now (or npx), unless an app set up before wasn't set up again this time: its hooks may
  // still run an older copy, which stays until init sets it up again.
  const others = await Promise.all(
    APPS.filter((app) => !setUp.some((each) => each.app.id === app.id)).map((app) =>
      app.installed(io),
    ),
  )
  if (!io.env.PENDINGYOU_SELF && !others.some(Boolean))
    await pruneCli(io, shared.copy?.version ?? null)
  // Hooks the app runs only once they're trusted there (Codex): how, and the wait for it, before what comes next.
  for (const { each } of installed) await trustHooks(io, each.app, options.origin)
  const nexts: NextStep[] = []
  for (const { each, ictx, done } of installed) {
    const next = await each.next(ictx, done)
    if (next) nexts.push(next)
  }
  const last = closing(nexts)
  if (last.length) io.out(`${last.join('\n')}\n`)
  return steps.every((step) => step.ok) && prepared.every((each) => each.skipped?.ok !== false)
    ? 0
    : 1
}

/**
 * The apps `status` covers: the ones named, else every one init set up, else the ones on this computer (Claude Code
 * when there are none either).
 */
async function coveredApps(io: Io, wanted: readonly AppId[] | undefined): Promise<AppModule[]> {
  if (wanted) return wanted.map(appModule)
  const installed: AppModule[] = []
  for (const app of APPS) if (await app.installed(io)) installed.push(app)
  if (installed.length) return installed
  const found: AppModule[] = []
  for (const app of APPS) if (await app.detect(io)) found.push(app)
  return found.length ? found : [appModule(DEFAULT_APP)]
}

/** `pendingyou status`: each app's section; exit 0 only when every one hears answers right away. */
export async function status(io: Io, options: { origin: string; apps?: AppId[] }): Promise<number> {
  const apps = await coveredApps(io, options.apps)
  const ready: boolean[] = []
  const sections: string[] = []
  for (const app of apps) {
    const signIn = await checkSignIn(io, options.origin, app.id)
    const section = await app.status(io, { origin: options.origin, signIn })
    ready.push(section.ready)
    sections.push(section.lines.join('\n'))
  }
  io.out(`${sections.join('\n\n')}\n`)
  // Hooks waiting for the person's trust (Codex): how, and the wait; then whether that app is ready.
  for (const [at, app] of apps.entries()) {
    const after = await trustHooks(io, app, options.origin)
    if (after) ready[at] = after.ready
  }
  return ready.every(Boolean) ? 0 : 1
}

/**
 * `pendingyou uninstall`: what init added for each app (every one set up, or the ones named), and its sign-in; the
 * shared parts once no app is left set up. A connection outlives its sign-in on Pending You's side: only the person
 * removes it, so it says where.
 */
export async function uninstall(
  io: Io,
  options: { origin: string; apps?: AppId[] },
): Promise<number> {
  // Claude Code's settings may hold hooks from before manifests: its uninstall always looks.
  const installed: AppModule[] = []
  for (const app of APPS)
    if (app.id !== DEFAULT_APP && (await app.installed(io))) installed.push(app)
  const apps = options.apps ? options.apps.map(appModule) : [appModule(DEFAULT_APP), ...installed]
  const ctx: AppContext = {
    origin: options.origin,
    yes: false,
    oauth: false,
    headless: headlessReason(io),
    progress: (text) => io.out(text),
  }
  let ok = true
  const after: string[] = []
  for (const app of apps) {
    if (apps.length > 1) io.out(`${app.name}:\n`)
    const credential = await readCredential(io, options.origin, app.id)
    const title = titleFrom(
      credential?.kind === 'connection'
        ? await checkSignIn(io, options.origin, app.id)
        : { state: 'none' },
      await titleHere(io, options.origin, app.id),
    )
    const steps = await app.uninstall(io, ctx)
    for (const step of steps) io.out(line(step))
    ok &&= steps.every((step) => step.ok)
    if (credential) await logout(io, { origin: options.origin, all: false, app: app.id })
    await saveConnectionClient(io, options.origin, null, undefined, app.id)
    if (credential?.kind === 'connection')
      after.push(
        `${title} is still on your Assistants page (${options.origin}/app/assistants): remove it there if you won’t use it again.`,
      )
  }
  // The shared parts go once nothing uses them.
  const left = await Promise.all(APPS.map((app) => app.installed(io)))
  if (!left.some(Boolean)) {
    if (await removeCli(io))
      io.out(line({ ok: true, text: 'Removed the hooks’ copy of pendingyou.' }))
    if (await removeHelper(io))
      io.out(line({ ok: true, text: 'Removed this computer’s sign-in helper.' }))
    if (await removeBridge(io))
      io.out(line({ ok: true, text: 'Removed the bridge to Pending You.' }))
    await removeShim(io)
  }
  for (const text of after) io.out(`${text}\n`)
  io.out(`To connect again: npx -y pendingyou@latest init${originArgs(options.origin)}\n`)
  return ok ? 0 : 1
}
