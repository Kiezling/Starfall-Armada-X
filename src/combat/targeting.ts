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
 *
 * 3. **Gimbal assist is a hard mount within its traverse range.** Real fighters use gimballed
 *    mounts with a traverse envelope. When a locked target's intercept point falls inside the
 *    gimbal's angular range, the guns physically traverse to lock on, firing at the intercept
 *    point directly. This teaches leading while keeping close shots reliable.
 *
 * 4. **Acquisition takes a beat.** A lock only completes after the reticle has held on a
 *    candidate for ACQUIRE_TIME seconds — see that constant below. This is what makes rule 1
 *    ("sticky") actually readable: a lock you can see forming is one whose stickiness makes
 *    sense, instead of the reticle appearing to have simply grabbed the first thing it saw.
 */

import * as THREE from 'three';
import { AimAssist, type PlayerState, type Settings } from '../core/types';
import { FORWARD, leadTarget, scratchVec3A, scratchVec3B, scratchVec3D, scratchVec3E } from '../core/math';
import { LIMITS, WEAPONS } from '../core/constants';
import type { EnemyQuery } from './projectiles';

/** Maximum lock range. Beyond this the HUD would be guessing anyway. */
const LOCK_RANGE = 700;
/**
 * Half-angle of the cone the *automatic* scan searches, in radians (~37°). This used to be
 * 0.5 rad (~28.6°) — barely narrower than half of the base camera FOV (fovBase 62° → 31°
 * half-angle, see constants.ts CAMERA). That meant a target sitting plainly on screen, near
 * the edge, could already be outside the cone the auto-scan considered — exactly the "enemies
 * zipping by that never became lockable" symptom, since a fast crosser spends most of its
 * screen time near the edges, not centred. Widened to sit past half of even the *boosted* FOV
 * (fovBoost 78° → 39° half-angle) so anything visibly on screen is scannable. Manual TAB
 * cycling (`cycle()`, below) was never limited by this cone and could already reach any live
 * target within LOCK_RANGE regardless of angle.
 */
const LOCK_CONE = 0.65;
/** A challenger must be this much better aligned before it steals an existing lock. */
const STICKINESS = 0.06;
/**
 * Seconds the reticle must hold on a candidate before an unlocked scan turns into an actual
 * lock (DESIGN §13/§15's "the lock is sticky" now also means "the lock isn't instant"). Sized
 * for a deliberate, readable acquisition — long enough to see the reticle "settle" onto a
 * target, short enough that it never feels like a dead input in a dogfight.
 */
const ACQUIRE_TIME = 0.45;
/**
 * Seconds for acquisition progress to fully decay once the reticle drifts off the current
 * candidate. Decaying (not resetting instantly) means a brief wobble off-target doesn't cost
 * the whole window, while sustained inattention still loses it — "partial progress that
 * decays if they look away," per the design ask.
 */
const ACQUIRE_DECAY_TIME = 0.3;

/**
 * Assist cone half-angles. Sized for a keyboard: steering resolution is coarser than a mouse's,
 * so a near-miss that would be a hit with a pointer has to be forgiven, or the game reads as
 * unresponsive rather than difficult. Off is still genuinely off.
 */
const AIM_ASSIST_RADIANS: Record<number, number> = {
  [AimAssist.Off]: 0,
  [AimAssist.Light]: 0.0698, // 4°
  [AimAssist.Strong]: 0.1571, // 9°
};

const forward = /*#__PURE__*/ new THREE.Vector3();
const toTarget = /*#__PURE__*/ new THREE.Vector3();
const bestDir = /*#__PURE__*/ new THREE.Vector3();
const axis = /*#__PURE__*/ new THREE.Vector3();
const rotation = /*#__PURE__*/ new THREE.Quaternion();
const gimbalAxis = /*#__PURE__*/ new THREE.Vector3();
const gimbalQuat = /*#__PURE__*/ new THREE.Quaternion();

