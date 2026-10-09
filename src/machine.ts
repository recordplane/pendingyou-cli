// This computer's key (0.18.0; Pending You's person API plan §4.2: a computer is known by a key, not its name). init
// makes a key pair once per computer and OS user, kept in ~/.config/pendingyou/machine.json: readable only by you (0600,
// in the 0700 folder with its .gitignore of `*`), shared by every Pending You address, written whole, never sent
// anywhere, never printed and never logged. A file someone loosened is tightened again on the next read. Pending You
// keeps only its public key's fingerprint (its RFC 7638 thumbprint), and knows the computer by it: two computers called
// "MacBook Pro" are two computers, and one renamed is still one.
//
// The command line proves the key with an attestation, a JWS it signs ES256 with the public key in its header, for one
// audience and one client, at most 5 minutes old, once (its jti):
// - every device sign-in it starts carries one (`machine_attestation`, for `<origin>/oauth/device`): whoever allows the
//   sign-in enrolls this computer, and the connection it makes belongs to it;
// - init proves it for each of this computer's connections already signed in (POST /mcp/cli/machine, for
//   `<origin>/mcp/cli/machine`, with that connection's own sign-in): a computer set up before 0.18.0 gets its key on its
//   next init, with nothing to approve and no new sign-in. Its hooks run the copy init installed, so before then
//   nothing runs that would make one;
// - `pendingyou machine attest` makes one for an app's own device sign-in, and `pendingyou app login` (0.21.0) for the
//   app it signs in (app-login.ts), naming Pending You's own by its slug.
// Each is dated by Pending You's own clock (its answers' Date), so a computer whose clock is off still proves its key.
//
// `pendingyou machine status` says whether Pending You knows this computer by its key, and `rotate` makes a new one
// (machine-command.ts).
import { createHash, randomBytes, webcrypto } from 'node:crypto'
import { chmod, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { sendJson } from './api.ts'
import type { AppId } from './apps/ids.ts'
import { connectionMachine, ignoreFolder, readCredential } from './credentials.ts'
import { PlainError } from './errors.ts'
import { configDir, readJson, withLock, writeWhole } from './files.ts'
import type { Io } from './io.ts'
import { discover, type Prover } from './oauth.ts'
import { machineOf } from './remote.ts'
import { proof as dpopProof } from './sdk/dpop.ts'

/** What an attestation says it is, in its header (apps/pendingyou/worker/oauth/machines.ts checks it). */
export const ATTESTATION_TYPE = 'pendingyou-machine+jwt'
/** How long one is good for: the most Pending You takes. */
const ATTESTATION_SECONDS = 300
/** Where a connection proves this computer's key on init. */
export const MACHINE_PATH = '/mcp/cli/machine'

export const machinePath = (io: Pick<Io, 'env' | 'home'>) => join(configDir(io), 'machine.json')

/** A P-256 key as a JWK: the public members, and `d`, the private one, which never leaves the file. */
interface PrivateJwk {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
  d: string
}

interface MachineFile {
  version: 1
  createdAt: string
  key: PrivateJwk
}

export interface MachineKey {
  /** Its public key's RFC 7638 thumbprint (base64url): how Pending You knows this computer. */
  thumbprint: string
  /** When it was made (ISO). */
  createdAt: string
  /** The public half, as an attestation's header carries it. */
  jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }
  /** The private half, held for signing only. */
  signer: webcrypto.CryptoKey
}

const base64url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString('base64url')

/** 32 bytes as base64url, exactly: a P-256 coordinate or private scalar. */
const isCoordinate = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[A-Za-z0-9_-]{43}$/.test(value) &&
  Buffer.from(value, 'base64url').length === 32

/** RFC 7638: SHA-256 of the key's required members, in order, with no whitespace. */
export function thumbprintOf(jwk: { crv: string; kty: string; x: string; y: string }): string {
  return createHash('sha256')
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest('base64url')
}

/** The key the file holds, when it's a P-256 private key; null for anything else. */
function keyOf(value: unknown): PrivateJwk | null {
  if (typeof value !== 'object' || value === null) return null
  const { kty, crv, x, y, d } = value as Record<string, unknown>
  if (kty !== 'EC' || crv !== 'P-256' || !isCoordinate(x) || !isCoordinate(y) || !isCoordinate(d))
    return null
  return { kty, crv, x, y, d }
}

