/**
 * Steering behaviours and per-archetype brains (DESIGN.md §10).
 *
 * Every function here runs once per live enemy per simulation step, so the zero-allocation
 * rule (§16.2.1) is absolute: no `new`, no array literals, no closures. Steering primitives
 * write their result into a caller-supplied `out` vector; brains combine several primitives by
 * accumulating into `intent.accel` using a small set of module-level scratch vectors that are
 * borrowed and immediately consumed, exactly like the pool in core/math.ts.
 *
 * `Enemy.aiState`/`aiTimer` are the only persistent scratch a brain gets; their meaning is
 * private to each archetype's function below. `Enemy.seed` desyncs identical enemies so a
 * swarm never reads as one enemy with extra hitpoints.
 */

import * as THREE from 'three';
import type { Enemy } from '../core/types';
import type { Rng } from '../core/rng';
import { ARENA } from '../core/constants';
import {
  EPSILON,
  TAU,
  WORLD_UP,
  clamp,
  clamp01,
  scratchVec3A,
} from '../core/math';

/* ------------------------------------------------------------------------------------------ */
/* Steering primitives                                                                         */
/* ------------------------------------------------------------------------------------------ */

/** Desired velocity toward `target` at `maxSpeed`, minus current velocity: the classic Reynolds
 * "seek" steering force. `out` doubles as workspace, so no scratch vector is needed. */
export function seek(
  out: THREE.Vector3,
  pos: THREE.Vector3,
  target: THREE.Vector3,
  maxSpeed: number,
  vel: THREE.Vector3,
): void {
  out.copy(target).sub(pos);
  if (out.lengthSq() < EPSILON) {
    out.set(0, 0, 0);
    return;
  }
  out.normalize().multiplyScalar(maxSpeed).sub(vel);
}

/** The inverse of `seek`: desired velocity directly away from `target`. */
export function flee(
  out: THREE.Vector3,
  pos: THREE.Vector3,
  target: THREE.Vector3,
  maxSpeed: number,
  vel: THREE.Vector3,
): void {
  out.copy(pos).sub(target);
  if (out.lengthSq() < EPSILON) {
    out.set(0, 0, 0);
    return;
  }
  out.normalize().multiplyScalar(maxSpeed).sub(vel);
}

/**
 * Seeks a point the target will occupy shortly, estimated from straight-line time-to-close —
 * cheaper than a true quadratic intercept (leadTarget in core/math.ts, which needs a
 * projectile speed) and good enough for a chasing enemy rather than a fired shot.
 */
export function pursue(
  out: THREE.Vector3,
  pos: THREE.Vector3,
  vel: THREE.Vector3,
  targetPos: THREE.Vector3,
  targetVel: THREE.Vector3,
  maxSpeed: number,
): void {
  const predicted = scratchVec3A;
  const dist = pos.distanceTo(targetPos);
  const t = dist / Math.max(maxSpeed, EPSILON);
  predicted.copy(targetVel).multiplyScalar(t).add(targetPos);
  seek(out, pos, predicted, maxSpeed, vel);
}

/**
 * Desired velocity to circle `center` at `radius`: a tangential term does the orbiting, a
 * radial term corrects drift back onto the ring. `tangentSign` of +1/-1 picks direction.
 */
export function orbit(
  out: THREE.Vector3,
  pos: THREE.Vector3,
  center: THREE.Vector3,
  radius: number,
  tangentSign: number,
  maxSpeed: number,
  vel: THREE.Vector3,
): void {
  const radial = scratchVec3A;
  radial.copy(pos).sub(center);
  const dist = radial.length();
  if (dist < EPSILON) {
    out.set(0, 0, 0);
    return;
  }
  radial.multiplyScalar(1 / dist);

  out.crossVectors(WORLD_UP, radial);
  if (out.lengthSq() < EPSILON) out.set(1, 0, 0);
  else out.normalize();
  out.multiplyScalar(tangentSign * maxSpeed);

  // Pull back toward the ring proportional to how far off it we are, capped so it never
  // dominates the tangential term and collapses the orbit into a straight seek.
  const radialError = clamp(dist - radius, -radius, radius);
  out.addScaledVector(radial, -radialError * 1.5);
  out.clampLength(0, maxSpeed * 1.4);
  out.sub(vel);
}

/**
 * A minimal read-only view over an enemy's neighbours, for `separate`. The manager owns the
 * actual spatial query; this interface exists so ai.ts never has to know how it is stored.
 */
export interface EnemyNeighbors {
  count: number;
  get(i: number): Enemy | null;
}

/**
 * Repels `self` from any neighbour within `radius`, weighted by how deep the overlap is. Pure
 * scalar arithmetic — no scratch vectors needed, and no allocation regardless of neighbour
 * count. This is what keeps a swarm from collapsing onto a single point.
 */
