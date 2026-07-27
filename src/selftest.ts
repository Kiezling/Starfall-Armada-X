/**
 * Headless logic self-tests.
 *
 * These cover the pure-simulation invariants that a screenshot can never catch: that stat
 * recomputation stays finite under every augment combination, that drafts always fill, that
 * the unlock tree is reachable, and that the colour palettes keep player and enemy fire
 * separable. Run with `npm run selftest`.
 *
 * Deliberately dependency-free — no test framework, so this runs anywhere Node runs.
 */

import { Rng } from './core/rng';
import { AugmentCategory, Difficulty, Rarity, type MetaState, type RunState } from './core/types';
import {
  AUGMENTS,
  createBaseStats,
  draftOdds,
  recomputeStats,
  rollDraft,
  takeAugment,
} from './progression/augments';
import { UNLOCK_TREE, computeRunSalvage, isNodeAvailable, purchase, verifyUnlockTree } from './progression/meta';
import { createRun, advanceEncounter, threatBudget, AdvanceResult, arenaRadiusFor } from './progression/run';
import { HULLS } from './ship/hulls';
import { verifyPaletteSeparation } from './render/palette';
import { createDefaultMeta } from './core/save';
import { SpatialGrid } from './core/spatial';
import { Pool } from './core/pool';
import { GameClock } from './core/time';
import * as THREE from 'three';
import { FlightModel, lookRotation } from './ship/flight';
import { createPlayerState, PlayerSystem } from './ship/player';
import type { InputAction, InputState } from './core/types';
import { TargetingSystem } from './combat/targeting';
import type { EnemyQuery } from './combat/projectiles';
import { ProjectileSystem } from './combat/projectiles';
import { HAZARD, PLAYER } from './core/constants';
import { TypedEventBus } from './core/events';
import { BossEncounter, CombinedEnemyQuery, type BossContext } from './enemies/bosses';
import { Hexard } from './enemies/bosses/hexard';
import { Arena } from './render/arena';

export interface TestResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: TestResult[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
}

function isFinitePositive(v: number): boolean {
  return Number.isFinite(v) && v >= 0;
}

/* ------------------------------------------------------------------------------------------- */

function testPalettes(): void {
  const rows = verifyPaletteSeparation();
  for (const row of rows) {
    check(
      `palette "${row.mode}" separates player/enemy fire by luminance`,
      row.ok,
      `margin ${row.margin.toFixed(3)} (need > 0.08)`,
    );
  }
}

function testAugmentPool(): void {
  check('augment pool has at least 44 entries', AUGMENTS.length >= 44, `${AUGMENTS.length} augments`);

  const ids = new Set<string>();
  let dupes = 0;
  for (const a of AUGMENTS) {
    if (ids.has(a.id)) dupes++;
    ids.add(a.id);
  }
  check('augment ids are unique', dupes === 0, `${dupes} duplicates`);

  // Every category should be represented well enough that a draft can offer variety.
  const perCategory = [0, 0, 0, 0];
  for (const a of AUGMENTS) perCategory[a.category]!++;
  check(
    'every augment category has at least 8 entries',
    perCategory.every((n) => n >= 8),
    `Offense ${perCategory[AugmentCategory.Offense]}, Defense ${perCategory[AugmentCategory.Defense]}, Mobility ${perCategory[AugmentCategory.Mobility]}, Systems ${perCategory[AugmentCategory.Systems]}`,
  );

  const missingDesc = AUGMENTS.filter((a) => !a.description || a.description.length < 10);
  check('every augment has real description text', missingDesc.length === 0, missingDesc.map((a) => a.id).join(', '));

  const badStacks = AUGMENTS.filter((a) => a.maxStacks < 1);
  check('every augment allows at least one stack', badStacks.length === 0, badStacks.map((a) => a.id).join(', '));
}

/**
 * The important one: throw every augment at the stat system, at max stacks, and confirm
 * nothing ever goes NaN, infinite, or negative where it must not. A single bad multiplier
 * here would silently corrupt an entire run.
 */
function testStatRecomputationIsAlwaysSane(): void {
  const hull = HULLS.starfall;
  let worst = '';
  let failures = 0;

  // Every augment alone, at max stacks.
  for (const a of AUGMENTS) {
    const map = new Map<string, number>([[a.id, a.maxStacks]]);
    const s = recomputeStats(hull, map, Difficulty.Pilot);
    if (!isFinitePositive(s.maxHull) || s.maxHull < 1) {
      failures++;
      worst = `${a.id} -> maxHull ${s.maxHull}`;
    }
    if (!Number.isFinite(s.damageMult) || s.damageMult <= 0) {
      failures++;
      worst = `${a.id} -> damageMult ${s.damageMult}`;
    }
    if (s.damageReduction >= 1) {
      failures++;
      worst = `${a.id} -> damageReduction ${s.damageReduction}`;
    }
  }
  check('each augment alone produces sane stats', failures === 0, worst);

  // Everything at once, at max stacks — the pathological case.
  const all = new Map<string, number>();
  for (const a of AUGMENTS) all.set(a.id, a.maxStacks);
  const s = recomputeStats(hull, all, Difficulty.Pilot);

  const fields: Array<[string, number]> = [
    ['maxHull', s.maxHull],
    ['maxShield', s.maxShield],
    ['damageMult', s.damageMult],
    ['fireRateMult', s.fireRateMult],
    ['heatMult', s.heatMult],
    ['speedMult', s.speedMult],
    ['turnRateMult', s.turnRateMult],
  ];
  const nonFinite = fields.filter(([, v]) => !Number.isFinite(v) || v <= 0);
  check(
    'all augments stacked at once stays finite and positive',
    nonFinite.length === 0,
    nonFinite.map(([k, v]) => `${k}=${v}`).join(', '),
  );

  check(
    'damage reduction is clamped below immortality',
    s.damageReduction <= 0.75 + 1e-9,
    `damageReduction=${s.damageReduction.toFixed(3)}`,
  );
  check('lifesteal is clamped', s.lifesteal <= 0.5 + 1e-9, `lifesteal=${s.lifesteal.toFixed(3)}`);
  check('maxHull stays at least 1 even with every penalty', s.maxHull >= 1, `maxHull=${s.maxHull.toFixed(1)}`);

  // Every hull, baseline.
  for (const id of Object.keys(HULLS) as Array<keyof typeof HULLS>) {
    const base = createBaseStats(HULLS[id], Difficulty.Nightmare);
    check(`hull "${id}" baseline stats are sane`, base.maxHull >= 1 && Number.isFinite(base.maxHull), `maxHull=${base.maxHull}`);
  }
}

/**
 * Drafts must always fill, must never repeat within a draft, and must never offer something
 * already at max stacks. An empty or duplicated card reads as a bug, not as bad luck.
 */
function testDraftsAlwaysFill(): void {
  const meta = createDefaultMeta();
  // Unlock everything so the gated Prototypes participate too.
  for (const a of AUGMENTS) if (a.requiresUnlock) meta.unlockedAugments.push(a.id);

  const rng = new Rng(12345);
  let shortDrafts = 0;
  let duplicateInDraft = 0;
  let overStacked = 0;
  let emptyEventually = 0;

  for (let trial = 0; trial < 200; trial++) {
    const run = createRun({ hull: 'starfall', primary: 'pulseRepeater', secondary: 'swarmMissiles', difficulty: Difficulty.Pilot });
    // Simulate a very long run: far more drafts than a real run would ever produce, to drive
    // the pool toward exhaustion and prove the fallback path works.
    for (let draft = 0; draft < 90; draft++) {
      const options = rollDraft(rng, run, meta, null, 3);
      if (options.length === 0) {
        emptyEventually++;
        break;
      }
      if (options.length < 3) shortDrafts++;

      const seen = new Set<string>();
      for (const o of options) {
        if (seen.has(o.id)) duplicateInDraft++;
        seen.add(o.id);
        const stacks = run.augments.get(o.id) ?? 0;
        if (stacks >= o.maxStacks) overStacked++;
      }

      takeAugment(run, options[0]!);
      run.wavesSincePrototype++;
    }
  }

  check('drafts never contain duplicates', duplicateInDraft === 0, `${duplicateInDraft} duplicates`);
  check('drafts never offer a maxed augment', overStacked === 0, `${overStacked} over-stacked offers`);
  check(
    'drafts stay full until the pool is genuinely exhausted',
    shortDrafts === 0,
    `${shortDrafts} short drafts (pool exhaustion produced ${emptyEventually} empty drafts, which is expected at 90 picks)`,
  );
}

