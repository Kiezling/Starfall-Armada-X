/**
 * Wave composition + spawn pacing (DESIGN.md §10, §13).
 *
 * `WaveDirector` turns a `RunState`'s threat budget into a concrete list of archetypes, then
 * trickles them into the arena through `EnemyManager` a few at a time so a wave reads as an
 * escalating fight rather than a wall of enemies appearing at once (§13's readability rule).
 * It never spawns anything for a boss encounter — bosses own their own arena rules — it only
 * reports that fact so the caller (the state machine) can hand off to the boss layer.
 */

import type * as THREE from 'three';
import type { EventBus, EnemyTypeId, GameEvents, RunState } from '../core/types';
import type { Rng } from '../core/rng';
import { RUN } from '../core/constants';
import { clamp01, damp } from '../core/math';
import {
  EncounterKind,
  encounterKind,
  threatBudget,
  enemyPowerScale,
  maxConcurrentEnemies,
} from '../progression/run';
import { ENEMY_ORDER, getEnemyDef } from './types';
import type { EnemyManager } from './manager';

/** Soft cap on how many archetypes a single wave's budget can be split into. Budgets grow
 * without bound as sectors and threat levels stack, so this exists purely as a safety valve —
 * if it is ever hit, the director simply stops spending the (very large) remainder. */
const MAX_QUEUE = 96;

/** How many enemies a single spawn pulse introduces at once. Kept small and independent of
 * `maxConcurrentEnemies` so even a wave with room for 40 concurrent enemies still trickles in
 * a few at a time (§13: "the fight stays readable"). */
const SPAWN_PER_PULSE = 3;

/** Elite variants cost more of the budget than their base archetype, mirroring the elite stat
 * multiplier `EnemyManager` applies to their hull/shield/damage — a wave that "spends the
 * budget on elite variants" should therefore field noticeably fewer of them. */
const ELITE_THREAT_MULT = 2.1;

/** Rise fast, fall slow: `intensity` should snap up when enemies pour in but ease down across
 * a clear so the music director never flickers between beds within the same second. `damp`'s
 * smoothing constant is "fraction remaining after one second," so the smaller rise value is the
 * faster response — see core/math.ts. */
const INTENSITY_RISE_SMOOTHING = 0.02;
const INTENSITY_FALL_SMOOTHING = 0.25;

/**
 * Archetypes are introduced progressively rather than all being available from wave one — a
 * fresh run should meet the swarm before it meets the thing that spawns more swarm. Once the
 * run has looped (`threatLevel > 0`) everything is already familiar, so the gate lifts.
 */
function archetypeUnlocked(id: EnemyTypeId, run: RunState): boolean {
  if (run.threatLevel > 0) return true;
  const globalWave = run.sector * RUN.encountersPerSector + run.wave;
  switch (id) {
    case 'waspDrone':
      return true;
    case 'interceptor':
      return globalWave >= 1;
    case 'mineLayer':
      return globalWave >= 2;
    case 'lancer':
      return globalWave >= 3;
    case 'bulwark':
      return globalWave >= 4 || run.sector >= 1;
    // Explicitly excluded from sector 0 / wave 0 per the design brief — a Carrier's whole
    // threat is "it keeps spawning more enemies," which needs a player who already understands
    // the roster it spawns.
    case 'carrier':
      return run.sector >= 1 || globalWave >= 6;
    default:
      return true;
  }
}

export class WaveDirector {
  private readonly manager: EnemyManager;
  private readonly events: EventBus;
  private readonly rng: Rng;

  private readonly queue: EnemyTypeId[] = new Array(MAX_QUEUE).fill('waspDrone');
  private queueLength = 0;
  private queueCursor = 0;
  private pulseTimer = 0;

  private isEliteWave = false;
  private isBossEncounter = false;
  private cleared = false;
  private aliveFromWave = 0;
  private readonly spawnedIds = new Set<number>();

  private intensitySmoothed = 0;

  private readonly candidateScratch: EnemyTypeId[] = new Array(ENEMY_ORDER.length);
  private readonly weightScratch: number[] = new Array(ENEMY_ORDER.length).fill(0);

  private readonly onEnemyDied = (payload: GameEvents['enemy:died']): void => {
    if (this.spawnedIds.delete(payload.id)) {
      this.aliveFromWave = Math.max(0, this.aliveFromWave - 1);
    }
  };

  constructor(manager: EnemyManager, events: EventBus, rng: Rng) {
    this.manager = manager;
    this.events = events;
    this.rng = rng;
    this.events.on('enemy:died', this.onEnemyDied);
  }

