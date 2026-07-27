/**
 * The four playable hulls (DESIGN.md §9).
 *
 * Stats are expressed as deltas against the shared `PLAYER` baseline so a hull reads as a
 * legible rule change ("+40% speed") rather than an arbitrary number invented in this file.
 * Shapes are consumed by `ship/geometry.ts` to build a silhouette per hull — the fantasy is
 * that a pilot can name the hull from its outline alone, before colour or HUD ever helps them.
 */

import type { HullDef, HullId } from '../core/types';
import { PLAYER } from '../core/constants';

/* Baseline stats for the default hull. Every other hull is defined as a multiple of these so
 * the relationship to DESIGN.md's percentages stays visible at the call site. */
const BASE_MAX_HULL = 100;
const BASE_MAX_SHIELD = 50;
const BASE_SHIELD_REGEN = 12;
/**
 * Out-of-combat hull regeneration, in hull points per second.
 *
 * Sized against the attrition problem it exists to solve, not against combat throughput: the
 * hull only fully repaired after a boss, i.e. once every seven encounters, so chip damage taken
 * in encounter 1 was still being carried into the boss six fights later. At 1.2/s, the ~12s of
 * downtime between waves returns ~14 hull — 14% of BASE_MAX_HULL. That is enough to erase the
 * cost of a couple of glancing hits per wave and no more; a fight that goes badly still leaves
 * a wound that lasts the sector. Gated on the same shieldDelay window as shields, so it never
 * ticks while anything is shooting at you.
 */
const BASE_HULL_REGEN = 1.2;
/** Linear acceleration in world units/s^2. Not modelled in PLAYER (flight.ts owns the curve),
 * so the baseline lives here and hulls scale it in lockstep with top speed. */
const BASE_ACCELERATION = 60;

export const HULLS: Readonly<Record<HullId, HullDef>> = {
  starfall: {
    id: 'starfall',
    displayName: 'Starfall',
    description:
      'The all-rounder. Balanced in every stat, with an extra augment reroll per draft.',
    maxHull: BASE_MAX_HULL,
    maxShield: BASE_MAX_SHIELD,
    shieldDelay: PLAYER.shieldDelay,
    shieldRegen: BASE_SHIELD_REGEN,
    hullRegen: BASE_HULL_REGEN,
    maxSpeed: PLAYER.baseSpeed,
    acceleration: BASE_ACCELERATION,
    turnRate: PLAYER.baseTurnRate,
    boostMultiplier: PLAYER.boostMultiplier,
    driftCooldown: PLAYER.driftCooldown,
    extraRerolls: 1,
    heatCapacity: 1.0,
  },

  vireo: {
    id: 'vireo',
    displayName: 'Vireo',
    description:
      'Glass-cannon interceptor. +40% speed and turn rate, -40% max hull. Drift has no cooldown.',
    maxHull: Math.round(BASE_MAX_HULL * 0.6),
    maxShield: BASE_MAX_SHIELD,
    shieldDelay: PLAYER.shieldDelay,
    // Glass cannon: the hull it does have is not supposed to come back. Vireo's answer to
    // damage is not being there for it, so it regenerates at a third of baseline.
    shieldRegen: BASE_SHIELD_REGEN,
    hullRegen: BASE_HULL_REGEN / 3,
    maxSpeed: Math.round(PLAYER.baseSpeed * 1.4),
    acceleration: Math.round(BASE_ACCELERATION * 1.4),
    turnRate: PLAYER.baseTurnRate * 1.4,
    boostMultiplier: PLAYER.boostMultiplier,
    driftCooldown: 0,
    extraRerolls: 0,
    heatCapacity: 1.0,
  },

  bastion: {
    id: 'bastion',
    displayName: 'Bastion',
    description:
      'Assault gunship. +80% max hull, -25% speed. Shields regenerate even in combat.',
    maxHull: Math.round(BASE_MAX_HULL * 1.8),
    maxShield: BASE_MAX_SHIELD,
    // "Regenerate in combat" is modelled as a short delay rather than zero, so a shield break
    // still reads as a punishing event — it just recovers faster than the other hulls.
    shieldDelay: 0.8,
    shieldRegen: BASE_SHIELD_REGEN,
    // Doubles down on the hull's existing identity — it is the one that survives attrition, so
    // it is the one whose plating comes back fastest. 2x baseline on 1.8x max hull still means
    // a full heal from empty takes ~75s of uninterrupted downtime, which never happens.
    hullRegen: BASE_HULL_REGEN * 2,
    maxSpeed: Math.round(PLAYER.baseSpeed * 0.75),
    acceleration: Math.round(BASE_ACCELERATION * 0.75),
    turnRate: PLAYER.baseTurnRate,
    boostMultiplier: PLAYER.boostMultiplier,
    driftCooldown: PLAYER.driftCooldown,
    extraRerolls: 0,
    heatCapacity: 1.0,
  },

  wraith: {
    id: 'wraith',
    displayName: 'Wraith',
    description: 'Technical hull. Starts with two primaries and swaps between them freely.',
    // The distinguishing rule is the weapon swap (owned by player.ts / weapons.ts), not a stat
    // delta — so this hull is stat-neutral against the baseline.
    maxHull: BASE_MAX_HULL,
    maxShield: BASE_MAX_SHIELD,
    shieldDelay: PLAYER.shieldDelay,
    shieldRegen: BASE_SHIELD_REGEN,
    hullRegen: BASE_HULL_REGEN,
    maxSpeed: PLAYER.baseSpeed,
    acceleration: BASE_ACCELERATION,
    turnRate: PLAYER.baseTurnRate,
    boostMultiplier: PLAYER.boostMultiplier,
    driftCooldown: PLAYER.driftCooldown,
    extraRerolls: 0,
    heatCapacity: 1.0,
  },
};

