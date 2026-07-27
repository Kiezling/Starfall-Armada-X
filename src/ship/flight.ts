/**
 * The flight model — "assisted arena flight".
 *
 * This is the single most important system for game feel, and the one where the genre most
 * often loses players. The research (DESIGN.md §2) is blunt about it: full 6DOF causes
 * disorientation and motion sickness, and auto-levelling is the standard mitigation.
 *
 * Orientation is a single quaternion, integrated in **body axes**: every step, the current
 * per-step pitch/yaw/roll rates (pitch about local X, yaw about local Y, roll about local Z)
 * are turned into a small delta rotation and composed onto the running orientation —
 * `orientation.multiply(delta)`, then renormalised. There is no yaw/pitch/roll scalar model
 * underneath and no clamp on pitch: the ship can pitch all the way over the top and keep
 * going, loop after loop, with no stop, no snap, and no gimbal lock. Body-axis yaw also needs
 * no compensation for pitch — unlike a world-up yaw, it turns the nose across the screen at
 * the same rate regardless of attitude, so there is no `cos(pitch)` scaling to carry.
 *
 * The one thing still measured against a fixed reference is roll: gentle auto-levelling pulls
 * bank back toward "flat against world up" so normal flight has a true level to return to.
 * That correction only ever runs when it is unambiguous and unopposed — never near vertical
 * (there is no meaningful "level" nose-up), never while the player is actively rolling, and
 * never in the second or so after sustained pitch input, so a looping ship is never yanked
 * upright mid-loop. It settles the ship level again once the loop is over and pitching stops.
 *
 * It is not Newtonian, deliberately. Pure momentum drift is the least readable option in a
 * dogfight. Instead velocity chases a target vector with a critically-damped approach, which
 * reads as inertia without ever feeling like ice.
 *
 * The depth mechanic is **drift**: holding it decouples heading from velocity, so the ship
 * keeps its momentum while the nose swings free. It is the only way to hold guns on something
 * that is out-turning you, and it is on a cooldown so it stays a decision rather than a mode.
 */

import * as THREE from 'three';
import type { InputState, PlayerState } from '../core/types';
import { ARENA, PLAYER } from '../core/constants';
import {
  FORWARD,
  clamp,
  dampVec3,
  moveTowards,
  scratchVec3A,
  scratchVec3B,
  scratchVec3C,
} from '../core/math';

/* Module-level scratch. Reused every step so the flight model allocates nothing. */
const forward = /*#__PURE__*/ new THREE.Vector3();
const right = /*#__PURE__*/ new THREE.Vector3();
const targetVelocity = /*#__PURE__*/ new THREE.Vector3();

/* Scratch for the body-axis integration and the auto-level roll reference. Kept private to
 * this file (rather than the shared `scratchVec3*`/`scratchQuat*` pool) because several of
 * them need to stay alive across the whole angular-motion section of `update`. */
const deltaQuat = /*#__PURE__*/ new THREE.Quaternion();
const bodyRateAxis = /*#__PURE__*/ new THREE.Vector3();
const trackUp = /*#__PURE__*/ new THREE.Vector3();
const targetQuat = /*#__PURE__*/ new THREE.Quaternion();
const trackLookMatrix = /*#__PURE__*/ new THREE.Matrix4();
/** Fixed at the origin — `Matrix4.lookAt` takes eye/target as points, not a direction. */
const trackEye = /*#__PURE__*/ new THREE.Vector3(0, 0, 0);

export interface FlightResult {
  /** Signed yaw rate this step, for the visual banking of wings and the camera lean. */
  yawRate: number;
  pitchRate: number;
  /** 0..1 normalised speed, for FOV, trails, and the momentum damage bonus. */
  speedFraction: number;
  /** True while the boundary is pushing the player back inward. */
  atBoundary: number;
  /** 0..1 how hard the lock-tracking assist is working, for the HUD lock readout. */
  lockTracking: number;
}

export class FlightModel {
  private readonly result: FlightResult = {
    yawRate: 0,
    pitchRate: 0,
    speedFraction: 0,
    atBoundary: 0,
    lockTracking: 0,
  };

  /** The ship's full orientation. Integrated in body axes — nothing rebuilds it from scalars. */
  private readonly orientation = new THREE.Quaternion();

