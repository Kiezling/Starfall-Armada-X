/**
 * Boss encounter controller.
 *
 * Owns the lifecycle of a boss fight: spawn, intro, the per-step update, collision against
 * player fire, phase-transition drama, and death. The game layer talks only to this, so adding
 * a fourth boss later means adding a factory entry rather than touching the run loop.
 *
 * Collision note: bosses are not part of the pooled enemy system — there is exactly one, it is
 * large, and it needs bespoke damage routing (The Maw Core's plates, Hexard's segments). So it
 * is tested directly against player projectiles here rather than going through the enemy
 * spatial grid.
 *
 * Lock-on note (playtester feedback #5/#6): because bosses live outside the pooled enemy
 * system, `combat/targeting.ts` — which only knows the pooled `EnemyQuery` shape — cannot see
 * them, so bosses were silently excluded from lock-on and aim assist. `CombinedEnemyQuery`
 * below closes that gap without any change to `targeting.ts`: it implements the exact same
 * `EnemyQuery` contract, forwarding to the pooled query and splicing in a synthetic entry for
 * the live boss (via `targetableEnemy`) when one is targetable. See the doc comment on
 * `CombinedEnemyQuery` for the one wiring change this still needs in `game.ts`.
 */

import * as THREE from 'three';
import { Team, type BossId, type Enemy, type EnemyDef, type EventBus } from '../../core/types';
import { sweptSphereHit } from '../../core/math';
import { LIMITS } from '../../core/constants';
import type { EnemyQuery, ProjectileSystem } from '../../combat/projectiles';
import { Boss, type BossContext } from './boss';
import { Hexard } from './hexard';
import { Vashkan } from './vashkan';
import { MawCore } from './mawcore';

export { Boss } from './boss';
export type { BossContext, BossPhase, BossMove } from './boss';

function createBoss(id: BossId): Boss {
  switch (id) {
    case 'hexard':
      return new Hexard();
    case 'vashkan':
      return new Vashkan();
    case 'mawCore':
      return new MawCore();
  }
}

/**
 * Structural-typing placeholder for the boss-as-`Enemy` shim below. `combat/targeting.ts` and
 * the HUD only ever read `position`/`velocity`/`hull`/`maxHull`/`active`/`id` off a queried
 * `Enemy` — nothing reads `def` or `typeId` for an entity reached through `CombinedEnemyQuery` —
 * but `Enemy` is a closed interface, so a conforming object needs every field to type-check.
 */
const BOSS_SHIM_DEF: EnemyDef = {
  id: 'lancer',
  displayName: 'Boss',
  hull: 0,
  shield: 0,
  radius: 0,
  speed: 0,
  turnRate: 0,
  engageRange: 0,
  fireRange: 0,
  fireInterval: 0,
  damage: 0,
  salvage: 0,
  score: 0,
  armorArc: 0,
  armorReduction: 0,
  threat: 0,
};

/** Sentinel entity id for the boss shim — a run's real enemy ids are a small monotonically
 * increasing counter (`core/pool.ts`'s `IdSource`, reset every run), so this is unreachable by
 * any genuine enemy across any realistic run length. */
const BOSS_ENTITY_ID = 0x7ffffff0;

/** Sentinel pool-slot index for the boss inside a `CombinedEnemyQuery`'s `out` buffer — one
 * past the real enemy pool's index range `[0, LIMITS.maxEnemies)`, so it can never collide with
 * a genuine `getByIndex` slot returned by the pooled query. */
const BOSS_QUERY_INDEX = LIMITS.maxEnemies;

export class BossEncounter {
  private readonly scene: THREE.Scene;
  private readonly events: EventBus;
  private readonly projectiles: ProjectileSystem;

  private boss: Boss | null = null;
  /** Seconds of intro remaining; the boss is inert and invulnerable while this runs. */
  private introTimer = 0;
  private lastPhase = 0;

