/**
 * The augment pool — the run-scoped power fantasy.
 *
 * Design constraints from DESIGN.md §7.1, enforced here:
 *
 * 1. **No augment is a pure stat stick without a visible consequence.** Every entry either
 *    changes a number the player can feel within one wave, or changes a rule outright.
 * 2. **Drafts, not drops.** `rollDraft` returns three visible options with rarity shown.
 * 3. **Legible RNG.** Rarity weights are fixed and published; the Prototype pity timer is
 *    additive and inspectable via `prototypeOdds`.
 * 4. **Stacking is explicit.** `maxStacks` is per-run and `apply` receives the stack count,
 *    so an augment decides for itself whether it scales linearly, with diminishing returns,
 *    or not at all past the first copy.
 *
 * Multiplier convention: multiplicative stats compose as products (a 1.12 and a 1.10 give
 * 1.232), additive stats as sums. `apply` accumulates into a fresh stats object during a full
 * recompute, so there is never a rollback path to get wrong.
 */

import {
  AugmentCategory,
  Rarity,
  type AugmentDef,
  type Difficulty,
  type HullDef,
  type MetaState,
  type PlayerStats,
  type RunState,
} from '../core/types';
import { DIFFICULTY_MODS, PLAYER, RUN } from '../core/constants';
import { clamp } from '../core/math';
import type { Rng } from '../core/rng';

/* Helpers ------------------------------------------------------------------------------------ */

/**
 * Diminishing-returns stacking. The first stack gives `per`, each subsequent stack gives
 * progressively less. Used where linear stacking would trivialise a stat.
 */
function diminishing(per: number, stacks: number, falloff = 0.82): number {
  let total = 0;
  let step = per;
  for (let i = 0; i < stacks; i++) {
    total += step;
    step *= falloff;
  }
  return total;
}

/* The pool ----------------------------------------------------------------------------------- */

const OFFENSE: AugmentDef[] = [
  {
    id: 'focusedEmitters',
    name: 'Focused Emitters',
    description: '+12% weapon damage per stack.',
    category: AugmentCategory.Offense,
    rarity: Rarity.Common,
    maxStacks: 5,
    apply: (s, n) => {
      s.damageMult *= Math.pow(1.12, n);
    },
  },
  {
    id: 'rapidCycling',
    name: 'Rapid Cycling',
    description: '+10% fire rate per stack.',
    category: AugmentCategory.Offense,
    rarity: Rarity.Common,
    maxStacks: 5,
    apply: (s, n) => {
      s.fireRateMult *= Math.pow(1.1, n);
    },
  },
  {
    id: 'acceleratorCoils',
    name: 'Accelerator Coils',
    description: '+18% projectile speed per stack. Easier leading, longer effective range.',
    category: AugmentCategory.Offense,
    rarity: Rarity.Common,
    maxStacks: 3,
    apply: (s, n) => {
      s.projectileSpeedMult *= Math.pow(1.18, n);
    },
  },
  {
    id: 'hairlineSights',
    name: 'Hairline Sights',
    description: '+6% critical chance per stack.',
    category: AugmentCategory.Offense,
    rarity: Rarity.Common,
    maxStacks: 5,
    apply: (s, n) => {
      s.critChance += 0.06 * n;
    },
  },
  {
    id: 'overpressureRounds',
    name: 'Overpressure Rounds',
    description: '+25% damage per stack, but +15% heat generation.',
    category: AugmentCategory.Offense,
    rarity: Rarity.Rare,
    maxStacks: 3,
    apply: (s, n) => {
      s.damageMult *= Math.pow(1.25, n);
      s.heatMult *= Math.pow(1.15, n);
    },
  },
  {
    id: 'executioner',
    name: 'Executioner',
    description: '+45% critical damage per stack.',
    category: AugmentCategory.Offense,
    rarity: Rarity.Rare,
    maxStacks: 3,
    apply: (s, n) => {
      s.critMult += 0.45 * n;
    },
  },
  {
    id: 'piercingCores',
    name: 'Piercing Cores',
    description: 'Projectiles pass through 1 additional enemy per stack.',
    category: AugmentCategory.Offense,
    rarity: Rarity.Rare,
    maxStacks: 3,
    apply: (s, n) => {
      s.pierceBonus += n;
    },
  },
  {
    id: 'twinLink',
    name: 'Twin-Link Array',
    description: '+1 projectile per volley, but −10% damage per projectile.',
    category: AugmentCategory.Offense,
    rarity: Rarity.Rare,
    maxStacks: 2,
    apply: (s, n) => {
      s.extraShots += n;
      s.damageMult *= Math.pow(0.9, n);
    },
  },
  {
    id: 'blastFormulae',
    name: 'Blast Formulae',
    description: '+30% explosion radius per stack.',
    category: AugmentCategory.Offense,
    rarity: Rarity.Rare,
    maxStacks: 3,
    apply: (s, n) => {
      s.aoeMult *= Math.pow(1.3, n);
    },
  },
  {
    id: 'pointBlankDoctrine',
    name: 'Point-Blank Doctrine',
    description: '+60% damage to enemies within 45m. Get uncomfortably close.',
    category: AugmentCategory.Offense,
    rarity: Rarity.Prototype,
    maxStacks: 1,
    ruleChanging: true,
    apply: (s) => {
      s.pointBlankBonus = 0.6;
      s.pointBlankRange = 45;
    },
  },
  {
    id: 'executionersMark',
    name: "Executioner's Mark",
    description: 'Double damage to enemies below 25% hull.',
    category: AugmentCategory.Offense,
    rarity: Rarity.Prototype,
    maxStacks: 1,
    ruleChanging: true,
    apply: (s) => {
      s.executeBonus = 1.0;
    },
  },
  {
    id: 'glassCannon',
    name: 'Glass Cannon',
    description: '+70% damage. −35% maximum hull. No second chances.',
    category: AugmentCategory.Offense,
    rarity: Rarity.Prototype,
    maxStacks: 1,
    ruleChanging: true,
    apply: (s) => {
      s.damageMult *= 1.7;
      s.maxHull *= 0.65;
    },
  },
];