export class TargetingSystem {
  private locked = -1;
  private lockTimer = 0;
  private readonly results = new Int32Array(LIMITS.maxQueryResults);
  /** Cached player position from last update(), for lead point calculations. */
  private readonly cachedPlayerPos = /*#__PURE__*/ new THREE.Vector3();
  /** Cached player velocity from last update(), for lead point calculations. */
  private readonly cachedPlayerVel = /*#__PURE__*/ new THREE.Vector3();

  /** Enemy id the dwell timer is currently accumulating on, or -1 while nothing qualifies. */
  private acquireCandidate = -1;
  /** 0..1 dwell progress toward completing a lock on `acquireCandidate`. */
  private acquireProgress = 0;

  get lockedId(): number {
    return this.locked;
  }

  /**
   * 0..1 progress of the current lock-acquisition dwell, for the HUD's future filling-ring
   * indicator (see DESIGN §13/§15). Reads 0 once a lock exists — dwelling only happens on the
   * way to a lock, not after one — and 0 whenever nothing is currently being acquired.
   */
  get acquisitionProgress(): number {
    return this.locked >= 0 ? 0 : this.acquireProgress;
  }

  clear(): void {
    this.locked = -1;
    this.lockTimer = 0;
    this.acquireCandidate = -1;
    this.acquireProgress = 0;
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

    // Cache player position and velocity for lead calculations.
    this.cachedPlayerPos.copy(player.position);
    this.cachedPlayerVel.copy(player.velocity);

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

    // Look for a better candidate. `enemyCount` no longer gates this — the grid query result
    // count is already an exact answer for "how many candidates does this call have," and
    // enemyCount (liveCount) is a frame-stale duplicate of the same fact (see EnemyManager.
    // liveCount's own doc comment on that staleness). Gating on it here bought nothing but a
    // second number that could disagree with the first.
    const count = enemies.queryNear(player.position.x, player.position.y, player.position.z, LOCK_RANGE, this.results);
    void enemyCount;

    let bestId = -1;
    let bestAlignment = Math.cos(LOCK_CONE);

    for (let i = 0; i < count; i++) {
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

    if (this.locked < 0) {
      // No confirmed lock yet: the best in-cone candidate has to be held for ACQUIRE_TIME
      // seconds before it actually locks, rather than locking the instant it is merely the
      // best thing in the cone. See ACQUIRE_TIME's doc comment for why.
      if (bestId !== this.acquireCandidate) {
        // Either nothing qualifies this frame, or a different candidate is best now — decay
        // rather than snap to 0, so a one-frame flicker between two close candidates (or a
        // brief glance away) does not forfeit the whole window. Once decay bottoms out, adopt
        // whatever is best now so accumulation can begin on it this same frame, rather than
        // losing a frame to "notice, then start counting" on the next call.
        this.acquireProgress = Math.max(0, this.acquireProgress - dt / ACQUIRE_DECAY_TIME);
        if (this.acquireProgress <= 0) this.acquireCandidate = bestId;
      }
      if (bestId >= 0 && bestId === this.acquireCandidate) {
        this.acquireProgress = Math.min(1, this.acquireProgress + dt / ACQUIRE_TIME);
      }

      if (this.acquireProgress >= 1 && this.acquireCandidate >= 0) {
        this.locked = this.acquireCandidate;
        this.acquireCandidate = -1;
        this.acquireProgress = 0;
      }
      return;
    }

    if (bestId < 0) return;
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
   *
   * @param out Output vector for the lead point
   * @param projectileSpeed Projectile speed in world units/second
   * @param enemies Enemy query interface
   * @param shooterPos Optional shooter position (defaults to cached player position)
   */
  getLeadPoint(
    out: THREE.Vector3,
    projectileSpeed: number,
    enemies: EnemyQuery,
    shooterPos?: THREE.Vector3,
  ): boolean {
    if (this.locked < 0) return false;
    const target = enemies.getById(this.locked);
    if (!target || !target.active) return false;

    // Use cached values if not provided (for compatibility with existing call sites).
    const actualShooterPos = shooterPos ?? this.cachedPlayerPos;
    // Projectiles don't inherit the ship's velocity (see weapons.ts:213), so we use the
    // target's absolute velocity in the intercept calculation.

    scratchVec3A.copy(target.position);
    scratchVec3B.copy(target.velocity);
    leadTarget(out, actualShooterPos, scratchVec3A, scratchVec3B, projectileSpeed);
    return true;
  }

  /**
   * Applies gun gimbal and aim assist to `aimDir`. Mutates in place.
   *
   * Gimbal: When a locked target's intercept point falls within the gimbal range (15° half-angle,
   * soft edge from 12°), the guns physically traverse to lock on, snapping the shot direction to
   * the intercept (or current position for hitscan). This applies only to the locked target when
   * assist is enabled.
   *
   * Assist: Bends `aimDir` toward the nearest non-locked target inside the assist cone. The bend
   * is capped at the setting's maximum angle and scaled by proximity, so it feels like settling
   * rather than dragging. Never exceeds the cap.
   *
   * @param projectileSpeed Weapon's projectile speed × projectileSpeedMult (see src/game.ts:596).
   *                        For hitscan (≤0), gimbal aims at target's current position.
   *                        For ballistic (>0), gimbal calculates intercept at this speed.
   */
  applyAimAssist(
    aimDir: THREE.Vector3,
    origin: THREE.Vector3,
    enemies: EnemyQuery,
    _enemyCount: number,
    settings: Settings,
    projectileSpeed: number,
  ): void {
    const maxBend = AIM_ASSIST_RADIANS[settings.aimAssist] ?? 0;

    // Try gimbal first: if we have a lock and assist is enabled, check if the lead point
    // falls within the gimbal's traverse range.
    if (maxBend > 0 && this.locked >= 0) {
      const target = enemies.getById(this.locked);
      if (target && target.active) {
        // For hitscan (speed ≤ 0), aim at current position. For ballistic (speed > 0),
        // calculate intercept using the actual projectile speed.
        let gimbalTargetPos: THREE.Vector3;
        if (projectileSpeed > 0) {
          // Ballistic: calculate where to aim to hit the target.
          if (!this.getLeadPoint(scratchVec3D, projectileSpeed, enemies)) {
            // No intercept solution; aim at current position as fallback.
            gimbalTargetPos = target.position;
          } else {
            gimbalTargetPos = scratchVec3D;
          }
        } else {
          // Hitscan: aim straight at the target's current position.
          gimbalTargetPos = target.position;
        }

        // Direction from ship to gimbal target (lead point or current position).
        scratchVec3E.copy(gimbalTargetPos).sub(origin);
        const leadDist = scratchVec3E.length();
        if (leadDist > 1e-3) {
          scratchVec3E.multiplyScalar(1 / leadDist);

          // Check if gimbal target is within gimbal range.
          const angle = Math.acos(Math.max(-1, Math.min(1, aimDir.dot(scratchVec3E))));

          // Soft edge: full traverse inside 12°, linear falloff to zero at 15°.
          if (angle <= WEAPONS.gimbalHalfAngle) {
            let traverse = 1.0;
            if (angle > WEAPONS.gimbalSoftStart) {
              // Linear interpolation from 1.0 at 12° to 0.0 at 15°.
              traverse = 1.0 - (angle - WEAPONS.gimbalSoftStart) / (WEAPONS.gimbalHalfAngle - WEAPONS.gimbalSoftStart);
            }

            if (traverse > 1e-4) {
              // Traverse toward the gimbal direction: at full strength, snap all the way;
              // at reduced strength, lerp partway.
              if (angle < 1e-5) {
                // Already aligned, just use the gimbal direction.
                aimDir.copy(scratchVec3E);
              } else {
                // Rotate proportionally toward the gimbal direction.
                gimbalAxis.copy(aimDir).cross(scratchVec3E);
                if (gimbalAxis.lengthSq() > 1e-8) {
                  gimbalAxis.normalize();
                  gimbalQuat.setFromAxisAngle(gimbalAxis, angle * traverse);
                  aimDir.applyQuaternion(gimbalQuat).normalize();
                }
              }
            }
            return; // Gimbal overrides regular assist.
          }
        }
      }
    }

    // Regular aim assist: bend toward non-locked targets inside the assist cone.
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