async function loaded(key: PrivateJwk, createdAt: string): Promise<MachineKey> {
  const signer = await webcrypto.subtle.importKey(
    'jwk',
    key,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const jwk = { kty: key.kty, crv: key.crv, x: key.x, y: key.y }
  return { thumbprint: thumbprintOf(jwk), createdAt, jwk, signer }
}

const unreadable = (path: string) =>
  new PlainError(
    `This computer’s key (${path}) can’t be read. Run npx pendingyou machine rotate to make a new one.`,
  )

/** This computer's key, or null when it has none yet. One that's there but isn't a key is a PlainError: never replaced. */
export async function readMachine(io: Pick<Io, 'env' | 'home'>): Promise<MachineKey | null> {
  const path = machinePath(io)
  let file: Partial<MachineFile> | null
  try {
    file = await readJson<Partial<MachineFile>>(path)
  } catch {
    throw unreadable(path)
  }
  if (file === null) return null
  const key = file?.version === 1 && typeof file.createdAt === 'string' ? keyOf(file.key) : null
  if (!key || typeof file?.createdAt !== 'string') throw unreadable(path)
  // Readable only by you, however it was left.
  if ((await stat(path)).mode & 0o077) await chmod(path, 0o600)
  try {
    return await loaded(key, file.createdAt)
  } catch {
    // Not a point on the curve.
    throw unreadable(path)
  }
}

/** A new key pair, written whole in place of whatever was there. */
async function writeNew(io: Pick<Io, 'env' | 'home' | 'now' | 'sleep'>): Promise<MachineKey> {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const key = keyOf(await webcrypto.subtle.exportKey('jwk', pair.privateKey))
  if (!key) throw new PlainError('This computer’s key couldn’t be made.')
  const createdAt = new Date(io.now()).toISOString()
  const file: MachineFile = {
    version: 1,
    createdAt,
    key: { kty: key.kty, crv: key.crv, x: key.x, y: key.y, d: key.d },
  }
  await writeWhole(machinePath(io), `${JSON.stringify(file, null, 2)}\n`, { secret: true })
  await ignoreFolder(io).catch(() => {})
  return loaded(key, createdAt)
}

/** This computer's key, made now when it has none (`made`). Under the file's lock, so two inits at once make one. */
export async function ensureMachine(
  io: Pick<Io, 'env' | 'home' | 'now' | 'sleep'>,
): Promise<{ machine: MachineKey; made: boolean }> {
  return withLock(machinePath(io), io, async () => {
    const machine = await readMachine(io)
    return machine ? { machine, made: false } : { machine: await writeNew(io), made: true }
  })
}

/** A new key in place of this computer's (or of a file that wasn't one): the thumbprint it had, and the new key. */
export async function rotateMachine(
  io: Pick<Io, 'env' | 'home' | 'now' | 'sleep'>,
): Promise<{ before: string | null; machine: MachineKey }> {
  return withLock(machinePath(io), io, async () => {
    const before = await readMachine(io).catch(() => null)
    return { before: before?.thumbprint ?? null, machine: await writeNew(io) }
  })
}

/**
 * What an attestation vouches for: the audience, the client signing in (or, for Pending You's own app named by its slug,
 * that app and no client: 0.21.0's `app login herdr`), the computer's name, and (an app's) the key its grant is bound to.
 */
export type AttestationClaims = {
  aud: string
  name: string
  /** A person app's own key for its grant (Pending You's plan §4.2, §4.3: DPoP). */
  cnf?: { jkt: string }
} & ({ client_id: string; app?: never } | { app: string; client_id?: never })

/**
 * An attestation: this computer's key vouching for one request, dated `now` (milliseconds: Pending You's time when it's
 * known), good for 5 minutes, once.
 */
export async function attest(
  machine: MachineKey,
  claims: AttestationClaims,
  now: number,
): Promise<string> {
  const iat = Math.floor(now / 1000)
  const header = { typ: ATTESTATION_TYPE, alg: 'ES256', jwk: machine.jwk }
  const payload = {
    ...claims,
    iat,
    exp: iat + ATTESTATION_SECONDS,
    jti: randomBytes(16).toString('base64url'),
  }
  const signing = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
  const signature = await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    machine.signer,
    Buffer.from(signing),
  )
  return `${signing}.${base64url(new Uint8Array(signature))}`
}

