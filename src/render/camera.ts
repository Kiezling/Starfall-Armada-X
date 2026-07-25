/**
 * The chase camera. DESIGN.md §12 treats this as gameplay, not decoration: position and
 * rotation lag the ship with a critically-damped spring, trauma-based shake sells impact,
 * and FOV communicates speed. None of that may allocate per frame.
 *
 * Time-scale convention used throughout `update()`: the spring that follows the ship uses
 * `dt` (scaled by hit-stop/slow-mo), so the camera settles in lock-step with a frozen or
 * slowed world instead of fighting it. Trauma decay, the shake noise clock, impulse decay,
 * the FOV punch ease-out, and the death-orbit angle all use `rawDt`, so a hit still reads
 * as a hit even during the hit-stop frames it is trying to sell.
 */

import * as THREE from 'three';
import type { PlayerState, Settings } from '../core/types';
import { CAMERA } from '../core/constants';
import { clamp, clamp01, damp, lerp, remap, springDamp, scratchQuatA, scratchMat4A, WORLD_UP, FORWARD, EPSILON } from '../core/math';

/** Fraction of a second after which the FOV punch has settled back to the speed-driven value. */
const FOV_PUNCH_SMOOTHING = 0.0003;
/** Fraction of a second after which the speed-driven FOV blend has caught up. */
const FOV_SPEED_SMOOTHING = 0.01;
/** Spring smooth time for directional impulses returning to zero. Looser than the position
 * spring so a hit reads as a shove rather than another tick of the same follow-cam motion. */
const IMPULSE_SMOOTH_TIME = 0.35;
/** Never let shake/impulse push the camera closer to the ship than this. */
const MIN_SHIP_DISTANCE = CAMERA.offsetBack * 0.35;
/** Keep the camera this fraction inside the arena radius, clear of the boundary shell. */
const CAMERA_ARENA_MARGIN = 0.94;
/**
 * Camera roll reference: below this |forward·worldUp| the camera stays fully world-locked, so
 * the horizon reads level and barrel rolls (which spin the hull's own up axis a full turn, see
 * `FlightModel` §Roll) never flip the screen -- DESIGN.md §2's "no inverted-world states".
 * Above `VERTICAL_BLEND_END` the reference is the camera's own previous-frame up instead of
 * world-up, because `lookAt`'s basis construction is a cross product against the reference: as
 * the view direction approaches parallel to worldUp that product collapses toward zero and the
 * normalised result becomes wildly sensitive to noise, which is what made the camera whip around
 * near vertical dives and climbs. Coasting on the camera's own already-stable up avoids ever
 * computing that cross product near-degenerate, and blending across a band (rather than
 * switching at one threshold) keeps the handoff continuous instead of snapping.
 */
const VERTICAL_BLEND_START = 0.9;
const VERTICAL_BLEND_END = 0.98;

// Module-level scratch -- borrowed within a single synchronous update() call, never retained.
const CAM_IDEAL_POS = /*#__PURE__*/ new THREE.Vector3();
const CAM_LOOK_TARGET = /*#__PURE__*/ new THREE.Vector3();
const CAM_OFFSET = /*#__PURE__*/ new THREE.Vector3();
const CAM_FORWARD = /*#__PURE__*/ new THREE.Vector3();
const CAM_RIGHT = /*#__PURE__*/ new THREE.Vector3();
const CAM_UP = /*#__PURE__*/ new THREE.Vector3();
const CAM_TO_SHIP = /*#__PURE__*/ new THREE.Vector3();
/** Roll reference passed to `lookAt`; see `VERTICAL_BLEND_START` for what it holds and why. */
const CAM_REF_UP = /*#__PURE__*/ new THREE.Vector3();
const CAM_PREV_UP = /*#__PURE__*/ new THREE.Vector3();
const AXIS_X = /*#__PURE__*/ new THREE.Vector3(1, 0, 0);
const AXIS_Y = /*#__PURE__*/ new THREE.Vector3(0, 1, 0);
const AXIS_Z = /*#__PURE__*/ new THREE.Vector3(0, 0, 1);

export class ChaseCamera {
  private readonly camera: THREE.PerspectiveCamera;