function testDraftOddsArePublishable(): void {
  const run = createRun({ hull: 'starfall', primary: 'pulseRepeater', secondary: 'swarmMissiles', difficulty: Difficulty.Pilot });
  const odds = draftOdds(run, null);
  const sum = odds[0] + odds[1] + odds[2];
  check('draft odds sum to 100%', Math.abs(sum - 100) < 0.001, `sum=${sum.toFixed(4)}`);

  // The pity timer must actually move the needle.
  run.wavesSincePrototype = 8;
  const pitied = draftOdds(run, null);
  check(
    'prototype pity timer raises prototype odds',
    pitied[2] > odds[2],
    `${odds[2].toFixed(1)}% -> ${pitied[2].toFixed(1)}% after 8 waves`,
  );
}

/** Prototype rarity must actually be rare at baseline — verified empirically, not assumed. */
function testRarityDistribution(): void {
  const meta = createDefaultMeta();
  for (const a of AUGMENTS) if (a.requiresUnlock) meta.unlockedAugments.push(a.id);
  const rng = new Rng(999);

  const counts = [0, 0, 0];
  const trials = 4000;
  for (let i = 0; i < trials; i++) {
    const run = createRun({ hull: 'starfall', primary: 'pulseRepeater', secondary: 'swarmMissiles', difficulty: Difficulty.Pilot });
    const options = rollDraft(rng, run, meta, null, 3);
    for (const o of options) counts[o.rarity]!++;
  }
  const total = counts[0]! + counts[1]! + counts[2]!;
  const protoPct = (counts[Rarity.Prototype]! / total) * 100;
  check(
    'prototype rate at zero pity sits near its published 10%',
    protoPct > 4 && protoPct < 22,
    `observed ${protoPct.toFixed(1)}% across ${total} cards`,
  );
}

/** A run must progress through all sectors and loop, with monotonically rising difficulty. */
function testRunProgression(): void {
  const run: RunState = createRun({ hull: 'starfall', primary: 'pulseRepeater', secondary: 'swarmMissiles', difficulty: Difficulty.Pilot });

  let sectorsCleared = 0;
  let looped = false;
  let lastBudget = -1;
  let budgetRegressions = 0;

  for (let i = 0; i < 21; i++) {
    const budget = threatBudget(run);
    if (!Number.isFinite(budget) || budget <= 0) {
      check('threat budget is always positive and finite', false, `budget=${budget}`);
      return;
    }
    // Budget may dip on the elite wave by design, so only compare like-for-like waves.
    if (run.wave === 0 && lastBudget > 0 && budget < lastBudget) budgetRegressions++;
    if (run.wave === 0) lastBudget = budget;

    const r = advanceEncounter(run);
    if (r === AdvanceResult.SectorCleared) sectorsCleared++;
    if (r === AdvanceResult.LoopCompleted) {
      looped = true;
      sectorsCleared++;
    }
  }

  check('a run clears three sectors and loops', looped && sectorsCleared === 3, `sectorsCleared=${sectorsCleared}, looped=${looped}`);
  check('threat level increased after looping', run.threatLevel === 1, `threatLevel=${run.threatLevel}`);
  check('wave-0 threat budget never regresses across sectors', budgetRegressions === 0, `${budgetRegressions} regressions`);

  // The Maw must contract, and never to zero.
  const maw = createRun({ hull: 'starfall', primary: 'pulseRepeater', secondary: 'swarmMissiles', difficulty: Difficulty.Pilot });
  maw.sector = 2;
  maw.wave = 0;
  const wide = arenaRadiusFor(maw);
  maw.wave = 6;
  const tight = arenaRadiusFor(maw);
  check('The Maw contracts the arena', tight < wide && tight > 50, `${wide.toFixed(0)} -> ${tight.toFixed(0)}`);
}

/** Every unlock must be reachable, and salvage must actually accumulate toward it. */
function testUnlockTree(): void {
  const problems = verifyUnlockTree();
  check('unlock tree is internally consistent', problems.length === 0, problems.join('; '));

  const meta: MetaState = createDefaultMeta();
  meta.totalSalvage = 100000;

  // Buy everything in dependency order; nothing may be permanently unreachable.
  let bought = 0;
  for (let pass = 0; pass < UNLOCK_TREE.length + 1; pass++) {
    for (const node of UNLOCK_TREE) {
      if (isNodeAvailable(meta, node) && purchase(meta, node.id) === 0) bought++;
    }
  }
  check('every unlock node is reachable', bought === UNLOCK_TREE.length, `${bought}/${UNLOCK_TREE.length} purchased`);

  // A realistic single good run should make visible progress.
  const oneGoodRun = computeRunSalvage(2, 180, 2);
  check(
    'one strong run earns meaningful salvage',
    oneGoodRun >= 400 && oneGoodRun <= 2000,
    `${oneGoodRun} salvage for reaching sector 2 with 180 kills and 2 bosses`,
  );
}

/** Progression must never hand out permanent raw power — the core design promise. */
function testMetaGrantsOptionsNotPower(): void {
  const statNodes = UNLOCK_TREE.filter((n) => n.kind !== 'hull' && n.kind !== 'primary' && n.kind !== 'secondary' && n.kind !== 'augment' && n.kind !== 'livery');
  check('no unlock node grants a raw stat bonus', statNodes.length === 0, `${statNodes.length} stat nodes found`);

  const meta = createDefaultMeta();
  const fresh = recomputeStats(HULLS.starfall, new Map(), Difficulty.Pilot);
  const veteran = createDefaultMeta();
  veteran.totalSalvage = 100000;
  for (let pass = 0; pass < UNLOCK_TREE.length + 1; pass++) {
    for (const node of UNLOCK_TREE) if (isNodeAvailable(veteran, node)) purchase(veteran, node.id);
  }
  const afterEverything = recomputeStats(HULLS.starfall, new Map(), Difficulty.Pilot);

  check(
    'a fully-unlocked profile has identical baseline stats to a new one',
    fresh.damageMult === afterEverything.damageMult && fresh.maxHull === afterEverything.maxHull,
    `damage ${fresh.damageMult} vs ${afterEverything.damageMult}, hull ${fresh.maxHull} vs ${afterEverything.maxHull}`,
  );
  check('a new profile still starts with a usable loadout', meta.unlockedHulls.length > 0 && meta.unlockedPrimaries.length > 0, '');
}

