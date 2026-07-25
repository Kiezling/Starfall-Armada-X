/**
 * The flight model — "assisted arena flight".
 *
 * This is the single most important system for game feel, and the one where the genre most
 * often loses players. The research (DESIGN.md §2) is blunt about it: full 6DOF causes
 * disorientation and motion sickness, and auto-levelling is the standard mitigation. So this
 * model gives full pitch and yaw, strafing, and free roll *while the player asks for it* — but
 * always returns the horizon to level when they let go. The player can never end up inverted
 * and lost.
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
  WORLD_UP,
  clamp,
  dampVec3,
  moveTowards,
  scratchVec3A,
  scratchVec3B,
  scratchVec3C,
  scratchVec3D,
} from '../core/math';

/* Module-level scratch. Reused every step so the flight model allocates nothing. */
const forward = /*#__PURE__*/ new THREE.Vector3();
const right = /*#__PURE__*/ new THREE.Vector3();
const up = /*#__PURE__*/ new THREE.Vector3();
const levelUp = /*#__PURE__*/ new THREE.Vector3();
const targetVelocity = /*#__PURE__*/ new THREE.Vector3();
const stepRotation = /*#__PURE__*/ new THREE.Quaternion();
const stepEuler = /*#__PURE__*/ new THREE.Euler();

export interface FlightResult {
  /** Signed yaw rate this step, for the visual banking of wings and the camera lean. */
  yawRate: number;
  pitchRate: number;
  /** 0..1 normalised speed, for FOV, trails, and the momentum damage bonus. */
  speedFraction: number;
  /** True while the boundary is pushing the player back inward. */
  atBoundary: number;
}

export class FlightModel {
  private readonly result: FlightResult = {
    yawRate: 0,
    pitchRate: 0,
    speedFraction: 0,
    atBoundary: 0,
  };

  /** Roll angle relative to level, carried between steps so banking is continuous. */
  private rollAngle = 0;

  /**
   * Advances one fixed simulation step.
   *
   * @param speedBuffMult Transient speed multiplier from augment procs (Slipstream, Evasive
   *        Protocols). Kept out of PlayerState so buff bookkeeping stays in one place.
   */
  update(
    player: PlayerState,
    input: InputState,
    dt: number,
    arenaRadius: number,
    speedBuffMult: number,
  ): FlightResult {
    const stats = player.stats;
    const def = player.def;

    // --- Basis vectors -----------------------------------------------------------------------
    forward.copy(FORWARD).applyQuaternion(player.quaternion).normalize();
    right.set(1, 0, 0).applyQuaternion(player.quaternion).normalize();
    up.set(0, 1, 0).applyQuaternion(player.quaternion).normalize();

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

    // The reticle position maps to a *rate*, not an angle. Squaring the magnitude while keeping
    // the sign gives fine control near centre and full authority at the edge.
    const aimX = input.aimX;
    const aimY = input.aimY;
    const desiredYaw = -signedSquare(aimX) * turnRate;
    const desiredPitch = signedSquare(aimY) * turnRate;

    const accel = PLAYER.angularAcceleration * dt;
    player.angular.x = moveTowards(player.angular.x, desiredPitch, accel);
    player.angular.y = moveTowards(player.angular.y, desiredYaw, accel);

    // --- Roll: manual, or auto-level with a bank into the turn ---------------------------------
    const rollInput = input.roll;
    const bankTarget = clamp(-player.angular.y / Math.max(0.001, def.turnRate), -1, 1) * PLAYER.maxBankAngle;

    if (Math.abs(rollInput) > 0.01) {
      // Manual roll overrides levelling entirely, so barrel rolls are possible on demand.
      player.angular.z = rollInput * PLAYER.rollRate;
      this.rollAngle += player.angular.z * dt;
    } else {
      this.rollAngle = this.measureRoll(player);
      const error = bankTarget - this.rollAngle;
      // Divide by the auto-level time so the correction is a rate, not a spring constant, and
      // clamp it to the manual roll rate so levelling never out-spins the player.
      player.angular.z = clamp(error / PLAYER.autoLevelTime, -PLAYER.rollRate, PLAYER.rollRate);
    }

    // Integrate the orientation. Local-space rotation composed onto the current quaternion.
    stepEuler.set(player.angular.x * dt, player.angular.y * dt, player.angular.z * dt, 'XYZ');
    stepRotation.setFromEuler(stepEuler);
    player.quaternion.multiply(stepRotation).normalize();

    // Recompute the basis after rotating so thrust applies along the new heading.
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
    return this.result;
  }

  /**
   * Signed roll relative to "level", measured about the ship's forward axis.
   *
   * Level is world-up projected perpendicular to forward. When the nose points nearly straight
   * up or down that projection degenerates, so we fall back to the ship's own right vector —
   * which keeps the value continuous instead of snapping through a singularity.
   */
  private measureRoll(player: PlayerState): number {
    forward.copy(FORWARD).applyQuaternion(player.quaternion).normalize();
    up.set(0, 1, 0).applyQuaternion(player.quaternion).normalize();

    const alignment = Math.abs(forward.dot(WORLD_UP));
    if (alignment > 0.995) return this.rollAngle;

    levelUp.copy(WORLD_UP).addScaledVector(forward, -WORLD_UP.dot(forward)).normalize();

    const dot = clamp(levelUp.dot(up), -1, 1);
    const angle = Math.acos(dot);
    scratchVec3D.copy(levelUp).cross(up);
    const sign = scratchVec3D.dot(forward) >= 0 ? 1 : -1;
    return angle * sign;
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

  reset(): void {
    this.rollAngle = 0;
    this.result.yawRate = 0;
    this.result.pitchRate = 0;
    this.result.speedFraction = 0;
    this.result.atBoundary = 0;
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