const DEFENSE: AugmentDef[] = [
  {
    id: 'plating',
    name: 'Ablative Plating',
    description: '+25 maximum hull per stack.',
    category: AugmentCategory.Defense,
    rarity: Rarity.Common,
    maxStacks: 5,
    apply: (s, n) => {
      s.maxHull += 25 * n;
    },
  },
  {
    id: 'capacitors',
    name: 'Shield Capacitors',
    description: '+20 maximum shield per stack.',
    category: AugmentCategory.Defense,
    rarity: Rarity.Common,
    maxStacks: 5,
    apply: (s, n) => {
      s.maxShield += 20 * n;
    },
  },
  {
    id: 'rapidRecharge',
    name: 'Rapid Recharge',
    description: '+25% shield regeneration rate per stack.',
    category: AugmentCategory.Defense,
    rarity: Rarity.Common,
    maxStacks: 4,
    apply: (s, n) => {
      s.shieldRegenMult *= Math.pow(1.25, n);
    },
  },
  {
    id: 'ablativeWeave',
    name: 'Ablative Weave',
    description: '+5% damage reduction per stack, with diminishing returns.',
    category: AugmentCategory.Defense,
    rarity: Rarity.Common,
    maxStacks: 4,
    apply: (s, n) => {
      s.damageReduction += diminishing(0.05, n);
    },
  },
  {
    id: 'reinforcedSpars',
    name: 'Reinforced Spars',
    description: '+60 maximum hull per stack.',
    category: AugmentCategory.Defense,
    rarity: Rarity.Rare,
    maxStacks: 3,
    apply: (s, n) => {
      s.maxHull += 60 * n;
    },
  },
  {
    id: 'emergencyVents',
    name: 'Emergency Vents',
    description: 'Shields immediately refill 30% when broken, per stack.',
    category: AugmentCategory.Defense,
    rarity: Rarity.Rare,
    maxStacks: 2,
    apply: (s, n) => {
      s.shieldBreakRefund += 0.3 * n;
    },
  },
  {
    id: 'hardenedCore',
    name: 'Hardened Core',
    description: '+10% damage reduction per stack.',
    category: AugmentCategory.Defense,
    rarity: Rarity.Rare,
    maxStacks: 2,
    apply: (s, n) => {
      s.damageReduction += diminishing(0.1, n);
    },
  },
  {
    id: 'overhealCells',
    name: 'Overheal Cells',
    description: 'Healing beyond maximum hull becomes temporary shield.',
    category: AugmentCategory.Defense,
    rarity: Rarity.Rare,
    maxStacks: 1,
    ruleChanging: true,
    apply: (s) => {
      s.overhealToShield = true;
    },
  },
  {
    id: 'bulwarkField',
    name: 'Bulwark Field',
    description: '+18% damage reduction while shields are up.',
    category: AugmentCategory.Defense,
    rarity: Rarity.Rare,
    maxStacks: 2,
    apply: (s, n) => {
      s.shieldedDR += diminishing(0.18, n);
    },
  },
  {
    id: 'reactiveArmor',
    name: 'Reactive Armour',
    description: 'Taking damage grants 25% damage reduction for 3s.',
    category: AugmentCategory.Defense,
    rarity: Rarity.Prototype,
    maxStacks: 1,
    ruleChanging: true,
    apply: (s) => {
      s.reactiveArmor = 0.25;
    },
  },
  {
    id: 'secondWind',
    name: 'Second Wind',
    description: 'Once per sector, survive a lethal hit at 1 hull with 2s of invulnerability.',
    category: AugmentCategory.Defense,
    rarity: Rarity.Prototype,
    maxStacks: 1,
    requiresUnlock: true,
    ruleChanging: true,
    apply: (s) => {
      s.secondWind = true;
    },
  },
  {
    id: 'aegisReversal',
    name: 'Aegis Reversal',
    description: 'When your shields break, the shot that broke them is reflected back, doubled.',
    category: AugmentCategory.Defense,
    rarity: Rarity.Prototype,
    maxStacks: 1,
    requiresUnlock: true,
    ruleChanging: true,
    apply: (s) => {
      s.aegisReversal = true;
    },
  },
];