  /** Reused every call to `targetableEnemy` — never reallocated, per the zero-allocation-on-hot-
   * paths rule; only the fields lock-on/aim-assist/the HUD actually read are refreshed. */
  private readonly bossShim: Enemy = {
    active: false,
    index: -1,
    id: BOSS_ENTITY_ID,
    typeId: 'lancer',
    def: BOSS_SHIM_DEF,
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    forward: new THREE.Vector3(0, 0, -1),
    quaternion: new THREE.Quaternion(),
    hull: 0,
    maxHull: 0,
    shield: 0,
    maxShield: 0,
    fireCooldown: 0,
    telegraph: 0,
    flash: 0,
    age: 0,
    isElite: false,
    aiState: 0,
    aiTimer: 0,
    seed: 0,
  };

  constructor(scene: THREE.Scene, events: EventBus, projectiles: ProjectileSystem) {
    this.scene = scene;
    this.events = events;
    this.projectiles = projectiles;
  }

  get active(): boolean {
    return this.boss !== null && this.boss.alive;
  }

  get inIntro(): boolean {
    return this.introTimer > 0;
  }

  get current(): Boss | null {
    return this.boss;
  }

  get displayName(): string {
    return this.boss?.displayName ?? '';
  }

  get subtitle(): string {
    return this.boss?.subtitle ?? '';
  }

  get hullFraction(): number {
    return this.boss?.hullFraction ?? 0;
  }

  get phase(): number {
    return this.boss?.currentPhaseIndex ?? 0;
  }

  get phaseCount(): number {
    return this.boss?.phaseCount ?? 1;
  }

  /**
   * HUD-facing flag: true only for Hexard, and only while it is heavily damage-resistant
   * because its adds are alive (playtester feedback #19). Every other boss/state returns false.
   * Wiring note for the HUD agent: read `bossEncounter.coreResistant` alongside the existing
   * `hullFraction`/`phase` getters already passed to `hud.setBossBar` in game.ts, and pair it
   * with `bossEncounter.liveAddCount` if you want an "X adds remaining" readout — see
   * `Hexard.coreResistant`/`Hexard.liveSegments` in `hexard.ts` for the underlying fields.
   */
  get coreResistant(): boolean {
    return this.boss instanceof Hexard && this.boss.coreResistant;
  }

  /** Companion to `coreResistant` — 0 for every boss except Hexard while its segments are up. */
  get liveAddCount(): number {
    return this.boss instanceof Hexard ? this.boss.liveSegments : 0;
  }

  /**
   * Boss-as-`Enemy` view for `CombinedEnemyQuery`/`TargetingSystem`, or null while the boss
   * cannot be meaningfully targeted: not spawned, dead, still in its name-card intro, or in the
   * brief invulnerable window after a phase transition. Locking onto something the player
   * cannot currently damage would read as a broken lock, so it is withheld entirely rather than
   * exposed-but-unhittable.
   *
   * `position` is `boss.lockPoint`, not `boss.position` — see that getter's doc comment on
   * `Boss` for why a boss with a rotating weak point (Maw Core's lit plate, Hexard's nearest
   * live add) should be locked there instead of its hull centre.
   */
  get targetableEnemy(): Enemy | null {
    const boss = this.boss;
    if (!boss || !boss.alive || this.introTimer > 0 || boss.invulnerable) return null;

    const shim = this.bossShim;
    shim.active = true;
    shim.position.copy(boss.lockPoint);
    shim.velocity.copy(boss.velocity);
    shim.hull = boss.hull;
    shim.maxHull = boss.maxHull;
    return shim;
  }

  /** Spawns a boss and starts its name-card intro. */
  start(id: BossId, hullPoints: number, arenaRadius: number, introSeconds = 3): void {
    this.clear();
    const boss = createBoss(id);
    boss.spawn(this.scene, hullPoints, arenaRadius);
    // The Maw Core needs its plate hull derived from the total, which only it knows how to do.
    if (boss instanceof MawCore) boss.configurePlates(hullPoints);
    // Hexard's segment "adds" likewise size themselves off the total (see item #19 in hexard.ts).
    if (boss instanceof Hexard) boss.configureSegments(hullPoints);
    this.boss = boss;
    this.introTimer = introSeconds;
    this.lastPhase = 0;
    this.events.emit('boss:spawned', { id });
  }

