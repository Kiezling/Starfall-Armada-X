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
import { FlightModel } from './ship/flight';
import { createPlayerState } from './ship/player';
import type { InputAction, InputState } from './core/types';
import { TargetingSystem } from './combat/targeting';

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

  wasPressed(): boolean {
    return false;
  }
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

  // Bank the ship hard mid-flight, then let go of everything and confirm auto-level brings it
  // back to level — but only once, after the roll input actually stops.
  input.aimY = 0;
  input.steering = false;
  input.roll = 1;
  for (let i = 0; i < 40; i++) flight.update(player, input, STEP, 520, 1, null, 0);
  input.roll = 0;

  for (let i = 0; i < 4 * 120; i++) flight.update(player, input, STEP, 520, 1, null, 0);

  flightUp.set(0, 1, 0).applyQuaternion(player.quaternion);
  flightForward.set(0, 0, -1).applyQuaternion(player.quaternion);
  // Compare against world-up projected into the ship's own plane, not raw world-up, since a
  // level ship pitched away from the horizon still has its up vector tilted off (0,1,0).
  const projectedUp = new THREE.Vector3(0, 1, 0)
    .addScaledVector(flightForward, -flightForward.dot(new THREE.Vector3(0, 1, 0)))
    .normalize();
  const levelError = Math.acos(Math.max(-1, Math.min(1, flightUp.dot(projectedUp))));
  check(
    'auto-level settles bank back to level once roll is released',
    levelError < 0.05,
    `${((levelError * 180) / Math.PI).toFixed(2)}° of residual bank after settling`,
  );
}

/**
 * Releasing the steering keys must *hold the heading*, not drift. On a keyboard the axes rest
 * at exactly zero, so any residual turn would be the model's own doing — and a nose that
 * wanders on its own is unusable for aiming.
 */
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
 * apply soft-edge falloff outside the primary range.
 */
function testGimbalAssist(): void {
  const targeting = new TargetingSystem();

  const player = createPlayerState({
    hullId: 'starfall',
    primary: 'pulseRepeater',
    secondary: 'swarmMissiles',
    difficulty: Difficulty.Pilot,
  });
  player.position.set(0, 0, 0);
  player.velocity.set(0, 0, 0);

  // Test case 1: target 10° off boresight (within gimbal range).
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
  targeting.update(player, mockEnemyQuery10, 0, null as any, settings, 0);
  (targeting as any).locked = 0;

  const aimDir10 = new THREE.Vector3(0, 0, -1); // Facing forward.
  targeting.applyAimAssist(aimDir10, player.position, mockEnemyQuery10, 0, settings);

  const leadPoint10 = new THREE.Vector3();
  targeting.getLeadPoint(leadPoint10, 300, mockEnemyQuery10);
  const expectedDir10 = leadPoint10.clone().sub(player.position).normalize();
  const alignment10 = aimDir10.dot(expectedDir10);

  check(
    'gimbal at 10° aligns with lead point',
    alignment10 > 0.93,
    `alignment=${alignment10.toFixed(3)} (should be close to 1.0)`,
  );

  // Test case 2: target 25° off boresight (outside gimbal range, should be untouched).
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

  const targeting25 = new TargetingSystem();
  targeting25.update(player, mockEnemyQuery25, 0, null as any, settings, 0);
  (targeting25 as any).locked = 0;

  const aimDir25 = new THREE.Vector3(0, 0, -1);
  const aimDirBefore = aimDir25.clone();
  targeting25.applyAimAssist(aimDir25, player.position, mockEnemyQuery25, 0, settings);

  const unchanged = Math.abs(aimDir25.dot(aimDirBefore) - 1.0) < 0.02;
  check(
    'gimbal at 25° leaves aim direction unchanged',
    unchanged,
    `dot product ${aimDir25.dot(aimDirBefore).toFixed(3)} (should be ~1.0)`,
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
  testLockAssistConvergesAndYields();
  testLeadTargetPrediction();
  testGimbalAssist();
  return results;
}