const MOBILITY: AugmentDef[] = [
  {
    id: 'thrusterTuning',
    name: 'Thruster Tuning',
    description: '+10% top speed per stack.',
    category: AugmentCategory.Mobility,
    rarity: Rarity.Common,
    maxStacks: 5,
    apply: (s, n) => {
      s.speedMult *= Math.pow(1.1, n);
    },
  },
  {
    id: 'gyroCalibration',
    name: 'Gyro Calibration',
    description: '+12% turn rate per stack.',
    category: AugmentCategory.Mobility,
    rarity: Rarity.Common,
    maxStacks: 5,
    apply: (s, n) => {
      s.turnRateMult *= Math.pow(1.12, n);
    },
  },
  {
    id: 'boostReserves',
    name: 'Boost Reserves',
    description: '+25% boost capacity and recharge per stack.',
    category: AugmentCategory.Mobility,
    rarity: Rarity.Common,
    maxStacks: 4,
    apply: (s, n) => {
      s.boostMult *= Math.pow(1.25, n);
    },
  },
  {
    id: 'featherweight',
    name: 'Featherweight Frame',
    description: '+18% speed, but −20 maximum hull.',
    category: AugmentCategory.Mobility,
    rarity: Rarity.Common,
    maxStacks: 3,
    apply: (s, n) => {
      s.speedMult *= Math.pow(1.18, n);
      s.maxHull -= 20 * n;
    },
  },
  {
    id: 'driftBearings',
    name: 'Drift Bearings',
    description: '−30% drift cooldown per stack.',
    category: AugmentCategory.Mobility,
    rarity: Rarity.Rare,
    maxStacks: 3,
    apply: (s, n) => {
      s.driftCooldownMult *= Math.pow(0.7, n);
    },
  },
  {
    id: 'afterburners',
    name: 'Afterburners',
    description: '+25% boost speed per stack.',
    category: AugmentCategory.Mobility,
    rarity: Rarity.Rare,
    maxStacks: 2,
    apply: (s, n) => {
      s.boostMult *= Math.pow(1.25, n);
    },
  },
  {
    id: 'inertialDampers',
    name: 'Inertial Dampers',
    description: '+20% turn rate while drifting, per stack.',
    category: AugmentCategory.Mobility,
    rarity: Rarity.Rare,
    maxStacks: 2,
    apply: (s, n) => {
      s.driftTurnBonus += 0.2 * n;
    },
  },
  {
    id: 'evasiveProtocols',
    name: 'Evasive Protocols',
    description: '+15% speed for 1.5s after taking damage.',
    category: AugmentCategory.Mobility,
    rarity: Rarity.Rare,
    maxStacks: 2,
    apply: (s, n) => {
      s.hitSpeedBonus += 0.15 * n;
    },
  },
  {
    id: 'slipstream',
    name: 'Slipstream',
    description: 'Each kill grants +40% speed for 2s. Refreshes on every kill.',
    category: AugmentCategory.Mobility,
    rarity: Rarity.Prototype,
    maxStacks: 1,
    ruleChanging: true,
    apply: (s) => {
      s.killSpeedBonus = 0.4;
    },
  },
  {
    id: 'momentumCore',
    name: 'Momentum Core',
    description: 'Damage scales with your current speed, up to +50% at full throttle.',
    category: AugmentCategory.Mobility,
    rarity: Rarity.Prototype,
    maxStacks: 1,
    requiresUnlock: true,
    ruleChanging: true,
    apply: (s) => {
      s.momentumBonus = 0.5;
    },
  },
];