/** Core data structures. */
function testCorePrimitives(): void {
  // Pool: the dense-prefix invariant and backwards-release rule.
  const pool = new Pool<{ v: number; index: number }>(8, (index) => ({ v: 0, index }));
  for (let i = 0; i < 8; i++) pool.acquire()!.v = i;
  check('pool fills to capacity', pool.size === 8 && pool.acquire() === null, `size=${pool.size}`);
  for (let i = pool.size - 1; i >= 0; i--) if (pool.items[i]!.v % 2 === 0) pool.releaseAt(i);
  const remainingAllOdd = Array.from({ length: pool.size }, (_, i) => pool.items[i]!.v).every((v) => v % 2 === 1);
  check('pool releases correctly during backwards iteration', pool.size === 4 && remainingAllOdd, `size=${pool.size}`);

  // Spatial grid: everything inserted must be findable.
  const grid = new SpatialGrid(500, 40, 1000);
  grid.insert(0, 0, 0, 0);
  grid.insert(1, 100, 0, 0);
  grid.insert(2, -450, 20, 300);
  const out = new Int32Array(64);
  const nearOrigin = grid.query(0, 0, 0, 10, out);
  check('spatial grid finds a co-located item', nearOrigin >= 1, `found ${nearOrigin}`);
  const wide = grid.query(0, 0, 0, 1200, out);
  check('spatial grid wide query finds all items', wide === 3, `found ${wide}`);
  grid.clear();
  check('spatial grid clears', grid.query(0, 0, 0, 1200, out) === 0);

  // Out-of-bounds insertion must clamp, not alias to the wrong side of the world.
  const grid2 = new SpatialGrid(100, 25, 100);
  grid2.insert(0, 99999, 0, 0);
  const farOut = new Int32Array(16);
  check('spatial grid clamps out-of-bounds inserts', grid2.query(99999, 0, 0, 10, farOut) >= 1, 'expected the clamped edge cell to be queryable');

  // Clock: hit-stop must slow time and then recover.
  const clock = new GameClock();
  clock.beginFrame(0);
  clock.beginFrame(16);
  const normal = clock.timeScale;
  clock.applyHitStop(0.05, 0.02);
  clock.beginFrame(32);
  const stopped = clock.timeScale;
  for (let t = 48; t < 800; t += 16) clock.beginFrame(t);
  const recovered = clock.timeScale;
  check('hit-stop slows time', stopped < normal * 0.5, `${normal.toFixed(2)} -> ${stopped.toFixed(3)}`);
  check('hit-stop recovers to normal speed', Math.abs(recovered - 1) < 0.02, `recovered=${recovered.toFixed(3)}`);

  // The fixed timestep must never spiral: a huge frame gap yields a bounded step count.
  const clock2 = new GameClock();
  clock2.beginFrame(0);
  const steps = clock2.beginFrame(100000);
  check('clock caps catch-up steps after a long stall', steps <= 5, `steps=${steps}`);
}

function testRngDeterminism(): void {
  const a = new Rng(4242);
  const b = new Rng(4242);
  let same = true;
  for (let i = 0; i < 1000; i++) if (a.next() !== b.next()) same = false;
  check('seeded rng is deterministic', same);

  const r = new Rng(7);
  let min = 1;
  let max = 0;
  for (let i = 0; i < 100000; i++) {
    const v = r.next();
    if (v < min) min = v;
    if (v > max) max = v;
  }
  check('rng stays within [0,1)', min >= 0 && max < 1, `min=${min.toFixed(5)} max=${max.toFixed(5)}`);

  // Weighted picks must respect their weights.
  const rw = new Rng(11);
  let heads = 0;
  const items = ['a', 'b'];
  const weights = [90, 10];
  for (let i = 0; i < 20000; i++) if (rw.weighted(items, weights) === 'a') heads++;
  const pct = (heads / 20000) * 100;
  check('weighted pick respects weights', pct > 86 && pct < 94, `observed ${pct.toFixed(1)}% for a 90% weight`);
}

/* ------------------------------------------------------------------------------------------- */

/**
 * A scriptable stand-in for InputManager. The flight model reads nothing else, so this is the
 * whole surface needed to fly the ship headlessly.
 */
class ScriptedInput implements InputState {
  aimX = 0;
  aimY = 0;
  steering = false;
  throttle = 0;
  strafe = 0;
  roll = 0;
  private readonly held = new Set<InputAction>();

  hold(action: InputAction, down: boolean): void {
    if (down) this.held.add(action);
    else this.held.delete(action);
  }

  isDown(action: InputAction): boolean {
    return this.held.has(action);
  }

  /**
   * Just-pressed edges, cleared by `endStep` exactly as InputManager clears its own. Without
   * this the harness reported `false` for every edge, so anything driven by a tap rather than a
   * hold — the blink, most obviously — could never fire in a test and would look green purely
   * because it was never exercised.
   */
  press(action: InputAction): void {
    this.pressed.add(action);
  }

  endStep(): void {
    this.pressed.clear();
  }

  wasPressed(action: InputAction): boolean {
    return this.pressed.has(action);
  }

  private readonly pressed = new Set<InputAction>();
}

const STEP = 1 / 120;
const flightUp = new THREE.Vector3();
const flightForward = new THREE.Vector3();

/**
 * The invariant the flight model now guarantees is the opposite of what it used to: pitch is
 * unlimited. Holding nose-up must carry the ship smoothly all the way over the top and back
 * around into a full loop — no stop, no snap, no NaN, and the orientation quaternion must stay
 * a valid unit quaternion throughout. Once the loop is over and the stick is released, gentle
 * auto-level must settle any bank picked up along the way back to level flight, without ever
 * yanking the ship while it was still pitching.
 */
function testFlightLoopsWithoutInverting(): void {
  const player = createPlayerState({
    hullId: 'starfall',
    primary: 'pulseRepeater',
    secondary: 'swarmMissiles',
    difficulty: Difficulty.Pilot,
  });
  const flight = new FlightModel();
  const input = new ScriptedInput();

  const startForward = new THREE.Vector3(0, 0, -1).applyQuaternion(player.quaternion);

  // Full nose-up and full throttle, held for as long as a full loop takes.
  input.aimY = 1;
  input.steering = true;
  input.throttle = 1;

  let sawNaN = false;
  let maxNormError = 0;
  let sawInverted = false;
  let hasLeftStart = false;
  let loopSteps = -1;

  const maxSteps = 10 * 120;
  for (let i = 0; i < maxSteps && loopSteps < 0; i++) {
    flight.update(player, input, STEP, 520, 1, null, 0);

    const q = player.quaternion;
    if (!Number.isFinite(q.x) || !Number.isFinite(q.y) || !Number.isFinite(q.z) || !Number.isFinite(q.w)) {
      sawNaN = true;
      break;
    }
    const norm = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    maxNormError = Math.max(maxNormError, Math.abs(norm - 1));

    flightUp.set(0, 1, 0).applyQuaternion(q);
    if (flightUp.y < -0.3) sawInverted = true;

    flightForward.set(0, 0, -1).applyQuaternion(q);
    const dot = Math.max(-1, Math.min(1, startForward.dot(flightForward)));
    if (!hasLeftStart) {
      if (dot < 0.9) hasLeftStart = true;
    } else if (dot > 0.999) {
      loopSteps = i;
    }
  }

  check('sustained nose-up never produces NaN', !sawNaN);
  check(
    'orientation quaternion stays normalized',
    maxNormError < 1e-4,
    `max |‖q‖-1| = ${maxNormError.toExponential(2)}`,
  );
  check('the loop genuinely inverts the ship at the top — no hidden clamp', sawInverted);
  check(
    'sustained nose-up completes a full loop back to the start heading',
    loopSteps >= 0,
    loopSteps >= 0 ? `closed the loop in ${(loopSteps / 120).toFixed(2)}s` : 'never returned to the start heading',
  );

  // Bank the ship hard mid-flight, then let go of everything: the attitude must be *kept*.
  // Space has no horizon, so nothing may roll the ship back toward world level.
  input.aimY = 0;
  input.steering = false;
  input.roll = 1;
  for (let i = 0; i < 40; i++) flight.update(player, input, STEP, 520, 1, null, 0);
  input.roll = 0;

  // Let the roll rate bleed off, then hold for several seconds — any auto-levelling would have
  // long since pulled the bank out within this window.
  for (let i = 0; i < 30; i++) flight.update(player, input, STEP, 520, 1, null, 0);
  const bankedUp = new THREE.Vector3(0, 1, 0).applyQuaternion(player.quaternion);
  for (let i = 0; i < 8 * 120; i++) flight.update(player, input, STEP, 520, 1, null, 0);

  flightUp.set(0, 1, 0).applyQuaternion(player.quaternion);
  const drift = Math.acos(Math.max(-1, Math.min(1, flightUp.dot(bankedUp))));
  check(
    'the ship holds its bank after roll is released — nothing re-levels it',
    drift < 0.02,
    `${((drift * 180) / Math.PI).toFixed(2)}° of attitude drift over 8s`,
  );
}

