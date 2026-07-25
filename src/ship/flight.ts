/**
 * The flight model — "assisted arena flight".
 *
 * This is the single most important system for game feel, and the one where the genre most
 * often loses players. The research (DESIGN.md §2) is blunt about it: full 6DOF causes
 * disorientation and motion sickness, and auto-levelling is the standard mitigation.
 *
 * So orientation is not a free-floating quaternion that integrates whatever rotation arrives.
 * It is three scalars — heading, pitch, bank — rebuilt into a quaternion every step:
 *
 *   quaternion = Ry(yaw) · Rx(pitch) · Rz(roll)
 *
 * That single choice is what makes the ship *unflippable*. Pitch is hard-clamped short of
 * vertical, so the nose can never carry over the top and come out inverted, and bank always
 * has a true "level" to return to because it is measured, not accumulated. An integrating
 * model has neither guarantee: small errors compound, and one long pull on the nose leaves the
 * player upside down with no idea which way is up. Barrel rolls still work — roll is a full
 * ±180° of manual authority on top of the level frame — they just always unwind.
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
const orientationEuler = /*#__PURE__*/ new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * Hard ceiling on pitch, in radians (~78°). Short of vertical on purpose: the last few degrees
 * are where a nose-up pull would tip over the top and invert, and they buy nothing — the ship
 * can already climb faster than anything in the arena can follow.
 */
const MAX_PITCH = 1.36;
/**
 * How much of the on-screen turn rate is preserved when pitched steeply. Yaw is a rotation
 * about world up, so at high pitch a given yaw rate barely moves the nose across the screen;
 * dividing by cos(pitch) compensates. Floored so the compensation stays bounded near vertical.
 */
