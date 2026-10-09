// Just enough TOML to edit one table of someone's config and leave every other byte as it was (0.11.0, for Codex's
// ~/.codex/config.toml). The command line has no dependencies (its private copy is the package's own files, nothing
// else), so this isn't a TOML library: it reads the file line by line, knowing where strings (one-line and multi-line,
// basic and literal), comments, arrays and inline tables start and end, so it can find a table's header and its lines,
// read its plain values (strings, booleans, numbers), and replace or remove that table and its subtables. A table
// defined some other way (dotted keys, an inline table) is reported, never edited: the caller leaves the file alone and
// says what to do.

/** One line of the file, and what it is at the top level. */
interface Line {
  text: string
  /** Where it starts in the file. */
  at: number
  /** A table header (`[a.b]`, or `[[a.b]]` for an array of tables): its key path. */
  header?: { path: string[]; array: boolean }
  /** The first line of a key/value pair: its key path (dotted keys split). */
  key?: string[]
}

/** A bare key, or a quoted one: the key path of a header or of a key/value pair, from the start of `text`. */
function keyPath(text: string): { path: string[]; rest: string } | null {
  const path: string[] = []
  let rest = text
  for (;;) {
    rest = rest.replace(/^[ \t]+/, '')
    const bare = /^[A-Za-z0-9_-]+/.exec(rest)
    const basic = bare ? null : /^"((?:[^"\\\n]|\\.)*)"/.exec(rest)
    const literal = bare || basic ? null : /^'([^'\n]*)'/.exec(rest)
    if (bare) path.push(bare[0])
    else if (basic) path.push(unescapeBasic(basic[1] ?? ''))
    else if (literal) path.push(literal[1] ?? '')
    else return null
    const match = (bare ?? basic ?? literal) as RegExpExecArray
    rest = rest.slice(match[0].length).replace(/^[ \t]+/, '')
    if (!rest.startsWith('.')) return { path, rest }
    rest = rest.slice(1)
  }
}

/** A basic string's escapes, as TOML has them. */
function unescapeBasic(text: string): string {
  return text.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (_, code: string) => {
    if (code[0] === 'u' || code[0] === 'U')
      return String.fromCodePoint(Number.parseInt(code.slice(1), 16))
    return (
      { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\', e: '\x1b' }[code] ?? code
    )
  })
}

/** A TOML basic string for `text`: quotes, backslashes and control characters escaped. */
export function basicString(text: string): string {
  return `"${[...text]
    .map((char) => {
      if (char === '"') return '\\"'
      if (char === '\\') return '\\\\'
      const code = char.codePointAt(0) ?? 0
      if (code < 0x20 || code === 0x7f) return `\\u${code.toString(16).padStart(4, '0')}`
      return char
    })
    .join('')}"`
}

/** The file's lines, each classified at the top level (never inside a string, an array or an inline table). */
function lines(doc: string): Line[] {
  const found: Line[] = []
  let state: 'normal' | 'basic' | 'literal' | 'mlbasic' | 'mlliteral' | 'comment' = 'normal'
  let depth = 0
  let at = 0
  while (at <= doc.length) {
    const end = doc.indexOf('\n', at)
    const stop = end < 0 ? doc.length : end + 1
    const text = doc.slice(at, stop)
    const line: Line = { text, at }
    const top = state === 'normal' && depth === 0
    if (top) {
      const trimmed = text.replace(/^[ \t]+/, '')
      const header = /^\[\[?/.exec(trimmed)
      if (header) {
        const array = header[0] === '[['
        const parsed = keyPath(trimmed.slice(header[0].length))
        const close = array ? ']]' : ']'
        if (parsed?.rest.startsWith(close)) {
          line.header = { path: parsed.path, array }
          // The header's own brackets aren't a value's: the rest of the line can only be a comment.
          found.push(line)
          if (end < 0) break
          at = stop
          continue
        }
      } else {
        const parsed = keyPath(trimmed)
        if (parsed?.rest.startsWith('=')) line.key = parsed.path
      }
    }
    // Walk the line, to know what the next one starts inside.
    for (let index = 0; index < text.length; index++) {
      const char = text[index] as string
      const three = text.slice(index, index + 3)
      if (state === 'comment') break
      if (state === 'basic') {
        if (char === '\\') index++
        else if (char === '"' || char === '\n') state = 'normal'
        continue
      }
      if (state === 'literal') {
        if (char === "'" || char === '\n') state = 'normal'
        continue
      }
      if (state === 'mlbasic') {
        if (char === '\\') index++
        else if (three === '"""') {
          index += 2
          while (text[index + 1] === '"') index++
          state = 'normal'
        }
        continue
      }
      if (state === 'mlliteral') {
        if (three === "'''") {
          index += 2
          while (text[index + 1] === "'") index++
          state = 'normal'
        }
        continue
      }
      if (char === '#') state = 'comment'
      else if (three === '"""') {
        state = 'mlbasic'
        index += 2
      } else if (three === "'''") {
        state = 'mlliteral'
        index += 2
      } else if (char === '"') state = 'basic'
      else if (char === "'") state = 'literal'
      else if (char === '[' || char === '{') depth++
      else if ((char === ']' || char === '}') && depth > 0) depth--
    }
    if (state === 'comment' || state === 'basic' || state === 'literal') state = 'normal'
    found.push(line)
    if (end < 0) break
    at = stop
  }
  return found
}

const startsWith = (path: readonly string[], prefix: readonly string[]) =>
  prefix.every((key, index) => path[index] === key)

/** A table and its subtables: where each section starts and ends in the file. */
export interface TableSpan {
  start: number
  end: number
}

/** The sections of `path` and its subtables (`[a.b]`, `[a.b.c]`), in order; empty when there's none. */
export function tableSpans(doc: string, path: readonly string[]): TableSpan[] {
  const all = lines(doc)
  const spans: TableSpan[] = []
  for (const [index, line] of all.entries()) {
    if (!line.header || !startsWith(line.header.path, path)) continue
    const next = all.slice(index + 1).find((later) => later.header)
    spans.push({ start: line.at, end: next ? next.at : doc.length })
  }
  return spans
}

/**
 * Whether `path` is defined some other way than by its own table header: a dotted key (`a.b.c = …` at the top, or
 * `b.c = …` under `[a]`), or an inline table (`b = { … }` under `[a]`). Such a file is left alone.
 */
export function definedInline(doc: string, path: readonly string[]): boolean {
  let table: string[] = []
  for (const line of lines(doc)) {
    if (line.header) {
      table = line.header.path
      continue
    }
    if (!line.key) continue
    const full = [...table, ...line.key]
    // A key whose full path reaches into ours (or holds it) from outside its own table.
    if (startsWith(table, path)) continue
    if (startsWith(full, path) || startsWith(path, full)) return true
  }
  return false
}

/** A table's plain values: strings, booleans and numbers by key (anything else is left out). */
export function tableValues(
  doc: string,
  path: readonly string[],
): Record<string, string | boolean | number> {
  const values: Record<string, string | boolean | number> = {}
  const span = tableSpans(doc, path).find((each) => {
    const header = lines(doc.slice(each.start, each.end))[0]?.header
    return header?.path.length === path.length
  })
  if (!span) return values
  for (const line of lines(doc.slice(span.start, span.end))) {
    if (line.key?.length !== 1) continue
    const value = line.text.slice(line.text.indexOf('=') + 1).trim()
    const key = line.key[0] as string
    const basic = /^"((?:[^"\\\n]|\\.)*)"\s*(#.*)?$/.exec(value)
    const literal = /^'([^'\n]*)'\s*(#.*)?$/.exec(value)
    const boolean = /^(true|false)\s*(#.*)?$/.exec(value)
    const integer = /^([+-]?\d[\d_]*)\s*(#.*)?$/.exec(value)
    if (basic) values[key] = unescapeBasic(basic[1] ?? '')
    else if (literal) values[key] = literal[1] ?? ''
    else if (boolean) values[key] = boolean[1] === 'true'
    else if (integer) values[key] = Number((integer[1] ?? '').replaceAll('_', ''))
  }
  return values
}

