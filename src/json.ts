// Editing a person's JSON file the way they would by hand (0.12.0, for Pi's mcp.json and settings.json): one member of
// an object, or one item of an array, added, changed or taken out, and every other byte as it was: the order, the
// spacing, the line breaks, the indentation. Strict JSON only, which is what Pi reads (JSON.parse); a file that isn't
// is never edited. Each edit is checked by reading the result back: if it doesn't say exactly what the change should,
// the file is written whole instead, with its own indentation, as Pi itself writes it.
import { PlainError } from './errors.ts'

type Json = Record<string, unknown>

interface Span {
  start: number
  end: number
}
type Node =
  | ({ kind: 'object'; members: Member[] } & Span)
  | ({ kind: 'array'; items: Node[] } & Span)
  | ({ kind: 'value' } & Span)
interface Member {
  key: string
  keyStart: number
  value: Node
}

/** One change: set or delete an object's member, or add to or take from an array, at a path of member names. */
export type JsonEdit =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'delete'; path: readonly string[] }
  | { op: 'append'; path: readonly string[]; value: unknown }
  | { op: 'remove'; path: readonly string[]; match: (item: unknown) => boolean }

const BOM = '\uFEFF'

export const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A file's JSON: `{}` for none (or an empty file), the object it holds, or why it can't be edited (not JSON, or not an
 * object). `where` names the file in the reason.
 */
export function readObject(
  text: string | null,
  where: string,
): { json: Json } | { invalid: string } {
  const body = text?.startsWith(BOM) ? text.slice(1) : text
  if (body === null || body.trim() === '') return { json: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { invalid: `${where} isn’t valid JSON, so I left it alone.` }
  }
  return isObject(parsed)
    ? { json: parsed }
    : { invalid: `${where} isn’t a JSON object, so I left it alone.` }
}

/** Reads strict JSON into nodes that know where they are in the text. The text has already passed JSON.parse. */
function nodesOf(text: string): Node {
  let at = 0
  const space = () => {
    while (at < text.length && ' \t\n\r'.includes(text[at] as string)) at++
  }
  const string = (): string => {
    const start = at
    at++
    while (text[at] !== '"') at += text[at] === '\\' ? 2 : 1
    at++
    return JSON.parse(text.slice(start, at)) as string
  }
  const value = (): Node => {
    space()
    const start = at
    const char = text[at]
    if (char === '{' || char === '[') {
      at++
      space()
      const close = char === '{' ? '}' : ']'
      const members: Member[] = []
      const items: Node[] = []
      if (text[at] !== close)
        for (;;) {
          space()
          if (char === '{') {
            const keyStart = at
            const key = string()
            space()
            at++
            members.push({ key, keyStart, value: value() })
          } else items.push(value())
          space()
          if (text[at] !== ',') break
          at++
        }
      at++
      return char === '{'
        ? { kind: 'object', start, end: at, members }
        : { kind: 'array', start, end: at, items }
    }
    if (char === '"') string()
    else while (at < text.length && !',]} \t\n\r'.includes(text[at] as string)) at++
    return { kind: 'value', start, end: at }
  }
  return value()
}

/** The indentation one level adds in this text (its first indented line's), or two spaces. */
const unitOf = (text: string) => /^([ \t]+)\S/m.exec(text)?.[1] ?? '  '

/** The indentation of the line `offset` is on. */
function indentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? ''
}

const inline = (text: string, node: Span) => !text.slice(node.start, node.end).includes('\n')

/** A value written where a line starts with `indent`: on lines of its own, or on one line in an inline container. */
const render = (value: unknown, indent: string, unit: string, oneLine: boolean) =>
  oneLine
    ? JSON.stringify(value)
    : JSON.stringify(value, null, unit).replaceAll('\n', `\n${indent}`)

/** A value nested under the rest of a path: `{ a: { b: value } }` for ['a', 'b']. */
const nested = (path: readonly string[], value: unknown): unknown =>
  path.reduceRight<unknown>((inner, key) => ({ [key]: inner }), value)