export function separate(
  out: THREE.Vector3,
  self: Enemy,
  neighbors: EnemyNeighbors,
  radius: number,
  strength: number,
): void {
  out.set(0, 0, 0);
  const radiusSq = radius * radius;
  const sx = self.position.x;
  const sy = self.position.y;
  const sz = self.position.z;

  for (let i = 0; i < neighbors.count; i++) {
    const n = neighbors.get(i);
    if (!n || n === self || !n.active) continue;
    const dx = sx - n.position.x;
    const dy = sy - n.position.y;
    const dz = sz - n.position.z;
    const dSq = dx * dx + dy * dy + dz * dz;
    if (dSq >= radiusSq || dSq < EPSILON) continue;
    const d = Math.sqrt(dSq);
    const push = (radius - d) / radius;
    out.x += (dx / d) * push;
    out.y += (dy / d) * push;
    out.z += (dz / d) * push;
  }
  out.multiplyScalar(strength);
}

/**
 * Desired velocity toward the local centroid of `self`'s neighbours within `radius` — the
 * Reynolds "cohesion" rule, and the counterpart to `separate` above (that one pushes apart at
 * close range; this one pulls together at long range). Used by the Warden to tuck in behind
 * whichever cluster of allies it is currently supporting rather than drifting to the arena edge
 * once the player gets close, which `flee` alone would do. Pure scalar accumulation over
 * `neighbors`, matching `separate`'s zero-allocation contract exactly.
 */
export function cohere(
  out: THREE.Vector3,
  self: Enemy,
  neighbors: EnemyNeighbors,
  radius: number,
  maxSpeed: number,
  vel: THREE.Vector3,
): void {
  out.set(0, 0, 0);
  let count = 0;
  const radiusSq = radius * radius;
  const sx = self.position.x;
  const sy = self.position.y;
  const sz = self.position.z;

  for (let i = 0; i < neighbors.count; i++) {
    const n = neighbors.get(i);
    if (!n || n === self || !n.active) continue;
    const dx = n.position.x - sx;
    const dy = n.position.y - sy;
    const dz = n.position.z - sz;
    const dSq = dx * dx + dy * dy + dz * dz;
    if (dSq >= radiusSq || dSq < EPSILON) continue;
    out.x += dx;
    out.y += dy;
    out.z += dz;
    count++;
  }

  if (count === 0) {
    out.set(0, 0, 0);
    return;
  }
  out.multiplyScalar(1 / count); // now the offset to the local flock centroid
  if (out.lengthSq() < EPSILON) {
    out.set(0, 0, 0);
    return;
  }
  out.normalize().multiplyScalar(maxSpeed).sub(vel);
}

/**
 * A small, smoothly-varying acceleration unique to this enemy, so a group holding formation
 * still reads as individual pilots rather than one rigid block. Purely a function of elapsed
 * time and `enemy.seed` — no stored state, so it costs nothing and never desyncs on its own.
 */
export function wander(out: THREE.Vector3, enemy: Enemy, elapsed: number, strength: number): void {
  const phase = enemy.seed * TAU;
  const t = elapsed * 1.3 + phase;
  const s = elapsed * 0.7 + phase * 1.7;
  out.set(Math.sin(t), Math.sin(s) * 0.4, Math.cos(t * 1.15 + phase)).multiplyScalar(strength);
}

/**
 * Pushes back toward the arena centre once `pos` passes the boundary's warning fraction — the
 * same band the player's own boundary rule (DESIGN.md §5) uses, so enemies and player read the
 * same shell consistently.
 */
export function containToArena(
  out: THREE.Vector3,
  pos: THREE.Vector3,
  arenaRadius: number,
  strength: number,
): void {
  const warnRadius = arenaRadius * ARENA.warnFraction;
  const distSq = pos.lengthSq();
  if (distSq <= warnRadius * warnRadius) {
    out.set(0, 0, 0);
    return;
  }
  const dist = Math.sqrt(distSq);
  const over = clamp01((dist - warnRadius) / Math.max(arenaRadius - warnRadius, EPSILON));
  out.set(-pos.x, -pos.y, -pos.z).multiplyScalar((strength * over) / dist);
}

/* ------------------------------------------------------------------------------------------ */
/* Brain contract                                                                               */
/* ------------------------------------------------------------------------------------------ */