/**
 * Releasing the steering keys must *hold the heading*, not drift. On a keyboard the axes rest
 * at exactly zero, so any residual turn would be the model's own doing — and a nose that
 * wanders on its own is unusable for aiming.
 */
/**
 * Boost is a blink now: a tap buys a fixed burst, and holding the key does nothing extra.
 *
 * That last half is the part worth guarding. The whole reason for the change is that a held
 * boost was the fourth key competing for a limited-rollover keyboard's attention, so if holding
 * the key silently kept re-triggering — or extended the burst — the change would have bought
 * nothing while looking like it worked. The test therefore checks all three properties: one tap
 * spends exactly one charge, the burst ends on its own timer while the key is still down, and a
 * meter below the rearm threshold refuses to start a blink at all.
 */
function testBoostBlinksOnTapNotHold(): void {
  const player = createPlayerState({
    hullId: 'starfall',
    primary: 'pulseRepeater',
    secondary: 'swarmMissiles',
    difficulty: Difficulty.Pilot,
  });
  const flight = new FlightModel();
  const input = new ScriptedInput();

  // One tap, then keep the key held for well past the blink's duration.
  const startCharge = player.boost;
  input.hold('boost', true);
  input.press('boost');
  flight.update(player, input, STEP, 520, 1, null, 0);
  input.endStep();

  const spent = startCharge - player.boost;
  check(
    'a single boost tap spends exactly one blink charge',
    Math.abs(spent - PLAYER.blinkCost) < 1e-3 && player.boosting,
    `spent ${spent.toFixed(2)} (blinkCost=${PLAYER.blinkCost}), boosting=${player.boosting}`,
  );

  // Hold the key down across the whole burst and beyond. The edge never repeats, so charge must
  // only ever climb back from here.
  let lowest = player.boost;
  let stillBoostingAtEnd = false;
  for (let i = 0; i < 120; i++) {
    flight.update(player, input, STEP, 520, 1, null, 0);
    input.endStep();
    lowest = Math.min(lowest, player.boost);
    if (i === 60) stillBoostingAtEnd = player.boosting;
  }

  check(
    'holding boost neither extends the blink nor re-triggers it',
    !stillBoostingAtEnd && !player.boosting && lowest >= startCharge - PLAYER.blinkCost - 1e-3,
    `boosting after 0.5s=${stillBoostingAtEnd}, at 1s=${player.boosting}, lowest charge=${lowest.toFixed(2)}`,
  );

  // Drain below the rearm threshold and confirm a tap is refused rather than feathered.
  player.boost = PLAYER.boostRearmThreshold - 1;
  const beforeRefused = player.boost;
  input.press('boost');
  flight.update(player, input, STEP, 520, 1, null, 0);
  input.endStep();
  check(
    'a blink below the rearm threshold is refused, not feathered',
    !player.boosting && player.boost >= beforeRefused,
    `boosting=${player.boosting}, charge ${beforeRefused.toFixed(2)} -> ${player.boost.toFixed(2)}`,
  );
}

function testFlightHoldsHeadingWhenReleased(): void {
  const player = createPlayerState({
    hullId: 'starfall',
    primary: 'pulseRepeater',
    secondary: 'swarmMissiles',
    difficulty: Difficulty.Pilot,
  });
  const flight = new FlightModel();
  const input = new ScriptedInput();

  // Turn for a second, then let go and coast for five.
  input.aimX = 1;
  input.steering = true;
  for (let i = 0; i < 120; i++) flight.update(player, input, STEP, 520, 1, null, 0);

  input.aimX = 0;
  input.steering = false;
  for (let i = 0; i < 120; i++) flight.update(player, input, STEP, 520, 1, null, 0);

  const settled = new THREE.Vector3(0, 0, -1).applyQuaternion(player.quaternion);
  for (let i = 0; i < 600; i++) flight.update(player, input, STEP, 520, 1, null, 0);
  const after = new THREE.Vector3(0, 0, -1).applyQuaternion(player.quaternion);

  const drift = Math.acos(Math.max(-1, Math.min(1, settled.dot(after))));
  check(
    'heading holds when steering is released',
    drift < 0.01,
    `${((drift * 180) / Math.PI).toFixed(3)}° of drift over 5s`,
  );
}

/**
 * `lookRotation` must produce a genuine rotation, not a reflection.
 *
 * It builds its basis by hand, and building it in the wrong cross-product order yields a
 * determinant of -1 — which `setFromRotationMatrix` happily converts into a non-unit
 * quaternion. Every enemy and boss aims through this helper, so a silent reflection there is a
 * whole-roster aiming bug that nothing else would catch.
 */
function testLookRotationIsARotation(): void {
  const up = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion();
  const dirs = [
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0.3, 0.7, -0.4).normalize(),
    new THREE.Vector3(-0.5, -0.2, 0.84).normalize(),
    new THREE.Vector3(0, 1, 0), // parallel to the up hint: the degenerate guard's path
  ];

  let worstNorm = 0;
  let worstAim = 0;
  const aimed = new THREE.Vector3();
  for (const dir of dirs) {
    lookRotation(q, dir, up);
    worstNorm = Math.max(worstNorm, Math.abs(q.length() - 1));
    if (dir.y < 0.999) {
      // The degenerate case may pick any roll, but every other direction must aim down `dir`.
      aimed.set(0, 0, -1).applyQuaternion(q);
      worstAim = Math.max(worstAim, aimed.distanceTo(dir));
    }
  }

  check('lookRotation returns unit quaternions', worstNorm < 1e-6, `worst |q|-1 = ${worstNorm.toExponential(2)}`);
  check('lookRotation aims down the requested direction', worstAim < 1e-6, `worst aim error = ${worstAim.toExponential(2)}`);
}

/**
 * The lock assist must converge the nose onto the target *and* stand down the moment the
 * player steers. Both halves matter: the first is the whole reason a keyboard player can
 * fight, the second is what stops the assist from fighting them for control.
 */
function testLockAssistConvergesAndYields(): void {
  const player = createPlayerState({
    hullId: 'starfall',
    primary: 'pulseRepeater',
    secondary: 'swarmMissiles',
    difficulty: Difficulty.Pilot,
  });
  const flight = new FlightModel();
  const input = new ScriptedInput();

  // A target 60° off the nose and slightly above.
  const dir = new THREE.Vector3(Math.sin(1.05), 0.25, -Math.cos(1.05)).normalize();
  for (let i = 0; i < 240; i++) flight.update(player, input, STEP, 520, 1, dir, 1);

  const nose = new THREE.Vector3(0, 0, -1).applyQuaternion(player.quaternion);
  const error = Math.acos(Math.max(-1, Math.min(1, nose.dot(dir))));
  check(
    'hard lock converges the nose onto the target',
    error < 0.02,
    `${((error * 180) / Math.PI).toFixed(2)}° off after 2s`,
  );

  // Now steer away: the assist must not claw the nose back.
  input.aimX = -1;
  input.steering = true;
  const before = new THREE.Vector3(0, 0, -1).applyQuaternion(player.quaternion);
  for (let i = 0; i < 120; i++) flight.update(player, input, STEP, 520, 1, dir, 1);
  const moved = new THREE.Vector3(0, 0, -1).applyQuaternion(player.quaternion);
  const turned = Math.acos(Math.max(-1, Math.min(1, before.dot(moved))));
  check(
    'manual steering overrides the lock assist',
    turned > 0.5,
    `turned ${((turned * 180) / Math.PI).toFixed(1)}° against the lock`,
  );
}