const SYSTEMS: AugmentDef[] = [
  {
    id: 'coolantLoop',
    name: 'Coolant Loop',
    description: '−15% heat generation per stack.',
    category: AugmentCategory.Systems,
    rarity: Rarity.Common,
    maxStacks: 4,
    apply: (s, n) => {
      s.heatMult *= Math.pow(0.85, n);
    },
  },
  {
    id: 'salvageMagnets',
    name: 'Salvage Magnets',
    description: '+80% salvage pickup radius per stack.',
    category: AugmentCategory.Systems,
    rarity: Rarity.Common,
    maxStacks: 3,
    apply: (s, n) => {
      s.magnetMult *= Math.pow(1.8, n);
    },
  },
  {
    id: 'munitionsBay',
    name: 'Munitions Bay',
    description: '+1 secondary charge per stack.',
    category: AugmentCategory.Systems,
    rarity: Rarity.Rare,
    maxStacks: 2,
    apply: (s, n) => {
      s.secondaryCharges += n;
    },
  },
  {
    id: 'rapidLoaders',
    name: 'Rapid Loaders',
    description: '−25% secondary cooldown per stack.',
    category: AugmentCategory.Systems,
    rarity: Rarity.Rare,
    maxStacks: 3,
    apply: (s, n) => {
      s.secondaryCooldownMult *= Math.pow(0.75, n);
    },
  },
  {
    id: 'guidanceUplink',
    name: 'Guidance Uplink',
    description: 'All projectiles gain slight homing. Stacks tighten the turn.',
    category: AugmentCategory.Systems,
    rarity: Rarity.Rare,
    maxStacks: 3,
    ruleChanging: true,
    apply: (s, n) => {
      s.homingBonus += 0.9 * n;
    },
  },
  {
    id: 'vampiricCoils',
    name: 'Vampiric Coils',
    description: 'Heal for 4% of damage dealt, per stack.',
    category: AugmentCategory.Systems,
    rarity: Rarity.Rare,
    maxStacks: 3,
    ruleChanging: true,
    apply: (s, n) => {
      s.lifesteal += 0.04 * n;
    },
  },
  {
    id: 'adaptiveTargeting',
    name: 'Adaptive Targeting',
    description: '+25% damage to your locked target, per stack.',
    category: AugmentCategory.Systems,
    rarity: Rarity.Rare,
    maxStacks: 2,
    apply: (s, n) => {
      s.lockedTargetBonus += 0.25 * n;
    },
  },
  {
    id: 'prototypeScanner',
    name: 'Prototype Scanner',
    description: 'Substantially improves Prototype odds in every future draft.',
    category: AugmentCategory.Systems,
    rarity: Rarity.Rare,
    maxStacks: 2,
    ruleChanging: true,
    apply: (s, n) => {
      s.prototypeLuck += 10 * n;
    },
  },
  {
    id: 'splitPayload',
    name: 'Split Payload',
    description: 'Projectiles fork into two on their first impact.',
    category: AugmentCategory.Systems,
    rarity: Rarity.Prototype,
    maxStacks: 2,
    ruleChanging: true,
    apply: (s, n) => {
      s.forkBonus += n;
    },
  },
  {
    id: 'chainReaction',
    name: 'Chain Reaction',
    description: 'Enemies detonate on death for 30% of their maximum hull.',
    category: AugmentCategory.Systems,
    rarity: Rarity.Prototype,
    maxStacks: 2,
    ruleChanging: true,
    apply: (s, n) => {
      s.chainReaction += 0.3 * n;
    },
  },
  {
    id: 'echoRounds',
    name: 'Echo Rounds',
    description: 'Every 5th shot fires a delayed phantom copy of itself.',
    category: AugmentCategory.Systems,
    rarity: Rarity.Prototype,
    maxStacks: 1,
    ruleChanging: true,
    apply: (s) => {
      s.echoRoundsEvery = 5;
    },
  },
  {
    id: 'kineticBattery',
    name: 'Kinetic Battery',
    description: 'Damage dealt charges a battery. At full charge, your next shot fires a free Lance.',
    category: AugmentCategory.Systems,
    rarity: Rarity.Prototype,
    maxStacks: 1,
    requiresUnlock: true,
    ruleChanging: true,
    apply: (s) => {
      s.kineticBatteryCharge = 600;
    },
  },
  {
    id: 'timeDilationCore',
    name: 'Time Dilation Core',
    description: 'A near miss slows time to 45% for 0.4s. Reward for flying close.',
    category: AugmentCategory.Systems,
    rarity: Rarity.Prototype,
    maxStacks: 1,
    requiresUnlock: true,
    ruleChanging: true,
    apply: (s) => {
      s.nearMissSlowMo = 0.4;
    },
  },
  {
    id: 'overchargeVents',
    name: 'Overcharge Vents',
    description: 'Heat no longer locks your guns. Instead, overheating detonates around you.',
    category: AugmentCategory.Systems,
    rarity: Rarity.Prototype,
    maxStacks: 1,
    requiresUnlock: true,
    ruleChanging: true,
    apply: (s) => {
      s.overchargeVents = true;
    },
  },
];