/** What a brain decided this step. The manager turns intent into projectiles and spawns. */
export interface AiIntent {
  /** Desired acceleration, world space. */
  accel: THREE.Vector3;
  /** Direction the enemy wants to face. */
  facing: THREE.Vector3;
  /** True if the enemy wants to fire its primary attack this step. */
  wantsFire: boolean;
  /** True if the enemy wants to begin a telegraphed attack. */
  wantsTelegraph: boolean;
  /** True if a Carrier wants to spawn a drone, or a Mine Layer wants to drop a mine. */
  wantsSpecial: boolean;
  /** Where the enemy is aiming, for the manager to spawn projectiles along. */
  aimPoint: THREE.Vector3;
}

export function createAiIntent(): AiIntent {
  return {
    accel: new THREE.Vector3(),
    facing: new THREE.Vector3(0, 0, -1),
    wantsFire: false,
    wantsTelegraph: false,
    wantsSpecial: false,
    aimPoint: new THREE.Vector3(),
  };
}

export interface AiContext {
  playerPos: THREE.Vector3;
  playerVel: THREE.Vector3;
  playerAlive: boolean;
  arenaRadius: number;
  elapsed: number;
  neighbors: EnemyNeighbors;
  rng: Rng;
}

/* ------------------------------------------------------------------------------------------ */
/* Shared scratch + tuning                                                                      */
/* ------------------------------------------------------------------------------------------ */
/*
 * Module-level accumulators, reused across every enemy's brain update this frame. Each is
 * written and folded into `intent.accel` before the next primitive call touches it — never
 * held across a yield point, exactly like the borrow contract in core/math.ts.
 */
const _steerA = /*#__PURE__*/ new THREE.Vector3();
const _toPlayer = /*#__PURE__*/ new THREE.Vector3();
const _tangent = /*#__PURE__*/ new THREE.Vector3();
const _virtualTarget = /*#__PURE__*/ new THREE.Vector3();

/** Generic separation/containment weights shared by every archetype; individual brains may
 * scale them further for swarm-vs-solo feel. */
const SEPARATE_RADIUS_MULT = 4.5;
const SEPARATE_STRENGTH = 55;
const CONTAIN_STRENGTH = ARENA.pushAcceleration;
const WANDER_STRENGTH = 6;

function addCommonSteering(enemy: Enemy, ctx: AiContext, intent: AiIntent, separateStrength: number): void {
  separate(_steerA, enemy, ctx.neighbors, enemy.def.radius * SEPARATE_RADIUS_MULT, separateStrength);
  intent.accel.add(_steerA);

  containToArena(_steerA, enemy.position, ctx.arenaRadius, CONTAIN_STRENGTH);
  intent.accel.add(_steerA);

  wander(_steerA, enemy, ctx.elapsed, WANDER_STRENGTH);
  intent.accel.add(_steerA);
}

/** Sets `intent.facing` from `dir`, but only if `dir` is non-degenerate — otherwise a
 * momentarily zero velocity/accel would collapse the facing vector to (0,0,0), which cannot
 * build a valid orientation quaternion downstream. */
function faceSafely(intent: AiIntent, dir: THREE.Vector3, fallback: THREE.Vector3): void {
  if (dir.lengthSq() > EPSILON) intent.facing.copy(dir).normalize();
  else intent.facing.copy(fallback);
}

/** True on the first simulation step after spawn — used to seed a desynchronised initial
 * timer instead of leaving the pool's zero-initialised `aiTimer` in effect for every enemy of
 * a type at once. */
function justSpawned(enemy: Enemy, dt: number): boolean {
  return enemy.age <= dt;
}

/* ------------------------------------------------------------------------------------------ */
/* Wasp Drone — arcing swarm, kamikaze commit at contact range                                  */
/* ------------------------------------------------------------------------------------------ */

const WASP_STATE_APPROACH = 0;
const WASP_STATE_DIVE = 1;
/** Re-arm distance for leaving the dive commit, as a multiple of fireRange — hysteresis so a
 * drone bobbing at the edge of contact range doesn't flicker between states every frame. */
const WASP_DIVE_REARM_MULT = 1.6;

