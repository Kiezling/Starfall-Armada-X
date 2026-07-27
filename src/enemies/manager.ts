/**
 * Pooled enemy lifecycle + instanced rendering (DESIGN.md §10, §16.2).
 *
 * `EnemyManager` owns every live `Enemy`: it drives `ai.ts`'s brains, integrates motion,
 * turns AI intent into projectile spawns, resolves damage (including Chain Reaction), and
 * keeps one `InstancedMesh` per archetype (plus one elite variant per archetype, plus a shared
 * elite aura mesh) in sync with the pool. It never touches the DOM or imports FX/audio —
 * feedback is entirely `EventBus` emissions, per the architectural rule at the top of this
 * task: the wiring layer is what turns 'enemy:died' into a shockwave and a sound.
 *
 * Zero allocation per frame: every scratch vector/quaternion/matrix used in `update()` is a
 * module- or instance-level singleton, borrowed and immediately consumed, exactly like the
 * convention in `ai.ts` and `core/math.ts`.
 */

import * as THREE from 'three';
import type { Enemy, EnemyTypeId, EventBus, Difficulty } from '../core/types';
import { ProjectileKind, Team } from '../core/types';
import { ARENA, LIMITS, FEEL } from '../core/constants';
import { Pool, IdSource } from '../core/pool';
import { SpatialGrid } from '../core/spatial';
import type { Rng } from '../core/rng';
import {
  EPSILON,
  WORLD_UP,
  FORWARD,
  randomOnSphere,
  scratchVec3A,
  scratchVec3B,
  scratchVec3C,
  scratchVec3D,
  scratchQuatA,
  scratchMat4A,
  scratchMat4B,
} from '../core/math';
import {
  getEnemyDef,
  scaleEnemyStats,
  buildEnemyGeometry,
  buildEnemyMaterial,
  buildEliteMaterial,
  buildEliteAuraGeometry,
  buildEliteAuraMaterial,
  ENEMY_ORDER,
} from './types';
import {
  updateBrain,
  createAiIntent,
  type AiIntent,
  type AiContext,
  type EnemyNeighbors,
} from './ai';
import { lookRotation } from '../ship/flight';
import type { EnemyQuery, ProjectileSpawnParams, ProjectileSystem } from '../combat/projectiles';

const TYPE_COUNT = ENEMY_ORDER.length;

/** A neighbourhood wide enough to cover every archetype's `separate()` radius (ai.ts uses
 * `def.radius * 4.5`; the Carrier's 7.0 radius is the largest at 31.5), with headroom. */
const NEIGHBOR_QUERY_RADIUS = 36;

/** How far a Chain Reaction detonation reaches, and how deep the cascade may recurse — capped
 * so a dense cluster cannot chain into an infinite (or merely frame-costly) cascade. */
const CHAIN_REACTION_RADIUS = 55;
const CHAIN_REACTION_MAX_DEPTH = 6;

/** Elites are "buffed stats" per DESIGN §10; hull/shield scale linearly and damage is damped
 * by `scaleEnemyStats`'s own sqrt curve, so this cannot let an elite one-shot a fresh hull. */
const ELITE_POWER_MULT = 2.1;

/** Aura ring scale relative to the enemy's own collision radius, and its idle spin rate —
 * purely cosmetic, but "rotating aura ring" is the explicit elite tell in DESIGN §10. */
const AURA_SCALE = 1.7;
const AURA_SPIN_SPEED = 1.3;

/** Projectile speed per archetype. Not part of `EnemyDef` because it is a rendering/feel
 * concern of the shot itself, not a stat that scales with sector/threat power.
 *
 * `mortar` never sets `wantsFire` (see ai.ts's `mortarBrain` — its only attack is the placed
 * mine handled below via `wantsSpecial`), so this entry is never actually read; it exists only
 * because `PROJECTILE_SPEED` is keyed by every `EnemyTypeId` and a plausible value costs nothing
 * to keep here in case a direct-fire mode is ever added. */
const PROJECTILE_SPEED: Readonly<Record<EnemyTypeId, number>> = {
  waspDrone: 90,
  interceptor: 150,
  lancer: 260,
  bulwark: 105,
  carrier: 100,
  mineLayer: 95,
  mortar: 90,
  warden: 80,
};

const PROJECTILE_RADIUS = 1.1;