/** The full pool, in a stable order. */
export const AUGMENTS: readonly AugmentDef[] = [...OFFENSE, ...DEFENSE, ...MOBILITY, ...SYSTEMS];

const BY_ID = new Map<string, AugmentDef>();
for (const a of AUGMENTS) {
  if (BY_ID.has(a.id)) throw new Error(`[augments] duplicate id "${a.id}"`);
  BY_ID.set(a.id, a);
}

export function getAugment(id: string): AugmentDef | undefined {
  return BY_ID.get(id);
}

export function augmentCount(): number {
  return AUGMENTS.length;
}

/* Stat computation --------------------------------------------------------------------------- */

/** Baseline stats before any augment is applied. */
export function createBaseStats(hull: HullDef, difficulty: Difficulty): PlayerStats {
  const mod = DIFFICULTY_MODS[difficulty] ?? DIFFICULTY_MODS[1]!;
  return {
    damageMult: 1,
    fireRateMult: 1,
    projectileSpeedMult: 1,
    critChance: 0.05,
    critMult: 1.5,

    maxHull: hull.maxHull * mod.playerHull,
    maxShield: hull.maxShield,
    shieldRegenMult: 1,
    damageReduction: 0,

    speedMult: 1,
    turnRateMult: 1,
    boostMult: 1,

    heatMult: 1,
    aoeMult: 1,
    extraShots: 0,
    pierceBonus: 0,
    forkBonus: 0,
    lifesteal: 0,
    chainReaction: 0,

    overchargeVents: false,
    echoRoundsEvery: 0,
    kineticBatteryCharge: 0,
    nearMissSlowMo: 0,
    aegisReversal: false,
    overhealToShield: false,
    secondWind: false,
    reactiveArmor: 0,
    shieldedDR: 0,
    shieldBreakRefund: 0,

    pointBlankBonus: 0,
    pointBlankRange: 0,
    executeBonus: 0,
    momentumBonus: 0,
    lockedTargetBonus: 0,
    killSpeedBonus: 0,
    hitSpeedBonus: 0,
    driftTurnBonus: 0,
    driftCooldownMult: 1,

    homingBonus: 0,
    magnetMult: 1,
    hullRegenMult: 1,
    secondaryCharges: 0,
    secondaryCooldownMult: 1,
    prototypeLuck: 0,
  };
}