function waspDroneBrain(enemy: Enemy, ctx: AiContext, _dt: number, intent: AiIntent): void {
  const def = enemy.def;
  _toPlayer.copy(ctx.playerPos).sub(enemy.position);
  const dist = _toPlayer.length();

  if (enemy.aiState === WASP_STATE_DIVE && dist > def.fireRange * WASP_DIVE_REARM_MULT) {
    enemy.aiState = WASP_STATE_APPROACH;
  } else if (enemy.aiState === WASP_STATE_APPROACH && dist <= def.fireRange) {
    enemy.aiState = WASP_STATE_DIVE;
  }

  if (enemy.aiState === WASP_STATE_DIVE) {
    // Committed: straight-line kamikaze run, detonating on contact.
    seek(_steerA, enemy.position, ctx.playerPos, def.speed, enemy.velocity);
    intent.accel.add(_steerA);
    intent.wantsFire = dist <= def.radius + 2.5;
    faceSafely(intent, _toPlayer, enemy.forward);
  } else {
    // Arc swarm: aim at a point offset tangentially from the player rather than the player
    // itself, so a group of drones spreads into a curved envelope instead of filing in single
    // file. The offset shrinks as the drone closes, so the arc tightens into the dive.
    const side = enemy.seed < 0.5 ? 1 : -1;
    const spreadJitter = 0.6 + enemy.seed * 0.8;
    _tangent.crossVectors(WORLD_UP, _toPlayer);
    if (_tangent.lengthSq() < EPSILON) _tangent.set(1, 0, 0);
    else _tangent.normalize();
    _tangent.multiplyScalar(side * spreadJitter);

    const arcMag = clamp(dist * 0.55, 8, 100);
    _virtualTarget.copy(ctx.playerPos).addScaledVector(_tangent, arcMag);
    seek(_steerA, enemy.position, _virtualTarget, def.speed, enemy.velocity);
    intent.accel.add(_steerA);
    faceSafely(intent, enemy.velocity, enemy.forward);
  }

  // Wasps swarm, so separation must dominate everything else or the group collapses onto one
  // point the instant they converge on the player.
  addCommonSteering(enemy, ctx, intent, 140);
  intent.aimPoint.copy(ctx.playerPos);
}

/* ------------------------------------------------------------------------------------------ */
/* Interceptor — lead-pursuit dogfighter with strafing, breakoffs, and reactive jinks           */
/* ------------------------------------------------------------------------------------------ */

const INTERCEPTOR_STATE_APPROACH = 0;
const INTERCEPTOR_STATE_STRAFE = 1;
const INTERCEPTOR_STATE_BREAKOFF = 2;
const INTERCEPTOR_STATE_JINK = 3;

const INTERCEPTOR_JINK_DURATION = 0.45;
/** Per-second hazard rate applied while the player looks lined up on this interceptor; treated
 * as a memoryless approximation of "aimed at for a sustained moment" so no extra persistent
 * timer is needed beyond the FSM's own aiTimer. */
const INTERCEPTOR_JINK_HAZARD = 2.2;
const INTERCEPTOR_JINK_ALIGNMENT_COS = 0.94;
/** Duty cycle for "fires in short bursts, not continuously": each interceptor's burst phase is
 * offset by its own seed so a squadron doesn't volley in lockstep. */
const INTERCEPTOR_BURST_FREQ = 1.6;
const INTERCEPTOR_BURST_THRESHOLD = 0.25;

function interceptorBrain(enemy: Enemy, ctx: AiContext, dt: number, intent: AiIntent): void {
  const def = enemy.def;
  _toPlayer.copy(ctx.playerPos).sub(enemy.position);
  const dist = _toPlayer.length();

  if (justSpawned(enemy, dt)) {
    enemy.aiState = INTERCEPTOR_STATE_APPROACH;
    enemy.aiTimer = 0;
  }

  switch (enemy.aiState) {
    case INTERCEPTOR_STATE_APPROACH: {
      pursue(_steerA, enemy.position, enemy.velocity, ctx.playerPos, ctx.playerVel, def.speed);
      intent.accel.add(_steerA);
      faceSafely(intent, _toPlayer, enemy.forward);
      if (dist <= def.engageRange) {
        enemy.aiState = INTERCEPTOR_STATE_STRAFE;
        enemy.aiTimer = ctx.rng.range(1.6, 3.2);
      }
      break;
    }
    case INTERCEPTOR_STATE_STRAFE: {
      const side = enemy.seed < 0.5 ? 1 : -1;
      orbit(_steerA, enemy.position, ctx.playerPos, def.engageRange, side, def.speed, enemy.velocity);
      intent.accel.add(_steerA);
      faceSafely(intent, _toPlayer, enemy.forward);

      // Burst fire: on while in range and inside this enemy's own duty-cycle window.
      const burstPhase = Math.sin(ctx.elapsed * INTERCEPTOR_BURST_FREQ * TAU + enemy.seed * TAU);
      intent.wantsFire = dist <= def.fireRange && burstPhase > INTERCEPTOR_BURST_THRESHOLD;

      // Reactive dodge: if the player's closing velocity is aimed roughly at this interceptor,
      // there is a rising chance per second it jinks perpendicular to break the shot.
      const playerSpeed = ctx.playerVel.length();
      if (playerSpeed > EPSILON) {
        const aimDot = -_toPlayer.dot(ctx.playerVel) / (dist * playerSpeed || 1);
        if (aimDot > INTERCEPTOR_JINK_ALIGNMENT_COS) {
          const hazard = 1 - Math.exp(-INTERCEPTOR_JINK_HAZARD * dt);
          if (ctx.rng.next() < hazard) {
            enemy.aiState = INTERCEPTOR_STATE_JINK;
            enemy.aiTimer = INTERCEPTOR_JINK_DURATION;
          }
        }
      }

      enemy.aiTimer -= dt;
      if (enemy.aiTimer <= 0) {
        enemy.aiState = INTERCEPTOR_STATE_BREAKOFF;
        enemy.aiTimer = ctx.rng.range(1.0, 1.8);
      }
      break;
    }
    case INTERCEPTOR_STATE_JINK: {
      // Perpendicular dodge impulse, independent of the strafe orbit so it reads as a distinct
      // snap rather than a slightly-faster orbit.
      _tangent.crossVectors(WORLD_UP, _toPlayer);
      if (_tangent.lengthSq() < EPSILON) _tangent.set(1, 0, 0);
      else _tangent.normalize();
      const jinkSide = enemy.seed < 0.5 ? -1 : 1;
      intent.accel.addScaledVector(_tangent, jinkSide * def.speed * 2.2);
      intent.wantsFire = false;
      faceSafely(intent, _toPlayer, enemy.forward);

      enemy.aiTimer -= dt;
      if (enemy.aiTimer <= 0) {
        enemy.aiState = INTERCEPTOR_STATE_STRAFE;
        enemy.aiTimer = ctx.rng.range(1.2, 2.4);
      }
      break;
    }
    case INTERCEPTOR_STATE_BREAKOFF:
    default: {
      flee(_steerA, enemy.position, ctx.playerPos, def.speed, enemy.velocity);
      intent.accel.add(_steerA);
      faceSafely(intent, enemy.velocity, enemy.forward);

      enemy.aiTimer -= dt;
      if (enemy.aiTimer <= 0) {
        enemy.aiState = INTERCEPTOR_STATE_APPROACH;
        enemy.aiTimer = 0;
      }
      break;
    }
  }

  addCommonSteering(enemy, ctx, intent, SEPARATE_STRENGTH);
  intent.aimPoint.copy(ctx.playerPos).addScaledVector(ctx.playerVel, dist / Math.max(def.speed * 2.2, EPSILON));
}

