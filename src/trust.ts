// Hooks an app runs only once the person trusts them in the app itself (0.22.0; Codex, apps/codex.ts). When init or
// status finds some installed but not trusted, it says how to trust them (the app's `untrustedHooks`: for Codex, the
// one command that opens it and /hooks there) and, with a person at the terminal, waits for them: it looks again every
// 3 seconds, for 10 minutes at most, until they're trusted, then says whether the app is ready. Ctrl-C stops the wait
// and nothing else. Pending You never writes an app's trust itself, and never gets around it: that's the person's
// review.
import type { AppModule, AppStatus } from './apps/types.ts'
import { originArgs } from './hooks.ts'
import type { Io } from './io.ts'
import { checkSignIn } from './signin.ts'

/** How often the wait looks again, and how long it waits at most. */
export const TRUST_EVERY_MS = 3000
export const TRUST_FOR_MS = 10 * 60_000

/** Looks every 3 seconds until `trusted` says so: 'trusted', or why it stopped (Ctrl-C, or 10 minutes). */
export async function waitForTrust(
  io: Io,
  trusted: () => Promise<boolean>,
): Promise<'trusted' | 'stopped' | 'timed-out'> {
  const until = io.now() + TRUST_FOR_MS
  while (io.now() < until) {
    if (io.signal.aborted) return 'stopped'
    await io.sleep(TRUST_EVERY_MS, io.signal)
    if (io.signal.aborted) return 'stopped'
    if (await trusted()) return 'trusted'
  }
  return 'timed-out'
}

/**
 * For an app with hooks installed and not trusted yet: how to trust them, and, with a person at the terminal, the wait
 * and then the app's status line (Ready, or what's not). The app's status once they're trusted; null when there was
 * nothing to trust, nobody to wait for, or the wait stopped.
 */
export async function trustHooks(
  io: Io,
  app: AppModule,
  origin: string,
): Promise<AppStatus | null> {
  const pending = await app.untrustedHooks?.(io)
  if (!pending) return null
  const later = `npx pendingyou status${originArgs(origin)}`
  io.out(`\n${pending.lines.join('\n')}\n`)
  if (!io.interactive) {
    io.out(`Once you have, run ${later} to check.\n`)
    return null
  }
  io.out(`Waiting for you to trust the hooks… (Ctrl-C to stop; run ${later} later)\n`)
  const outcome = await waitForTrust(io, pending.trusted)
  if (outcome !== 'trusted') {
    io.out(
      `${outcome === 'stopped' ? 'Stopped waiting.' : 'Stopped waiting after 10 minutes.'} Once you’ve trusted them, run ${later}.\n`,
    )
    return null
  }
  const section = await app.status(io, { origin, signIn: await checkSignIn(io, origin, app.id) })
  io.out(`${section.lines.at(-1)}\n`)
  return section
}
