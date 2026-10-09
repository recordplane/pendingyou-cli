#!/usr/bin/env node
// `npx pendingyou …`: runs the command line with the real computer (realIo) and exits with its code.
import { realIo } from './io.ts'
import { isHook, main } from './main.ts'

const argv = process.argv.slice(2)
// A hook (pickup, handoff, stopcheck) exits 0 even here: it must never block the person's message.
const failed = isHook(argv) ? 0 : 1
try {
  main(argv, realIo()).then(
    (code) => process.exit(code),
    () => {
      process.stderr.write('pendingyou: Something went wrong.\n')
      process.exit(failed)
    },
  )
} catch {
  process.stderr.write('pendingyou: Something went wrong.\n')
  process.exit(failed)
}
