// A small editor for JSON with comments (0.12.0: OpenCode's config). It finds a key's value by its place in the text
// and sets, adds or removes it with a splice, so every comment, blank line and other byte stays where it was: the
// command line has no dependencies (toml.ts is the same for Codex's config). It reads what OpenCode reads (jsonc-parser
// with trailing commas): JSON, `//` and `/* */` comments and trailing commas. Anything else is an error that says
// where, and a path through a value that isn't an object, or through a key given twice, is never edited.

export type Node =
  | { type: 'object'; start: number; end: number; members: Member[] }
  | { type: 'array'; start: number; end: number; items: Node[] }
  | { type: 'string' | 'number' | 'boolean' | 'null'; start: number; end: number; value: unknown }

export type ObjectNode = Extract<Node, { type: 'object' }>

/** A key and its value in an object, and where the comma after it is (null for the last, with none). */
export interface Member {
  key: string
  /** Where the key starts (its opening quote). */
  start: number
  value: Node
  comma: number | null
}

/** Why a text can't be read or edited, and where. */
export class JsoncError extends Error {
  override name = 'JsoncError'
}

const where = (text: string, at: number) => {
  const before = text.slice(0, at).split('\n')
  return `line ${before.length}, column ${(before.at(-1)?.length ?? 0) + 1}`
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: a JSON string can't hold a raw control character
const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const WORDS: Record<string, unknown> = { true: true, false: false, null: null }

/** The text's value, with where each part of it is. Throws a JsoncError that says what and where. */
export function parse(text: string): Node {
  let at = 0
  const fail = (wanted: string): never => {
    throw new JsoncError(
      `${at < text.length ? `${JSON.stringify(text[at])} where` : 'the end of the file where'} ${wanted} should be (${where(text, at)})`,
    )
  }
  const skip = () => {
    for (;;) {
      const char = text[at]
      if (char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '﻿') at++
      else if (text.startsWith('//', at)) {
        const end = text.indexOf('\n', at)
        at = end < 0 ? text.length : end
      } else if (text.startsWith('/*', at)) {
        const end = text.indexOf('*/', at + 2)
        if (end < 0) fail('the end of a comment')
        at = end + 2
      } else return
    }
  }
  const string = (): string => {
    STRING.lastIndex = at
    const found = STRING.exec(text)
    if (!found) return fail('a string')
    at += found[0].length
    return JSON.parse(found[0]) as string
  }
  const value = (): Node => {
    skip()
    const start = at
    const char = text[at]
    if (char === '{') {
      at++
      const members: Member[] = []
      skip()
      if (text[at] === '}') return { type: 'object', start, end: ++at, members }
      for (;;) {
        skip()
        if (text[at] !== '"') fail('a key in double quotes')
        const keyStart = at
        const key = string()
        skip()
        if (text[at] !== ':') fail('a colon')
        at++
        const member: Member = { key, start: keyStart, value: value(), comma: null }
        members.push(member)
        skip()
        if (text[at] === ',') {
          member.comma = at++
          skip()
          if (text[at] === '}') return { type: 'object', start, end: ++at, members }
          continue
        }
        if (text[at] === '}') return { type: 'object', start, end: ++at, members }
        fail('a comma or }')
      }
    }
    if (char === '[') {
      at++
      const items: Node[] = []
      skip()
      if (text[at] === ']') return { type: 'array', start, end: ++at, items }
      for (;;) {
        items.push(value())
        skip()
        if (text[at] === ',') {
          at++
          skip()
          if (text[at] === ']') return { type: 'array', start, end: ++at, items }
          continue
        }
        if (text[at] === ']') return { type: 'array', start, end: ++at, items }
        fail('a comma or ]')
      }
    }
    if (char === '"') return { type: 'string', start, value: string(), end: at }
    for (const [word, meaning] of Object.entries(WORDS))
      if (text.startsWith(word, at)) {
        at += word.length
        return { type: meaning === null ? 'null' : 'boolean', start, end: at, value: meaning }
      }
    NUMBER.lastIndex = at
    const number = NUMBER.exec(text)
    if (number) {
      at += number[0].length
      return { type: 'number', start, end: at, value: Number(number[0]) }
    }
    return fail('a value')
  }
  const root = value()
  skip()
  if (at < text.length) fail('the end of the file')
  return root
}

/** The value a node holds, as JSON.parse would give it (a key given twice: the last one, as OpenCode takes it). */
export function jsonOf(node: Node): unknown {
  if (node.type === 'object')
    return Object.fromEntries(node.members.map((member) => [member.key, jsonOf(member.value)]))
  if (node.type === 'array') return node.items.map(jsonOf)
  return node.value
}

/** The member of an object with this key; an error when the key is given twice (which one counts is unclear). */
export function memberOf(object: ObjectNode, key: string): Member | undefined {
  const found = object.members.filter((member) => member.key === key)
  if (found.length > 1) throw new JsoncError(`“${key}” is given ${found.length} times`)
  return found[0]
}

/** The node at a path of keys, or null where there's none; an error when the path goes through something else. */
export function nodeAt(root: Node, path: readonly string[]): Node | null {
  let node: Node = root
  for (const [index, key] of path.entries()) {
    if (node.type !== 'object')
      throw new JsoncError(`“${path.slice(0, index).join('.') || 'the file'}” isn’t an object`)
    const member = memberOf(node, key)
    if (!member) return null
    node = member.value
  }
  return node
}

/** The whitespace a line starts with. */
function indentAt(text: string, at: number): string {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? ''
}

/** Whether only whitespace comes before `at` on its line. */
const startsLine = (text: string, at: number) =>
  /^[ \t]*$/.test(text.slice(text.lastIndexOf('\n', at - 1) + 1, at))

/** The step one level of the file is indented by: what its first indented line uses, else two spaces. */
function unitOf(text: string): string {
  const found = /\n([ \t]+)\S/.exec(text)?.[1]
  return found?.startsWith('\t') ? '\t' : found ? ' '.repeat(Math.min(found.length, 8)) : '  '
}

/**
 * A value as JSON for the file, its lines after the first at `indent`: objects a key a line, a short list of plain
 * values on one line.
 */
export function stringify(value: unknown, unit: string, indent: string): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const flat = value.every((item) => item === null || typeof item !== 'object')
    const inline = `[${value.map((item) => JSON.stringify(item)).join(', ')}]`
    if (flat && indent.length + inline.length <= 100) return inline
    const inner = indent + unit
    return `[\n${value.map((item) => `${inner}${stringify(item, unit, inner)}`).join(',\n')}\n${indent}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
    if (entries.length === 0) return '{}'
    const inner = indent + unit
    return `{\n${entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${stringify(item, unit, inner)}`).join(',\n')}\n${indent}}`
  }
  return JSON.stringify(value)
}

/** Where a new last member of an object goes, and the text to put there. */
function insertion(
  text: string,
  object: ObjectNode,
  key: string,
  value: unknown,
): { at: number; insert: string; comma: number | null } {
  const unit = unitOf(text)
  const last = object.members.at(-1)
  if (!last) {
    // An empty object: the member on a line of its own, between the braces.
    const outer = indentAt(text, object.start)
    const inner = outer + unit
    const between = text.slice(object.start + 1, object.end - 1)
    const member = `${JSON.stringify(key)}: ${stringify(value, unit, inner)}`
    if (/^\s*$/.test(between))
      return { at: object.start + 1, insert: `\n${inner}${member}\n${outer}`, comma: null }
    return { at: object.start + 1, insert: `\n${inner}${member},`, comma: null }
  }
  const inner = startsLine(text, last.start)
    ? indentAt(text, last.start)
    : indentAt(text, object.start) + unit
  const member = `${JSON.stringify(key)}: ${stringify(value, unit, inner)}`
  // After the last member, and after a comment that ends its line, so the comment stays with what it was about.
  let at = last.comma === null ? last.value.end : last.comma + 1
  let scan = at
  for (;;) {
    while (text[scan] === ' ' || text[scan] === '\t') scan++
    if (text.startsWith('//', scan)) {
      const end = text.indexOf('\n', scan)
      scan = end < 0 ? text.length : end
    } else if (
      text.startsWith('/*', scan) &&
      !text.slice(scan, text.indexOf('*/', scan)).includes('\n')
    )
      scan = text.indexOf('*/', scan) + 2
    else break
  }
  if (text[scan] === '\n' || text[scan] === '\r' || scan >= text.length)
    at = text[scan - 1] === '\r' ? scan - 1 : scan
  else if (last.comma !== null) at = last.comma + 1
  const trailing = last.comma !== null
  return {
    at,
    insert: `\n${inner}${member}${trailing ? ',' : ''}`,
    comma: trailing ? null : last.value.end,
  }
}

/** Splices: each [start, end, text], applied from the end so the offsets hold. */
function splice(text: string, edits: [number, number, string][]): string {
  let out = text
  for (const [start, end, insert] of [...edits].sort((a, b) => b[0] - a[0]))
    out = out.slice(0, start) + insert + out.slice(end)
  return out
}

/**
 * The text with the value at `path` set: replaced where it's there, added (with the objects on the way) where it
 * isn't. Throws a JsoncError when the text can't be read, or the path goes through something that isn't an object.
 */
export function setAt(text: string, path: readonly string[], value: unknown): string {
  if (path.length === 0) throw new JsoncError('nothing to set')
  if (!text.trim()) return `${stringify(nest(path, value), '  ', '')}\n`
  const root = parse(text)
  let node: Node = root
  for (const [index, key] of path.entries()) {
    if (node.type !== 'object')
      throw new JsoncError(`“${path.slice(0, index).join('.') || 'the file'}” isn’t an object`)
    const member = memberOf(node, key)
    if (!member) {
      const { at, insert, comma } = insertion(text, node, key, nest(path.slice(index + 1), value))
      return splice(text, [
        [at, at, insert],
        ...(comma === null ? [] : [[comma, comma, ','] as [number, number, string]]),
      ])
    }
    if (index === path.length - 1) {
      const indent = startsLine(text, member.start)
        ? indentAt(text, member.start)
        : indentAt(text, node.start) + unitOf(text)
      return splice(text, [
        [member.value.start, member.value.end, stringify(value, unitOf(text), indent)],
      ])
    }
    node = member.value
  }
  return text
}

/** `{a: {b: value}}` for the path [a, b]. */
function nest(path: readonly string[], value: unknown): unknown {
  return path.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value)
}