/**
 * Full recompute from hull + augment stacks. Always recomputes from scratch rather than
 * incrementally patching, so there is no way for an add/remove sequence to drift.
 */
export function recomputeStats(
  hull: HullDef,
  augments: ReadonlyMap<string, number>,
  difficulty: Difficulty,
): PlayerStats {
  const stats = createBaseStats(hull, difficulty);

  for (const [id, stacks] of augments) {
    if (stacks <= 0) continue;
    const def = BY_ID.get(id);
    // Unknown ids can arrive from a tampered save; skip rather than crash.
    if (!def) continue;
    def.apply(stats, Math.min(stacks, def.maxStacks));
  }

  // Clamps. Damage reduction in particular must never reach 1.0 or the player is immortal.
  stats.damageReduction = clamp(stats.damageReduction, 0, 0.75);
  stats.shieldedDR = clamp(stats.shieldedDR, 0, 0.4);
  stats.critChance = clamp(stats.critChance, 0, 1);
  stats.maxHull = Math.max(1, stats.maxHull);
  stats.maxShield = Math.max(0, stats.maxShield);
  stats.heatMult = Math.max(0.1, stats.heatMult);
  stats.driftCooldownMult = Math.max(0, stats.driftCooldownMult);
  stats.secondaryCooldownMult = Math.max(0.15, stats.secondaryCooldownMult);
  stats.lifesteal = clamp(stats.lifesteal, 0, 0.5);

  return stats;
}

/* Drafting ----------------------------------------------------------------------------------- */

/** Current Prototype weight, including the pity timer and any Prototype Scanner stacks. */
export function prototypeWeight(run: RunState, stats: PlayerStats | null): number {
  const base = RUN.rarityWeights[2];
  const pity = run.wavesSincePrototype * RUN.prototypePity;
  const luck = stats ? stats.prototypeLuck : 0;
  return base + pity + luck;
}

/** The odds actually shown to the player, as percentages summing to 100. */
export function draftOdds(run: RunState, stats: PlayerStats | null): [number, number, number] {
  const c = RUN.rarityWeights[0];
  const r = RUN.rarityWeights[1];
  const p = prototypeWeight(run, stats);
  const total = c + r + p;
  return [(c / total) * 100, (r / total) * 100, (p / total) * 100];
}

/** True when this augment may still appear: unlocked, and not already at max stacks. */
function isEligible(def: AugmentDef, run: RunState, meta: MetaState): boolean {
  if (def.requiresUnlock && !meta.unlockedAugments.includes(def.id)) return false;
  const stacks = run.augments.get(def.id) ?? 0;
  return stacks < def.maxStacks;
}

const eligibleScratch: AugmentDef[] = [];
const byRarityScratch: AugmentDef[][] = [[], [], []];

