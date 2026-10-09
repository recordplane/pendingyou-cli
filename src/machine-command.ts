// `pendingyou machine status | attest | rotate` (0.18.0): this computer's key (machine.ts), as the person sees it.
// - status: the key's file and fingerprint, and whether Pending You knows each of this computer's connections at an
//   address by it (`for.machineKey`, from /mcp/cli/answers); exit 0 only when every one is.
// - attest: an attestation for an app's own device sign-in at an address (`--client-id`, and `--cnf` for its own key),
//   on stdout and nowhere else.
// - rotate: a new key, after a yes (or `--yes`). Pending You knows the computer as a new one from its next sign-in; its
//   connections stay with the old key until that computer is removed from the person's account.
// - link (0.29.0): links this computer's sign-ins to it by its key, its apps' own ones too (link.ts).
// None of them ever prints the private key.
import { APP_NAMES, type AppId } from './apps/ids.ts'
import type { MachineCommand } from './args.ts'
import { readCredential, signedInSlots } from './credentials.ts'
import { originArgs } from './hooks.ts'
import type { Io } from './io.ts'
import { machineLink } from './link.ts'
import { attest, clockOffset, machinePath, readMachine, rotateMachine } from './machine.ts'
import { computerName } from './remote.ts'
import { checkSignIn } from './signin.ts'

/** `pendingyou machine status`: this computer's key, and whether Pending You knows each of its connections here by it. */
export async function machineStatus(io: Io, origin: string): Promise<number> {
  const flag = originArgs(origin)
  const machine = await readMachine(io)
  if (!machine) {
    io.out(
      `This computer has no key yet. npx -y pendingyou@latest init${flag} makes one, and proves it to Pending You.\n`,
    )
    return 1
  }
  const lines = [
    `This computer’s key: ${machinePath(io)} (made ${machine.createdAt.slice(0, 10)})`,
    `Its fingerprint: ${machine.thumbprint}`,
  ]
  let ready = true
  const apps: AppId[] = []
  for (const slot of await signedInSlots(io))
    if (
      slot.origin === origin &&
      (await readCredential(io, origin, slot.app))?.kind === 'connection'
    )
      apps.push(slot.app)
  lines.push(
    apps.length
      ? `At ${origin}:`
      : `No agent here is signed in to ${origin} with a connection of its own, so there’s nothing to prove there.`,
  )
  for (const app of apps) {
    const check = await checkSignIn(io, origin, app)
    const name = APP_NAMES[app]
    if (check.state !== 'ok') {
      ready = false
      lines.push(
        check.state === 'unreachable'
          ? `  ${name}: Pending You couldn’t be reached.`
          : `  ${name}: not signed in; run npx -y pendingyou@latest init${flag}.`,
      )
      continue
    }
    const key = check.for?.machineKey
    if (key === machine.thumbprint) {
      lines.push(
        `  ${name}: known by this key${check.for?.machine ? ` (as ${check.for.machine})` : ''}.`,
      )
      continue
    }
    ready = false
    lines.push(
      key
        ? `  ${name}: known by another key, this computer’s before it was replaced. Once that computer is removed from your Pending You account, npx -y pendingyou@latest init${flag} proves this one.`
        : `  ${name}: not yet. npx -y pendingyou@latest init${flag} proves this key, with nothing to approve.`,
    )
  }
  io.out(`${lines.join('\n')}\n`)
  return ready ? 0 : 1
}

/** `pendingyou machine attest`: an attestation for an app's own device sign-in at `origin`, on stdout only. */
export async function machineAttest(
  io: Io,
  command: { origin: string; clientId: string; cnf?: string; machine?: string },
): Promise<number> {
  const machine = await readMachine(io)
  if (!machine) {
    io.err(
      `pendingyou: This computer has no key yet. Run npx -y pendingyou@latest init${originArgs(command.origin)} first.\n`,
    )
    return 1
  }
  const name = command.machine ?? (await computerName(io)).name
  const offset = await clockOffset(io, command.origin)
  const attestation = await attest(
    machine,
    {
      aud: `${command.origin}/oauth/device`,
      client_id: command.clientId,
      name,
      ...(command.cnf ? { cnf: { jkt: command.cnf } } : {}),
    },
    io.now() + offset,
  )
  io.out(`${attestation}\n`)
  return 0
}

/** `pendingyou machine rotate`: a new key for this computer, after a yes (or `--yes`). */
export async function machineRotate(
  io: Io,
  command: { origin: string; yes: boolean },
): Promise<number> {
  const flag = originArgs(command.origin)
  // A file that isn't a key counts as one to replace.
  const had = await readMachine(io).then(
    (machine) => machine !== null,
    () => true,
  )
  if (had && !command.yes) {
    if (!io.interactive) {
      io.err(
        'pendingyou: This replaces this computer’s key, and Pending You will know it as a new computer. Run it again with --yes to go ahead.\n',
      )
      return 1
    }
    const answer = await io.ask(
      'Replace this computer’s key? Pending You will know it as a new computer. [y/N] ',
    )
    if (!/^y(es)?$/i.test(answer.trim())) {
      io.out('Kept this computer’s key.\n')
      return 1
    }
  }
  const { before, machine } = await rotateMachine(io)
  const lines = [
    `New key for this computer: ${machinePath(io)}`,
    `Its fingerprint: ${machine.thumbprint}${before ? ` (it was ${before})` : ''}`,
    before
      ? `Pending You knows this computer’s connections by the old key until that computer is removed from your account; then npx -y pendingyou@latest init${flag} proves this one for them.`
      : `npx -y pendingyou@latest init${flag} proves it to Pending You.`,
  ]
  io.out(`${lines.join('\n')}\n`)
  return 0
}

/** `pendingyou machine …`. */
export function machine(io: Io, command: MachineCommand): Promise<number> {
  switch (command.sub) {
    case 'status':
      return machineStatus(io, command.origin)
    case 'attest':
      return machineAttest(io, command)
    case 'rotate':
      return machineRotate(io, command)
    case 'link':
      return machineLink(io, command)
  }
}