/** Adds `"key": value` at the end of an object. */
function addMember(text: string, object: Node & { kind: 'object' }, key: string, value: unknown) {
  const unit = unitOf(text)
  const last = object.members.at(-1)
  if (!last) {
    const outer = indentAt(text, object.start)
    const inner = outer + unit
    return `${text.slice(0, object.start)}{\n${inner}${JSON.stringify(key)}: ${render(value, inner, unit, false)}\n${outer}}${text.slice(object.end)}`
  }
  if (inline(text, object))
    return `${text.slice(0, last.value.end)}, ${JSON.stringify(key)}: ${render(value, '', unit, true)}${text.slice(last.value.end)}`
  const indent = indentAt(text, last.keyStart)
  return `${text.slice(0, last.value.end)},\n${indent}${JSON.stringify(key)}: ${render(value, indent, unit, false)}${text.slice(last.value.end)}`
}

/** Adds an item at the end of an array. */
function addItem(text: string, array: Node & { kind: 'array' }, value: unknown) {
  const unit = unitOf(text)
  const last = array.items.at(-1)
  if (!last) {
    const outer = indentAt(text, array.start)
    const inner = outer + unit
    return `${text.slice(0, array.start)}[\n${inner}${render(value, inner, unit, false)}\n${outer}]${text.slice(array.end)}`
  }
  if (inline(text, array))
    return `${text.slice(0, last.end)}, ${render(value, '', unit, true)}${text.slice(last.end)}`
  const indent = indentAt(text, last.start)
  return `${text.slice(0, last.end)},\n${indent}${render(value, indent, unit, false)}${text.slice(last.end)}`
}

/** Takes out the entry at `index` (a member's key and value, or an item) with the comma that went with it. */
function dropAt(text: string, container: Node, starts: number[], ends: number[], index: number) {
  if (starts.length === 1) {
    const [open, close] = container.kind === 'object' ? ['{', '}'] : ['[', ']']
    return `${text.slice(0, container.start)}${open}${close}${text.slice(container.end)}`
  }
  if (index > 0) return text.slice(0, ends[index - 1]) + text.slice(ends[index])
  return text.slice(0, starts[0]) + text.slice(starts[1])
}

/** The node at a path of member names, and the deepest object on the way when it stops short. */
function find(
  root: Node,
  path: readonly string[],
): { node: Node | null; parent: Node; depth: number } {
  let parent = root
  for (const [depth, key] of path.entries()) {
    if (parent.kind !== 'object') return { node: null, parent, depth }
    // The last of the same name, as JSON.parse reads it.
    const member = parent.members.findLast((each) => each.key === key)
    if (!member) return { node: null, parent, depth }
    if (depth === path.length - 1) return { node: member.value, parent, depth }
    parent = member.value
  }
  return { node: root, parent: root, depth: 0 }
}

/** The change made to parsed JSON: what the edited text must read back as. */
function applied(json: Json, edit: JsonEdit): Json {
  const copy = structuredClone(json)
  let parent: Json = copy
  for (const key of edit.path.slice(0, -1)) {
    if (!isObject(parent[key])) {
      // Nothing to take out where there's nothing; an addition makes the way.
      if (edit.op === 'delete' || edit.op === 'remove') return copy
      parent[key] = {}
    }
    parent = parent[key] as Json
  }
  const last = edit.path.at(-1) as string
  if (edit.op === 'set') parent[last] = structuredClone(edit.value)
  else if (edit.op === 'delete') delete parent[last]
  else if (edit.op === 'append')
    parent[last] = [
      ...(Array.isArray(parent[last]) ? parent[last] : []),
      structuredClone(edit.value),
    ]
  else if (Array.isArray(parent[last]))
    parent[last] = (parent[last] as unknown[]).filter((item) => !edit.match(item))
  return copy
}