/* ------------------------------------------------------------------------------------------ */
/* Lancer — kites at max range, telegraphs, fires, recovers                                     */
/* ------------------------------------------------------------------------------------------ */

const LANCER_STATE_REPOSITION = 0;
const LANCER_STATE_TELEGRAPH = 1;
const LANCER_STATE_FIRE = 2;

/** Matches DESIGN.md §10's "1.4 s beam telegraph" exactly. */
const LANCER_TELEGRAPH_TIME = 1.4;
const LANCER_FIRE_PULSE = 0.15;
const LANCER_READY_DELAY = 0.5;

function lancerBrain(enemy: Enemy, ctx: AiContext, dt: number, intent: AiIntent): void {
  const def = enemy.def;
  _toPlayer.copy(ctx.playerPos).sub(enemy.position);
  const dist = _toPlayer.length();

  if (justSpawned(enemy, dt)) {
    enemy.aiState = LANCER_STATE_REPOSITION;
    enemy.aiTimer = LANCER_READY_DELAY;
  }

  switch (enemy.aiState) {
    case LANCER_STATE_REPOSITION: {
      // The whole counter to a Lancer is closing the gap, so it must genuinely retreat rather
      // than merely stop advancing.
      if (dist < def.engageRange * 0.8) {
        flee(_steerA, enemy.position, ctx.playerPos, def.speed, enemy.velocity);
        intent.accel.add(_steerA);
      } else if (dist > def.fireRange * 0.95) {
        seek(_steerA, enemy.position, ctx.playerPos, def.speed * 0.6, enemy.velocity);
        intent.accel.add(_steerA);
      }
      // Otherwise: in its sniping band. "Stationary sniper" means it actually stops here.
      faceSafely(intent, _toPlayer, enemy.forward);

      enemy.aiTimer -= dt;
      if (enemy.aiTimer <= 0) {
        const inBand = dist >= def.engageRange * 0.8 && dist <= def.fireRange;
        if (inBand) {
          enemy.aiState = LANCER_STATE_TELEGRAPH;
          enemy.aiTimer = LANCER_TELEGRAPH_TIME;
        } else {
          enemy.aiTimer = LANCER_READY_DELAY;
        }
      }
      break;
    }
    case LANCER_STATE_TELEGRAPH: {
      intent.wantsTelegraph = true;
      faceSafely(intent, _toPlayer, enemy.forward);

      enemy.aiTimer -= dt;
      if (enemy.aiTimer <= 0) {
        enemy.aiState = LANCER_STATE_FIRE;
        enemy.aiTimer = LANCER_FIRE_PULSE;
      }
      break;
    }
    case LANCER_STATE_FIRE:
    default: {
      intent.wantsFire = true;
      faceSafely(intent, _toPlayer, enemy.forward);

      enemy.aiTimer -= dt;
      if (enemy.aiTimer <= 0) {
        const recover = Math.max(0.4, def.fireInterval - LANCER_TELEGRAPH_TIME - LANCER_FIRE_PULSE);
        enemy.aiState = LANCER_STATE_REPOSITION;
        enemy.aiTimer = recover;
      }
      break;
    }
  }

  addCommonSteering(enemy, ctx, intent, SEPARATE_STRENGTH);
  // No lead: the beam telegraphs the exact current player position, which is what makes it a
  // dodgeable, yellow-tier threat rather than an unavoidable one (DESIGN.md §13).
  intent.aimPoint.copy(ctx.playerPos);
}

