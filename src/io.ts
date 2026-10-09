// Everything the command line touches outside itself, in one place, so tests can hand it a temporary home, a fake
// network, a fake browser and a fake `claude`. `realIo()` is the real thing.
import { spawn } from 'node:child_process'
import { homedir, hostname } from 'node:os'
import { createInterface } from 'node:readline'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface Io {
  /** The environment variables (HOME, XDG_CONFIG_HOME, CLAUDE_CONFIG_DIR, PENDINGYOU_*). */
  env: Record<string, string | undefined>
  home: string
  cwd: string
  host: string
  platform: NodeJS.Platform
  out(text: string): void
  err(text: string): void
  fetch: typeof fetch
  /** The Node running this command line (process.execPath): what the hooks run it with. */
  execPath: string
  /** Whether a person is at the terminal (stdin and stdout are both a TTY), so init may ask them. */
  interactive: boolean
  /** Asks the person a question at the terminal and resolves with their answer ('' when there's none). */
  ask(question: string): Promise<string>
  /**
   * Runs a program without a shell and collects what it printed. Code 127 when it isn't installed, 124 when it ran
   * past `timeoutMs` (it's stopped). With `env`, the program gets exactly that environment instead of this one's.
   */
  run(
    command: string,
    args: readonly string[],
    timeoutMs?: number,
    options?: { env?: Record<string, string> },
  ): Promise<RunResult>
  /**
   * Runs the person's own command for `watch`: no shell, its output passed straight through, `stdin` written to it,
   * `env` added to this process's. Resolves with its exit code (127 when it can't be started, 124 on timeout).
   */
  exec(
    command: string,
    args: readonly string[],
    options: {
      env: Record<string, string>
      stdin: string
      timeoutMs: number
      signal?: AbortSignal
    },
  ): Promise<number>
  /**
   * Runs a program in this terminal, as if it had been run instead of this one (0.33.0: `pendingyou claude`): stdin,
   * stdout and stderr its own, the terminal's Ctrl-C its own too, this environment. Resolves with its exit code (127
   * when it isn't installed).
   */
  handOver?(command: string, args: readonly string[]): Promise<number>
  /** Opens a page in the person's browser; false when it couldn't. */
  openBrowser(url: string): Promise<boolean>
  /**
   * What a hook was handed on stdin (Claude Code sends JSON), or '' when stdin is a terminal. At most `maxChars`
   * (a million unless it says: a permission hook's can hold a whole file).
   */
  readStdin(timeoutMs: number, maxChars?: number): Promise<string>
  /**
   * stdin a line at a time, as each arrives (0.12.0: the stdio bridge's JSON-RPC messages, the OpenCode listener's
   * replies from the plugin). Ends when stdin closes, when this command is stopped, or when nobody reads stdout any
   * more.
   */
  lines(): AsyncIterable<string>
  /** Resolves once everything written to stdout so far has been handed on (before exiting with some still queued). */
  flush(): Promise<void>
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  /** Aborted on Ctrl-C or when Claude Code stops the background command. */
  signal: AbortSignal
  /** Where the running command line lives (process.argv[1]). */
  script: string
  /** Milliseconds since this process started (a hook's deadline counts from there). */
  uptime(): number
  /**
   * Starts this command line again with `args`, detached: it outlives this process (a hook that hit its deadline),
   * prints nowhere, and is never waited for. Used for the sign-in's refresh, which must never be cut off halfway.
   */
  background(args: readonly string[]): void
  /**
   * The process that started this one (0.15.0): a Codex hook's presence keeper finds the Codex process it runs for
   * among its ancestors (presence.ts). Absent where it can't be known.
   */
  ppid?: number
  /**
   * Keys pressed at the terminal as they come, stdin in raw mode until the loop ends (0.17.0: the Herdr plugin's
   * popup, herdr/popup.ts). Ends with stdin, or when this command is stopped.
   */
  keys?(): AsyncIterable<string>
  /** How many columns wide the terminal is (0.17.0). */
  columns?(): number
  /** How many rows high it is (0.21.0: the Herdr plugin's popup shows as many cards as fit). */
  rows?(): number
}

export function runProgram(
  command: string,
  args: readonly string[],
  timeoutMs = 60_000,
  options: { env?: Record<string, string> } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, [...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // Exactly that environment, nothing of this process's.
        ...(options.env ? { env: options.env as NodeJS.ProcessEnv } : {}),
      })
    } catch {
      resolve({ code: 127, stdout, stderr })
      return
    }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)
    const done = (code: number) => {
      clearTimeout(timer)
      resolve({ code: timedOut ? 124 : code, stdout, stderr })
    }
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error: NodeJS.ErrnoException) => done(error.code === 'ENOENT' ? 127 : 1))
    child.on('close', (code) => done(code ?? 1))
  })
}

export function execProgram(
  command: string,
  args: readonly string[],
  options: { env: Record<string, string>; stdin: string; timeoutMs: number; signal?: AbortSignal },
): Promise<number> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, [...args], {
        stdio: ['pipe', 'inherit', 'inherit'],
        env: { ...process.env, ...options.env },
        windowsHide: true,
      })
    } catch {
      resolve(127)
      return
    }
    let timedOut = false
    const stop = () => child.kill('SIGTERM')
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, options.timeoutMs)
    options.signal?.addEventListener('abort', stop, { once: true })
    const done = (code: number) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', stop)
      resolve(code)
    }
    child.on('error', (error: NodeJS.ErrnoException) => done(error.code === 'ENOENT' ? 127 : 1))
    child.on('close', (code) => done(timedOut ? 124 : (code ?? 1)))
    child.stdin?.on('error', () => {})
    child.stdin?.end(options.stdin)
  })
}

