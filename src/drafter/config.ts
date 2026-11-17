// The drafter's settings on a computer (the chief, 2026-11-16: thresholds and the unsure action are configuration, so
// they change without a release of logic): `<config>/drafter/config.json`, `{ "tiers": [{ "model", "below" }],
// "unsure": "card" | "quiet" | "none", "atLimit": "stop" | "go" }`, each part optional. Anything it can't read is left at DEFAULT_CONFIG.
import { join } from 'node:path'
import { configDir, readJson } from '../files.ts'
import type { Io } from '../io.ts'
import {
  type AtLimit,
  DEFAULT_CONFIG,
  type DrafterConfig,
  type TierConfig,
  type UnsureAction,
} from './types.ts'

/** The most tiers a turn goes through. */
export const MAX_TIERS = 3
/** Models a tier may name: Claude Code's aliases and full model ids, nothing that could be read as a flag. */
const MODEL = /^[a-z][a-z0-9.-]{1,60}$/

export const configPath = (io: Pick<Io, 'env' | 'home'>) =>
  join(configDir(io), 'drafter', 'config.json')

/** The settings from what the file holds: its valid parts over the defaults. */
export function configOf(value: unknown): DrafterConfig {
  if (typeof value !== 'object' || value === null) return DEFAULT_CONFIG
  const given = value as { tiers?: unknown; unsure?: unknown; atLimit?: unknown }
  const tiers = Array.isArray(given.tiers)
    ? given.tiers.flatMap((tier): TierConfig[] => {
        if (typeof tier !== 'object' || tier === null) return []
        const { model, below } = tier as { model?: unknown; below?: unknown }
        if (typeof model !== 'string' || !MODEL.test(model)) return []
        if (typeof below !== 'number' || !(below >= 0 && below <= 1)) return []
        return [{ model, below }]
      })
    : []
  const unsure: UnsureAction =
    given.unsure === 'card' || given.unsure === 'quiet' || given.unsure === 'none'
      ? given.unsure
      : DEFAULT_CONFIG.unsure
  const atLimit: AtLimit =
    given.atLimit === 'stop' || given.atLimit === 'go' ? given.atLimit : DEFAULT_CONFIG.atLimit
  return {
    tiers: tiers.length && tiers.length <= MAX_TIERS ? tiers : DEFAULT_CONFIG.tiers,
    unsure,
    atLimit,
  }
}

/** This computer's settings. */
export async function readConfig(io: Pick<Io, 'env' | 'home'>): Promise<DrafterConfig> {
  return configOf(await readJson(configPath(io)).catch(() => null))
}