/* ------------------------------------------------------------------------------------------ */
/* Bulwark — advances slowly, always keeps its armoured nose on the player                      */
/* ------------------------------------------------------------------------------------------ */

function bulwarkBrain(enemy: Enemy, ctx: AiContext, _dt: number, intent: AiIntent): void {
  const def = enemy.def;
  _toPlayer.copy(ctx.playerPos).sub(enemy.position);
  const dist = _toPlayer.length();

  if (dist > def.engageRange) {
    seek(_steerA, enemy.position, ctx.playerPos, def.speed, enemy.velocity);
    intent.accel.add(_steerA);
  }
  // Inside engage range it simply holds — a Bulwark does not need to manoeuvre, it needs to
  // keep its nose pointed at the threat, which is the line right below.

  // The entire flanking counterplay depends on this: the Bulwark always turns toward the
  // player regardless of where it is moving, so its armoured front is a target you have to
  // out-position it for, not something it will ever expose by accident.
  faceSafely(intent, _toPlayer, enemy.forward);

  intent.wantsFire = dist <= def.fireRange;
  intent.aimPoint.copy(ctx.playerPos);

  addCommonSteering(enemy, ctx, intent, SEPARATE_STRENGTH);
}

/* ------------------------------------------------------------------------------------------ */
/* Carrier — holds distance, drifts, periodically spawns drones                                 */
/* ------------------------------------------------------------------------------------------ */

/** Base interval between drone spawns; jittered per-instance below so multiple Carriers in a
 * wave don't pulse in lockstep. */
const CARRIER_SPAWN_INTERVAL = 4.5;

function carrierBrain(enemy: Enemy, ctx: AiContext, dt: number, intent: AiIntent): void {
  const def = enemy.def;
  _toPlayer.copy(ctx.playerPos).sub(enemy.position);
  const dist = _toPlayer.length();

  if (justSpawned(enemy, dt)) {
    // Stagger the opening spawn instead of every Carrier in a wave firing off its first drone
    // on the same frame it appears.
    enemy.aiTimer = CARRIER_SPAWN_INTERVAL * (0.3 + enemy.seed * 0.5);
  }

  if (dist < def.engageRange * 0.9) {
    flee(_steerA, enemy.position, ctx.playerPos, def.speed * 0.6, enemy.velocity);
    intent.accel.add(_steerA);
  } else if (dist > def.engageRange * 1.3) {
    seek(_steerA, enemy.position, ctx.playerPos, def.speed * 0.6, enemy.velocity);
    intent.accel.add(_steerA);
  }
  faceSafely(intent, _toPlayer, enemy.forward);

  enemy.aiTimer -= dt;
  if (enemy.aiTimer <= 0) {
    intent.wantsSpecial = true;
    enemy.aiTimer = CARRIER_SPAWN_INTERVAL * (0.85 + enemy.seed * 0.3);
  }

  // Weak point-defence fire only — a Carrier's threat is what it spawns, not its own gun.
  intent.wantsFire = dist <= def.fireRange;
  intent.aimPoint.copy(ctx.playerPos);

  addCommonSteering(enemy, ctx, intent, SEPARATE_STRENGTH);
}

/* ------------------------------------------------------------------------------------------ */
/* Mine Layer — strafes laterally across the approach, drops mines on an interval               */
/* ------------------------------------------------------------------------------------------ */

const MINE_DROP_INTERVAL = 3.0;
/** How slowly the crossing direction flips — large relative to the interval, so the Mine
 * Layer reads as sweeping broad lateral passes rather than tight little circles. */
const MINE_SIDE_FLIP_FREQ = 0.05;
const MINE_POTSHOT_DUTY = 0.7;