  // Position spring: one critically-damped scalar spring per axis.
  private readonly posVelX = { value: 0 };
  private readonly posVelY = { value: 0 };
  private readonly posVelZ = { value: 0 };

  // FOV: a speed-driven base value plus an additive, self-decaying punch.
  private fov: number = CAMERA.fovBase;
  private fovPunchValue = 0;

  // Trauma-based shake. Magnitude is trauma², per the design doc; the noise itself is a
  // sum of sines at incommensurate frequencies (never Math.random -- random per-frame
  // jitter reads as a bug, not an impact).
  private trauma = 0;
  private shakeClock = 0;

  // Directional impulses: a spring per axis targeting zero, kicked by addImpulse().
  private impulseX = 0;
  private impulseY = 0;
  private impulseZ = 0;
  private readonly impulseVelX = { value: 0 };
  private readonly impulseVelY = { value: 0 };
  private readonly impulseVelZ = { value: 0 };

  private deathCam = false;
  private readonly deathCamTarget = new THREE.Vector3();
  private deathOrbitAngle = 0;

  /** Arena radius, so the camera can be kept inside the boundary shell. */
  private arenaRadius = Infinity;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
  }

  /** Kept in sync by the game whenever the arena resizes (sector change, contraction). */
  setArenaRadius(radius: number): void {
    this.arenaRadius = radius;
  }

  update(player: PlayerState, dt: number, rawDt: number, settings: Settings): void {
    // Wrapped so the noise sines never run sin() on an ever-growing argument.
    this.shakeClock = (this.shakeClock + rawDt) % 3600;

    this.trauma = Math.max(0, this.trauma - CAMERA.traumaDecay * rawDt);
    this.fovPunchValue = damp(this.fovPunchValue, 0, FOV_PUNCH_SMOOTHING, rawDt);

    if (this.deathCam) {
      this.deathOrbitAngle += CAMERA.deathOrbitSpeed * rawDt;
      const r = CAMERA.deathOrbitRadius;
      CAM_IDEAL_POS.set(
        this.deathCamTarget.x + Math.cos(this.deathOrbitAngle) * r,
        this.deathCamTarget.y + CAMERA.offsetUp * 0.4,
        this.deathCamTarget.z + Math.sin(this.deathOrbitAngle) * r,
      );
      CAM_LOOK_TARGET.copy(this.deathCamTarget);
    } else {
      // Ideal pose: behind and above the ship in its own local frame, looking a fixed
      // distance ahead of the nose.
      CAM_OFFSET.set(0, CAMERA.offsetUp, CAMERA.offsetBack).applyQuaternion(player.quaternion);
      CAM_IDEAL_POS.copy(player.position).add(CAM_OFFSET);

      CAM_FORWARD.copy(FORWARD).applyQuaternion(player.quaternion);
      CAM_LOOK_TARGET.copy(player.position).addScaledVector(CAM_FORWARD, CAMERA.lookAhead);
    }

    // Critically-damped spring follow. Using `dt` here means the camera settles in
    // lock-step with a hit-stopped or slow-mo'd world rather than overshooting a target
    // that (from the camera's perspective) has effectively stopped moving.
    this.camera.position.x = springDamp(this.camera.position.x, CAM_IDEAL_POS.x, this.posVelX, CAMERA.positionSmoothTime, dt);
    this.camera.position.y = springDamp(this.camera.position.y, CAM_IDEAL_POS.y, this.posVelY, CAMERA.positionSmoothTime, dt);
    this.camera.position.z = springDamp(this.camera.position.z, CAM_IDEAL_POS.z, this.posVelZ, CAMERA.positionSmoothTime, dt);

    // Rotation: frame-rate independent exponential slerp toward the look-at orientation.
    // Roll reference: world-up normally, blending toward the camera's own previous up near the
    // vertical pole so `lookAt` never has to cross-product against a near-parallel reference.
    // See `VERTICAL_BLEND_START` -- this deliberately never reads the ship's own up axis, which
    // carries the ship's full manual roll and would flip the screen mid-barrel-roll.
    if (this.deathCam) {
      CAM_REF_UP.copy(WORLD_UP);
    } else {
      const vertical = Math.abs(CAM_FORWARD.dot(WORLD_UP));
      if (vertical <= VERTICAL_BLEND_START) {
        CAM_REF_UP.copy(WORLD_UP);
      } else {
        CAM_PREV_UP.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
        const blend = clamp01(remap(vertical, VERTICAL_BLEND_START, VERTICAL_BLEND_END, 0, 1));
        CAM_REF_UP.lerpVectors(WORLD_UP, CAM_PREV_UP, blend);
      }
    }
    scratchMat4A.lookAt(this.camera.position, CAM_LOOK_TARGET, CAM_REF_UP);
    scratchQuatA.setFromRotationMatrix(scratchMat4A);
    const rotT = clamp01(1 - Math.exp(-dt / CAMERA.rotationSmoothTime));
    this.camera.quaternion.slerp(scratchQuatA, rotT);

    // Trauma shake: magnitude is trauma², scaled by the accessibility slider so it can
    // genuinely go to zero. Skipped entirely when there is nothing to shake, both for
    // cost and so a settings change to 0 is instantly and visibly silent.
    const shakeMag = this.trauma * this.trauma;
    if (shakeMag > EPSILON && settings.screenShake > 0) {
      const f = CAMERA.shakeFrequency;
      const t = this.shakeClock;
      const shakeScale = shakeMag * settings.screenShake;

      const noiseX = Math.sin(t * f * 1.0 + 0.0) * 0.6 + Math.sin(t * f * 2.13 + 11.1) * 0.4;
      const noiseY = Math.sin(t * f * 1.07 + 4.7) * 0.6 + Math.sin(t * f * 2.31 + 8.3) * 0.4;
      const pitchN = Math.sin(t * f * 0.93 + 2.2) * 0.6 + Math.sin(t * f * 1.87 + 15.6) * 0.4;
      const yawN = Math.sin(t * f * 1.19 + 6.6) * 0.6 + Math.sin(t * f * 2.05 + 3.3) * 0.4;
      const rollN = Math.sin(t * f * 1.31 + 9.9) * 0.6 + Math.sin(t * f * 1.73 + 1.1) * 0.4;

      CAM_RIGHT.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
      CAM_UP.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
      const posShake = CAMERA.shakeTranslation * shakeScale;
      this.camera.position.addScaledVector(CAM_RIGHT, noiseX * posShake);
      this.camera.position.addScaledVector(CAM_UP, noiseY * posShake);

      const rotShake = CAMERA.shakeRotation * shakeScale;
      scratchQuatA.setFromAxisAngle(AXIS_X, pitchN * rotShake);
      this.camera.quaternion.multiply(scratchQuatA);
      scratchQuatA.setFromAxisAngle(AXIS_Y, yawN * rotShake);
      this.camera.quaternion.multiply(scratchQuatA);
      scratchQuatA.setFromAxisAngle(AXIS_Z, rollN * rotShake);
      this.camera.quaternion.multiply(scratchQuatA);
    }

    // Directional impulses: spring back to zero, driven by rawDt so a hit still shoves
    // the camera through a hit-stop pause instead of freezing mid-shove.
    this.impulseX = springDamp(this.impulseX, 0, this.impulseVelX, IMPULSE_SMOOTH_TIME, rawDt);
    this.impulseY = springDamp(this.impulseY, 0, this.impulseVelY, IMPULSE_SMOOTH_TIME, rawDt);
    this.impulseZ = springDamp(this.impulseZ, 0, this.impulseVelZ, IMPULSE_SMOOTH_TIME, rawDt);
    this.camera.position.x += this.impulseX;
    this.camera.position.y += this.impulseY;
    this.camera.position.z += this.impulseZ;

    // The camera must never end up inside the ship. Death cam's orbit radius is already
    // far larger than this clamp so it is only meaningful during normal flight.
    if (!this.deathCam) {
      CAM_TO_SHIP.copy(this.camera.position).sub(player.position);
      const dist = CAM_TO_SHIP.length();
      if (dist < MIN_SHIP_DISTANCE) {
        if (dist < EPSILON) CAM_TO_SHIP.copy(CAM_OFFSET).normalize();
        else CAM_TO_SHIP.multiplyScalar(1 / dist);
        this.camera.position.copy(player.position).addScaledVector(CAM_TO_SHIP, MIN_SHIP_DISTANCE);
      }
    }

    // Keep the camera inside the boundary shell. The chase spring trails the ship, so a player
    // pinned against the arena wall would otherwise drag the camera onto (and through) the
    // shell — at which point the near plane slices its triangles and they read as huge flat
    // sheets across the screen. DESIGN §12: the chase camera never clips through geometry.
    if (Number.isFinite(this.arenaRadius)) {
      const limit = this.arenaRadius * CAMERA_ARENA_MARGIN;
      const distSq = this.camera.position.lengthSq();
      if (distSq > limit * limit) {
        this.camera.position.multiplyScalar(limit / Math.sqrt(distSq));
      }
    }

    // FOV: widen with speed so velocity reads at a glance, plus a punch that eases out.
    const speedFrac = clamp01(player.velocity.length() / Math.max(player.def.maxSpeed, EPSILON));
    const targetFov = lerp(CAMERA.fovBase, CAMERA.fovBoost, speedFrac);
    this.fov = damp(this.fov, targetFov, FOV_SPEED_SMOOTHING, dt);
    this.camera.fov = clamp(this.fov + this.fovPunchValue, CAMERA.fovBase * 0.5, CAMERA.fovBoost + CAMERA.fovPunch * 2);
    this.camera.updateProjectionMatrix();
  }

  /** Trauma accumulates, is capped, and decays; shake magnitude is trauma². */
  addTrauma(amount: number): void {
    this.trauma = clamp(this.trauma + amount, 0, CAMERA.maxTrauma);
  }

  addImpulse(x: number, y: number, z: number, strength: number): void {
    this.impulseVelX.value += x * strength;
    this.impulseVelY.value += y * strength;
    this.impulseVelZ.value += z * strength;
  }

  addFovPunch(degrees: number): void {
    this.fovPunchValue += degrees;
  }

  beginDeathCam(x: number, y: number, z: number): void {
    this.deathCam = true;
    this.deathCamTarget.set(x, y, z);
    this.deathOrbitAngle = 0;
  }

  endDeathCam(): void {
    this.deathCam = false;
  }

  get inDeathCam(): boolean {
    return this.deathCam;
  }

  /** Snaps instantly to the ideal pose -- no spring lag on frame one. */
  snapTo(player: PlayerState): void {
    CAM_OFFSET.set(0, CAMERA.offsetUp, CAMERA.offsetBack).applyQuaternion(player.quaternion);
    this.camera.position.copy(player.position).add(CAM_OFFSET);

    CAM_FORWARD.copy(FORWARD).applyQuaternion(player.quaternion);
    CAM_LOOK_TARGET.copy(player.position).addScaledVector(CAM_FORWARD, CAMERA.lookAhead);
    // World-locked, matching `update()`'s default. There is no previous frame to blend from on
    // a snap, and the ship always spawns level, so the near-vertical case cannot arise here.
    scratchMat4A.lookAt(this.camera.position, CAM_LOOK_TARGET, WORLD_UP);
    this.camera.quaternion.setFromRotationMatrix(scratchMat4A);

    this.posVelX.value = 0;
    this.posVelY.value = 0;
    this.posVelZ.value = 0;

    this.fov = CAMERA.fovBase;
    this.fovPunchValue = 0;
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
  }

  /** Restores the camera to a clean pre-run state. Does not move it -- call `snapTo` once
   * the new run's player state exists. */
  reset(): void {
    this.trauma = 0;
    this.shakeClock = 0;
    this.fovPunchValue = 0;

    this.impulseX = 0;
    this.impulseY = 0;
    this.impulseZ = 0;
    this.impulseVelX.value = 0;
    this.impulseVelY.value = 0;
    this.impulseVelZ.value = 0;

    this.posVelX.value = 0;
    this.posVelY.value = 0;
    this.posVelZ.value = 0;

    this.deathCam = false;
    this.deathOrbitAngle = 0;
  }
}
