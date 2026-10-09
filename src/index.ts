// The command line's parts, for tests elsewhere in the repo (the Worker's sign-in test signs the real client in).
export { getJson, SignInNeeded, Unavailable } from './api.ts'
export { DEFAULT_ORIGIN, parseArgs } from './args.ts'
export { readCredential, updateCredential } from './credentials.ts'
export type { Heard } from './format.ts'
export type { Io, RunResult } from './io.ts'
export { appClients, clientsIn, LINK_PATH, linkClients, machineLink } from './link.ts'
export {
  attest,
  ensureMachine,
  type MachineKey,
  machinePath,
  proveConnections,
  readMachine,
  thumbprintOf,
} from './machine.ts'
export { main } from './main.ts'
export {
  CLIENT_NAME,
  type DeviceAsk,
  type DeviceFlow,
  deviceLink,
  discover,
  register,
  revoke,
  SCOPE,
  signIn,
  signInWithDevice,
  startDevice,
  waitForDevices,
} from './oauth.ts'
export { qrCode, qrLines } from './qr.ts'
/** What the person says to an agent to finish setting up (0.11.0): the app's setup pages say the same. */
export { FINISH_SAY } from './setup.ts'
export { VERSION } from './version.ts'