/** The headers of every table under `prefix` with one more key (`[hooks.state."x"]` under `hooks.state`), by that key. */
export function childTables(doc: string, prefix: readonly string[]): string[] {
  return lines(doc).flatMap((line) =>
    line.header &&
    line.header.path.length === prefix.length + 1 &&
    startsWith(line.header.path, prefix)
      ? [line.header.path[prefix.length] as string]
      : [],
  )
}

/**
 * The file with `path`'s table (and its subtables) replaced by `table` (the whole text, header included, ending in a
 * newline), where the first of them was, or added at the end; or, with `table` null, taken out. Every other line stays
 * byte for byte.
 */
export function withTable(doc: string, path: readonly string[], table: string | null): string {
  const spans = tableSpans(doc, path)
  if (spans.length === 0) {
    if (table === null) return doc
    const gap = doc === '' ? '' : doc.endsWith('\n\n') ? '' : doc.endsWith('\n') ? '\n' : '\n\n'
    return `${doc}${gap}${table}`
  }
  let next = ''
  let from = 0
  for (const [index, span] of spans.entries()) {
    next += doc.slice(from, span.start)
    const old = doc.slice(span.start, span.end)
    if (index === 0 && table !== null) {
      // Keep the blank line that separated the old table from the next one.
      next += `${table}${/\n\s*\n\s*$/.test(old) ? '\n' : ''}`
    } else if (table === null && span.end === doc.length && next.endsWith('\n\n')) {
      // A table taken from the end takes the blank line before it, as it was added.
      next = next.slice(0, -1)
    }
    from = span.end
  }
  return next + doc.slice(from)
}

/** A key as a header writes it: bare when it can be, else a basic string. */
const keyText = (key: string) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : basicString(key))

/** A table's header for a key path: `[hooks.state."/x/hooks.json:stop:0:0"]`. */
export const headerOf = (path: readonly string[]) => `[${path.map(keyText).join('.')}]`

/**
 * The file with the table at `from` now at `to`: its header line rewritten (a comment after it kept), nothing else
 * touched. Unchanged when there's no such table, or one at `to` already.
 */
export function renameTable(doc: string, from: readonly string[], to: readonly string[]): string {
  const all = lines(doc)
  const same = (path: readonly string[], other: readonly string[]) =>
    path.length === other.length && startsWith(path, other)
  if (all.some((line) => line.header && same(line.header.path, to))) return doc
  const found = all.find(
    (line) => line.header && !line.header.array && same(line.header.path, from),
  )
  if (!found) return doc
  const comment = /\][ \t]*(#.*?)?[ \t]*(\r?\n)?$/.exec(found.text)
  const rewritten = `${headerOf(to)}${comment?.[1] ? ` ${comment[1]}` : ''}${comment?.[2] ?? ''}`
  return doc.slice(0, found.at) + rewritten + doc.slice(found.at + found.text.length)
}