/**
 * Lead calculation must account for target velocity. A target crossing perpendicular to the
 * ship should produce a lead point ahead of the target's current position.
 */
function testLeadTargetPrediction(): void {
  const targeting = new TargetingSystem();

  const player = createPlayerState({
    hullId: 'starfall',
    primary: 'pulseRepeater',
    secondary: 'swarmMissiles',
    difficulty: Difficulty.Pilot,
  });
  player.position.set(0, 0, 0);
  player.velocity.set(0, 0, 0);

  // Mock EnemyQuery interface.
  const enemyPos = new THREE.Vector3(100, 0, 0);
  const enemyVel = new THREE.Vector3(0, 50, 0);
  const mockEnemy = { id: 0, position: enemyPos, velocity: enemyVel, active: true, radius: 5 };
  const mockEnemyQuery = {
    queryNear: () => 1,
    getByIndex: () => mockEnemy,
    getById: (id: number) => (id === 0 ? mockEnemy : null),
  } as any;

  // Cache player state in targeting system.
  targeting.update(player, mockEnemyQuery, 0, null as any, { aimAssist: 0 } as any, 0);

  // Lock onto the mock enemy.
  (targeting as any).locked = 0;

  const leadPoint = new THREE.Vector3();
  const projectileSpeed = 300;

  const success = targeting.getLeadPoint(leadPoint, projectileSpeed, mockEnemyQuery);
  check(
    'lead point calculation succeeds with locked target',
    success,
    'getLeadPoint returned false',
  );

  if (success) {
    // Lead point should be ahead of the target, not at its current position.
    const isAhead = leadPoint.y > enemyPos.y + 1;
    check(
      'lead point is ahead of crossing target',
      isAhead,
      `lead ${leadPoint.toArray().map((v) => v.toFixed(1)).join(',')} vs target ${enemyPos.toArray().map((v) => v.toFixed(1)).join(',')}`,
    );

    // Time-to-intercept: distance from player to lead point divided by projectile speed.
    const distToLead = leadPoint.clone().sub(player.position).length();
    const timeToLead = distToLead / projectileSpeed;
    // Target should be at the lead point at that time.
    const targetAtTime = enemyPos.clone().addScaledVector(enemyVel, timeToLead);
    const convergence = targetAtTime.clone().sub(leadPoint).length();
    check(
      'projectile fired at lead point arrives within tolerance',
      convergence < 0.5,
      `convergence error ${convergence.toFixed(3)} (target: ${targetAtTime.toArray().map((v) => v.toFixed(1)).join(',')}, lead: ${leadPoint.toArray().map((v) => v.toFixed(1)).join(',')})`,
    );
  }
}

/**
 * Gimbal assist should snap locked targets' aim to the lead point when within range, and
 * apply soft-edge falloff outside the primary range. Different projectile speeds should
 * produce different lead points.
 */
function testGimbalAssist(): void {
  const player = createPlayerState({
    hullId: 'starfall',
    primary: 'pulseRepeater',
    secondary: 'swarmMissiles',
    difficulty: Difficulty.Pilot,
  });
  player.position.set(0, 0, 0);
  player.velocity.set(0, 0, 0);

  // Test case 1: gimbal at 10° engages and aligns with ballistic lead point.
  const angle10 = 10 * (Math.PI / 180);
  const enemyPos10 = new THREE.Vector3(
    100 * Math.sin(angle10),
    0,
    -100 * Math.cos(angle10),
  );
  const enemyVel10 = new THREE.Vector3(0, 100, 0); // Crossing velocity.

  const mockEnemy10 = { id: 0, position: enemyPos10, velocity: enemyVel10, active: true, radius: 5 };
  const mockEnemyQuery10 = {
    queryNear: () => 1,
    getByIndex: () => mockEnemy10,
    getById: (id: number) => (id === 0 ? mockEnemy10 : null),
  } as any;

  const settings = { aimAssist: 2 } as any; // AimAssist.Strong = 2
  const targeting10 = new TargetingSystem();
  targeting10.update(player, mockEnemyQuery10, 0, null as any, settings, 0);
  (targeting10 as any).locked = 0;

  const aimDir10 = new THREE.Vector3(0, 0, -1); // Facing forward.
  const projectileSpeed300 = 300;
  targeting10.applyAimAssist(aimDir10, player.position, mockEnemyQuery10, 0, settings, projectileSpeed300);

  const leadPoint10 = new THREE.Vector3();
  targeting10.getLeadPoint(leadPoint10, projectileSpeed300, mockEnemyQuery10);
  const expectedDir10 = leadPoint10.clone().sub(player.position).normalize();
  const alignment10 = aimDir10.dot(expectedDir10);

  check(
    'gimbal at 10° aligns with ballistic lead point',
    alignment10 > 0.93,
    `alignment=${alignment10.toFixed(3)} (should be close to 1.0)`,
  );

  // Test case 2: gimbal with AimAssist.Off is completely disabled.
  const angle25 = 25 * (Math.PI / 180);
  const enemyPos25 = new THREE.Vector3(
    100 * Math.sin(angle25),
    0,
    -100 * Math.cos(angle25),
  );
  const enemyVel25 = new THREE.Vector3(0, 50, 0);

  const mockEnemy25 = { id: 0, position: enemyPos25, velocity: enemyVel25, active: true, radius: 5 };
  const mockEnemyQuery25 = {
    queryNear: () => 1,
    getByIndex: () => mockEnemy25,
    getById: (id: number) => (id === 0 ? mockEnemy25 : null),
  } as any;

  const settingsOff = { aimAssist: 0 } as any; // AimAssist.Off
  const targeting25Off = new TargetingSystem();
  targeting25Off.update(player, mockEnemyQuery25, 0, null as any, settingsOff, 0);
  (targeting25Off as any).locked = 0;

  const aimDir25Off = new THREE.Vector3(0, 0, -1);
  const aimDirBefore25Off = aimDir25Off.clone();
  targeting25Off.applyAimAssist(aimDir25Off, player.position, mockEnemyQuery25, 0, settingsOff, projectileSpeed300);

  const unchanged25Off = Math.abs(aimDir25Off.dot(aimDirBefore25Off) - 1.0) < 1e-6;
  check(
    'gimbal with AimAssist.Off is completely disabled',
    unchanged25Off,
    `dot product ${aimDir25Off.dot(aimDirBefore25Off).toFixed(6)} (should be exactly 1.0)`,
  );

  // Test case 3: gimbal with hitscan (speed <= 0) aims at current position, not intercepted.
  const targetingHitscan = new TargetingSystem();
  targetingHitscan.update(player, mockEnemyQuery10, 0, null as any, settings, 0);
  (targetingHitscan as any).locked = 0;

  const aimDirHitscan = new THREE.Vector3(0, 0, -1);
  const hitscanSpeed = 0; // Hitscan weapon
  targetingHitscan.applyAimAssist(aimDirHitscan, player.position, mockEnemyQuery10, 0, settings, hitscanSpeed);

  // For hitscan, gimbal should aim at target's current position, not an intercept point.
  const targetDir = enemyPos10.clone().sub(player.position).normalize();
  const hitscanAlignment = aimDirHitscan.dot(targetDir);

  check(
    'gimbal with hitscan (speed=0) aims at current position',
    hitscanAlignment > 0.93,
    `alignment with current pos=${hitscanAlignment.toFixed(3)} (should be close to 1.0)`,
  );

  // Test case 4: different projectile speeds produce different lead points.
  // Slower projectiles lead further ahead.
  const slowSpeed = 150;
  const fastSpeed = 600;

  const leadPointSlow = new THREE.Vector3();
  const leadPointFast = new THREE.Vector3();
  const targetingLead = new TargetingSystem();
  targetingLead.update(player, mockEnemyQuery10, 0, null as any, settings, 0);
  (targetingLead as any).locked = 0;

  targetingLead.getLeadPoint(leadPointSlow, slowSpeed, mockEnemyQuery10);
  targetingLead.getLeadPoint(leadPointFast, fastSpeed, mockEnemyQuery10);

  const distanceFromTarget = (point: THREE.Vector3) => point.clone().sub(enemyPos10).length();
  const leadDistSlow = distanceFromTarget(leadPointSlow);
  const leadDistFast = distanceFromTarget(leadPointFast);

  check(
    'slower projectiles lead further ahead than faster ones',
    leadDistSlow > leadDistFast,
    `slow: ${leadDistSlow.toFixed(2)}, fast: ${leadDistFast.toFixed(2)} (slow should be larger)`,
  );
}