const MIN_YAW_COMPENSATION = 0.5;

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

  /** Heading about world up. Wraps freely — there is no "wrong way round" for yaw. */
  private yaw = 0;
  /** Nose elevation, always within ±MAX_PITCH. This clamp is what forbids inversion. */
  private pitch = 0;
  /** Bank relative to level. Manual roll drives it; auto-level returns it to the turn's bank. */
  private roll = 0;

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

    // --- Boost --------------------------------------------------------------------------------
    // Boost is gated on a rearm threshold so an empty meter cannot be feathered for a permanent
    // speed bonus; the player has to let it recover meaningfully first.
    const wantsBoost = input.isDown('boost');
    if (wantsBoost && player.boost > 0 && (player.boosting || player.boost > PLAYER.boostRearmThreshold)) {
      player.boosting = true;
      player.boost = Math.max(0, player.boost - PLAYER.boostDrain * dt);
      if (player.boost <= 0) player.boosting = false;
    } else {
      player.boosting = false;
      player.boost = Math.min(
        PLAYER.boostMax,
        player.boost + PLAYER.boostRegen * stats.boostMult * dt,
      );
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

    // Yaw is a world-up rotation, so it has to be scaled up when pitched steeply or the nose
    // would crawl across the screen exactly when the player is pulling hardest.
    const yawCompensation = 1 / Math.max(MIN_YAW_COMPENSATION, Math.cos(this.pitch));
    this.yaw = wrapAngle(this.yaw + player.angular.y * yawCompensation * dt);
    this.pitch = clamp(this.pitch + player.angular.x * dt, -MAX_PITCH, MAX_PITCH);

    // Pitch is clamped, not wrapped, so the integrated rate has to be zeroed at the stop —
    // otherwise the accumulated rate would fight the clamp and the nose would feel sticky when
    // the player finally pulls the other way.
    if (Math.abs(this.pitch) >= MAX_PITCH - 1e-6 && Math.sign(player.angular.x) === Math.sign(this.pitch)) {
      player.angular.x = 0;
    }

    // --- Lock tracking assist -------------------------------------------------------------------
    const tracking = this.applyTrackingAssist(input, trackDir, trackStrength, turnRate, dt);

    // --- Roll: manual, or auto-level with a bank into the turn ---------------------------------
    const rollInput = input.roll;
    const bankTarget = clamp(-player.angular.y / Math.max(0.001, def.turnRate), -1, 1) * PLAYER.maxBankAngle;

    if (Math.abs(rollInput) > 0.01) {
      // Manual roll overrides levelling entirely, so barrel rolls are possible on demand.
      player.angular.z = rollInput * PLAYER.rollRate;
      this.roll = wrapAngle(this.roll + player.angular.z * dt);
    } else {
      const error = wrapAngle(bankTarget - this.roll);
      // Divide by the auto-level time so the correction is a rate, not a spring constant, and
      // clamp it to the manual roll rate so levelling never out-spins the player.
      player.angular.z = clamp(error / PLAYER.autoLevelTime, -PLAYER.rollRate, PLAYER.rollRate);
      this.roll = wrapAngle(this.roll + player.angular.z * dt);
    }

    // Rebuild the orientation from the three scalars rather than composing onto the previous
    // quaternion. Nothing accumulates, so nothing can drift out of the level frame.
    orientationEuler.set(this.pitch, this.yaw, this.roll, 'YXZ');
    player.quaternion.setFromEuler(orientationEuler);

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
   * Rotates heading and pitch toward the locked target's intercept point.
   *
   * This is the single most important accessibility feature in the game. Without a mouse there
   * is no fast, high-resolution way to place the nose on a moving ship, so the lock does that
   * part: it converges the nose onto the lead point at a bounded rate, and the player spends
   * their attention on positioning, throttle, and when to shoot.
   *
   * Two rules keep it honest. It **yields entirely to manual steering** — the instant a
   * steering key goes down the assist stops contributing, so it can never fight the player for
   * the nose. And it is **rate-limited, not a snap**: it converges proportionally to how far
   * off it is, capped below the ship's own turn rate, so a target crossing fast still has to be
   * flown to rather than being pinned for free.
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

    const targetPitch = clamp(Math.asin(clamp(trackDir.y, -1, 1)), -MAX_PITCH, MAX_PITCH);
    const targetYaw = Math.atan2(-trackDir.x, -trackDir.z);

    const yawError = wrapAngle(targetYaw - this.yaw);
    const pitchError = targetPitch - this.pitch;
    const error = Math.hypot(yawError, pitchError);
    if (error < 1e-4) return 0;

    // Proportional convergence with a ceiling. TRACK_CONVERGENCE is a 1/seconds gain, so the
    // nose closes most of a small error inside a few frames while a large one is still capped.
    const maxRate = turnRate * strength * PLAYER.trackMaxRateFraction;
    const rate = Math.min(error * PLAYER.trackConvergence, maxRate);
    const stepAngle = Math.min(rate * dt, error);
    const scale = stepAngle / error;

    this.yaw = wrapAngle(this.yaw + yawError * scale);
    this.pitch = clamp(this.pitch + pitchError * scale, -MAX_PITCH, MAX_PITCH);

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

  /** Re-derives the yaw/pitch/roll scalars from a quaternion set outside the model. */
  syncFrom(quaternion: THREE.Quaternion): void {
    orientationEuler.setFromQuaternion(quaternion, 'YXZ');
    this.pitch = clamp(orientationEuler.x, -MAX_PITCH, MAX_PITCH);
    this.yaw = orientationEuler.y;
    this.roll = orientationEuler.z;
  }

  reset(): void {
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
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

/** Normalises an angle to (-π, π]. Keeps heading and bank errors taking the short way round. */
function wrapAngle(a: number): number {
  const wrapped = (a + Math.PI) % (Math.PI * 2);
  return (wrapped < 0 ? wrapped + Math.PI * 2 : wrapped) - Math.PI;
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
  lookRight.copy(lookUpHint).cross(lookForward).normalize();
  lookUp.copy(lookForward).cross(lookRight).normalize();

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