  /**
   * Advances the fight. Returns true on the step the boss dies, so the caller can sequence the
   * death celebration exactly once.
   */
  update(ctx: BossContext, dt: number): boolean {
    const boss = this.boss;
    if (!boss || !boss.alive) return false;

    if (this.introTimer > 0) {
      this.introTimer -= dt;
      // Still ticks its transform so it drifts into view during the name card.
      boss.update(ctx, dt * 0.25);
      return false;
    }

    boss.update(ctx, dt);
    const died = this.resolvePlayerFire(ctx);

    if (boss.currentPhaseIndex !== this.lastPhase) {
      this.lastPhase = boss.currentPhaseIndex;
    }
    return died;
  }

  /**
   * Tests live player projectiles against the boss. Uses the swept test so a Lance at 400 u/s
   * cannot tunnel through a 26-unit hull between two steps.
   *
   * Hexard is special-cased: its three segments orbit outside the core's own hit-sphere (see
   * `hexard.ts`'s file header), so they need their own swept test *before* the core one — a
   * shot that visibly connects with a "pop-up" add must hit the add, not silently pass through
   * it (playtester feedback #19).
   */
  private resolvePlayerFire(ctx: BossContext): boolean {
    const boss = this.boss;
    if (!boss) return false;

    const pool = this.projectiles.pool;
    let died = false;

    // Backwards, because releasing swaps the last live projectile into the freed slot.
    for (let i = pool.size - 1; i >= 0; i--) {
      const p = pool.items[i]!;
      if (!p.active || p.team !== Team.Player) continue;

      let killed: boolean;
      let hitX: number;
      let hitY: number;
      let hitZ: number;

      if (boss instanceof Hexard) {
        const segIndex = boss.findSegmentHit(p.prevPosition, p.position, p.radius);
        if (segIndex >= 0) {
          boss.segmentWorldPosition(segIndex, SEGMENT_HIT_POINT);
          killed = boss.damageSegment(segIndex, p.damage, ctx);
          hitX = SEGMENT_HIT_POINT.x;
          hitY = SEGMENT_HIT_POINT.y;
          hitZ = SEGMENT_HIT_POINT.z;
        } else if (sweptSphereHit(p.prevPosition, p.position, p.radius, boss.position, boss.radius)) {
          killed = boss.damage(p.damage, ctx);
          hitX = p.position.x;
          hitY = p.position.y;
          hitZ = p.position.z;
        } else {
          continue;
        }
      } else {
        if (!sweptSphereHit(p.prevPosition, p.position, p.radius, boss.position, boss.radius)) continue;
        killed = boss.damage(p.damage, ctx);
        hitX = p.position.x;
        hitY = p.position.y;
        hitZ = p.position.z;
      }

      if (killed) died = true;

      this.events.emit('weapon:impact', {
        weapon: p.sourceWeapon,
        x: hitX, y: hitY, z: hitZ,
        nx: hitX - boss.position.x,
        ny: hitY - boss.position.y,
        nz: hitZ - boss.position.z,
        damage: p.damage,
      });

      p.pierce -= 1;
      if (p.pierce < 0) {
        p.active = false;
        pool.releaseAt(i);
      }
      if (died) break;
    }

    return died;
  }

  /** True when the player's shot would connect — used for the lock-on reticle. */
  contains(point: THREE.Vector3): boolean {
    const boss = this.boss;
    if (!boss || !boss.alive) return false;
    return point.distanceToSquared(boss.position) <= boss.radius * boss.radius;
  }

  clear(): void {
    if (this.boss) {
      this.boss.dispose();
      this.boss = null;
    }
    this.introTimer = 0;
    this.lastPhase = 0;
  }