/**
 * Rolls a draft of `count` distinct augments.
 *
 * Rarity is rolled per card, then a card of that rarity is chosen uniformly. If a rarity has
 * no eligible members left, it falls back to the next rarity down rather than returning
 * fewer cards — a draft with an empty slot would read as a bug.
 */
export function rollDraft(
  rng: Rng,
  run: RunState,
  meta: MetaState,
  stats: PlayerStats | null,
  count = 3,
  out: AugmentDef[] = [],
): AugmentDef[] {
  out.length = 0;

  eligibleScratch.length = 0;
  byRarityScratch[0]!.length = 0;
  byRarityScratch[1]!.length = 0;
  byRarityScratch[2]!.length = 0;

  for (const def of AUGMENTS) {
    if (!isEligible(def, run, meta)) continue;
    eligibleScratch.push(def);
    byRarityScratch[def.rarity]!.push(def);
  }

  if (eligibleScratch.length === 0) return out;

  const weights: [number, number, number] = [
    RUN.rarityWeights[0],
    RUN.rarityWeights[1],
    prototypeWeight(run, stats),
  ];

  pickedScratch.clear();
  const n = Math.min(count, eligibleScratch.length);

  while (out.length < n) {
    const rolled = rollRarity(rng, weights);

    // Preference order: the rolled rarity, then the remaining rarities from rarest to
    // commonest, then the whole eligible pool. Falling back rather than returning a short
    // draft matters — an empty card slot reads as a bug, not as bad luck.
    let bucket: readonly AugmentDef[] | null = null;
    if (hasUnpicked(byRarityScratch[rolled]!, pickedScratch)) {
      bucket = byRarityScratch[rolled]!;
    } else {
      for (let r = 2; r >= 0; r--) {
        if (r === rolled) continue;
        if (hasUnpicked(byRarityScratch[r]!, pickedScratch)) {
          bucket = byRarityScratch[r]!;
          break;
        }
      }
    }
    if (!bucket) bucket = eligibleScratch;

    // Uniform choice among the unpicked members, via size-1 reservoir sampling so we never
    // allocate a filtered copy.
    let chosen: AugmentDef | null = null;
    let seen = 0;
    for (const def of bucket) {
      if (pickedScratch.has(def.id)) continue;
      seen++;
      if (rng.next() < 1 / seen) chosen = def;
    }
    if (!chosen) break;

    pickedScratch.add(chosen.id);
    out.push(chosen);
  }

  return out;
}

const pickedScratch = new Set<string>();

function hasUnpicked(bucket: readonly AugmentDef[], picked: ReadonlySet<string>): boolean {
  for (const def of bucket) if (!picked.has(def.id)) return true;
  return false;
}

function rollRarity(rng: Rng, weights: readonly [number, number, number]): Rarity {
  const total = weights[0] + weights[1] + weights[2];
  let roll = rng.next() * total;
  roll -= weights[2];
  if (roll <= 0) return Rarity.Prototype;
  roll -= weights[1];
  if (roll <= 0) return Rarity.Rare;
  return Rarity.Common;
}

/** Records a pick into the run, updating stacks and the Prototype pity timer. */
export function takeAugment(run: RunState, def: AugmentDef): void {
  run.augments.set(def.id, (run.augments.get(def.id) ?? 0) + 1);
  if (def.rarity === Rarity.Prototype) run.wavesSincePrototype = 0;
}

/* Presentation helpers ------------------------------------------------------------------------ */

export const CATEGORY_NAMES: readonly string[] = ['Offense', 'Defense', 'Mobility', 'Systems'];
export const RARITY_NAMES: readonly string[] = ['Common', 'Rare', 'Prototype'];

/**
 * Effective drift cooldown after augments, in seconds. Lives here because the augment layer
 * owns the semantics of `driftCooldownMult`.
 */
export function effectiveDriftCooldown(hull: HullDef, stats: PlayerStats): number {
  const base = hull.driftCooldown > 0 ? hull.driftCooldown : PLAYER.driftCooldown;
  return base * stats.driftCooldownMult;
}
