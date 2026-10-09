// Every app module, in the order init sets them up and status lists them (ids.ts has the same order). Adding an app is
// a module of its own beside these (docs/apps.md) and one line here.
import { claudeCode } from './claude-code.ts'
import { codex } from './codex.ts'
import type { AppId } from './ids.ts'
import { opencode } from './opencode.ts'
import { pi } from './pi.ts'
import type { AppModule } from './types.ts'

export { atLeast } from '../mod.ts'

export const APPS: readonly AppModule[] = [claudeCode, codex, opencode, pi]

export function appModule(id: AppId): AppModule {
  const found = APPS.find((app) => app.id === id)
  if (!found) throw new Error(`no module for ${id}`)
  return found
}