/**
 * How far a Warden's shield-regen aura reaches, and how much shield/second it restores to each
 * ally inside it. This runs its own `SpatialGrid` query (via `applyWardenAura`) rather than
 * reusing the AI neighbour buffer bound for `separate()`/`cohere()` each iteration, so its
 * radius is chosen independently of `NEIGHBOR_QUERY_RADIUS` — "how far the aura visibly
 * protects" matters more here than saving one query.
 *
 * 12/s fully restores an Interceptor's 20 shield in 1.7s and a Bulwark's 60 in 5s (see
 * `ENEMY_DEFS` in enemies/types.ts) — fast enough that a shielded escort effectively cannot be
 * broken down while its Warden lives, which is the entire point of making the Warden the
 * priority target, but not so fast that it out-heals sustained multi-weapon focus fire, which
 * would make an escorted group uncounterable rather than merely a detour.
 */
const WARDEN_AURA_RADIUS = 70;
const WARDEN_AURA_REGEN = 12;

/** Unit scale reused for every instance matrix compose — enemies do not stretch, so this is a
 * shared constant rather than a fresh vector per instance. */
const ONE_SCALE = /*#__PURE__*/ new THREE.Vector3(1, 1, 1);

/** Materials are memoized singletons owned by `enemies/types.ts`; each is consumed by exactly
 * one InstancedMesh in this module, so patching them once for the hit-flash attribute is safe
 * and does not leak across unrelated consumers. Guarded so a second `EnemyManager` (e.g. in a
 * test harness) does not double-patch a shared material. */
const patchedMaterials = /*#__PURE__*/ new WeakSet<THREE.Material>();

function ensureFlashSupport(material: THREE.Material): void {
  if (patchedMaterials.has(material)) return;
  patchedMaterials.add(material);
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float instanceFlash;\nvarying float vInstanceFlash;',
      )
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvInstanceFlash = instanceFlash;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vInstanceFlash;')
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\ndiffuseColor.rgb = mix( diffuseColor.rgb, vec3( 1.0 ), vInstanceFlash );',
      );
  };
  // The injected attribute changes the compiled program, so it needs its own cache key —
  // otherwise three.js may reuse a program compiled before the patch was applied.
  material.customProgramCacheKey = () => 'enemyHitFlash';
}

/** Derives an enemy's current (power-scaled) damage from its already-scaled `maxHull`, rather
 * than storing a second scaled value: `maxHull / def.hull` recovers the exact power-scale
 * factor `scaleEnemyStats` applied at spawn, since hull and shield both scale linearly by it. */
function currentDamage(enemy: Enemy): number {
  return enemy.def.damage * Math.sqrt(enemy.maxHull / enemy.def.hull);
}

/** Read-only view over a grid query's results, rebound (never reallocated) once per enemy per
 * frame so `ai.ts`'s `separate()` can walk neighbours without the manager exposing its grid. */
class GridNeighborView implements EnemyNeighbors {
  count = 0;
  private buffer: Int32Array | null = null;
  private bySlot: readonly (Enemy | null)[] | null = null;

  bind(buffer: Int32Array, count: number, bySlot: readonly (Enemy | null)[]): void {
    this.buffer = buffer;
    this.count = count;
    this.bySlot = bySlot;
  }

  get(i: number): Enemy | null {
    if (!this.buffer || !this.bySlot || i < 0 || i >= this.count) return null;
    const e = this.bySlot[this.buffer[i]!];
    return e && e.active ? e : null;
  }
}

export interface EnemyUpdateContext {
  playerPos: THREE.Vector3;
  playerVel: THREE.Vector3;
  playerAlive: boolean;
  arenaRadius: number;
  elapsed: number;
  difficulty: Difficulty;
  /** Fraction of an enemy's max hull to detonate on death; 0 disables Chain Reaction. */
  chainReaction: number;
  /** Called when an enemy dies, so the wiring layer can award salvage/score and drive FX. */
  onKill: (enemy: Enemy) => void;
}

export class EnemyManager implements EnemyQuery {
  private readonly scene: THREE.Scene;
  private readonly events: EventBus;
  private readonly projectiles: ProjectileSystem;
  private readonly rng: Rng;
  private readonly randFn: () => number;

  private readonly ids = new IdSource();
  private readonly enemyPool: Pool<Enemy>;
  /** `bySlot[enemy.index]` is always that same Enemy object, live or not — `index` is the
   * object's permanent pool-slot identity (see core/pool.ts), so this array never needs
   * updating after construction. It is how `getByIndex`/grid queries resolve back to entities. */
  private readonly bySlot: (Enemy | null)[];
  private readonly idToEnemy = new Map<number, Enemy>();

  private readonly grid: SpatialGrid;
  private readonly neighborQueryBuffer = new Int32Array(LIMITS.maxQueryResults);
  private readonly chainQueryBuffer = new Int32Array(LIMITS.maxQueryResults);
  private readonly neighborView = new GridNeighborView();