  dispose(): void {
    this.clear();
  }
}

/** Scratch for `resolvePlayerFire`'s segment-hit branch — reused across calls, never retained. */
const SEGMENT_HIT_POINT = /*#__PURE__*/ new THREE.Vector3();

/**
 * Merges the pooled enemy query with the (at most one) active boss into a single `EnemyQuery`,
 * so `combat/targeting.ts` can lock onto either without knowing bosses exist. This is the fix
 * for playtester feedback #5/#6 ("the bosses don't get locked on to"): `TargetingSystem` was
 * never wrong, it simply was never handed anything but the pooled enemy manager.
 *
 * **Wiring note for game.ts (I do not own that file, so this is a report, not a diff):**
 * Construct one instance once, e.g. `private readonly targetQuery = new CombinedEnemyQuery(this.enemies, this.bosses);`
 * next to where `this.targeting`/`this.enemies`/`this.bosses` are already constructed, then:
 *
 * 1. In `simulate()`, swap `this.enemies` for `this.targetQuery` in the
 *    `this.targeting.update(player, this.enemies, this.enemies.liveCount, ...)` call. The
 *    `enemyCount` argument no longer needs adjusting — current `combat/targeting.ts` already
 *    ignores it (`void enemyCount;`) in favour of trusting the query's own result count, so pass
 *    `this.enemies.liveCount` through unchanged.
 * 2. Same file, swap `this.enemies` for `this.targetQuery` in the `this.targeting.cycle(...)`
 *    call and the `this.targeting.applyAimAssist(...)` call.
 * 3. In `resolveTrackDirection()`, swap `this.targeting.getLeadPoint(trackPoint, leadSpeed, this.enemies)`
 *    for `this.targeting.getLeadPoint(trackPoint, leadSpeed, this.targetQuery)`, or the tracking
 *    assist will steer toward a locked boss's *current* position instead of its lead point.
 * 4. For the HUD reticle/off-screen-arrow to draw the boss (not just for weapons to lock it),
 *    `targetView.count`/`targetView.get()` (built in game.ts's constructor, consumed by
 *    `hud.ts`'s `updateTracking`) need a boss entry appended the same way: bump `count` by 1
 *    when `this.bosses.targetableEnemy` is non-null, and have the last ordinal's `get()` return
 *    `{ id: <targetableEnemy.id>, isElite: false, isFiring: <boss.phase move firing?>,
 *    hullFraction: this.bosses.hullFraction }` with `outPos` copied from
 *    `this.bosses.targetableEnemy.position`. Compare ids against `this.bosses.targetableEnemy?.id`
 *    directly rather than a hardcoded constant — the sentinel below is not exported.
 *
 * None of the above requires changing `combat/targeting.ts` at all — that file already treats
 * every `EnemyQuery` result generically.
 */
export class CombinedEnemyQuery implements EnemyQuery {
  constructor(
    private readonly enemies: EnemyQuery,
    private readonly bosses: BossEncounter,
  ) {}

  queryNear(x: number, y: number, z: number, radius: number, out: Int32Array): number {
    let count = this.enemies.queryNear(x, y, z, radius, out);
    const boss = this.bosses.targetableEnemy;
    if (boss && count < out.length) {
      const dx = boss.position.x - x;
      const dy = boss.position.y - y;
      const dz = boss.position.z - z;
      if (dx * dx + dy * dy + dz * dz <= radius * radius) out[count++] = BOSS_QUERY_INDEX;
    }
    return count;
  }

  getByIndex(i: number): Enemy | null {
    if (i === BOSS_QUERY_INDEX) return this.bosses.targetableEnemy;
    return this.enemies.getByIndex(i);
  }

  getById(id: number): Enemy | null {
    const boss = this.bosses.targetableEnemy;
    if (boss && boss.id === id) return boss;
    return this.enemies.getById(id);
  }
}
