/**
 * Lock-on, target cycling, lead indication, and aim assist.
 *
 * Two rules govern this file, both from DESIGN §13/§15:
 *
 * 1. **The lock is sticky.** Two enemies a few degrees apart must not cause the reticle to
 *    flicker between them; that is worse than no lock at all. A candidate has to beat the
 *    current target by a real margin before it steals the lock.
 *
 * 2. **Aim assist bends, never snaps, and never fires.** It nudges the shot direction by at
 *    most a couple of degrees toward a target already near the crosshair. Off means genuinely
 *    off — no hidden magnetism.
 */

import * as THREE from 'three';
import { AimAssist, type PlayerState, type Settings } from '../core/types';
import { FORWARD, leadTarget, scratchVec3A, scratchVec3B, scratchVec3C } from '../core/math';
import { LIMITS } from '../core/constants';
import type { EnemyQuery } from './projectiles';

/** Maximum lock range. Beyond this the HUD would be guessing anyway. */
const LOCK_RANGE = 700;
/** Half-angle of the cone the lock searches, in radians (~28°). */
const LOCK_CONE = 0.5;
/** A challenger must be this much better aligned before it steals an existing lock. */
const STICKINESS = 0.06;

const AIM_ASSIST_RADIANS: Record<number, number> = {
  [AimAssist.Off]: 0,
  [AimAssist.Light]: 0.0436, // 2.5°
  [AimAssist.Strong]: 0.1047, // 6°
};

const forward = /*#__PURE__*/ new THREE.Vector3();
const toTarget = /*#__PURE__*/ new THREE.Vector3();
const bestDir = /*#__PURE__*/ new THREE.Vector3();
const axis = /*#__PURE__*/ new THREE.Vector3();
const rotation = /*#__PURE__*/ new THREE.Quaternion();

export class TargetingSystem {
  private locked = -1;
  private lockTimer = 0;
  private readonly results = new Int32Array(LIMITS.maxQueryResults);

  get lockedId(): number {
    return this.locked;
  }

  clear(): void {
    this.locked = -1;
    this.lockTimer = 0;
  }

  update(
    player: PlayerState,
    enemies: EnemyQuery,
    enemyCount: number,
    _camera: THREE.Camera,
    _settings: Settings,
    dt: number,
  ): void {
    this.lockTimer += dt;

    forward.copy(FORWARD).applyQuaternion(player.quaternion).normalize();

    // Validate the existing lock first: it survives unless the target died or left the cone.
    let currentAlignment = -Infinity;
    if (this.locked >= 0) {
      const current = enemies.getById(this.locked);
      if (!current || !current.active) {
        this.locked = -1;
      } else {
        toTarget.copy(current.position).sub(player.position);
        const dist = toTarget.length();
        if (dist > LOCK_RANGE) {
          this.locked = -1;
        } else {
          toTarget.multiplyScalar(1 / dist);
          currentAlignment = toTarget.dot(forward);
          if (currentAlignment < Math.cos(LOCK_CONE * 1.4)) this.locked = -1;
        }
      }
    }

    // Look for a better candidate.
    const count = enemies.queryNear(player.position.x, player.position.y, player.position.z, LOCK_RANGE, this.results);
    const limit = Math.min(count, enemyCount > 0 ? count : 0);

    let bestId = -1;
    let bestAlignment = Math.cos(LOCK_CONE);

    for (let i = 0; i < limit; i++) {
      const enemy = enemies.getByIndex(this.results[i]!);
      if (!enemy || !enemy.active) continue;

      toTarget.copy(enemy.position).sub(player.position);
      const dist = toTarget.length();
      if (dist < 1e-3 || dist > LOCK_RANGE) continue;
      toTarget.multiplyScalar(1 / dist);

      const alignment = toTarget.dot(forward);
      if (alignment > bestAlignment) {
        bestAlignment = alignment;
        bestId = enemy.id;
      }
    }

    if (bestId < 0) return;
    if (this.locked < 0) {
      this.locked = bestId;
      return;
    }
    // Hysteresis: only switch for a meaningfully better angle.
    if (bestId !== this.locked && bestAlignment > currentAlignment + STICKINESS) {
      this.locked = bestId;
    }
  }