  /**
   * Advances one fixed simulation step.
   *
   * @param speedBuffMult Transient speed multiplier from augment procs (Slipstream, Evasive
   *        Protocols). Kept out of PlayerState so buff bookkeeping stays in one place.
   * @param trackDir Unit direction toward the locked target's intercept point, or null when
   *        nothing is locked. Drives the tracking assist.
   * @param trackStrength 0..1 authority for that assist: 1 while hard lock is held.
   */
  update(
    player: PlayerState,
    input: InputState,
    dt: number,
    arenaRadius: number,
    speedBuffMult: number,
    trackDir: THREE.Vector3 | null,
    trackStrength: number,
  ): FlightResult {
    const stats = player.stats;
    const def = player.def;

    // --- Blink --------------------------------------------------------------------------------
    // Boost is a tap, not a hold: one press spends `blinkCost` and buys a fixed `blinkDuration`
    // of boosted speed that runs to completion on its own. Holding the key does nothing extra,
    // which is the point — it frees the key that a limited-rollover keyboard was dropping, and
    // it makes boost a committed repositioning burst rather than a speed slider.
    //
    // The press edge is read with `wasPressed`, so this must run on the fixed-timestep path:
    // `endStep` clears the edge once per simulation step, and a blink triggered from the render
    // cadence would fire several times off a single tap.
    if (player.blinkTimer > 0) {
      player.blinkTimer -= dt;
      if (player.blinkTimer <= 0) {
        player.blinkTimer = 0;
        player.boosting = false;
      }
    }

    // Charge regenerates whenever a blink is not actively running, including across the tap
    // itself — the cost is deducted up front, so there is no window where a blink both drains
    // and refills.
    if (player.blinkTimer <= 0) {
      player.boost = Math.min(PLAYER.boostMax, player.boost + PLAYER.boostRegen * stats.boostMult * dt);
      // The rearm threshold stops a nearly-empty meter being feathered into a stutter of
      // micro-blinks; it has to clear the cost outright, not merely be non-zero.
      if (input.wasPressed('boost') && player.boost >= PLAYER.boostRearmThreshold) {
        player.boost = Math.max(0, player.boost - PLAYER.blinkCost);
        player.blinkTimer = PLAYER.blinkDuration;
        player.boosting = true;
      }
    }

    // --- Drift ---------------------------------------------------------------------------------
    this.updateDrift(player, input, dt);

    // --- Angular motion ------------------------------------------------------------------------
    // Drifting turns faster — that is the entire point of it. PLAYER.driftTurnBonus is the
    // base multiplier; Inertial Dampers stacks add on top.
    const driftMult = player.drifting ? PLAYER.driftTurnBonus + stats.driftTurnBonus : 1;
    const turnRate = def.turnRate * stats.turnRateMult * driftMult;

    // Steering maps to a *rate*, not an angle. Squaring the magnitude while keeping the sign
    // gives fine control on a light tap and full authority on a held key.
    const desiredYaw = -signedSquare(input.aimX) * turnRate;
    const desiredPitch = signedSquare(input.aimY) * turnRate;

    const accel = PLAYER.angularAcceleration * dt;
    player.angular.x = moveTowards(player.angular.x, desiredPitch, accel);
    player.angular.y = moveTowards(player.angular.y, desiredYaw, accel);

    // --- Lock tracking assist -------------------------------------------------------------------
    const tracking = this.applyTrackingAssist(input, trackDir, trackStrength, turnRate, dt);

    // --- Roll: manual only ---------------------------------------------------------------------
    const rollInput = input.roll;

    if (Math.abs(rollInput) > 0.01) {
      player.angular.z = rollInput * PLAYER.rollRate;
    } else {
      // No auto-levelling. Space has no horizon to return to, and re-levelling is exactly what
      // made sustained climbs and dives whip the view around. Roll simply bleeds off to zero,
      // so whatever attitude the player flies into is the attitude they keep.
      player.angular.z = moveTowards(player.angular.z, 0, PLAYER.angularAcceleration * dt);
    }

    // --- Integrate orientation in body axes -----------------------------------------------------
    // The three per-step rates describe a single instantaneous rotation of the body frame; its
    // axis-angle form is exactly that rotation, so composing it is order-independent and exact
    // for the step, unlike composing three separate axis rotations.
    bodyRateAxis.set(player.angular.x, player.angular.y, player.angular.z);
    const rateMagSq = bodyRateAxis.lengthSq();
    if (rateMagSq > 1e-12) {
      const rateMag = Math.sqrt(rateMagSq);
      bodyRateAxis.multiplyScalar(1 / rateMag);
      deltaQuat.setFromAxisAngle(bodyRateAxis, rateMag * dt);
      this.orientation.multiply(deltaQuat);
      this.orientation.normalize();
    }
    player.quaternion.copy(this.orientation);

    forward.copy(FORWARD).applyQuaternion(player.quaternion).normalize();
    right.set(1, 0, 0).applyQuaternion(player.quaternion).normalize();

    // --- Linear motion ---------------------------------------------------------------------------
    const boostMult = player.boosting ? def.boostMultiplier * stats.boostMult : 1;
    const maxSpeed = def.maxSpeed * stats.speedMult * speedBuffMult * boostMult;

    const throttle = input.throttle;
    const forwardSpeed = throttle >= 0 ? throttle * maxSpeed : throttle * maxSpeed * PLAYER.reverseFraction;
    const strafeSpeed = input.strafe * maxSpeed * PLAYER.strafeFraction;

    if (player.drifting) {
      // Momentum is preserved along the vector locked in at drift start; thrust only nudges it.
      // This is what lets the nose swing away from the direction of travel.
      targetVelocity.copy(player.driftVector).multiplyScalar(player.driftVector.length() > 0 ? maxSpeed * 0.85 : 0);
      scratchVec3A.copy(forward).multiplyScalar(forwardSpeed * 0.25);
      scratchVec3B.copy(right).multiplyScalar(strafeSpeed * 0.25);
      targetVelocity.add(scratchVec3A).add(scratchVec3B);
    } else {
      scratchVec3A.copy(forward).multiplyScalar(forwardSpeed);
      scratchVec3B.copy(right).multiplyScalar(strafeSpeed);
      targetVelocity.copy(scratchVec3A).add(scratchVec3B);
    }

    dampVec3(player.velocity, targetVelocity, PLAYER.velocitySmoothing, dt);

    // --- Integrate position ------------------------------------------------------------------------
    scratchVec3C.copy(player.velocity).multiplyScalar(dt);
    player.position.add(scratchVec3C);

    // --- Arena boundary -------------------------------------------------------------------------------
    const boundary = this.applyBoundary(player, arenaRadius, dt);

    // --- Report ----------------------------------------------------------------------------------------
    const speed = player.velocity.length();
    this.result.yawRate = player.angular.y;
    this.result.pitchRate = player.angular.x;
    this.result.speedFraction = clamp(speed / Math.max(1, def.maxSpeed * stats.speedMult), 0, 2);
    this.result.atBoundary = boundary;
    this.result.lockTracking = tracking;
    return this.result;
  }