/** While a program has the terminal (handOver): where this process's own signals go instead of stopping it. */
let handedTo: ((signal: NodeJS.Signals) => void) | null = null

function handOver(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, [...args], { stdio: 'inherit' })
    } catch {
      resolve(127)
      return
    }
    // The terminal's Ctrl-C reaches it as it reaches this process (the same process group); a signal sent to this
    // process alone is passed on.
    handedTo = (signal) => {
      if (signal !== 'SIGINT') child.kill(signal)
    }
    const done = (code: number) => {
      handedTo = null
      resolve(code)
    }
    child.on('error', (error: NodeJS.ErrnoException) => done(error.code === 'ENOENT' ? 127 : 1))
    child.on('exit', (code, signal) =>
      done(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)),
    )
  })
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted || ms <= 0) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

function readStdin(timeoutMs: number, maxChars = 1_000_000): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('')
  return new Promise((resolve) => {
    let text = ''
    const finish = () => {
      clearTimeout(timer)
      process.stdin.pause()
      resolve(text)
    }
    const timer = setTimeout(finish, timeoutMs)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      text += chunk
      if (text.length > maxChars) finish()
    })
    process.stdin.on('end', finish)
    process.stdin.on('error', finish)
  })
}

/**
 * stdin line by line until it closes or `signal` stops this command. A reader that has gone away (the app closed its
 * end of stdout: EPIPE) stops it too, rather than ending it with an error nobody sees.
 */
function lines(signal: AbortSignal, stop: () => void): AsyncIterable<string> {
  process.stdout.on('error', stop)
  const reader = createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
    terminal: false,
  })
  if (signal.aborted) reader.close()
  else signal.addEventListener('abort', () => reader.close(), { once: true })
  return reader
}

/** Waits for stdout to take what was written to it, five seconds at most. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000)
    timer.unref()
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    if (process.stdout.destroyed || process.stdout.writableLength === 0) done()
    else process.stdout.write('', done)
  })
}

function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const prompt = createInterface({ input: process.stdin, output: process.stdout })
    let answered = false
    prompt.on('close', () => {
      if (!answered) resolve('')
    })
    prompt.question(question, (answer) => {
      answered = true
      prompt.close()
      resolve(answer)
    })
  })
}

async function openBrowser(url: string): Promise<boolean> {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url.replaceAll('&', '^&')]]
        : ['xdg-open', [url]]
  const result = await runProgram(command, args as string[], 10_000)
  return result.code === 0
}

/**
 * Keys as they're pressed: stdin in raw mode (a terminal's own keys, Ctrl-C among them, come as they are), back to how
 * it was once the loop ends, stdin ends or the command is stopped.
 */
function keys(signal: AbortSignal): AsyncIterable<string> {
  return {
    [Symbol.asyncIterator]() {
      const stdin = process.stdin
      const queue: string[] = []
      let waiting: ((result: IteratorResult<string>) => void) | null = null
      let done = false
      const raw = stdin.isTTY === true
      const onData = (chunk: string) => {
        const resolve = waiting
        waiting = null
        if (resolve) resolve({ value: chunk, done: false })
        else queue.push(chunk)
      }
      const end = () => {
        if (done) return
        done = true
        stdin.off('data', onData)
        stdin.off('end', end)
        signal.removeEventListener('abort', end)
        if (raw) stdin.setRawMode(false)
        stdin.pause()
        const resolve = waiting
        waiting = null
        resolve?.({ value: undefined, done: true })
      }
      if (raw) stdin.setRawMode(true)
      stdin.setEncoding('utf8')
      stdin.on('data', onData)
      stdin.on('end', end)
      stdin.resume()
      if (signal.aborted) end()
      else signal.addEventListener('abort', end, { once: true })
      return {
        next: (): Promise<IteratorResult<string>> => {
          const chunk = queue.shift()
          if (chunk !== undefined) return Promise.resolve({ value: chunk, done: false })
          if (done) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => {
            waiting = resolve
          })
        },
        return: (): Promise<IteratorResult<string>> => {
          end()
          return Promise.resolve({ value: undefined, done: true })
        },
      }
    },
  }
}

function background(script: string, args: readonly string[]): void {
  if (!script) return
  try {
    const child = spawn(process.execPath, [script, ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', () => {})
    child.unref()
  } catch {}
}

export function realIo(): Io {
  const controller = new AbortController()
  // The first signal lets the command finish cleanly (a hold says how the answer will still arrive); a second one
  // exits at once.
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.on(name, () => {
      if (handedTo) return handedTo(name)
      if (controller.signal.aborted) process.exit(130)
      controller.abort()
    })
  return {
    env: process.env,
    home: homedir(),
    cwd: process.cwd(),
    host: hostname(),
    platform: process.platform,
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    fetch: (input, init) => fetch(input, init),
    execPath: process.execPath,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask,
    run: runProgram,
    exec: execProgram,
    handOver,
    openBrowser,
    readStdin,
    lines: () => lines(controller.signal, () => controller.abort()),
    flush,
    now: () => Date.now(),
    sleep,
    signal: controller.signal,
    script: process.argv[1] ?? '',
    uptime: () => process.uptime() * 1000,
    background: (args) => background(process.argv[1] ?? '', args),
    ppid: process.ppid,
    keys: () => keys(controller.signal),
    columns: () => process.stdout.columns || 80,
    rows: () => process.stdout.rows || 24,
  }
}
