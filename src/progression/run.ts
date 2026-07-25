/**
 * Run state: sectors, waves, threat level, and the sector modifiers that change the rules.
 *
 * The structure is deliberately shallow — three sectors of seven encounters — because the
 * variety comes from the augment draft and the sector modifiers, not from length. A run that
 * outstays its welcome is the failure mode this genre's mid-game most often hits (DESIGN §2).
 *
 * After sector 3 the run loops with an incremented Threat Level rather than ending, so mastery
 * has somewhere to go.
 */

import type {
  BossId,
  Difficulty,
  HullId,
  MetaState,
  PrimaryWeaponId,
  RunState,
  SecondaryWeaponId,
} from '../core/types';
import { ARENA, DIFFICULTY_MODS, RUN } from '../core/constants';
import { randomSeed } from '../core/rng';

/* Encounters ---------------------------------------------------------------------------------- */

export const EncounterKind = {
  Normal: 0,
  Elite: 1,
  Boss: 2,
} as const;
export type EncounterKind = (typeof EncounterKind)[keyof typeof EncounterKind];

export function encounterKind(wave: number): EncounterKind {
  if (wave >= RUN.bossWaveIndex) return EncounterKind.Boss;
  if (wave >= RUN.eliteWaveIndex) return EncounterKind.Elite;
  return EncounterKind.Normal;
}

/* Sectors -------------------------------------------------------------------------------------- */

export interface SectorDef {
  readonly index: number;
  readonly name: string;
  readonly subtitle: string;
  readonly boss: BossId;
  /** Human-readable statement of the rule this sector changes. Shown on the sector card. */
  readonly modifier: string;
  /** Destructible asteroid cover is active. */
  readonly asteroids: boolean;
  /** Periodic EMP fronts sweep the arena, disabling shields inside them. */
  readonly empFronts: boolean;
  /** The arena contracts over the sector, and gravity wells bend projectiles. */
  readonly contracting: boolean;
}

export const SECTORS: readonly SectorDef[] = [
  {
    index: 0,
    name: 'Debris Belt',
    subtitle: 'What is left of the Third Fleet',
    boss: 'hexard',
    modifier: 'Asteroids provide cover — and can be shot into the enemy.',
    asteroids: true,
    empFronts: false,
    contracting: false,
  },
  {
    index: 1,
    name: 'Ion Storm',
    subtitle: 'The sky itself is hostile',
    boss: 'vashkan',
    modifier: 'EMP fronts sweep the arena. Shields do not work inside them.',
    asteroids: false,
    empFronts: true,
    contracting: false,
  },
  {
    index: 2,
    name: 'The Maw',
    subtitle: 'Where the Armada was built',
    boss: 'mawCore',
    modifier: 'The arena contracts. Gravity bends every shot.',
    asteroids: false,
    empFronts: false,
    contracting: true,
  },
];

export function getSector(index: number): SectorDef {
  return SECTORS[index % SECTORS.length]!;
}

/* Run lifecycle -------------------------------------------------------------------------------- */

export interface RunConfig {
  seed?: number;
  hull: HullId;
  primary: PrimaryWeaponId;
  secondary: SecondaryWeaponId;
  difficulty: Difficulty;
}

export function createRun(config: RunConfig): RunState {
  return {
    seed: config.seed ?? randomSeed(),
    sector: 0,
    wave: 0,
    threatLevel: 0,
    difficulty: config.difficulty,

    augments: new Map<string, number>(),
    rerolls: RUN.baseRerolls,
    wavesSincePrototype: 0,

    salvage: 0,
    score: 0,
    kills: 0,
    bossesKilled: 0,
    time: 0,
  };
}

/** Resets an existing RunState in place, so a restart allocates nothing new. */
export function resetRun(run: RunState, config: RunConfig): void {
  run.seed = config.seed ?? randomSeed();
  run.sector = 0;
  run.wave = 0;
  run.threatLevel = 0;
  run.difficulty = config.difficulty;
  run.augments.clear();
  run.rerolls = RUN.baseRerolls;
  run.wavesSincePrototype = 0;
  run.salvage = 0;
  run.score = 0;
  run.kills = 0;
  run.bossesKilled = 0;
  run.time = 0;
}

/**
 * Advances past a cleared encounter. Returns what just happened so the caller can sequence the
 * right celebration — a cleared wave, a cleared sector, or a completed loop.
 */
export const AdvanceResult = {
  NextWave: 0,
  SectorCleared: 1,
  LoopCompleted: 2,
} as const;
export type AdvanceResult = (typeof AdvanceResult)[keyof typeof AdvanceResult];