  /**
   * Rotates the ship toward the locked target's intercept point.
   *
   * This is the single most important accessibility feature in the game. Without a mouse there
   * is no fast, high-resolution way to place the nose on a moving ship, so the lock does that
   * part: it converges the nose onto the lead point at a bounded rate, and the player spends
   * their attention on positioning, throttle, and when to shoot.
   *
   * Two rules keep it honest. It **yields entirely to manual steering** — the instant a
   * steering key goes down the assist stops contributing, so it can never fight the player for
   * the nose. And it is **rate-limited, not a snap**: `orientation.rotateTowards` advances at
   * most `maxStepAngle` toward the target look-rotation, capped below the ship's own turn rate,
   * so a target crossing fast still has to be flown to rather than being pinned for free.
   *
   * @returns 0..1 how hard the assist is currently working, for the HUD's lock readout.
   */
  private applyTrackingAssist(
    input: InputState,
    trackDir: THREE.Vector3 | null,
    strength: number,
    turnRate: number,
    dt: number,
  ): number {
    if (!trackDir || strength <= 0 || input.steering) return 0;

    // Look-rotation toward the target, using the ship's *own* up as the roll reference so the
    // assist only ever swings the nose -- it must never roll the ship back toward a world
    // horizon. Built straight off THREE.Matrix4.lookAt rather than composed by hand, so it is
    // guaranteed a proper (determinant +1) rotation.
    trackUp.set(0, 1, 0).applyQuaternion(this.orientation).normalize();
    if (Math.abs(trackUp.dot(trackDir)) > 0.999) trackUp.set(1, 0, 0).applyQuaternion(this.orientation).normalize();
    trackLookMatrix.lookAt(trackEye, trackDir, trackUp);
    targetQuat.setFromRotationMatrix(trackLookMatrix);

    const error = this.orientation.angleTo(targetQuat);
    if (error < 1e-4) return 0;

    // Proportional convergence with a ceiling. trackConvergence is a 1/seconds gain, so the
    // nose closes most of a small error inside a few frames while a large one is still capped.
    const maxRate = turnRate * strength * PLAYER.trackMaxRateFraction;
    const rate = Math.min(error * PLAYER.trackConvergence, maxRate);
    const maxStepAngle = rate * dt;

    this.orientation.rotateTowards(targetQuat, maxStepAngle);
    this.orientation.normalize();

    // Report saturation, not raw error: a bar that pegs at 1 whenever the target is far away
    // tells the player nothing. This reads "the assist is at its limit", which is the cue to
    // help it by turning.
    return clamp(rate / Math.max(1e-3, maxRate), 0, 1);
  }