/**
 * The text without the member at `path` (its line, when it has one to itself, and the comma that went with it), and
 * unchanged when it isn't there. Throws as setAt does.
 */
export function removeAt(text: string, path: readonly string[]): string {
  const root = parse(text)
  const parent = nodeAt(root, path.slice(0, -1))
  if (parent?.type !== 'object') return text
  const key = path.at(-1) as string
  const member = memberOf(parent, key)
  if (!member) return text
  const index = parent.members.indexOf(member)
  let start = member.start
  let end = member.comma === null ? member.value.end : member.comma + 1
  const edits: [number, number, string][] = []
  if (startsLine(text, start)) {
    // The whole line (or lines) it has to itself, from the indent to the newline after it.
    const after = /^[ \t]*(\/\/[^\n]*)?\r?\n/.exec(text.slice(end))
    if (after) {
      start = text.lastIndexOf('\n', start - 1) + 1
      end += after[0].length
    }
  } else end += /^[ \t]*/.exec(text.slice(end))?.[0].length ?? 0
  // The last member goes with the comma before it, unless the one before keeps a trailing comma of its own.
  const before = parent.members[index - 1]
  if (member.comma === null && before?.comma != null)
    edits.push([before.comma, before.comma + 1, ''])
  edits.push([start, end, ''])
  return splice(text, edits)
}