export function advanceEncounter(run: RunState): AdvanceResult {
  run.wave += 1;
  run.wavesSincePrototype += 1;
  run.rerolls = RUN.baseRerolls;

  if (run.wave < RUN.encountersPerSector) return AdvanceResult.NextWave;

  run.wave = 0;
  run.sector += 1;

  if (run.sector < RUN.sectorCount) return AdvanceResult.SectorCleared;

  // The loop: sector resets, threat level rises, and the run keeps going.
  run.sector = 0;
  run.threatLevel += 1;
  return AdvanceResult.LoopCompleted;
}

/* Difficulty scaling ---------------------------------------------------------------------------- */

/**
 * The threat budget the wave director may spend on enemies for the current encounter.
 *
 * Scaling is multiplicative across sector and threat level but additive within a sector, so
 * the curve inside a sector is gentle and the step between sectors is a real event.
 */
export function threatBudget(run: RunState): number {
  const mod = DIFFICULTY_MODS[run.difficulty] ?? DIFFICULTY_MODS[1]!;
  const kind = encounterKind(run.wave);

  let budget = RUN.baseThreatBudget + RUN.threatPerWave * run.wave;
  budget *= Math.pow(RUN.threatPerSector, run.sector);
  budget *= Math.pow(RUN.threatPerLevel, run.threatLevel);
  budget *= mod.enemyCount;

  // Elite waves trade quantity for quality; the director spends this on buffed enemies.
  if (kind === EncounterKind.Elite) budget *= 0.75;

  return budget;
}

/** Multiplier applied to enemy hull and damage, separate from the count budget. */
export function enemyPowerScale(run: RunState): number {
  return (1 + run.sector * 0.28) * Math.pow(1.35, run.threatLevel);
}

/** Boss hull scale, which climbs faster than trash so bosses stay meaningful when looping. */
export function bossPowerScale(run: RunState): number {
  return (1 + run.sector * 0.15) * Math.pow(1.5, run.threatLevel);
}

export function maxConcurrentEnemies(run: RunState): number {
  // Readability caps this hard: past roughly this many, the fight stops being parseable
  // regardless of how much budget the director has left to spend (DESIGN §13).
  return Math.min(RUN.maxConcurrentEnemies + run.threatLevel * 4, 48);
}

/* Arena shaping ---------------------------------------------------------------------------------- */

/**
 * The arena radius for the current encounter. Only The Maw contracts, and only across its
 * waves, so the squeeze is felt gradually rather than sprung on the player.
 */
export function arenaRadiusFor(run: RunState): number {
  const sector = getSector(run.sector);
  if (!sector.contracting) return ARENA.radius;

  const progress = run.wave / Math.max(1, RUN.encountersPerSector - 1);
  const min = ARENA.radius * ARENA.mawMinFraction;
  return ARENA.radius + (min - ARENA.radius) * progress;
}

/* Presentation ------------------------------------------------------------------------------------ */

export function encounterLabel(run: RunState): string {
  const kind = encounterKind(run.wave);
  if (kind === EncounterKind.Boss) return 'BOSS';
  if (kind === EncounterKind.Elite) return 'ELITE WAVE';
  return `WAVE ${run.wave + 1} / ${RUN.wavesPerSector}`;
}

export function sectorLabel(run: RunState): string {
  const sector = getSector(run.sector);
  return run.threatLevel > 0
    ? `${sector.name}  ·  THREAT ${run.threatLevel + 1}`
    : sector.name;
}

export function formatRunTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/* Scoring -------------------------------------------------------------------------------------------- */

/** Score for a kill, scaled so deeper sectors are worth pushing to. */
export function killScore(base: number, run: RunState): number {
  return Math.round(base * (1 + run.sector * 0.5) * (1 + run.threatLevel * 0.75));
}

/** Total sectors cleared across the whole run, counting loops. */
export function sectorsCleared(run: RunState): number {
  return run.threatLevel * RUN.sectorCount + run.sector;
}

/** The starting loadout for a new run, honouring what the profile has unlocked. */
export function defaultLoadout(meta: MetaState): {
  hull: HullId;
  primary: PrimaryWeaponId;
  secondary: SecondaryWeaponId;
} {
  return {
    hull: meta.unlockedHulls[0] ?? 'starfall',
    primary: meta.unlockedPrimaries[0] ?? 'pulseRepeater',
    secondary: meta.unlockedSecondaries[0] ?? 'swarmMissiles',
  };
}