  private updateDrift(player: PlayerState, input: InputState, dt: number): void {
    if (player.driftCooldown > 0) player.driftCooldown = Math.max(0, player.driftCooldown - dt);

    if (player.drifting) {
      player.driftTimer -= dt;
      // Releasing early ends the drift, so a skilled player can tap it for a quick snap-turn
      // and keep most of the cooldown budget.
      if (player.driftTimer <= 0 || !input.isDown('drift')) {
        player.drifting = false;
        const cooldown = player.def.driftCooldown * player.stats.driftCooldownMult;
        player.driftCooldown = cooldown;
      }
      return;
    }

    if (input.isDown('drift') && player.driftCooldown <= 0) {
      const speed = player.velocity.length();
      // Drifting from a standstill would do nothing but disable thrust, so require real motion.
      if (speed > 5) {
        player.drifting = true;
        player.driftTimer = PLAYER.driftDuration;
        player.driftVector.copy(player.velocity).normalize();
      }
    }
  }

  /**
   * Keeps the player inside the arena. A soft inward acceleration in the warning band, then a
   * hard positional clamp — never a teleport and never instant death, because "the boundary
   * killed me" is the least fair way to lose a run.
   *
   * @returns 0..1 proximity to the boundary, for the HUD warning and the boundary shader.
   */
  private applyBoundary(player: PlayerState, arenaRadius: number, dt: number): number {
    const dist = player.position.length();
    const warnRadius = arenaRadius * ARENA.warnFraction;
    if (dist <= warnRadius) return 0;

    const overshoot = (dist - warnRadius) / Math.max(1, arenaRadius - warnRadius);

    // Inward push ramps with depth into the band so the edge feels like thickening air.
    scratchVec3A.copy(player.position).multiplyScalar(-1 / Math.max(0.001, dist));
    player.velocity.addScaledVector(scratchVec3A, ARENA.pushAcceleration * overshoot * dt);

    if (dist > arenaRadius) {
      player.position.multiplyScalar(arenaRadius / dist);
      // Cancel only the outward component; tangential motion along the shell is preserved so
      // the player slides along the boundary rather than stopping dead against it.
      const outward = player.velocity.dot(scratchVec3A);
      if (outward < 0) player.velocity.addScaledVector(scratchVec3A, -outward);
    }

    return clamp(overshoot, 0, 1);
  }

  /** Resyncs the internal orientation from a quaternion set outside the model. */
  syncFrom(quaternion: THREE.Quaternion): void {
    this.orientation.copy(quaternion).normalize();
  }

  reset(): void {
    this.orientation.identity();
    this.result.yawRate = 0;
    this.result.pitchRate = 0;
    this.result.speedFraction = 0;
    this.result.atBoundary = 0;
    this.result.lockTracking = 0;
  }
}

/** Keeps the sign but squares the magnitude: fine control near centre, full authority at edge. */
function signedSquare(v: number): number {
  return v * Math.abs(v);
}

/**
 * Points a quaternion along `dir` with the given up hint, without allocating.
 *
 * Uses its own private scratch rather than the shared `scratchVec3*` pool, because callers
 * routinely hold shared scratch across this call.
 */
export function lookRotation(out: THREE.Quaternion, dir: THREE.Vector3, upHint: THREE.Vector3): void {
  lookForward.copy(dir).normalize();
  // Guard the degenerate case where dir is parallel to the up hint, which would collapse the
  // cross product to zero and produce a NaN quaternion.
  const parallel = Math.abs(lookForward.dot(upHint)) > 0.999;
  lookUpHint.copy(parallel ? FORWARD : upHint);
  // Handedness matters: with -Z forward, right is forward × up and up is right × forward. The
  // reverse order builds a determinant -1 basis — a reflection, not a rotation — and
  // `setFromRotationMatrix` turns that into a non-unit, invalid quaternion. Every enemy and
  // boss that aims through this helper inherits that, so the order here is load-bearing.
  lookRight.copy(lookForward).cross(lookUpHint).normalize();
  lookUp.copy(lookRight).cross(lookForward).normalize();

  // Three.js convention: local -Z is forward, so the third basis column is -forward.
  lookBack.copy(lookForward).multiplyScalar(-1);
  lookMatrix.makeBasis(lookRight, lookUp, lookBack);
  out.setFromRotationMatrix(lookMatrix);
}

const lookForward = /*#__PURE__*/ new THREE.Vector3();
const lookRight = /*#__PURE__*/ new THREE.Vector3();
const lookUp = /*#__PURE__*/ new THREE.Vector3();
const lookUpHint = /*#__PURE__*/ new THREE.Vector3();
const lookBack = /*#__PURE__*/ new THREE.Vector3();
const lookMatrix = /*#__PURE__*/ new THREE.Matrix4();
