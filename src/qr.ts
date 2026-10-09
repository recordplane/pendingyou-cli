// A QR code for the device sign-in's link (0.10.0), so the person can scan it from the terminal with their phone
// instead of typing the address: on a computer reached over SSH, that phone is where they approve the code. The
// command line has no dependencies, so this is a small encoder of its own: byte mode, versions 1–9 (up to 180 bytes at
// level M), every error correction level, and the standard's mask choice (lowest penalty). It follows Project Nayuki's
// QR Code generator, as uqr does (the app's phone code, onboarding.tsx); apps/pendingyou/test/cli-qr.test.ts checks it
// against uqr module for module.

export type Ecc = 'L' | 'M' | 'Q' | 'H'

export interface QrCode {
  version: number
  mask: number
  /** Rows of modules, top to bottom; true is dark. */
  modules: boolean[][]
}

const LEVELS: Record<Ecc, { index: number; format: number }> = {
  L: { index: 0, format: 1 },
  M: { index: 1, format: 0 },
  Q: { index: 2, format: 3 },
  H: { index: 3, format: 2 },
}
/** Byte mode's character count is 8 bits up to version 9; this encoder stops there. */
const MAX_VERSION = 9
/** Error correction codewords per block, by level, then version (index 0 unused). */
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24],
]
/** Error correction blocks, by level, then version (index 0 unused). */
const BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8],
]

const bit = (value: number, index: number) => ((value >>> index) & 1) !== 0

/** Modules left for data and error correction once the function patterns are drawn. */
function rawModules(version: number): number {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2
    result -= (25 * align - 10) * align - 55
    if (version >= 7) result -= 36
  }
  return result
}

const dataCodewords = (version: number, level: number) =>
  Math.floor(rawModules(version) / 8) -
  (ECC_PER_BLOCK[level]?.[version] ?? 0) * (BLOCKS[level]?.[version] ?? 0)

/** GF(256) multiplication, modulo x^8 + x^4 + x^3 + x^2 + 1. */
function multiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

function divisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = multiply(result[j] as number, root)
      if (j + 1 < result.length) result[j] = (result[j] as number) ^ (result[j + 1] as number)
    }
    root = multiply(root, 2)
  }
  return result
}

function remainder(data: readonly number[], by: readonly number[]): number[] {
  const result = by.map(() => 0)
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number)
    result.push(0)
    by.forEach((coefficient, index) => {
      result[index] = (result[index] as number) ^ multiply(coefficient, factor)
    })
  }
  return result
}

/** The data codewords with each block's error correction, interleaved as the standard places them. */
function interleave(data: readonly number[], version: number, level: number): number[] {
  const blocks = BLOCKS[level]?.[version] as number
  const eccLength = ECC_PER_BLOCK[level]?.[version] as number
  const raw = Math.floor(rawModules(version) / 8)
  const short = blocks - (raw % blocks)
  const shortLength = Math.floor(raw / blocks)
  const by = divisor(eccLength)
  const all: number[][] = []
  for (let index = 0, at = 0; index < blocks; index++) {
    const block = data.slice(at, at + shortLength - eccLength + (index < short ? 0 : 1))
    at += block.length
    const ecc = remainder(block, by)
    if (index < short) block.push(0)
    all.push([...block, ...ecc])
  }
  const result: number[] = []
  for (let i = 0; i < (all[0]?.length ?? 0); i++)
    all.forEach((block, j) => {
      if (i !== shortLength - eccLength || j >= short) result.push(block[i] as number)
    })
  return result
}