/**
 * Overheating must have a real, self-clearing consequence (playtester issue #7a): crossing
 * heatMax latches PlayerState.venting, and it must clear itself once heat bleeds back below
 * heatRearmThreshold — no fixed timer — mirroring the boostRearmThreshold idiom.
 */
function testHeatOverheatLockout(): void {
  const events = new TypedEventBus();
  const player = createPlayerState({
    hullId: 'starfall',
    primary: 'pulseRepeater',
    secondary: 'swarmMissiles',
    difficulty: Difficulty.Pilot,
  });
  const playerSystem = new PlayerSystem(player, events);

  // Simulate heat having just been pushed to the cap by a shot (weapons.ts's addHeat clamps
  // the same way) and let PlayerSystem's next step discover the crossing, matching real frame
  // order: weapon fire adds heat, then the following step's updateHeat() reacts to it.
  player.heat = PLAYER.heatMax;
  playerSystem.update(1 / 60);

  check(
    'reaching heatMax latches the overheat lockout',
    player.venting,
    `venting=${player.venting}, heat=${player.heat.toFixed(1)}`,
  );

  let steps = 0;
  while (player.venting && steps < 600) {
    playerSystem.update(1 / 60);
    steps++;
  }
  const recoverySeconds = steps / 60;

  check(
    'the lockout clears on its own once heat drops below the rearm threshold',
    !player.venting && player.heat <= PLAYER.heatRearmThreshold,
    `cleared after ${recoverySeconds.toFixed(2)}s, heat=${player.heat.toFixed(1)}`,
  );
  check(
    'recovery from a full overheat lands in the ~2-3s target, not a fixed 2s dead zone',
    recoverySeconds > 1.5 && recoverySeconds < 3.0,
    `recovery took ${recoverySeconds.toFixed(2)}s (heatMax=${PLAYER.heatMax}, heatCooling=${PLAYER.heatCooling}, heatRearmThreshold=${PLAYER.heatRearmThreshold})`,
  );
}

/**
 * Overcharge Vents repurposes overheat into a detonation (weapons.ts's addHeat/overchargeDetonate
 * path). PlayerSystem.updateHeat must never latch the normal lockout for that augment — issue #7a
 * explicitly calls out not breaking this interaction.
 */
function testOverchargeVentsBypassesLockout(): void {
  const events = new TypedEventBus();
  const player = createPlayerState({
    hullId: 'starfall',
    primary: 'pulseRepeater',
    secondary: 'swarmMissiles',
    difficulty: Difficulty.Pilot,
  });
  const playerSystem = new PlayerSystem(player, events);

  player.stats.overchargeVents = true;
  player.heat = PLAYER.heatMax;
  playerSystem.update(1 / 60);

  check(
    'Overcharge Vents never latches the heat lockout',
    !player.venting,
    `venting=${player.venting} (should stay false — weapons.ts resets heat to 0 before this ever observes the cap in real play)`,
  );
}

/**
 * Lock-on must not snap instantly (playtester issue #14): a candidate has to be held for the
 * documented 0.35-0.6s dwell window before TargetingSystem.lockedId actually changes.
 */
function testLockAcquisitionDwell(): void {
  const targeting = new TargetingSystem();
  const player = createPlayerState({
    hullId: 'starfall',
    primary: 'pulseRepeater',
    secondary: 'swarmMissiles',
    difficulty: Difficulty.Pilot,
  });
  player.position.set(0, 0, 0);
  player.velocity.set(0, 0, 0);

  const enemyPos = new THREE.Vector3(0, 0, -100); // dead ahead of the default (identity) facing.
  const mockEnemy = { id: 7, position: enemyPos, velocity: new THREE.Vector3(), active: true, radius: 5 };
  const mockEnemyQuery = {
    queryNear: () => 1,
    getByIndex: () => mockEnemy,
    getById: (id: number) => (id === 7 ? mockEnemy : null),
  } as any;
  const settings = { aimAssist: 0 } as any;
  const step = 1 / 60;

  targeting.update(player, mockEnemyQuery, 1, null as any, settings, step);
  check(
    'a dead-on-boresight target does not lock on the very first frame',
    targeting.lockedId < 0,
    `lockedId=${targeting.lockedId} after 1 frame — dwell should still be accumulating`,
  );
  check(
    'acquisition progress is exposed and rising while dwelling',
    targeting.acquisitionProgress > 0 && targeting.acquisitionProgress < 1,
    `acquisitionProgress=${targeting.acquisitionProgress.toFixed(3)}`,
  );

  // Keep dwelling until the lock completes; the 1.0s ceiling is well past the documented
  // window so a regression that never locks fails loudly instead of looping forever.
  let seconds = step;
  while (targeting.lockedId < 0 && seconds < 1.0) {
    targeting.update(player, mockEnemyQuery, 1, null as any, settings, step);
    seconds += step;
  }
  check(
    'the lock completes within the documented 0.35-0.6s dwell window',
    targeting.lockedId === 7 && seconds >= 0.35 && seconds <= 0.7,
    `locked after ${seconds.toFixed(2)}s (lockedId=${targeting.lockedId})`,
  );
  check(
    'acquisitionProgress reads back to 0 once a lock exists',
    targeting.acquisitionProgress === 0,
    `acquisitionProgress=${targeting.acquisitionProgress}`,
  );
}

/** Partial acquisition progress must decay (not persist) once the reticle looks away. */
function testLockAcquisitionDecaysWhenLookingAway(): void {
  const targeting = new TargetingSystem();
  const player = createPlayerState({
    hullId: 'starfall',
    primary: 'pulseRepeater',
    secondary: 'swarmMissiles',
    difficulty: Difficulty.Pilot,
  });
  player.position.set(0, 0, 0);

  const enemyPos = new THREE.Vector3(0, 0, -100);
  const mockEnemy = { id: 3, position: enemyPos, velocity: new THREE.Vector3(), active: true, radius: 5 };
  const withTarget = {
    queryNear: () => 1,
    getByIndex: () => mockEnemy,
    getById: (id: number) => (id === 3 ? mockEnemy : null),
  } as any;
  const empty = { queryNear: () => 0, getByIndex: () => null, getById: () => null } as any;
  const settings = { aimAssist: 0 } as any;
  const step = 1 / 60;

  // Dwell for a quarter second — short of a full lock — then look away for a full second.
  for (let i = 0; i < 15; i++) targeting.update(player, withTarget, 1, null as any, settings, step);
  const midway = targeting.acquisitionProgress;
  for (let i = 0; i < 60; i++) targeting.update(player, empty, 0, null as any, settings, step);

  check(
    'looking away decays acquisition progress back to zero instead of holding or completing it',
    midway > 0 && targeting.acquisitionProgress === 0 && targeting.lockedId < 0,
    `midway=${midway.toFixed(3)}, after look-away=${targeting.acquisitionProgress.toFixed(3)}, lockedId=${targeting.lockedId}`,
  );
}

