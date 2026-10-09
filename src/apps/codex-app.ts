// The Codex app for macOS (0.13.0; research 2026-10-04): "ChatGPT.app" (bundle id com.openai.codex; 26.928 carries codex
// 0.159.2) has its own codex command line inside it, and shares ~/.codex with Codex CLI: its MCP servers (the headers
// helper too), ~/.agents/skills, ~/.codex/hooks.json and the hooks' trust. Its hooks run with a PATH that ends in its own
// codex, and its private Codex server reads ~/.codex/queue_1.sqlite every 10 seconds, so `codex queue --thread` wakes a
// chat the app has loaded while it's open (an idle chat is let go after 3 hours, or behind 10 newer idle ones; then the
// message waits until the chat is opened again). Where `codex` isn't on PATH, init, status and the listener
// (codex-wake.ts) run the app's own instead: these paths, in /Applications or ~/Applications, under either name.
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Io } from '../io.ts'

/** The app's names: the ChatGPT desktop app that carries Codex, and Codex's own, should it ship as that. */
const APP_NAMES = ['ChatGPT.app', 'Codex.app']

/**
 * Where a Codex app keeps its own codex: the CodexCLI.app inside it that the app's own code looks for
 * (`codex-cli/CodexCLI.app/Contents/MacOS/codex`, run by hand to trust the hooks in /hooks: 0.22.0, seen working
 * 2026-10-06), then `Contents/Resources/codex-cli/bin/codex`, in /Applications, then ~/Applications. `system` is
 * /Applications unless PENDINGYOU_APPLICATIONS_DIR says otherwise (tests: they never look in the real one).
 */
export function appCodexPaths(home: string, system = '/Applications'): string[] {
  return [system, join(home, 'Applications')].flatMap((root) =>
    APP_NAMES.flatMap((name) => {
      const cli = join(root, name, 'Contents', 'Resources', 'codex-cli')
      return [join(cli, 'CodexCLI.app', 'Contents', 'MacOS', 'codex'), join(cli, 'bin', 'codex')]
    }),
  )
}

/** The codex command line that runs here: the one on PATH (`codex`), or the Codex app's own, by its full path. */
export interface CodexProgram {
  command: string
  version: string
  /** It's the Codex app's own: there's no `codex` on PATH. */
  app: boolean
}

/** `codex --version`'s version ("codex-cli 0.159.2"), or "installed" when it can't be read. */
const versionOf = (stdout: string) => /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? 'installed'

const executable = (path: string) =>
  stat(path).then(
    (info) => info.isFile() && (info.mode & 0o111) !== 0,
    () => false,
  )

/**
 * The codex to run: `codex` on PATH; else, on a Mac, the Codex app's own (the first of `paths` there that answers
 * `--version`); null when there's neither.
 */
export async function findCodex(
  io: Pick<Io, 'run' | 'home' | 'platform' | 'env'>,
  paths: readonly string[] = appCodexPaths(
    io.home,
    io.env.PENDINGYOU_APPLICATIONS_DIR || undefined,
  ),
): Promise<CodexProgram | null> {
  const onPath = await io.run('codex', ['--version'], 20_000)
  if (onPath.code === 0) return { command: 'codex', version: versionOf(onPath.stdout), app: false }
  if (io.platform !== 'darwin') return null
  for (const path of paths) {
    if (!(await executable(path))) continue
    const result = await io.run(path, ['--version'], 20_000)
    if (result.code === 0) return { command: path, version: versionOf(result.stdout), app: true }
  }
  return null
}
