/**
 * Boss encounter controller.
 *
 * Owns the lifecycle of a boss fight: spawn, intro, the per-step update, collision against
 * player fire, phase-transition drama, and death. The game layer talks only to this, so adding
 * a fourth boss later means adding a factory entry rather than touching the run loop.
 *
 * Collision note: bosses are not part of the pooled enemy system — there is exactly one, it is
 * large, and it needs bespoke damage routing (The Maw Core's plates). So it is tested directly
 * against player projectiles here rather than going through the enemy spatial grid.
 */

import * as THREE from 'three';
import { Team, type BossId, type EventBus } from '../../core/types';
import { sweptSphereHit } from '../../core/math';
import type { ProjectileSystem } from '../../combat/projectiles';
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

export class BossEncounter {
  private readonly scene: THREE.Scene;
  private readonly events: EventBus;
  private readonly projectiles: ProjectileSystem;

  private boss: Boss | null = null;
  /** Seconds of intro remaining; the boss is inert and invulnerable while this runs. */
  private introTimer = 0;
  private lastPhase = 0;

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

  /** Spawns a boss and starts its name-card intro. */
  start(id: BossId, hullPoints: number, arenaRadius: number, introSeconds = 3): void {
    this.clear();
    const boss = createBoss(id);
    boss.spawn(this.scene, hullPoints, arenaRadius);
    // The Maw Core needs its plate hull derived from the total, which only it knows how to do.
    if (boss instanceof MawCore) boss.configurePlates(hullPoints);
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
      if (!sweptSphereHit(p.prevPosition, p.position, p.radius, boss.position, boss.radius)) continue;

      const killed = boss.damage(p.damage, ctx);
      if (killed) died = true;

      this.events.emit('weapon:impact', {
        weapon: p.sourceWeapon,
        x: p.position.x, y: p.position.y, z: p.position.z,
        nx: p.position.x - boss.position.x,
        ny: p.position.y - boss.position.y,
        nz: p.position.z - boss.position.z,
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