  /**
   * `arenaRadius`/`playerPos` are accepted to match the encounter-start signature every other
   * caller in this module uses, but composing a wave only needs `run` — placement happens per
   * spawn pulse, where the current arena radius and player position are read fresh.
   */
  startWave(run: RunState, _arenaRadius: number, _playerPos: THREE.Vector3): void {
    this.queueLength = 0;
    this.queueCursor = 0;
    this.pulseTimer = 0;
    this.cleared = false;
    this.aliveFromWave = 0;
    this.spawnedIds.clear();

    const kind = encounterKind(run.wave);
    this.isBossEncounter = kind === EncounterKind.Boss;
    this.isEliteWave = kind === EncounterKind.Elite;

    if (this.isBossEncounter) {
      // The boss layer owns spawning entirely; the director just sits idle and reports it.
      this.events.emit('wave:started', { sector: run.sector, wave: run.wave, enemyCount: 0 });
      return;
    }

    const budget = threatBudget(run);
    this.composeQueue(run, budget);
    this.events.emit('wave:started', { sector: run.sector, wave: run.wave, enemyCount: this.queueLength });
  }

  private composeQueue(run: RunState, budgetIn: number): void {
    let budget = budgetIn;
    let candidateCount = 0;
    for (const id of ENEMY_ORDER) {
      if (!archetypeUnlocked(id, run)) continue;
      this.candidateScratch[candidateCount] = id;
      this.weightScratch[candidateCount] = getEnemyDef(id).threat;
      candidateCount++;
    }
    if (candidateCount === 0) return;

    // Truncate (not reallocate) the reused scratch arrays to exactly the active candidate
    // count; the next call's fill loop simply grows them back as needed.
    this.candidateScratch.length = candidateCount;
    this.weightScratch.length = candidateCount;
    const candidates = this.candidateScratch;
    const weights = this.weightScratch;
    const costMult = this.isEliteWave ? ELITE_THREAT_MULT : 1;

    while (this.queueLength < MAX_QUEUE) {
      const pick = this.rng.weighted(candidates, weights);
      const cost = getEnemyDef(pick).threat * costMult;
      // Always seat at least one enemy even if it slightly overspends a tiny remaining budget,
      // so a low-budget wave (e.g. Cadet difficulty, wave 1) is never empty.
      if (cost > budget && this.queueLength > 0) break;
      this.queue[this.queueLength++] = pick;
      budget -= cost;
      if (budget <= 0) break;
    }
  }

  update(dt: number, run: RunState, arenaRadius: number, playerPos: THREE.Vector3): void {
    this.updateIntensity(dt, run);

    if (this.isBossEncounter || this.cleared) return;

    if (this.queueCursor < this.queueLength) {
      this.pulseTimer -= dt;
      if (this.pulseTimer <= 0) {
        this.pulseTimer = RUN.spawnInterval;
        this.spawnPulse(run, arenaRadius, playerPos);
      }
    }

    if (this.queueCursor >= this.queueLength && this.aliveFromWave <= 0) {
      this.cleared = true;
      this.events.emit('wave:cleared', { sector: run.sector, wave: run.wave });
    }
  }

  private spawnPulse(run: RunState, arenaRadius: number, playerPos: THREE.Vector3): void {
    const cap = maxConcurrentEnemies(run);
    const powerScale = enemyPowerScale(run);
    let spawnedThisPulse = 0;

    while (
      this.queueCursor < this.queueLength &&
      spawnedThisPulse < SPAWN_PER_PULSE &&
      this.manager.liveCount < cap
    ) {
      const typeId = this.queue[this.queueCursor]!;
      const enemy = this.manager.spawn(typeId, this.isEliteWave, powerScale, arenaRadius, playerPos);
      if (!enemy) break; // Manager is at hard capacity; retry next pulse.
      this.queueCursor++;
      this.aliveFromWave++;
      this.spawnedIds.add(enemy.id);
      spawnedThisPulse++;
    }
  }

  private updateIntensity(dt: number, run: RunState): void {
    const cap = Math.max(1, maxConcurrentEnemies(run));
    const target = this.isBossEncounter ? 1 : clamp01(this.manager.liveCount / cap);
    const smoothing = target > this.intensitySmoothed ? INTENSITY_RISE_SMOOTHING : INTENSITY_FALL_SMOOTHING;
    this.intensitySmoothed = damp(this.intensitySmoothed, target, smoothing, dt);
  }

  get isCleared(): boolean {
    return this.cleared;
  }

  get enemiesRemaining(): number {
    return this.aliveFromWave + (this.queueLength - this.queueCursor);
  }

  get intensity(): number {
    return this.intensitySmoothed;
  }

  /** True while the current encounter is a boss wave — the director spends nothing and never
   * clears one; the caller uses this to know it must hand control to the boss layer instead. */
  get isBossWave(): boolean {
    return this.isBossEncounter;
  }

  reset(): void {
    this.queueLength = 0;
    this.queueCursor = 0;
    this.pulseTimer = 0;
    this.isEliteWave = false;
    this.isBossEncounter = false;
    this.cleared = false;
    this.aliveFromWave = 0;
    this.spawnedIds.clear();
    this.intensitySmoothed = 0;
  }
}