  private readonly aiCtx: AiContext;
  private readonly intent: AiIntent = createAiIntent();
  private lastCtx: EnemyUpdateContext | null = null;

  /** Reused for every enemy-fired projectile so firing never allocates a param object mid-frame
   * — every field is overwritten in `fireEnemyProjectile`/`handleSpecial` before each
   * `projectiles.spawn` call, exactly like the scratch-vector borrow convention. */
  private readonly spawnParams: ProjectileSpawnParams = {
    kind: ProjectileKind.Linear,
    team: Team.Enemy,
    ownerId: 0,
    x: 0,
    y: 0,
    z: 0,
    dx: 0,
    dy: 0,
    dz: 1,
    speed: 0,
    damage: 0,
    radius: PROJECTILE_RADIUS,
    life: 0,
    pierce: 0,
    fork: 0,
    homingRate: 0,
    targetId: -1,
    proximity: 0,
    aoe: 0,
    colorIndex: 0,
    scale: 1,
    sourceWeapon: 'enemy',
  };

  /* Rendering: one InstancedMesh per archetype, one elite variant per archetype, one shared
   * elite aura mesh. Geometries are cloned (not the shared cache from enemies/types.ts) because
   * each mesh needs its own `instanceFlash` attribute sized to its own instance count. */
  private readonly normalMeshes: THREE.InstancedMesh[] = [];
  private readonly eliteMeshes: THREE.InstancedMesh[] = [];
  private readonly normalFlash: THREE.InstancedBufferAttribute[] = [];
  private readonly eliteFlash: THREE.InstancedBufferAttribute[] = [];
  private readonly auraMesh: THREE.InstancedMesh;
  private readonly typeIndex: Record<EnemyTypeId, number>;
  private readonly normalCounts: number[] = new Array(TYPE_COUNT).fill(0);
  private readonly eliteCounts: number[] = new Array(TYPE_COUNT).fill(0);

  constructor(scene: THREE.Scene, events: EventBus, projectiles: ProjectileSystem, rng: Rng) {
    this.scene = scene;
    this.events = events;
    this.projectiles = projectiles;
    this.rng = rng;
    this.randFn = () => this.rng.next();

    this.bySlot = new Array(LIMITS.maxEnemies).fill(null);
    this.enemyPool = new Pool<Enemy>(
      LIMITS.maxEnemies,
      (index) => this.makeEnemy(index),
      (e) => {
        e.active = false;
      },
    );
    for (let i = 0; i < LIMITS.maxEnemies; i++) this.bySlot[i] = this.enemyPool.items[i]!;

    // Sized to the spawn shell (arena + margin), not just the base arena, so freshly-spawned
    // enemies land in a meaningful grid cell immediately rather than being clamped to the edge.
    this.grid = new SpatialGrid(ARENA.radius + ARENA.spawnMargin, LIMITS.gridCellSize, LIMITS.maxEnemies);

    this.typeIndex = {} as Record<EnemyTypeId, number>;
    ENEMY_ORDER.forEach((id, i) => {
      this.typeIndex[id] = i;
    });

    for (const id of ENEMY_ORDER) {
      const normalGeo = buildEnemyGeometry(id).clone();
      normalGeo.setAttribute('instanceFlash', new THREE.InstancedBufferAttribute(new Float32Array(LIMITS.maxEnemies), 1));
      const normalMat = buildEnemyMaterial(id);
      ensureFlashSupport(normalMat);
      const normalMesh = new THREE.InstancedMesh(normalGeo, normalMat, LIMITS.maxEnemies);
      normalMesh.count = 0;
      normalMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Instances are spread across the whole arena; the geometry's own bounding sphere (the
      // only thing three.js would otherwise cull against) sits at the origin and is tiny.
      normalMesh.frustumCulled = false;
      this.scene.add(normalMesh);
      this.normalMeshes.push(normalMesh);
      this.normalFlash.push(normalGeo.attributes.instanceFlash as THREE.InstancedBufferAttribute);

      const eliteGeo = buildEnemyGeometry(id).clone();
      eliteGeo.setAttribute('instanceFlash', new THREE.InstancedBufferAttribute(new Float32Array(LIMITS.maxEnemies), 1));
      const eliteMat = buildEliteMaterial(id);
      ensureFlashSupport(eliteMat);
      const eliteMesh = new THREE.InstancedMesh(eliteGeo, eliteMat, LIMITS.maxEnemies);
      eliteMesh.count = 0;
      eliteMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      eliteMesh.frustumCulled = false;
      this.scene.add(eliteMesh);
      this.eliteMeshes.push(eliteMesh);
      this.eliteFlash.push(eliteGeo.attributes.instanceFlash as THREE.InstancedBufferAttribute);
    }

    this.auraMesh = new THREE.InstancedMesh(buildEliteAuraGeometry(), buildEliteAuraMaterial(), LIMITS.maxEnemies);
    this.auraMesh.count = 0;
    this.auraMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.auraMesh.frustumCulled = false;
    this.scene.add(this.auraMesh);

    this.neighborView.bind(this.neighborQueryBuffer, 0, this.bySlot);
    this.aiCtx = {
      playerPos: new THREE.Vector3(),
      playerVel: new THREE.Vector3(),
      playerAlive: true,
      arenaRadius: ARENA.radius,
      elapsed: 0,
      neighbors: this.neighborView,
      rng: this.rng,
    };
  }