  /** Cycles to the next valid target, ordered by how central it is on screen. */
  cycle(player: PlayerState, enemies: EnemyQuery, _enemyCount: number, _camera: THREE.Camera): void {
    forward.copy(FORWARD).applyQuaternion(player.quaternion).normalize();

    const count = enemies.queryNear(player.position.x, player.position.y, player.position.z, LOCK_RANGE, this.results);

    // Find the best-aligned target strictly worse than the current one — that ordering makes
    // repeated presses walk outward from the crosshair instead of jumping randomly.
    let currentAlignment = 1.1;
    if (this.locked >= 0) {
      const current = enemies.getById(this.locked);
      if (current && current.active) {
        toTarget.copy(current.position).sub(player.position).normalize();
        currentAlignment = toTarget.dot(forward);
      }
    }

    let nextId = -1;
    let nextAlignment = -Infinity;
    let fallbackId = -1;
    let fallbackAlignment = -Infinity;

    for (let i = 0; i < count; i++) {
      const enemy = enemies.getByIndex(this.results[i]!);
      if (!enemy || !enemy.active) continue;

      toTarget.copy(enemy.position).sub(player.position);
      const dist = toTarget.length();
      if (dist < 1e-3) continue;
      toTarget.multiplyScalar(1 / dist);
      const alignment = toTarget.dot(forward);

      if (alignment > fallbackAlignment) {
        fallbackAlignment = alignment;
        fallbackId = enemy.id;
      }
      if (enemy.id !== this.locked && alignment < currentAlignment && alignment > nextAlignment) {
        nextAlignment = alignment;
        nextId = enemy.id;
      }
    }

    // Wrap around to the most central target once the list is exhausted.
    this.locked = nextId >= 0 ? nextId : fallbackId;
  }

  /**
   * Writes the point to aim at in order to hit the locked target with a projectile of the given
   * speed. This is what the HUD's lead pip renders — it teaches leading rather than doing it.
   */
  getLeadPoint(out: THREE.Vector3, projectileSpeed: number, enemies: EnemyQuery): boolean {
    if (this.locked < 0) return false;
    const target = enemies.getById(this.locked);
    if (!target || !target.active) return false;

    scratchVec3A.copy(target.position);
    scratchVec3B.copy(target.velocity);
    scratchVec3C.set(0, 0, 0);
    leadTarget(out, scratchVec3C, scratchVec3A, scratchVec3B, projectileSpeed);
    return true;
  }

  /**
   * Bends `aimDir` toward the nearest target inside the assist cone. Mutates in place.
   *
   * The bend is capped at the setting's maximum angle and scaled by how close the target
   * already is to the crosshair, so it feels like the shot is settling rather than being
   * dragged. It never exceeds the cap, so a target 20° off is never hit for free.
   */
  applyAimAssist(
    aimDir: THREE.Vector3,
    origin: THREE.Vector3,
    enemies: EnemyQuery,
    _enemyCount: number,
    settings: Settings,
  ): void {
    const maxBend = AIM_ASSIST_RADIANS[settings.aimAssist] ?? 0;
    if (maxBend <= 0) return;

    // Only consider targets already close to the crosshair — assist should reward near-misses,
    // not compensate for aiming somewhere else entirely.
    const cone = maxBend * 3;
    const cosCone = Math.cos(cone);

    const count = enemies.queryNear(origin.x, origin.y, origin.z, LOCK_RANGE, this.results);
    let bestAlignment = cosCone;
    let found = false;

    for (let i = 0; i < count; i++) {
      const enemy = enemies.getByIndex(this.results[i]!);
      if (!enemy || !enemy.active) continue;

      toTarget.copy(enemy.position).sub(origin);
      const dist = toTarget.length();
      if (dist < 1e-3) continue;
      toTarget.multiplyScalar(1 / dist);

      const alignment = toTarget.dot(aimDir);
      if (alignment > bestAlignment) {
        bestAlignment = alignment;
        bestDir.copy(toTarget);
        found = true;
      }
    }

    if (!found) return;

    const angle = Math.acos(Math.max(-1, Math.min(1, bestAlignment)));
    if (angle < 1e-5) return;
    const bend = Math.min(maxBend, angle);

    axis.copy(aimDir).cross(bestDir);
    if (axis.lengthSq() < 1e-8) return;
    axis.normalize();
    rotation.setFromAxisAngle(axis, bend);
    aimDir.applyQuaternion(rotation).normalize();
  }
}
