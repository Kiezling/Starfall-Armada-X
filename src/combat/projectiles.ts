/**
 * Pooled, instanced projectile simulation.
 *
 * This is the hottest code in the game: up to ~2400 live projectiles stepping, colliding, and
 * rendering every frame. Consequently there is no allocation anywhere in `update`, collision
 * goes through the enemy manager's spatial grid rather than an all-pairs loop, and everything
 * renders in exactly two draw calls.
 *
 * Readability (DESIGN §13): shape encodes ownership, not just colour. Player bolts are
 * elongated along their velocity; enemy shots are round orbs. A player who is colourblind, or
 * who is simply overwhelmed, can still tell instantly which projectiles belong to them.
 */

import * as THREE from 'three';
import {
  ProjectileKind,
  Team,
  type Enemy,
  type EventBus,
  type PlayerState,
  type Projectile,
  type WeaponId,
} from '../core/types';
import { LIMITS } from '../core/constants';
import { Pool } from '../core/pool';
import { distSq, sweptSphereHit } from '../core/math';
import { enemyProjectileColor, playerProjectileColor } from '../render/palette';

export interface ProjectileSpawnParams {
  kind: ProjectileKind;
  team: Team;
  ownerId: number;
  x: number; y: number; z: number;
  dx: number; dy: number; dz: number;
  speed: number;
  damage: number;
  radius: number;
  life: number;
  pierce: number;
  fork: number;
  homingRate: number;
  targetId: number;
  proximity: number;
  aoe: number;
  colorIndex: number;
  scale: number;
  sourceWeapon: WeaponId | 'enemy' | 'boss';
}

/** Read-only view of the enemy set, implemented by the enemy manager. */
export interface EnemyQuery {
  queryNear(x: number, y: number, z: number, radius: number, out: Int32Array): number;
  getByIndex(i: number): Enemy | null;
  getById(id: number): Enemy | null;
}

/** Everything the projectile step needs from the rest of the game. */
export interface CombatContext {
  player: PlayerState;
  playerAlive: boolean;
  arenaRadius: number;
  enemies: EnemyQuery;
  damageEnemy: (
    enemyId: number,
    amount: number,
    crit: boolean,
    hx: number, hy: number, hz: number,
    sourceWeapon: WeaponId | 'enemy' | 'boss',
  ) => number;
  damagePlayer: (amount: number, dx: number, dy: number, dz: number) => void;
  blockedByTerrain?: (
    fromX: number, fromY: number, fromZ: number,
    toX: number, toY: number, toZ: number,
    radius: number,
  ) => boolean;
  pullEnemies?: (x: number, y: number, z: number, radius: number, strength: number, dt: number) => void;
}

/** Slots of recently-hit enemy ids per projectile, so one bolt cannot damage a target twice. */
const HIT_MEMORY = 4;

/* Module scratch — borrowed within a single synchronous block, never retained. */
const matrix = /*#__PURE__*/ new THREE.Matrix4();
const quat = /*#__PURE__*/ new THREE.Quaternion();
const scaleVec = /*#__PURE__*/ new THREE.Vector3();
const dirVec = /*#__PURE__*/ new THREE.Vector3();
const posVec = /*#__PURE__*/ new THREE.Vector3();
const colorTmp = /*#__PURE__*/ new THREE.Color();
const UP = /*#__PURE__*/ new THREE.Vector3(0, 1, 0);
const FORWARD_Y = /*#__PURE__*/ new THREE.Vector3(0, 1, 0);

export class ProjectileSystem {
  private readonly scene: THREE.Scene;
  private readonly events: EventBus;
  private readonly projectiles: Pool<Projectile>;

  private readonly playerMesh: THREE.InstancedMesh;
  private readonly enemyMesh: THREE.InstancedMesh;

  /** Flat ring buffer of recently-hit ids, HIT_MEMORY per pool slot. */
  private readonly hitMemory: Int32Array;
  private readonly hitCursor: Uint8Array;

  private readonly queryResults = new Int32Array(LIMITS.maxQueryResults);
  private nearestEnemyShot = Infinity;

  /** Reused spawn record for forked children, so forking allocates nothing. */
  private readonly forkParams: ProjectileSpawnParams;

