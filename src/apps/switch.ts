// Moving an app's pendingyou MCP server that signs in by itself to this computer's own sign-in (0.11.0), asked the
// same way for every app. Since 0.15.0 Pending You merges the old sign-in into this computer's on its own (the
// Assistants page's replaced sign-ins, product-contract.md §6m), so the question says what moves, and where nobody can
// be asked because there's no browser (an SSH session), init says what it switched rather than switching silently.
import type { Io } from '../io.ts'
import type { AppContext } from './types.ts'

/** What happens to the sign-in it had, in a sentence. */
export const movesOver = (name: string) =>
  `Once ${name} shows up on this computer’s sign-in, Pending You moves the old sign-in’s agents over to it, with their cards and the questions you delegated to them, and signs the old one out.`

/**
 * Whether to switch: `--yes`, or (`headless`, for the apps whose own sign-in can't finish without a browser) no browser
 * here, said out loud; Yes (the default) at a terminal; kept, with nobody to ask.
 */
export async function switches(
  io: Io,
  ctx: AppContext,
  options: { name: string; what: string; uses: string; headless: boolean },
): Promise<boolean> {
  const { name } = options
  if (ctx.yes) return true
  if (options.headless && ctx.headless) {
    io.out(
      `${options.what} There’s no browser here (${ctx.headless}), where that sign-in can’t finish, so init is switching ${name} to this computer’s own sign-in, which ${options.uses} too. ${movesOver(name)}\n`,
    )
    return true
  }
  if (!io.interactive) return false
  io.out(
    `${options.what} init can move ${name} to this computer’s own sign-in, which ${options.uses} too: one sign-in for both. ${movesOver(name)}\n`,
  )
  const answer = await io.ask(`Switch ${name} to this computer’s sign-in? [Y/n] `)
  return !/^\s*no?\s*$/i.test(answer)
}
