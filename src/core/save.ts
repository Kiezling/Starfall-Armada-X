/**
 * Meta-progression persistence.
 *
 * `MetaState` survives across runs, so unlike `settings.ts` its localStorage blob is not just
 * "player preference" that can safely degrade to a default — it gates which hulls and weapons
 * the hangar and draft pool are allowed to offer. A hand-edited or stale save must never be
 * able to inject an id that combat, hangar, or draft code will later index a definition table
 * with and fail to find; every id array is validated against the known id set on load.
 */

import type { HullId, MetaState, PrimaryWeaponId, SecondaryWeaponId } from './types';
import { STORAGE } from './constants';

const STARTER_HULL: HullId = 'starfall';
const STARTER_PRIMARY: PrimaryWeaponId = 'pulseRepeater';
const STARTER_SECONDARY: SecondaryWeaponId = 'swarmMissiles';

const KNOWN_HULLS: readonly HullId[] = ['starfall', 'vireo', 'bastion', 'wraith'];
const KNOWN_PRIMARIES: readonly PrimaryWeaponId[] = [
  'pulseRepeater',
  'lanceDriver',
  'scatterVents',
  'arcTether',
  'flakBattery',
  'singularityCoil',
];
const KNOWN_SECONDARIES: readonly SecondaryWeaponId[] = [
  'swarmMissiles',
  'novaMine',
  'phaseLance',
  'gravityWell',
  'aegisPulse',
];

export function createDefaultMeta(): MetaState {
  return {
    totalSalvage: 0,
    unlockedHulls: [STARTER_HULL],
    unlockedPrimaries: [STARTER_PRIMARY],
    unlockedSecondaries: [STARTER_SECONDARY],
    unlockedAugments: [],
    bestSector: 0,
    bestScore: 0,
    runsPlayed: 0,
    onboarded: false,
  };
}

/** Keeps only entries that are strings present in `known`, and drops duplicates. */
function sanitizeKnownIds<T extends string>(raw: unknown, known: readonly T[]): T[] {
  const out: T[] = [];
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (typeof entry === 'string' && (known as readonly string[]).includes(entry) && !out.includes(entry as T)) {
      out.push(entry as T);
    }
  }
  return out;
}

/**
 * Augment ids are open-ended (defined by content, not by this module), so there is no known-id
 * set to check against here. What we can still guarantee is that every entry is a non-empty
 * string with no duplicates, so downstream `Map`/lookup code never trips on a non-string key.
 */
function sanitizeAugmentIds(raw: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.length > 0 && !out.includes(entry)) out.push(entry);
  }
  return out;
}

function readCount(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

/**
 * Schema-tolerant load: corrupt JSON, a missing key, or an unknown id anywhere in the arrays
 * degrades gracefully rather than throwing. The starter loadout is always force-included so a
 * damaged save can never leave the player with nothing equippable.
 */
export function loadMeta(): MetaState {
  const defaults = createDefaultMeta();

  let parsed: unknown;
  try {
    const stored = localStorage.getItem(STORAGE.meta);
    if (!stored) return defaults;
    parsed = JSON.parse(stored);
  } catch {
    return defaults;
  }
  if (parsed === null || typeof parsed !== 'object') return defaults;
  const rec = parsed as Record<string, unknown>;

  const hulls = sanitizeKnownIds(rec.unlockedHulls, KNOWN_HULLS);
  if (!hulls.includes(STARTER_HULL)) hulls.unshift(STARTER_HULL);

  const primaries = sanitizeKnownIds(rec.unlockedPrimaries, KNOWN_PRIMARIES);
  if (!primaries.includes(STARTER_PRIMARY)) primaries.unshift(STARTER_PRIMARY);

  const secondaries = sanitizeKnownIds(rec.unlockedSecondaries, KNOWN_SECONDARIES);
  if (!secondaries.includes(STARTER_SECONDARY)) secondaries.unshift(STARTER_SECONDARY);

  return {
    totalSalvage: readCount(rec.totalSalvage, defaults.totalSalvage),
    unlockedHulls: hulls,
    unlockedPrimaries: primaries,
    unlockedSecondaries: secondaries,
    unlockedAugments: sanitizeAugmentIds(rec.unlockedAugments),
    bestSector: readCount(rec.bestSector, defaults.bestSector),
    bestScore: readCount(rec.bestScore, defaults.bestScore),
    runsPlayed: readCount(rec.runsPlayed, defaults.runsPlayed),
    onboarded: typeof rec.onboarded === 'boolean' ? rec.onboarded : defaults.onboarded,
  };
}

export function saveMeta(m: MetaState): void {
  try {
    localStorage.setItem(STORAGE.meta, JSON.stringify(m));
  } catch {
    // Quota/private-mode failure: progress for this run simply won't be recorded.
  }
}

export function resetMeta(): MetaState {
  const defaults = createDefaultMeta();
  saveMeta(defaults);
  return defaults;
}

export function isUnlocked(
  meta: MetaState,
  kind: 'hull' | 'primary' | 'secondary' | 'augment',
  id: string,
): boolean {
  switch (kind) {
    case 'hull':
      return meta.unlockedHulls.includes(id as HullId);
    case 'primary':
      return meta.unlockedPrimaries.includes(id as PrimaryWeaponId);
    case 'secondary':
      return meta.unlockedSecondaries.includes(id as SecondaryWeaponId);
    case 'augment':
      return meta.unlockedAugments.includes(id);
  }
}

/** Mutates `meta` in place. Returns false without changes when `id` was already unlocked. */
export function unlock(
  meta: MetaState,
  kind: 'hull' | 'primary' | 'secondary' | 'augment',
  id: string,
): boolean {
  if (isUnlocked(meta, kind, id)) return false;
  switch (kind) {
    case 'hull':
      meta.unlockedHulls.push(id as HullId);
      break;
    case 'primary':
      meta.unlockedPrimaries.push(id as PrimaryWeaponId);
      break;
    case 'secondary':
      meta.unlockedSecondaries.push(id as SecondaryWeaponId);
      break;
    case 'augment':
      meta.unlockedAugments.push(id);
      break;
  }
  return true;
}