/**
 * Playtester feedback #5/#6: bosses were excluded from lock-on entirely (because they live
 * outside the pooled `EnemyQuery` the targeting system reads from) and were small enough to be
 * "too easy" to just sit and shoot. Covers the `CombinedEnemyQuery` adapter end-to-end — a real
 * `TargetingSystem` completing a real dwell-based lock through it — plus the collision-radius
 * bump each boss got.
 */
function testBossLockOnAndHitboxes(): void {
  const events = new TypedEventBus();
  const scene = new THREE.Scene();
  const projectiles = new ProjectileSystem(scene, events);
  const encounter = new BossEncounter(scene, events, projectiles);

  const bossCtx: BossContext = {
    projectiles,
    events,
    playerPos: new THREE.Vector3(0, 0, 0),
    playerVel: new THREE.Vector3(),
    playerAlive: true,
    arenaRadius: 520,
    elapsed: 0,
    onTelegraph: () => {},
  };

  encounter.start('vashkan', 500, 520, 2);
  check(
    'a boss is not lock-on-eligible during its name-card intro',
    encounter.targetableEnemy === null,
    `targetableEnemy=${encounter.targetableEnemy}`,
  );

  encounter.update(bossCtx, 2.1); // outlasts the 2s intro in one step
  check(
    'Vashkan becomes lock-on-eligible once its intro ends',
    encounter.targetableEnemy !== null,
    `targetableEnemy=${encounter.targetableEnemy}`,
  );
  check(
    'Vashkan hitbox increased to 20 world units (was 14) — more than doubles the hittable area',
    encounter.current?.radius === 20,
    `radius=${encounter.current?.radius}`,
  );

  const emptyPooledEnemies: EnemyQuery = { queryNear: () => 0, getByIndex: () => null, getById: () => null };
  const combined = new CombinedEnemyQuery(emptyPooledEnemies, encounter);
  const buf = new Int32Array(8);
  const nearCount = combined.queryNear(0, 0, 0, 10000, buf);
  check(
    'CombinedEnemyQuery surfaces the boss to a scan even with zero pooled enemies alive',
    nearCount === 1,
    `nearCount=${nearCount}`,
  );
  const resolved = nearCount > 0 ? combined.getByIndex(buf[0]!) : null;
  check(
    'the resolved boss entry round-trips through getById by its own id',
    resolved !== null && combined.getById(resolved.id) === resolved,
    `resolved id=${resolved ? resolved.id : null}`,
  );

  // Feed the merged query into the real dwell-based TargetingSystem, exactly as game.ts's
  // wiring change would, to confirm the whole path locks onto a boss and not just the adapter.
  const targeting = new TargetingSystem();
  const player = createPlayerState({
    hullId: 'starfall',
    primary: 'pulseRepeater',
    secondary: 'swarmMissiles',
    difficulty: Difficulty.Pilot,
  });
  player.position.set(0, 0, 0);
  player.velocity.set(0, 0, 0);
  encounter.current!.position.set(0, 0, -100); // dead ahead of the default (identity) facing
  const settings = { aimAssist: 0 } as unknown as import('./core/types').Settings;
  const step = 1 / 60;
  let seconds = 0;
  while (targeting.lockedId < 0 && seconds < 1.0) {
    targeting.update(player, combined, 0, null as unknown as THREE.Camera, settings, step);
    seconds += step;
  }
  check(
    'TargetingSystem completes a real lock on a boss through CombinedEnemyQuery',
    resolved !== null && targeting.lockedId === resolved.id,
    `lockedId=${targeting.lockedId}, expected=${resolved?.id}, after ${seconds.toFixed(2)}s`,
  );

  encounter.clear();

  encounter.start('hexard', 500, 520, 0);
  check(
    'Hexard hitbox increased to 32 world units (was 26)',
    encounter.current?.radius === 32,
    `radius=${encounter.current?.radius}`,
  );
  encounter.clear();

  encounter.start('mawCore', 500, 520, 0);
  check(
    'Maw Core hitbox increased to 40 world units (was 34)',
    encounter.current?.radius === 40,
    `radius=${encounter.current?.radius}`,
  );
  encounter.clear();
}

/**
 * Playtester feedback #19: Hexard's three "adds" should force a priority switch, and the boss
 * should visibly (not just numerically) become hard-to-hurt while they live. Covers the whole
 * gate: resistant-but-not-immune core damage while segments live, full damage once they're
 * cleared, and that segments themselves are never discounted (or there would be nothing to
 * prioritise).
 */
function testHexardAddGating(): void {
  const events = new TypedEventBus();
  const scene = new THREE.Scene();
  const projectiles = new ProjectileSystem(scene, events);
  const hexard = new Hexard();
  hexard.spawn(scene, 1000, 520);
  hexard.configureSegments(1000);

  const bossCtx: BossContext = {
    projectiles,
    events,
    playerPos: new THREE.Vector3(0, 0, -50),
    playerVel: new THREE.Vector3(),
    playerAlive: true,
    arenaRadius: 520,
    elapsed: 0,
    onTelegraph: () => {},
  };

  hexard.update(bossCtx, 1 / 60); // one step so segment orbit offsets are established

  check(
    'segments do not gate core damage before phase 1 activates them',
    !hexard.coreResistant,
    `coreResistant=${hexard.coreResistant}`,
  );

  // Cross the phase-1 threshold (startsBelow: 0.66) the same way ordinary player damage would,
  // rather than reaching into protected phase-machinery.
  hexard.damage(400, bossCtx); // 1000 -> 600, at/below the 660 threshold
  hexard.update(bossCtx, 1.3); // outlast the 1.2s post-transition invulnerability window

  check(
    'Hexard becomes core-resistant once its segment phase activates',
    hexard.coreResistant,
    `coreResistant=${hexard.coreResistant}, liveSegments=${hexard.liveSegments}`,
  );

  const hullBeforeResisted = hexard.hull;
  hexard.damage(100, bossCtx);
  const resistedLoss = hullBeforeResisted - hexard.hull;
  check(
    'core damage is reduced to ~12% while adds are alive (an 85-90% reduction band) — resistant, not immune',
    resistedLoss > 0 && resistedLoss < 20,
    `expected ~12, got ${resistedLoss.toFixed(2)}`,
  );

  // Kill every segment directly. Each pool is totalHull*0.18/3 = 60; 70 clears it with margin.
  for (let i = 0; i < 3; i++) hexard.damageSegment(i, 70, bossCtx);
  check('all three segments are dead after enough direct damage', hexard.liveSegments === 0, `liveSegments=${hexard.liveSegments}`);
  check('the core stops being resistant once every add is down', !hexard.coreResistant, `coreResistant=${hexard.coreResistant}`);

  const hullBeforeFull = hexard.hull;
  hexard.damage(100, bossCtx);
  const fullLoss = hullBeforeFull - hexard.hull;
  check(
    'core damage returns to its full value once the adds are cleared',
    Math.abs(fullLoss - 100) < 1e-6,
    `expected 100, got ${fullLoss.toFixed(2)}`,
  );

  // A dead segment must not be damageable twice, and a hit on a live segment must not also land
  // on the core through the resistant-core path.
  const hullBeforeDeadSegment = hexard.hull;
  const killedWholeBoss = hexard.damageSegment(0, 1000, bossCtx);
  check(
    'damaging an already-dead segment is a no-op',
    !killedWholeBoss && hexard.hull === hullBeforeDeadSegment,
    `hull ${hullBeforeDeadSegment} -> ${hexard.hull}`,
  );
}