/**
 * Proofs by this computer's key for its own connections' refreshes (0.30.0): a DPoP proof (RFC 9449, ES256,
 * the public key in its header) for one request, dated `now`, with the server's nonce when it gave one. Pending You
 * renews a sign-in whose refresh is proven by the key of the computer it's on, so it lasts while it's used here; its
 * tokens are unchanged. None when this computer has no key yet, or it can't be read: refreshes go on without.
 */
export async function machineProver(io: Pick<Io, 'env' | 'home'>): Promise<Prover | undefined> {
  const machine = await readMachine(io).catch(() => null)
  if (!machine) return undefined
  // The SDK's proofs (sdk/dpop.ts), the only DPoP the command line makes, signed by this computer's key.
  // Node's own CryptoKey is the global one: its types differ only in usages WebCrypto's lib doesn't list yet.
  const key = { jwk: machine.jwk, jkt: machine.thumbprint, privateKey: machine.signer as CryptoKey }
  return ({ method, url, nonce, now }) =>
    dpopProof(key, { method, url, now, ...(nonce ? { nonce } : {}) })
}

/**
 * This computer's key for a sign-in (init, login): made now when there's none, and said so; null when it can't be
 * read or made, said too, and the sign-in goes on without it.
 */
export async function keyForSignIn(io: Io): Promise<MachineKey | null> {
  try {
    const { machine, made } = await ensureMachine(io)
    if (made)
      io.out(
        `Made this computer’s key for Pending You (${machinePath(io)}): it stays on this computer, and Pending You knows the computer by it.\n`,
      )
    return machine
  } catch (error) {
    io.err(
      `pendingyou: ${error instanceof PlainError ? error.message : 'This computer’s key couldn’t be made.'} Signing in without it.\n`,
    )
    return null
  }
}

/** How proving the key went for one connection: its answer's `connection`, or why there was none. */
export type Proven = 'joined' | 'already' | 'elsewhere' | 'absent' | 'refused' | 'failed'

/** How far Pending You's clock is ahead of this one, as it says now; 0 when it can't be asked. */
export async function clockOffset(io: Pick<Io, 'fetch' | 'now'>, origin: string): Promise<number> {
  return discover(io, origin, 5000).then(
    (metadata) => metadata.clockOffsetMs ?? 0,
    () => 0,
  )
}

/**
 * Proves this computer's key for each of these apps' connections here that's signed in already: POST /mcp/cli/machine
 * with that connection's own sign-in, so Pending You knows which computer it's on (0.18.0). Nothing to approve: a
 * computer set up before 0.18.0 gets its key this way on its next init. Quiet: a Pending You from before machines
 * answers 404, and anything else that goes wrong waits for the next init. How each went, by app.
 */
export async function proveConnections(
  io: Io,
  origin: string,
  apps: readonly AppId[],
  machine: MachineKey,
): Promise<Map<AppId, Proven>> {
  const results = new Map<AppId, Proven>()
  const connected: { app: AppId; clientId: string }[] = []
  for (const app of apps) {
    const credential = await readCredential(io, origin, app)
    if (credential?.kind === 'connection') connected.push({ app, clientId: credential.clientId })
  }
  if (connected.length === 0) return results
  const offset = await clockOffset(io, origin)
  for (const { app, clientId } of connected) {
    try {
      const attestation = await attest(
        machine,
        {
          aud: `${origin}${MACHINE_PATH}`,
          client_id: clientId,
          name: (await connectionMachine(io, origin, app)) ?? machineOf(io.host),
        },
        io.now() + offset,
      )
      const { status, body } = await sendJson<{ connection?: unknown }>(
        io,
        origin,
        MACHINE_PATH,
        { attestation },
        15_000,
        { app },
      )
      const said = body.connection
      results.set(
        app,
        status === 200 && (said === 'joined' || said === 'already' || said === 'elsewhere')
          ? said
          : status === 404
            ? 'absent'
            : status >= 400 && status < 500
              ? 'refused'
              : 'failed',
      )
    } catch {
      results.set(app, 'failed')
    }
  }
  return results
}