function mineLayerBrain(enemy: Enemy, ctx: AiContext, dt: number, intent: AiIntent): void {
  const def = enemy.def;
  _toPlayer.copy(ctx.playerPos).sub(enemy.position);
  const dist = _toPlayer.length();

  if (justSpawned(enemy, dt)) {
    enemy.aiTimer = MINE_DROP_INTERVAL * (0.3 + enemy.seed * 0.6);
  }

  const side = Math.sin(ctx.elapsed * MINE_SIDE_FLIP_FREQ * TAU + enemy.seed * TAU) >= 0 ? 1 : -1;
  orbit(_steerA, enemy.position, ctx.playerPos, def.engageRange, side, def.speed, enemy.velocity);
  intent.accel.add(_steerA);
  faceSafely(intent, enemy.velocity, enemy.forward);

  enemy.aiTimer -= dt;
  if (enemy.aiTimer <= 0) {
    intent.wantsSpecial = true;
    enemy.aiTimer = MINE_DROP_INTERVAL * (0.85 + enemy.seed * 0.3);
  }

  // Avoids direct engagement: only takes the occasional pot-shot rather than sustained fire.
  const potshotPhase = Math.sin(ctx.elapsed * 0.5 + enemy.seed * TAU);
  intent.wantsFire = dist <= def.fireRange && potshotPhase > MINE_POTSHOT_DUTY;
  intent.aimPoint.copy(ctx.playerPos);

  addCommonSteering(enemy, ctx, intent, SEPARATE_STRENGTH);
}

/* ------------------------------------------------------------------------------------------ */
/* Mortar — kites at extreme range, telegraphs, drops a proximity mine on the player's spot     */
/* ------------------------------------------------------------------------------------------ */

const MORTAR_STATE_REPOSITION = 0;
const MORTAR_STATE_TELEGRAPH = 1;

/** Shorter than Lancer's 1.4s beam telegraph: the payoff here is a placed hazard rather than
 * an instant hit, so the warning window can be tighter without becoming unfair. */
const MORTAR_TELEGRAPH_TIME = 1.2;
const MORTAR_READY_DELAY = 0.6;

function mortarBrain(enemy: Enemy, ctx: AiContext, dt: number, intent: AiIntent): void {
  const def = enemy.def;
  _toPlayer.copy(ctx.playerPos).sub(enemy.position);
  const dist = _toPlayer.length();

  if (justSpawned(enemy, dt)) {
    enemy.aiState = MORTAR_STATE_REPOSITION;
    enemy.aiTimer = MORTAR_READY_DELAY;
  }

  switch (enemy.aiState) {
    case MORTAR_STATE_REPOSITION: {
      // Same reposition shape as the Lancer: retreat if crowded, creep closer if out of range,
      // otherwise hold — a Mortar's sniping band is where it actually stops.
      if (dist < def.engageRange * 0.8) {
        flee(_steerA, enemy.position, ctx.playerPos, def.speed, enemy.velocity);
        intent.accel.add(_steerA);
      } else if (dist > def.fireRange * 0.95) {
        seek(_steerA, enemy.position, ctx.playerPos, def.speed * 0.6, enemy.velocity);
        intent.accel.add(_steerA);
      }
      faceSafely(intent, _toPlayer, enemy.forward);

      enemy.aiTimer -= dt;
      if (enemy.aiTimer <= 0) {
        const inBand = dist >= def.engageRange * 0.8 && dist <= def.fireRange;
        if (inBand) {
          enemy.aiState = MORTAR_STATE_TELEGRAPH;
          enemy.aiTimer = MORTAR_TELEGRAPH_TIME;
        } else {
          enemy.aiTimer = MORTAR_READY_DELAY;
        }
      }
      break;
    }
    case MORTAR_STATE_TELEGRAPH:
    default: {
      intent.wantsTelegraph = true;
      faceSafely(intent, _toPlayer, enemy.forward);

      enemy.aiTimer -= dt;
      if (enemy.aiTimer <= 0) {
        // Fires exactly once, on the single frame the telegraph completes, then immediately
        // returns to REPOSITION so the next frame doesn't re-trigger it. `wantsSpecial` tells
        // manager.ts to drop the shell at *this* frame's player position (no lead) — same
        // "no lead, dodge during the telegraph" rule the Lancer's beam uses, just paid out as a
        // lingering hazard (manager.ts's 'mortar' handleSpecial branch) instead of an instant
        // hit, which is what makes camping the same spot dangerous over multiple volleys even
        // though any single shell is dodgeable by simply moving.
        intent.wantsSpecial = true;
        enemy.aiState = MORTAR_STATE_REPOSITION;
        enemy.aiTimer = Math.max(0.6, def.fireInterval - MORTAR_TELEGRAPH_TIME);
      }
      break;
    }
  }

  addCommonSteering(enemy, ctx, intent, SEPARATE_STRENGTH);
  // No lead, matching the Lancer's own beam: the shell lands wherever the player is *right now*.
  intent.aimPoint.copy(ctx.playerPos);
}