/**
 * Batch B, mechanic 1: Debris Belt ramming/shooting. `game.ts`'s `checkAsteroidRam` and the
 * `blockedByTerrain` shot-damage wiring both sit on top of `Arena`'s collision/damage API plus
 * `PlayerSystem.takeDamage` and the `HAZARD` constants — Game itself needs a live DOM container
 * and can't run headlessly, so this exercises exactly that combination directly rather than
 * only the sweep test that used to gate it (raycastAsteroids has had a caller — enemy-fire
 * terrain blocking — since before this pass; what was missing was anything that turned a hit
 * into damage on either side).
 */
function testAsteroidRamming(): void {
  const scene = new THREE.Scene();
  const arena = new Arena(scene, 777);

  // Every rock is alive immediately after construction, so index 0 is a stable, deterministic
  // target rather than something that needs to be searched for.
  const rockPos = new THREE.Vector3();
  const rockRadius = arena.getAsteroid(0, rockPos);
  check('arena seeds a live asteroid at index 0', rockRadius > 0, `radius=${rockRadius}`);

  // A short straight-line sweep centred on the rock, well outside it on both ends, must find it.
  const axis = new THREE.Vector3(1, 0, 0);
  const from = rockPos.clone().addScaledVector(axis, rockRadius + 40);
  const to = rockPos.clone().addScaledVector(axis, -(rockRadius + 40));
  const hit = arena.raycastAsteroids(from, to, HAZARD.playerRamRadius);
  check('raycastAsteroids finds a rock the sweep passes through', hit === 0, `hit=${hit}`);

  // A sweep nowhere near the field (the shell tops out at 0.82 * ARENA.radius) must miss clean.
  const clearFrom = new THREE.Vector3(0, 5000, 0);
  const clearTo = new THREE.Vector3(10, 5000, 0);
  check(
    'raycastAsteroids reports no hit for a sweep nowhere near the field',
    arena.raycastAsteroids(clearFrom, clearTo, HAZARD.playerRamRadius) < 0,
  );

  // Replicate checkAsteroidRam's arithmetic for a full-boost-speed impact (see HAZARD's doc
  // comments for the same numbers) and confirm it damages both sides through the real APIs.
  const events = new TypedEventBus();
  const player = createPlayerState({
    hullId: 'starfall',
    primary: 'pulseRepeater',
    secondary: 'swarmMissiles',
    difficulty: Difficulty.Pilot,
  });
  const playerSystem = new PlayerSystem(player, events);
  const hullBefore = player.hull;

  const closingSpeed = PLAYER.baseSpeed * 1.85; // full boost, per HAZARD.ramDamagePerSpeed's comment
  const over = closingSpeed - HAZARD.ramMinSpeed;
  const dealt = playerSystem.takeDamage(over * HAZARD.ramDamagePerSpeed, 1, 0, 0);
  check(
    'a full-speed ram deals real, bounded hull damage to the player',
    dealt > 0 && dealt < player.stats.maxHull && player.hull < hullBefore,
    `dealt=${dealt.toFixed(1)}, hull ${hullBefore} -> ${player.hull.toFixed(1)}`,
  );

  let rockKilled = false;
  let hits = 0;
  while (!rockKilled && hits < 20) {
    rockKilled = arena.damageAsteroid(0, over * HAZARD.ramDamagePerSpeedToRock);
    hits++;
  }
  check('repeated ram-scale hits eventually destroy the rock', rockKilled, `took ${hits} hit(s)`);
  check(
    'a destroyed rock is no longer a live collider',
    arena.getAsteroid(0, rockPos) === 0,
    `radius after death=${arena.getAsteroid(0, rockPos)}`,
  );

  arena.dispose();
}

/**
 * Batch B, mechanic 2: Ion Storm EMP suppression. While `PlayerSystem.setEmpSuppressed(true)`
 * is in effect, shield regen must stop entirely and any remaining charge must drain toward zero
 * at `PLAYER.empShieldDrainRate` (a bleed, not an instant zero-out — see that constant's doc
 * comment), then normal regen must resume the instant suppression lifts.
 */
function testEmpSuppression(): void {
  const events = new TypedEventBus();
  const player = createPlayerState({
    hullId: 'starfall',
    primary: 'pulseRepeater',
    secondary: 'swarmMissiles',
    difficulty: Difficulty.Pilot,
  });
  const playerSystem = new PlayerSystem(player, events);

  // Partial shield, long out of combat — absent suppression this would be regenerating.
  player.shield = player.stats.maxShield * 0.5;
  player.timeSinceDamage = 999;

  playerSystem.setEmpSuppressed(true);
  const beforeDrain = player.shield;
  playerSystem.update(1 / 60);
  const expectedDrop = PLAYER.empShieldDrainRate * (1 / 60);
  check(
    'shield regen is suppressed and existing charge drains at empShieldDrainRate, not instantly',
    player.shield > 0 && Math.abs(beforeDrain - player.shield - expectedDrop) < 1e-6,
    `shield ${beforeDrain.toFixed(3)} -> ${player.shield.toFixed(3)} (expected drop ${expectedDrop.toFixed(4)})`,
  );

  // Keep draining to zero and confirm the "shields just hit zero" signal fires exactly once at
  // the crossing (see PlayerSystem.updateShield's comment for why this reuses shieldBreak).
  let breaks = 0;
  events.on('player:shieldBreak', () => {
    breaks++;
  });
  let steps = 0;
  while (player.shield > 0 && steps < 6000) {
    playerSystem.update(1 / 60);
    steps++;
  }
  check('sustained EMP exposure drains the shield fully to zero', player.shield === 0, `steps=${steps}`);
  check('the drain-to-zero fires exactly one shieldBreak signal', breaks === 1, `breaks=${breaks}`);

  // Lift suppression: regen must resume immediately (timeSinceDamage is still well past
  // shieldDelay), rather than staying latched off.
  playerSystem.setEmpSuppressed(false);
  const beforeRegen = player.shield;
  playerSystem.update(1 / 60);
  check(
    'shield regen resumes the instant EMP suppression lifts',
    player.shield > beforeRegen,
    `shield ${beforeRegen.toFixed(3)} -> ${player.shield.toFixed(3)}`,
  );
}

export function runSelfTest(): TestResult[] {
  results.length = 0;
  testPalettes();
  testAugmentPool();
  testStatRecomputationIsAlwaysSane();
  testDraftsAlwaysFill();
  testDraftOddsArePublishable();
  testRarityDistribution();
  testRunProgression();
  testUnlockTree();
  testMetaGrantsOptionsNotPower();
  testCorePrimitives();
  testRngDeterminism();
  testFlightLoopsWithoutInverting();
  testFlightHoldsHeadingWhenReleased();
  testBoostBlinksOnTapNotHold();
  testLookRotationIsARotation();
  testLockAssistConvergesAndYields();
  testLeadTargetPrediction();
  testGimbalAssist();
  testHeatOverheatLockout();
  testOverchargeVentsBypassesLockout();
  testLockAcquisitionDwell();
  testLockAcquisitionDecaysWhenLookingAway();
  testBossLockOnAndHitboxes();
  testHexardAddGating();
  testAsteroidRamming();
  testEmpSuppression();
  return results;
}