/** Whether two parsed JSON values say the same thing (an object's members in any order). */
function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => same(item, b[index]))
    )
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false
    const keys = Object.keys(a)
    return (
      keys.length === Object.keys(b).length && keys.every((key) => key in b && same(a[key], b[key]))
    )
  }
  return a === b
}

/** The text with the change made in place, or null when it can't be made there. */
function inPlace(text: string, edit: JsonEdit): string | null {
  const root = nodesOf(text)
  if (root.kind !== 'object') return null
  const { node, parent, depth } = find(root, edit.path)
  const last = edit.path.length - 1
  if (edit.op === 'set') {
    if (!node) {
      if (parent.kind !== 'object') return null
      return addMember(
        text,
        parent,
        edit.path[depth] as string,
        nested(edit.path.slice(depth + 1), edit.value),
      )
    }
    if (parent.kind !== 'object') return null
    const member = parent.members.findLast((each) => each.value === node) as Member
    const unit = unitOf(text)
    return `${text.slice(0, node.start)}${render(edit.value, indentAt(text, member.keyStart), unit, inline(text, parent))}${text.slice(node.end)}`
  }
  if (edit.op === 'delete') {
    if (!node || parent.kind !== 'object' || depth !== last) return text
    const index = parent.members.findLastIndex((each) => each.value === node)
    return dropAt(
      text,
      parent,
      parent.members.map((each) => each.keyStart),
      parent.members.map((each) => each.value.end),
      index,
    )
  }
  if (edit.op === 'append') {
    if (!node) {
      if (parent.kind !== 'object') return null
      return addMember(
        text,
        parent,
        edit.path[depth] as string,
        nested(edit.path.slice(depth + 1), [edit.value]),
      )
    }
    return node.kind === 'array' ? addItem(text, node, edit.value) : null
  }
  if (node?.kind !== 'array') return text
  let next = text
  // From the end, so each place found is still where it was.
  for (let index = node.items.length - 1; index >= 0; index--) {
    const item = node.items[index] as Node
    if (!edit.match(JSON.parse(text.slice(item.start, item.end)))) continue
    const current = nodesOf(next)
    const array = find(current, edit.path).node
    if (array?.kind !== 'array') return null
    next = dropAt(
      next,
      array,
      array.items.map((each) => each.start),
      array.items.map((each) => each.end),
      index,
    )
  }
  return next
}

/**
 * The file's text with one change made, everything else as it was. `text` null (no file) or empty starts a new file.
 * Throws a plain error when the file isn't a JSON object, or something on the path isn't what the change needs (an
 * object to set a member in, an array to add to): the caller says so, and what to add by hand.
 */
export function editJson(text: string | null, edit: JsonEdit, where = 'The file'): string {
  const read = readObject(text, where)
  if ('invalid' in read) throw new PlainError(read.invalid)
  const bom = text?.startsWith(BOM) ? BOM : ''
  const body = (text ?? '').slice(bom.length)
  let parent: unknown = read.json
  for (const key of edit.path.slice(0, -1)) {
    const next = (parent as Json)[key]
    if (next !== undefined && !isObject(next))
      throw new PlainError(`${where} has a “${key}” that isn’t an object, so I left it alone.`)
    if (next === undefined) break
    parent = next
  }
  const at = isObject(parent) ? parent[edit.path.at(-1) as string] : undefined
  if ((edit.op === 'append' || edit.op === 'remove') && at !== undefined && !Array.isArray(at))
    throw new PlainError(
      `${where} has a “${edit.path.at(-1)}” that isn’t a list, so I left it alone.`,
    )
  const wanted = applied(read.json, edit)
  if (same(wanted, read.json)) return text ?? ''
  if (body.trim() === '') return `${JSON.stringify(wanted, null, 2)}\n`
  const edited = inPlace(body, edit)
  if (edited !== null) {
    try {
      if (same(JSON.parse(edited), wanted)) return bom + edited
    } catch {}
  }
  const trailing = /\n$/.test(body) ? '\n' : ''
  return `${bom}${JSON.stringify(wanted, null, unitOf(body))}${trailing}`
}