/* ------------------------------------------------------------------------------------------ */
/* Warden — hangs near its escort, restores their shields; flees the player, never leads a fight */
/* ------------------------------------------------------------------------------------------ */

/** Radius `cohere` searches for allies to tuck in behind. Deliberately larger than
 * manager.ts's `WARDEN_AURA_RADIUS` (70): the Warden should be drawn toward a cluster before
 * it's necessarily within aura range of all of it, the same way a real support pilot closes on
 * a fight already in progress rather than teleporting into position. */
const WARDEN_COHESION_RADIUS = 90;
/** Duty cycle for its point-defence potshots, same idiom as Mine Layer's — the Warden is not
 * meant to feel like a threat on its own, only as the thing keeping its escort alive. */
const WARDEN_POTSHOT_DUTY = 0.75;

function wardenBrain(enemy: Enemy, ctx: AiContext, _dt: number, intent: AiIntent): void {
  const def = enemy.def;
  _toPlayer.copy(ctx.playerPos).sub(enemy.position);
  const dist = _toPlayer.length();

  // Never lets the player close inside its standoff — a Warden with the player on top of it is
  // a Warden about to die before its aura matters to anything.
  if (dist < def.engageRange) {
    flee(_steerA, enemy.position, ctx.playerPos, def.speed, enemy.velocity);
    intent.accel.add(_steerA);
  }

  // Pulled toward whatever it's protecting: without this it would simply flee to the arena edge
  // the instant the player approaches and its aura would end up covering nobody.
  cohere(_steerA, enemy, ctx.neighbors, WARDEN_COHESION_RADIUS, def.speed, enemy.velocity);
  intent.accel.add(_steerA);

  faceSafely(intent, _toPlayer, enemy.forward);

  // Weak point-defence only, same duty-cycle idiom as Mine Layer's pot-shots — a Warden's
  // threat is the aura (manager.ts's `applyWardenAura`), not its gun.
  const potshotPhase = Math.sin(ctx.elapsed * 0.6 + enemy.seed * TAU);
  intent.wantsFire = dist <= def.fireRange && potshotPhase > WARDEN_POTSHOT_DUTY;
  intent.aimPoint.copy(ctx.playerPos);

  addCommonSteering(enemy, ctx, intent, SEPARATE_STRENGTH);
}

/* ------------------------------------------------------------------------------------------ */
/* Idle brain — no live player target (e.g. death-cam / intermission)                          */
/* ------------------------------------------------------------------------------------------ */

function idleBrain(enemy: Enemy, ctx: AiContext, intent: AiIntent): void {
  wander(_steerA, enemy, ctx.elapsed, WANDER_STRENGTH);
  intent.accel.add(_steerA);
  containToArena(_steerA, enemy.position, ctx.arenaRadius, CONTAIN_STRENGTH);
  intent.accel.add(_steerA);
  separate(_steerA, enemy, ctx.neighbors, enemy.def.radius * SEPARATE_RADIUS_MULT, SEPARATE_STRENGTH);
  intent.accel.add(_steerA);
  faceSafely(intent, enemy.velocity, enemy.forward);
}

/* ------------------------------------------------------------------------------------------ */
/* Dispatch                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** Runs the brain for one enemy and writes the result into `intent`. Allocates nothing. */
export function updateBrain(enemy: Enemy, ctx: AiContext, dt: number, intent: AiIntent): void {
  intent.accel.set(0, 0, 0);
  intent.wantsFire = false;
  intent.wantsTelegraph = false;
  intent.wantsSpecial = false;
  intent.aimPoint.copy(ctx.playerPos);
  intent.facing.copy(enemy.forward);

  if (!ctx.playerAlive) {
    idleBrain(enemy, ctx, intent);
    return;
  }

  switch (enemy.typeId) {
    case 'waspDrone':
      waspDroneBrain(enemy, ctx, dt, intent);
      break;
    case 'interceptor':
      interceptorBrain(enemy, ctx, dt, intent);
      break;
    case 'lancer':
      lancerBrain(enemy, ctx, dt, intent);
      break;
    case 'bulwark':
      bulwarkBrain(enemy, ctx, dt, intent);
      break;
    case 'carrier':
      carrierBrain(enemy, ctx, dt, intent);
      break;
    case 'mineLayer':
      mineLayerBrain(enemy, ctx, dt, intent);
      break;
    case 'mortar':
      mortarBrain(enemy, ctx, dt, intent);
      break;
    case 'warden':
      wardenBrain(enemy, ctx, dt, intent);
      break;
  }
}