class Grid {
  readonly version: number
  /** The level's format bits (L 1, M 0, Q 3, H 2). */
  readonly format: number
  readonly size: number
  readonly modules: boolean[][]
  /** Function modules (finders, timing, alignment, format and version), which data and masks never touch. */
  readonly reserved: boolean[][]
  constructor(version: number, format: number) {
    this.version = version
    this.format = format
    this.size = version * 4 + 17
    this.modules = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    )
    this.reserved = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    )
  }

  set(x: number, y: number, dark: boolean) {
    ;(this.modules[y] as boolean[])[x] = dark
    ;(this.reserved[y] as boolean[])[x] = true
  }

  functionPatterns() {
    for (let i = 0; i < this.size; i++) {
      this.set(6, i, i % 2 === 0)
      this.set(i, 6, i % 2 === 0)
    }
    for (const [x, y] of [
      [3, 3],
      [this.size - 4, 3],
      [3, this.size - 4],
    ] as const)
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const distance = Math.max(Math.abs(dx), Math.abs(dy))
          const [xx, yy] = [x + dx, y + dy]
          if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size)
            this.set(xx, yy, distance !== 2 && distance !== 4)
        }
    // Alignment patterns everywhere on the grid of positions but the three finder corners.
    const positions = this.alignments()
    const last = positions.length - 1
    for (const [i, a] of positions.entries())
      for (const [j, b] of positions.entries()) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++)
            this.set(a + dx, b + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    this.formatBits(0)
    if (this.version >= 7) {
      let rest = this.version
      for (let i = 0; i < 12; i++) rest = (rest << 1) ^ ((rest >>> 11) * 0x1f25)
      const bits = (this.version << 12) | rest
      for (let i = 0; i < 18; i++) {
        const a = this.size - 11 + (i % 3)
        const b = Math.floor(i / 3)
        this.set(a, b, bit(bits, i))
        this.set(b, a, bit(bits, i))
      }
    }
  }

  alignments(): number[] {
    if (this.version === 1) return []
    const count = Math.floor(this.version / 7) + 2
    const step = Math.ceil((this.version * 4 + 4) / (count * 2 - 2)) * 2
    const result = [6]
    for (let at = this.size - 7; result.length < count; at -= step) result.splice(1, 0, at)
    return result
  }

  formatBits(mask: number) {
    const data = (this.format << 3) | mask
    let rest = data
    for (let i = 0; i < 10; i++) rest = (rest << 1) ^ ((rest >>> 9) * 0x537)
    const bits = ((data << 10) | rest) ^ 0x5412
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i))
    this.set(8, 7, bit(bits, 6))
    this.set(8, 8, bit(bits, 7))
    this.set(7, 8, bit(bits, 8))
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i))
    for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, bit(bits, i))
    for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, bit(bits, i))
    this.set(8, this.size - 8, true)
  }

  codewords(data: readonly number[]) {
    let i = 0
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vertical = 0; vertical < this.size; vertical++)
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? this.size - 1 - vertical : vertical
          if (!this.reserved[y]?.[x] && i < data.length * 8) {
            ;(this.modules[y] as boolean[])[x] = bit(data[i >>> 3] as number, 7 - (i & 7))
            i++
          }
        }
    }
  }

  /** XORs the data modules with a mask pattern; applying it twice undoes it. */
  mask(mask: number) {
    for (let y = 0; y < this.size; y++)
      for (let x = 0; x < this.size; x++) {
        const flip = [
          (x + y) % 2 === 0,
          y % 2 === 0,
          x % 3 === 0,
          (x + y) % 3 === 0,
          (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
          ((x * y) % 2) + ((x * y) % 3) === 0,
          (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
          (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
        ][mask]
        if (flip && !this.reserved[y]?.[x])
          (this.modules[y] as boolean[])[x] = !this.modules[y]?.[x]
      }
  }

  /** The standard's penalty for the modules as they are: runs, boxes, finder look-alikes and imbalance. */
  penalty(): number {
    let result = 0
    const at = (x: number, y: number) => this.modules[y]?.[x] as boolean
    for (const across of [true, false]) {
      for (let line = 0; line < this.size; line++) {
        let color = false
        let run = 0
        const history = [0, 0, 0, 0, 0, 0, 0]
        for (let along = 0; along < this.size; along++) {
          const dark = across ? at(along, line) : at(line, along)
          if (dark === color) {
            run++
            if (run === 5) result += 3
            else if (run > 5) result++
          } else {
            this.addHistory(run, history)
            if (!color) result += this.finderLike(history) * 40
            color = dark
            run = 1
          }
        }
        if (color) {
          this.addHistory(run, history)
          run = 0
        }
        this.addHistory(run + this.size, history)
        result += this.finderLike(history) * 40
      }
    }
    for (let y = 0; y < this.size - 1; y++)
      for (let x = 0; x < this.size - 1; x++) {
        const color = at(x, y)
        if (color === at(x + 1, y) && color === at(x, y + 1) && color === at(x + 1, y + 1))
          result += 3
      }
    const dark = this.modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0)
    const total = this.size * this.size
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10
    return result
  }

  addHistory(run: number, history: number[]) {
    history.pop()
    history.unshift(history[0] === 0 ? run + this.size : run)
  }

  finderLike(history: readonly number[]): number {
    const [a = 0, n = 0, c = 0, d = 0, e = 0, f = 0, g = 0] = history
    const core = n > 0 && c === n && d === n * 3 && e === n && f === n
    return (core && a >= n * 4 && g >= n ? 1 : 0) + (core && g >= n * 4 && a >= n ? 1 : 0)
  }
}

/**
 * `text` as a QR code in byte mode, the smallest version that holds it at level `ecc` (M unless asked), with the mask
 * the standard's penalty prefers (or `mask`). Null when it's longer than version 9 holds.
 */
export function qrCode(text: string, options: { ecc?: Ecc; mask?: number } = {}): QrCode | null {
  const bytes = [...new TextEncoder().encode(text)]
  const { index: level, format } = LEVELS[options.ecc ?? 'M']
  let version = 1
  // Mode (4 bits), the count (8 bits), then the bytes.
  const used = 4 + 8 + bytes.length * 8
  while (version <= MAX_VERSION && used > dataCodewords(version, level) * 8) version++
  if (version > MAX_VERSION) return null
  const capacity = dataCodewords(version, level) * 8
  const bits: number[] = []
  const append = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  append(0b0100, 4)
  append(bytes.length, 8)
  for (const byte of bytes) append(byte, 8)
  append(0, Math.min(4, capacity - bits.length))
  append(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) append(pad, 8)
  const data = new Array<number>(bits.length / 8).fill(0)
  bits.forEach((value, i) => {
    data[i >>> 3] = (data[i >>> 3] as number) | (value << (7 - (i & 7)))
  })

  const grid = new Grid(version, format)
  grid.functionPatterns()
  grid.codewords(interleave(data, version, level))
  let mask = options.mask ?? -1
  if (mask < 0) {
    let lowest = Number.POSITIVE_INFINITY
    for (let candidate = 0; candidate < 8; candidate++) {
      grid.mask(candidate)
      grid.formatBits(candidate)
      const score = grid.penalty()
      if (score < lowest) {
        lowest = score
        mask = candidate
      }
      grid.mask(candidate)
    }
  }
  grid.mask(mask)
  grid.formatBits(mask)
  return { version, mask, modules: grid.modules.map((row) => [...row]) }
}

/** Dark on light whatever the terminal's colours: black text on a white background, then back to normal. */
const ON = '\u001b[30;47m'
const OFF = '\u001b[0m'
/** Light modules around the code, so a camera finds its edges. */
const QUIET = 2

/**
 * The code as terminal lines: two rows of modules a line, drawn with half blocks, dark on light, with a quiet zone.
 * Null when the text is too long for a code, or the terminal can't be trusted with colours (NO_COLOR, TERM=dumb).
 */
export function qrLines(
  text: string,
  env: Record<string, string | undefined> = {},
): string[] | null {
  if (env.NO_COLOR || env.TERM === 'dumb') return null
  const code = qrCode(text)
  if (!code) return null
  const size = code.modules.length + QUIET * 2
  const dark = (x: number, y: number) => code.modules[y - QUIET]?.[x - QUIET] === true
  const lines: string[] = []
  for (let y = 0; y < size; y += 2) {
    let line = ''
    for (let x = 0; x < size; x++) {
      const top = dark(x, y)
      const bottom = y + 1 < size && dark(x, y + 1)
      line += top ? (bottom ? '█' : '▀') : bottom ? '▄' : ' '
    }
    lines.push(`${ON}${line}${OFF}`)
  }
  return lines
}