export const HULL_ORDER: readonly HullId[] = ['starfall', 'vireo', 'bastion', 'wraith'];

export function getHull(id: HullId): HullDef {
  return HULLS[id];
}

/**
 * Per-hull visual parameters consumed by `buildShip`. Kept separate from `HullDef` because
 * these numbers describe silhouette, not gameplay — a cosmetic-only rework of a hull's shape
 * should never touch the stats block above.
 */
export interface HullShape {
  readonly length: number;
  readonly wingSpan: number;
  /** Leading-edge sweep angle in radians, measured from the spanwise axis. */
  readonly wingSweep: number;
  readonly bodyWidth: number;
  readonly bodyHeight: number;
  readonly engineCount: number;
  readonly muzzleCount: number;
  readonly canards: boolean;
  readonly finCount: number;
  /** Seed for the greeble RNG — fixed per hull so its detailing is identical every run. */
  readonly greebleSeed: number;
  /** Multiplier on the base greeble count. */
  readonly greebleDensity: number;
}

export const HULL_SHAPES: Readonly<Record<HullId, HullShape>> = {
  // Balanced silhouette: moderate sweep, single dorsal fin, a modest set of canards up front.
  starfall: {
    length: 14,
    wingSpan: 13,
    wingSweep: 0.55,
    bodyWidth: 2.2,
    bodyHeight: 1.5,
    engineCount: 2,
    muzzleCount: 2,
    canards: true,
    finCount: 1,
    greebleSeed: 0x1001,
    greebleDensity: 1.0,
  },
  // Narrow and long with heavily swept wings and no canards — reads as a thin dart even in
  // silhouette, which is the point: it is the hull the player learns to fear in a dogfight.
  vireo: {
    length: 17.5,
    wingSpan: 11,
    wingSweep: 0.9,
    bodyWidth: 1.5,
    bodyHeight: 1.1,
    engineCount: 2,
    muzzleCount: 2,
    canards: false,
    finCount: 1,
    greebleSeed: 0x2002,
    greebleDensity: 0.7,
  },
  // Wide, blunt, front-heavy, four engines — the widest wingspan and body of any hull so it
  // reads as a slow brick even before the player sees the extra nacelles.
  bastion: {
    length: 13,
    wingSpan: 17,
    wingSweep: 0.22,
    bodyWidth: 3.6,
    bodyHeight: 2.4,
    engineCount: 4,
    muzzleCount: 3,
    canards: true,
    finCount: 2,
    greebleSeed: 0x3003,
    greebleDensity: 1.5,
  },
  // Angular twin-boom asymmetric hull. `finCount: 2` plus geometry.ts keying off the hullId to
  // stagger the two booms is what actually sells "asymmetric" — no shape field forces symmetry,
  // buildShip just chooses not to mirror this one hull perfectly.
  wraith: {
    length: 15.5,
    wingSpan: 14.5,
    wingSweep: 0.68,
    bodyWidth: 1.9,
    bodyHeight: 1.3,
    engineCount: 2,
    muzzleCount: 2,
    canards: false,
    finCount: 2,
    greebleSeed: 0x4004,
    greebleDensity: 1.1,
  },
};