  constructor(scene: THREE.Scene, events: EventBus) {
    this.scene = scene;
    this.events = events;

    this.projectiles = new Pool<Projectile>(
      LIMITS.maxProjectiles,
      (index) => ({
        active: false,
        index,
        position: new THREE.Vector3(),
        velocity: new THREE.Vector3(),
        prevPosition: new THREE.Vector3(),
        kind: ProjectileKind.Linear,
        team: Team.Player,
        damage: 0,
        radius: 1,
        speed: 0,
        life: 0,
        maxLife: 1,
        pierce: 0,
        fork: 0,
        homingRate: 0,
        targetId: -1,
        proximity: 0,
        aoe: 0,
        colorIndex: 0,
        scale: 1,
        sourceWeapon: 'enemy',
        ownerId: -1,
      }),
      (p) => {
        p.active = false;
      },
    );

    this.hitMemory = new Int32Array(LIMITS.maxProjectiles * HIT_MEMORY).fill(-1);
    this.hitCursor = new Uint8Array(LIMITS.maxProjectiles);

    // Player bolts: a slim elongated form, stretched along velocity at draw time.
    const boltGeo = new THREE.CapsuleGeometry(0.35, 2.2, 3, 6);
    // Capsule's long axis is Y; the instance matrix rotates Y onto the velocity direction.
    const boltMat = new THREE.MeshBasicMaterial({
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.playerMesh = new THREE.InstancedMesh(boltGeo, boltMat, LIMITS.maxProjectiles);
    this.playerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.playerMesh.frustumCulled = false;
    this.playerMesh.count = 0;
    scene.add(this.playerMesh);

    // Enemy shots: round orbs. Deliberately a different silhouette.
    const orbGeo = new THREE.SphereGeometry(1, 8, 6);
    const orbMat = new THREE.MeshBasicMaterial({
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.enemyMesh = new THREE.InstancedMesh(orbGeo, orbMat, LIMITS.maxProjectiles);
    this.enemyMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.enemyMesh.frustumCulled = false;
    this.enemyMesh.count = 0;
    scene.add(this.enemyMesh);

    this.forkParams = {
      kind: ProjectileKind.Linear, team: Team.Player, ownerId: -1,
      x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1,
      speed: 0, damage: 0, radius: 1, life: 0,
      pierce: 0, fork: 0, homingRate: 0, targetId: -1,
      proximity: 0, aoe: 0, colorIndex: 0, scale: 1,
      sourceWeapon: 'enemy',
    };
  }

  get liveCount(): number {
    return this.projectiles.size;
  }

  get pool(): Pool<Projectile> {
    return this.projectiles;
  }

  /** Closest approach of any enemy shot to the player this step, for the near-miss augment. */
  get closestEnemyShotDistance(): number {
    return this.nearestEnemyShot;
  }

  spawn(p: ProjectileSpawnParams): Projectile | null {
    const proj = this.projectiles.acquire();
    if (!proj) return null;

    proj.active = true;
    proj.position.set(p.x, p.y, p.z);
    proj.prevPosition.copy(proj.position);

    // Normalise defensively: a zero-length direction would produce a NaN velocity that then
    // silently poisons every downstream distance test.
    dirVec.set(p.dx, p.dy, p.dz);
    if (dirVec.lengthSq() < 1e-8) dirVec.set(0, 0, -1);
    else dirVec.normalize();
    proj.velocity.copy(dirVec).multiplyScalar(p.speed);

    proj.kind = p.kind;
    proj.team = p.team;
    proj.damage = p.damage;
    proj.radius = p.radius;
    proj.speed = p.speed;
    proj.life = p.life;
    proj.maxLife = p.life;
    proj.pierce = p.pierce;
    proj.fork = p.fork;
    proj.homingRate = p.homingRate;
    proj.targetId = p.targetId;
    proj.proximity = p.proximity;
    proj.aoe = p.aoe;
    proj.colorIndex = p.colorIndex;
    proj.scale = p.scale;
    proj.sourceWeapon = p.sourceWeapon;
    proj.ownerId = p.ownerId;

    this.clearHitMemory(proj.index);
    return proj;
  }

  private clearHitMemory(slot: number): void {
    const base = slot * HIT_MEMORY;
    for (let i = 0; i < HIT_MEMORY; i++) this.hitMemory[base + i] = -1;
    this.hitCursor[slot] = 0;
  }

  private hasHit(slot: number, id: number): boolean {
    const base = slot * HIT_MEMORY;
    for (let i = 0; i < HIT_MEMORY; i++) if (this.hitMemory[base + i] === id) return true;
    return false;
  }

  private rememberHit(slot: number, id: number): void {
    const base = slot * HIT_MEMORY;
    const cursor = this.hitCursor[slot]! % HIT_MEMORY;
    this.hitMemory[base + cursor] = id;
    this.hitCursor[slot] = (cursor + 1) % HIT_MEMORY;
  }

  /* Simulation ------------------------------------------------------------------------------ */

  update(dt: number, ctx: CombatContext): void {
    this.nearestEnemyShot = Infinity;
    const pool = this.projectiles;
    const maxRange = ctx.arenaRadius + 120;
    const player = ctx.player;

    // Backwards, because releasing swaps the last live item into the freed slot.
    for (let i = pool.size - 1; i >= 0; i--) {
      const p = pool.items[i]!;
      if (!p.active) {
        pool.releaseAt(i);
        continue;
      }

      p.life -= dt;
      if (p.life <= 0) {
        this.detonate(p, ctx, false);
        p.active = false;
        pool.releaseAt(i);
        continue;
      }

      p.prevPosition.copy(p.position);

      switch (p.kind) {
        case ProjectileKind.Homing:
          this.steerHoming(p, ctx, dt);
          break;
        case ProjectileKind.Mine:
          // Mines hang in space; they arm over their first second and then fuse on proximity.
          p.velocity.multiplyScalar(0.9);
          break;
        case ProjectileKind.Singularity:
          if (ctx.pullEnemies) ctx.pullEnemies(p.position.x, p.position.y, p.position.z, p.aoe > 0 ? p.aoe : 60, 130, dt);
          break;
        default:
          break;
      }

      p.position.addScaledVector(p.velocity, dt);

      // Out of bounds.
      if (p.position.lengthSq() > maxRange * maxRange) {
        p.active = false;
        pool.releaseAt(i);
        continue;
      }

      // Terrain (asteroids) blocks shots — this is what makes Debris Belt cover real.
      if (
        ctx.blockedByTerrain &&
        ctx.blockedByTerrain(
          p.prevPosition.x, p.prevPosition.y, p.prevPosition.z,
          p.position.x, p.position.y, p.position.z,
          p.radius,
        )
      ) {
        this.emitImpact(p, p.position.x, p.position.y, p.position.z, 0, 1, 0);
        this.detonate(p, ctx, true);
        p.active = false;
        pool.releaseAt(i);
        continue;
      }

      const consumed = p.team === Team.Player
        ? this.collidePlayerShot(p, ctx)
        : this.collideEnemyShot(p, ctx, player);

      if (consumed) {
        p.active = false;
        pool.releaseAt(i);
      }
    }

    this.syncInstances();
  }

  private steerHoming(p: Projectile, ctx: CombatContext, dt: number): void {
    if (p.targetId < 0) return;
    const target = ctx.enemies.getById(p.targetId);
    if (!target) {
      // Target died mid-flight: fly straight rather than snapping to a new one, which would
      // read as the missile cheating.
      p.targetId = -1;
      return;
    }
    dirVec.copy(target.position).sub(p.position);
    const dist = dirVec.length();
    if (dist < 1e-4) return;
    dirVec.multiplyScalar(1 / dist);

    // Rotate the velocity toward the target by at most homingRate radians this step.
    const maxTurn = p.homingRate * dt;
    posVec.copy(p.velocity).normalize();
    const dot = Math.max(-1, Math.min(1, posVec.dot(dirVec)));
    const angle = Math.acos(dot);
    if (angle < 1e-4) return;

    const t = Math.min(1, maxTurn / angle);
    posVec.lerp(dirVec, t).normalize();
    p.velocity.copy(posVec).multiplyScalar(p.speed);
  }

  /** Player shot vs enemies. Returns true if the projectile is consumed. */
  private collidePlayerShot(p: Projectile, ctx: CombatContext): boolean {
    const searchRadius = Math.max(p.radius + 24, p.proximity + 8);
    const count = ctx.enemies.queryNear(p.position.x, p.position.y, p.position.z, searchRadius, this.queryResults);

    for (let i = 0; i < count; i++) {
      const enemy = ctx.enemies.getByIndex(this.queryResults[i]!);
      if (!enemy || !enemy.active) continue;
      if (this.hasHit(p.index, enemy.id)) continue;

      const proximityHit = p.proximity > 0 && distSq(p.position, enemy.position) <= p.proximity * p.proximity;
      const directHit = sweptSphereHit(p.prevPosition, p.position, p.radius, enemy.position, enemy.def.radius);
      if (!proximityHit && !directHit) continue;

      // Mines only fuse once armed, so the player is not blown up by their own deployment.
      if (p.kind === ProjectileKind.Mine && p.maxLife - p.life < 1) continue;

      this.rememberHit(p.index, enemy.id);

      dirVec.copy(p.position).sub(enemy.position);
      if (dirVec.lengthSq() < 1e-6) dirVec.copy(UP);
      else dirVec.normalize();

      if (p.aoe <= 0) {
        ctx.damageEnemy(enemy.id, p.damage, false, p.position.x, p.position.y, p.position.z, p.sourceWeapon);
      }
      this.emitImpact(p, p.position.x, p.position.y, p.position.z, dirVec.x, dirVec.y, dirVec.z);

      if (p.fork > 0) this.forkInto(p, ctx);
      if (p.aoe > 0 || p.proximity > 0) {
        this.detonate(p, ctx, true);
        return true;
      }

      p.pierce -= 1;
      if (p.pierce < 0) return true;
    }
    return false;
  }

  /** Enemy shot vs the player. */
  private collideEnemyShot(p: Projectile, ctx: CombatContext, player: PlayerState): boolean {
    if (!ctx.playerAlive) return false;

    const d2 = distSq(p.position, player.position);
    if (d2 < this.nearestEnemyShot * this.nearestEnemyShot) this.nearestEnemyShot = Math.sqrt(d2);

    const playerRadius = 4.2;
    const proximityHit = p.proximity > 0 && d2 <= p.proximity * p.proximity;
    const directHit = sweptSphereHit(p.prevPosition, p.position, p.radius, player.position, playerRadius);
    if (!proximityHit && !directHit) return false;

    dirVec.copy(player.position).sub(p.position);
    if (dirVec.lengthSq() < 1e-6) dirVec.copy(UP);
    else dirVec.normalize();

    ctx.damagePlayer(p.damage, dirVec.x, dirVec.y, dirVec.z);
    this.emitImpact(p, p.position.x, p.position.y, p.position.z, -dirVec.x, -dirVec.y, -dirVec.z);
    return true;
  }

  /** Area damage on detonation, with linear falloff from the centre. */
  private detonate(p: Projectile, ctx: CombatContext, impacted: boolean): void {
    if (p.aoe <= 0 || p.team !== Team.Player) return;
    if (!impacted && p.kind !== ProjectileKind.Mine && p.kind !== ProjectileKind.Proximity) return;

    const count = ctx.enemies.queryNear(p.position.x, p.position.y, p.position.z, p.aoe, this.queryResults);
    for (let i = 0; i < count; i++) {
      const enemy = ctx.enemies.getByIndex(this.queryResults[i]!);
      if (!enemy || !enemy.active) continue;
      const dist = Math.sqrt(distSq(p.position, enemy.position));
      if (dist > p.aoe) continue;
      const falloff = 1 - dist / p.aoe;
      ctx.damageEnemy(enemy.id, p.damage * falloff, false, enemy.position.x, enemy.position.y, enemy.position.z, p.sourceWeapon);
    }
  }

  /** Split Payload: two children at spread angles, carrying reduced damage. */
  private forkInto(p: Projectile, _ctx: CombatContext): void {
    const f = this.forkParams;
    f.kind = ProjectileKind.Linear;
    f.team = p.team;
    f.ownerId = p.ownerId;
    f.x = p.position.x; f.y = p.position.y; f.z = p.position.z;
    f.speed = p.speed * 0.9;
    f.damage = p.damage * 0.6;
    f.radius = p.radius;
    f.life = Math.max(0.6, p.maxLife * 0.5);
    f.pierce = 0;
    f.fork = p.fork - 1;
    f.homingRate = 0;
    f.targetId = -1;
    f.proximity = 0;
    f.aoe = 0;
    f.colorIndex = p.colorIndex;
    f.scale = p.scale * 0.8;
    f.sourceWeapon = p.sourceWeapon;

    posVec.copy(p.velocity).normalize();
    // Build a perpendicular so the two children split across the flight path, not along it.
    dirVec.copy(Math.abs(posVec.y) < 0.9 ? UP : FORWARD_Y).cross(posVec).normalize();

    for (let sign = -1; sign <= 1; sign += 2) {
      scaleVec.copy(posVec).addScaledVector(dirVec, 0.45 * sign).normalize();
      f.dx = scaleVec.x; f.dy = scaleVec.y; f.dz = scaleVec.z;
      this.spawn(f);
    }
  }

  private emitImpact(p: Projectile, x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
    this.events.emit('weapon:impact', {
      weapon: p.sourceWeapon,
      x, y, z,
      nx, ny, nz,
      damage: p.damage,
    });
  }

  /**
   * Clears a team's projectiles inside a radius. Aegis Pulse's bullet-clear, which is what
   * makes it a genuine panic button rather than a small shield top-up.
   */
  clearTeam(team: Team, x: number, y: number, z: number, radius: number): number {
    const pool = this.projectiles;
    const r2 = radius * radius;
    let cleared = 0;
    posVec.set(x, y, z);

    for (let i = pool.size - 1; i >= 0; i--) {
      const p = pool.items[i]!;
      if (!p.active || p.team !== team) continue;
      if (distSq(p.position, posVec) > r2) continue;
      p.active = false;
      pool.releaseAt(i);
      cleared++;
    }
    return cleared;
  }

  /* Rendering -------------------------------------------------------------------------------- */

  /**
   * Rebuilds both instance buffers. Setting `.count` to the live number (rather than hiding
   * spare instances off-screen) keeps the vertex shader off the dead ones entirely.
   */
  private syncInstances(): void {
    const pool = this.projectiles;
    let playerCount = 0;
    let enemyCount = 0;

    for (let i = 0; i < pool.size; i++) {
      const p = pool.items[i]!;
      if (!p.active) continue;

      const isPlayer = p.team === Team.Player;
      posVec.copy(p.position);

      if (isPlayer) {
        // Align the capsule's +Y axis with the direction of travel, then stretch along it so
        // fast shots read as tracers.
        dirVec.copy(p.velocity);
        if (dirVec.lengthSq() < 1e-8) dirVec.set(0, 1, 0);
        else dirVec.normalize();
        quat.setFromUnitVectors(FORWARD_Y, dirVec);
        scaleVec.set(p.scale, p.scale * 1.8, p.scale);
        matrix.compose(posVec, quat, scaleVec);
        this.playerMesh.setMatrixAt(playerCount, matrix);
        colorTmp.setHex(playerProjectileColor(p.colorIndex));
        this.playerMesh.setColorAt(playerCount, colorTmp);
        playerCount++;
      } else {
        quat.identity();
        const s = p.scale * p.radius;
        scaleVec.set(s, s, s);
        matrix.compose(posVec, quat, scaleVec);
        this.enemyMesh.setMatrixAt(enemyCount, matrix);
        colorTmp.setHex(enemyProjectileColor(p.colorIndex));
        this.enemyMesh.setColorAt(enemyCount, colorTmp);
        enemyCount++;
      }
    }

    this.playerMesh.count = playerCount;
    this.enemyMesh.count = enemyCount;
    if (playerCount > 0) {
      this.playerMesh.instanceMatrix.needsUpdate = true;
      if (this.playerMesh.instanceColor) this.playerMesh.instanceColor.needsUpdate = true;
    }
    if (enemyCount > 0) {
      this.enemyMesh.instanceMatrix.needsUpdate = true;
      if (this.enemyMesh.instanceColor) this.enemyMesh.instanceColor.needsUpdate = true;
    }
  }

  reset(): void {
    this.projectiles.releaseAll();
    this.playerMesh.count = 0;
    this.enemyMesh.count = 0;
    this.nearestEnemyShot = Infinity;
  }

  dispose(): void {
    this.scene.remove(this.playerMesh);
    this.scene.remove(this.enemyMesh);
    this.playerMesh.geometry.dispose();
    (this.playerMesh.material as THREE.Material).dispose();
    this.enemyMesh.geometry.dispose();
    (this.enemyMesh.material as THREE.Material).dispose();
    this.playerMesh.dispose();
    this.enemyMesh.dispose();
  }
}