  private makeEnemy(index: number): Enemy {
    const def = getEnemyDef('waspDrone');
    return {
      active: false,
      index,
      id: 0,
      typeId: 'waspDrone',
      def,
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
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Spawning                                                                                     */
  /* ------------------------------------------------------------------------------------------ */

  spawn(
    typeId: EnemyTypeId,
    isElite: boolean,
    powerScale: number,
    arenaRadius: number,
    playerPos: THREE.Vector3,
  ): Enemy | null {
    const shellRadius = arenaRadius + ARENA.spawnMargin;

    // Reject-sample a shell direction until it clears the minimum player distance; player is
    // almost always well inside the shell, so this typically succeeds on the first try — the
    // attempt cap just guards the pathological case where the player hugs the boundary.
    let attempts = 0;
    do {
      randomOnSphere(scratchVec3A, this.randFn);
      scratchVec3A.multiplyScalar(shellRadius);
      attempts++;
    } while (scratchVec3A.distanceTo(playerPos) < ARENA.minSpawnDistanceFromPlayer && attempts < 8);

    // "Flying inward": face toward the arena centre at spawn. AI takes over next tick.
    scratchVec3B.copy(scratchVec3A).multiplyScalar(-1).normalize();

    return this.spawnAt(typeId, isElite, powerScale, scratchVec3A, scratchVec3B);
  }

  private spawnAt(
    typeId: EnemyTypeId,
    isElite: boolean,
    powerScale: number,
    position: THREE.Vector3,
    forwardHint: THREE.Vector3,
  ): Enemy | null {
    const enemy = this.enemyPool.acquire();
    if (!enemy) return null;

    const def = getEnemyDef(typeId);
    enemy.active = true;
    enemy.id = this.ids.issue();
    enemy.typeId = typeId;
    enemy.def = def;
    enemy.position.copy(position);

    const scaled = scratchStats;
    scaleEnemyStats(def, isElite ? powerScale * ELITE_POWER_MULT : powerScale, scaled);
    enemy.hull = scaled.hull;
    enemy.maxHull = scaled.hull;
    enemy.shield = scaled.shield;
    enemy.maxShield = scaled.shield;

    enemy.isElite = isElite;
    // Jittered initial cooldown desyncs enemies of the same archetype spawned in the same
    // pulse so they do not all open fire on the exact same frame.
    enemy.fireCooldown = def.fireInterval * (0.3 + this.rng.next() * 0.5);
    enemy.telegraph = 0;
    enemy.flash = 0;
    enemy.age = 0;
    enemy.aiState = 0;
    enemy.aiTimer = 0;
    enemy.seed = this.rng.next();

    if (forwardHint.lengthSq() > EPSILON) enemy.forward.copy(forwardHint).normalize();
    else enemy.forward.set(0, 0, -1);
    enemy.velocity.copy(enemy.forward).multiplyScalar(def.speed * 0.25);
    lookRotation(enemy.quaternion, enemy.forward, WORLD_UP);

    this.idToEnemy.set(enemy.id, enemy);
    this.events.emit('enemy:spawned', { id: enemy.id, typeId, isElite });
    return enemy;
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Update                                                                                       */
  /* ------------------------------------------------------------------------------------------ */

  update(dt: number, ctx: EnemyUpdateContext): void {
    this.lastCtx = ctx;

    this.grid.clear();
    const items = this.enemyPool.items;
    const n = this.enemyPool.size;
    for (let i = 0; i < n; i++) {
      const e = items[i]!;
      this.grid.insert(e.index, e.position.x, e.position.y, e.position.z);
    }

    this.aiCtx.playerPos = ctx.playerPos;
    this.aiCtx.playerVel = ctx.playerVel;
    this.aiCtx.playerAlive = ctx.playerAlive;
    this.aiCtx.arenaRadius = ctx.arenaRadius;
    this.aiCtx.elapsed = ctx.elapsed;

    for (let i = n - 1; i >= 0; i--) {
      const e = items[i]!;
      e.age += dt;

      const count = this.grid.query(e.position.x, e.position.y, e.position.z, NEIGHBOR_QUERY_RADIUS, this.neighborQueryBuffer);
      this.neighborView.bind(this.neighborQueryBuffer, count, this.bySlot);

      updateBrain(e, this.aiCtx, dt, this.intent);

      e.velocity.addScaledVector(this.intent.accel, dt);
      // Without this cap, summed steering forces (seek + separate + wander + contain) can
      // exceed `def.speed`, which breaks the readable speed hierarchy the counters in
      // DESIGN.md §10 depend on (e.g. "lead your shots" assumes the Interceptor tops out
      // at its stated speed).
      const speed = e.velocity.length();
      if (speed > e.def.speed) e.velocity.multiplyScalar(e.def.speed / speed);

      e.position.addScaledVector(e.velocity, dt);

      lookRotation(scratchQuatA, this.intent.facing, WORLD_UP);
      e.quaternion.rotateTowards(scratchQuatA, e.def.turnRate * dt);
      e.forward.copy(FORWARD).applyQuaternion(e.quaternion);

      // Mirrors ai.ts's own Lancer telegraph countdown (aiTimer during LANCER_STATE_TELEGRAPH
      // counts down from LANCER_TELEGRAPH_TIME to 0), so Enemy.telegraph reads exactly as
      // "seconds remaining" for the FX/HUD layer without ai.ts needing to know about it.
      e.telegraph = this.intent.wantsTelegraph ? Math.max(e.aiTimer, 0) : 0;

      if (e.fireCooldown > 0) e.fireCooldown -= dt;
      // The `!wantsTelegraph` guard is defensive: ai.ts never sets both flags true in the same
      // step, but firing must never happen mid-windup regardless.
      if (this.intent.wantsFire && !this.intent.wantsTelegraph && e.fireCooldown <= 0) {
        this.fireEnemyProjectile(e, this.intent);
        e.fireCooldown = e.def.fireInterval;
      }

      if (this.intent.wantsSpecial) this.handleSpecial(e);

      // Continuous, not event-driven like the spawns/mines above — a Warden buffs every live
      // ally within range every step it is alive, which is what makes "kill it first" a real
      // pressure rather than something a player can safely postpone.
      if (e.typeId === 'warden') this.applyWardenAura(e, dt);

      if (e.flash > 0) e.flash = Math.max(0, e.flash - dt / FEEL.hitFlashDecay);
    }

    this.syncRender();
  }

  private fireEnemyProjectile(enemy: Enemy, intent: AiIntent): void {
    const dir = scratchVec3B;
    dir.copy(intent.aimPoint).sub(enemy.position);
    if (dir.lengthSq() < EPSILON) dir.copy(enemy.forward);
    else dir.normalize();

    const isLancer = enemy.typeId === 'lancer';
    const p = this.spawnParams;
    p.kind = isLancer ? ProjectileKind.Beam : ProjectileKind.Linear;
    p.team = Team.Enemy;
    p.ownerId = enemy.id;
    p.x = enemy.position.x;
    p.y = enemy.position.y;
    p.z = enemy.position.z;
    p.dx = dir.x;
    p.dy = dir.y;
    p.dz = dir.z;
    p.speed = PROJECTILE_SPEED[enemy.typeId];
    p.damage = currentDamage(enemy);
    p.radius = PROJECTILE_RADIUS;
    p.life = isLancer ? 2.4 : 3.0;
    p.pierce = isLancer ? 6 : 0;
    p.fork = 0;
    p.homingRate = 0;
    p.targetId = -1;
    p.proximity = 0;
    p.aoe = 0;
    p.colorIndex = ENEMY_ORDER.indexOf(enemy.typeId);
    p.scale = enemy.isElite ? 1.3 : 1.0;
    p.sourceWeapon = 'enemy';
    this.projectiles.spawn(p);
  }

  /** Tops up shield on every live ally (never itself) within `WARDEN_AURA_RADIUS`, capped at
   * that ally's own `maxShield`. Zero allocation: `this.chainQueryBuffer` is the same
   * pre-allocated `Int32Array` `chainReactionBurst`/`pull` already use, safe to reuse here
   * because nothing else touches it mid-frame during `update()`'s own enemy loop. */
  private applyWardenAura(warden: Enemy, dt: number): void {
    const count = this.grid.query(
      warden.position.x,
      warden.position.y,
      warden.position.z,
      WARDEN_AURA_RADIUS,
      this.chainQueryBuffer,
    );
    const restore = WARDEN_AURA_REGEN * dt;
    for (let i = 0; i < count; i++) {
      const ally = this.bySlot[this.chainQueryBuffer[i]!];
      if (!ally || !ally.active || ally === warden || ally.maxShield <= 0) continue;
      if (ally.shield >= ally.maxShield) continue;
      ally.shield = Math.min(ally.maxShield, ally.shield + restore);
    }
  }

  private handleSpecial(enemy: Enemy): void {
    if (enemy.typeId === 'carrier') {
      randomOnSphere(scratchVec3B, this.randFn);
      scratchVec3C.copy(enemy.position).addScaledVector(scratchVec3B, enemy.def.radius + 5);
      const powerScale = enemy.maxHull / enemy.def.hull;
      this.spawnAt('waspDrone', false, powerScale, scratchVec3C, scratchVec3B);
    } else if (enemy.typeId === 'mineLayer') {
      const p = this.spawnParams;
      p.kind = ProjectileKind.Mine;
      p.team = Team.Enemy;
      p.ownerId = enemy.id;
      p.x = enemy.position.x;
      p.y = enemy.position.y;
      p.z = enemy.position.z;
      p.dx = 0;
      p.dy = 0;
      p.dz = 0;
      p.speed = 0;
      p.damage = currentDamage(enemy) * 1.6;
      p.radius = 2.4;
      p.life = 20;
      p.pierce = 0;
      p.fork = 0;
      p.homingRate = 0;
      p.targetId = -1;
      p.proximity = 14;
      p.aoe = 42;
      p.colorIndex = ENEMY_ORDER.indexOf(enemy.typeId);
      p.scale = enemy.isElite ? 1.3 : 1.0;
      p.sourceWeapon = 'enemy';
      this.projectiles.spawn(p);
    } else if (enemy.typeId === 'mortar') {
      // Placed at the *player's* current position, not the Mortar's own — this is an artillery
      // shell, not a dropped mine, and that distinction is the entire counter (ai.ts's
      // mortarBrain: "move during the telegraph and the shell lands on empty ground"). Reads
      // `this.aiCtx.playerPos` directly rather than threading a target through `AiIntent`
      // because it is already the same up-to-date reference `update()` refreshed this frame.
      const p = this.spawnParams;
      p.kind = ProjectileKind.Mine;
      p.team = Team.Enemy;
      p.ownerId = enemy.id;
      p.x = this.aiCtx.playerPos.x;
      p.y = this.aiCtx.playerPos.y;
      p.z = this.aiCtx.playerPos.z;
      p.dx = 0;
      p.dy = 0;
      p.dz = 0;
      p.speed = 0;
      p.damage = currentDamage(enemy) * 1.3;
      p.radius = 2.4;
      // Long past `fireInterval` on purpose: a dodged shell should still leave the ground it
      // landed on dangerous for a while, which is what turns "camp two favourite spots" into a
      // losing strategy over the course of a wave rather than just this one shot.
      p.life = 16;
      p.pierce = 0;
      p.fork = 0;
      p.homingRate = 0;
      p.targetId = -1;
      p.proximity = 9;
      p.aoe = 30;
      p.colorIndex = ENEMY_ORDER.indexOf(enemy.typeId);
      p.scale = enemy.isElite ? 1.3 : 1.0;
      p.sourceWeapon = 'enemy';
      this.projectiles.spawn(p);
    }
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Damage / death                                                                               */
  /* ------------------------------------------------------------------------------------------ */

  damage(enemyId: number, amount: number, crit: boolean, hx: number, hy: number, hz: number): number {
    const enemy = this.idToEnemy.get(enemyId);
    if (!enemy || !enemy.active || amount <= 0) return 0;
    return this.applyDamage(enemy, amount, crit, hx, hy, hz, 0);
  }

  private applyDamage(
    enemy: Enemy,
    amount: number,
    crit: boolean,
    hx: number,
    hy: number,
    hz: number,
    depth: number,
  ): number {
    let remaining = amount;
    if (enemy.shield > 0) {
      const absorbed = Math.min(enemy.shield, remaining);
      enemy.shield -= absorbed;
      remaining -= absorbed;
    }
    enemy.hull -= remaining;
    enemy.flash = 1;
    this.events.emit('enemy:damaged', { id: enemy.id, amount, crit, x: hx, y: hy, z: hz });

    if (enemy.hull <= 0) this.killEnemy(enemy, depth);
    return amount;
  }

  private killEnemy(enemy: Enemy, depth: number): void {
    const id = enemy.id;
    const typeId = enemy.typeId;
    const isElite = enemy.isElite;
    const x = enemy.position.x;
    const y = enemy.position.y;
    const z = enemy.position.z;
    const maxHull = enemy.maxHull;
    const ctx = this.lastCtx;

    // Release before the callbacks: `resetItem` only flips `active`, so `enemy`'s other fields
    // (def, position, etc.) stay readable for `onKill` even though the slot is now free.
    this.releaseEnemy(enemy);

    this.events.emit('enemy:died', { id, typeId, isElite, x, y, z });
    if (ctx) ctx.onKill(enemy);

    if (ctx && ctx.chainReaction > 0 && depth < CHAIN_REACTION_MAX_DEPTH) {
      const burst = maxHull * ctx.chainReaction;
      if (burst > 0) this.chainReactionBurst(x, y, z, burst, depth + 1);
    }
  }

  private chainReactionBurst(x: number, y: number, z: number, amount: number, depth: number): void {
    const count = this.grid.query(x, y, z, CHAIN_REACTION_RADIUS, this.chainQueryBuffer);
    for (let i = 0; i < count; i++) {
      const e = this.bySlot[this.chainQueryBuffer[i]!];
      if (!e || !e.active) continue;
      this.applyDamage(e, amount, false, e.position.x, e.position.y, e.position.z, depth);
    }
  }

  private releaseEnemy(enemy: Enemy): void {
    this.idToEnemy.delete(enemy.id);
    const items = this.enemyPool.items;
    const n = this.enemyPool.size;
    for (let i = 0; i < n; i++) {
      if (items[i] === enemy) {
        this.enemyPool.releaseAt(i);
        return;
      }
    }
  }

  /** Pull impulse for Singularity Coil / Gravity Well. Matches CombatContext.pullEnemies. */
  pull(x: number, y: number, z: number, radius: number, strength: number, dt: number): void {
    const count = this.grid.query(x, y, z, radius, this.chainQueryBuffer);
    const radiusSq = radius * radius;
    for (let i = 0; i < count; i++) {
      const e = this.bySlot[this.chainQueryBuffer[i]!];
      if (!e || !e.active) continue;
      const dx = x - e.position.x;
      const dy = y - e.position.y;
      const dz = z - e.position.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < EPSILON || distSq > radiusSq) continue;
      const dist = Math.sqrt(distSq);
      const falloff = 1 - dist / radius;
      const accel = (strength * falloff) / dist;
      e.velocity.x += dx * accel * dt;
      e.velocity.y += dy * accel * dt;
      e.velocity.z += dz * accel * dt;
    }
  }

  /* ------------------------------------------------------------------------------------------ */
  /* EnemyQuery                                                                                   */
  /* ------------------------------------------------------------------------------------------ */

  queryNear(x: number, y: number, z: number, radius: number, out: Int32Array): number {
    return this.grid.query(x, y, z, radius, out);
  }

  /**
   * Resolves a *permanent slot identity* (i.e. `Enemy.index`, the value the spatial grid stores
   * and hands back from `queryNear`) to its Enemy. This is the only correct way to turn a grid
   * query result back into an entity — callers that instead loop a raw ordinal `0..liveCount`
   * through here get garbage, because `bySlot[k]` is not "the k-th live enemy," it's "whichever
   * enemy currently occupies permanent slot k," and slot occupancy has nothing to do with how
   * many enemies happen to be alive right now. See `getLiveByOrdinal` for that other case.
   */
  getByIndex(i: number): Enemy | null {
    const e = this.bySlot[i];
    return e && e.active ? e : null;
  }

  /**
   * Resolves an *ordinal* in `[0, liveCount)` — "the i-th currently-live enemy, in no particular
   * order" — to its Enemy. Use this for "walk every live enemy" callers (the HUD radar / off-
   * screen-arrow feed is the one that needs it); use `getByIndex` for spatial-grid query results.
   *
   * This works because `Pool<Enemy>` keeps its live objects packed into the dense prefix
   * `items[0, size)` (see core/pool.ts) — unlike `bySlot`, that prefix is exactly "every enemy
   * that is currently alive," so an ordinal in `[0, liveCount)` is a real live enemy, not a
   * permanent-identity slot that happens to be empty right now.
   *
   * Mixing this up with `getByIndex` was the actual bug behind three separate playtester reports
   * that looked unrelated: enemies missing from the minimap, the Hostiles counter never quite
   * matching what was on screen, and enemies that felt "un-lockable." The HUD used to drive its
   * radar/arrow loop with `getByIndex(i)` for `i` in `[0, liveCount)` — i.e. by permanent slot
   * identity, not live rank. Once a wave has spawned and killed a few enemies, a slot's identity
   * has nothing to do with whether it's currently occupied, so most of `[0, liveCount)` resolved
   * to *dead* slots (silently skipped, `meta` came back null) while genuinely live enemies sitting
   * in higher-numbered permanent slots were never visited at all — dropped from the radar and the
   * off-screen arrows without ever showing up as "missing" in any obvious way. Target lock itself
   * was never affected (`targeting.ts` always resolves grid-query results through `getByIndex`,
   * which is the correct call for that data), but a target the player could never see on the
   * radar or an off-screen arrow reads as "un-lockable" even when `TAB`-cycling could still reach
   * it. The Hostiles counter (`WaveDirector.enemiesRemaining`) was already correct — it never used
   * this indexing at all — but a player who can't find the enemies it says are still out there
   * understandably reads the number itself as the thing that's wrong.
   */
  getLiveByOrdinal(i: number): Enemy | null {
    return i >= 0 && i < this.enemyPool.size ? this.enemyPool.items[i]! : null;
  }

  getById(id: number): Enemy | null {
    return this.idToEnemy.get(id) ?? null;
  }

  get liveCount(): number {
    return this.enemyPool.size;
  }

  get pool(): Pool<Enemy> {
    return this.enemyPool;
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Rendering                                                                                    */
  /* ------------------------------------------------------------------------------------------ */

  private syncRender(): void {
    for (let i = 0; i < TYPE_COUNT; i++) {
      this.normalCounts[i] = 0;
      this.eliteCounts[i] = 0;
    }
    let auraCount = 0;

    const items = this.enemyPool.items;
    const n = this.enemyPool.size;
    for (let i = 0; i < n; i++) {
      const e = items[i]!;
      const typeIdx = this.typeIndex[e.typeId]!;
      scratchMat4A.compose(e.position, e.quaternion, ONE_SCALE);

      if (e.isElite) {
        const slot = this.eliteCounts[typeIdx]!++;
        this.eliteMeshes[typeIdx]!.setMatrixAt(slot, scratchMat4A);
        this.eliteFlash[typeIdx]!.setX(slot, e.flash);

        scratchQuatA.setFromAxisAngle(WORLD_UP, e.age * AURA_SPIN_SPEED);
        scratchVec3D.set(e.def.radius * AURA_SCALE, e.def.radius * AURA_SCALE, e.def.radius * AURA_SCALE);
        scratchMat4B.compose(e.position, scratchQuatA, scratchVec3D);
        this.auraMesh.setMatrixAt(auraCount++, scratchMat4B);
      } else {
        const slot = this.normalCounts[typeIdx]!++;
        this.normalMeshes[typeIdx]!.setMatrixAt(slot, scratchMat4A);
        this.normalFlash[typeIdx]!.setX(slot, e.flash);
      }
    }

    for (let i = 0; i < TYPE_COUNT; i++) {
      const nm = this.normalMeshes[i]!;
      nm.count = this.normalCounts[i]!;
      nm.instanceMatrix.needsUpdate = true;
      this.normalFlash[i]!.needsUpdate = true;

      const em = this.eliteMeshes[i]!;
      em.count = this.eliteCounts[i]!;
      em.instanceMatrix.needsUpdate = true;
      this.eliteFlash[i]!.needsUpdate = true;
    }
    this.auraMesh.count = auraCount;
    this.auraMesh.instanceMatrix.needsUpdate = true;
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Lifecycle                                                                                    */
  /* ------------------------------------------------------------------------------------------ */

  clear(): void {
    this.idToEnemy.clear();
    this.enemyPool.releaseAll();
    this.syncRender();
  }

  reset(): void {
    this.clear();
    this.ids.reset();
    this.lastCtx = null;
  }

  dispose(): void {
    for (let i = 0; i < TYPE_COUNT; i++) {
      const nm = this.normalMeshes[i]!;
      this.scene.remove(nm);
      nm.geometry.dispose();

      const em = this.eliteMeshes[i]!;
      this.scene.remove(em);
      em.geometry.dispose();
    }
    // The aura geometry/material (and the base per-archetype materials patched above) are
    // cached singletons owned by enemies/types.ts's disposeSharedEnemyAssets — not ours to free.
    this.scene.remove(this.auraMesh);
  }
}

/** Reused across every `spawnAt` call; `scaleEnemyStats` writes into it and the values are
 * copied out immediately, so a single module-level instance is enough. */
const scratchStats = { hull: 0, shield: 0, damage: 0 };
