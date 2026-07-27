/**
 * Boss framework: phases, HP gates, and the named bullet-pattern library.
 *
 * The central research finding driving this file (DESIGN.md §2): *100 bullets in one legible
 * pattern are easier to dodge than 30 independent ones.* People are excellent pattern
 * recognisers and poor at reacting to uncorrelated chaos. So bosses never aim shot-by-shot at
 * high volume. Every volley is emitted by a **named pattern** — ring, fan, spiral, wall,
 * aimed-burst, sweep — whose shape the player can read and learn.
 *
 * The second finding: telegraphs must be visible *and* audible, and each phase must feel
 * distinct. Phases here are HP-gated, each with its own move list and palette index, and every
 * heavy attack passes through `telegraph()` before it fires.
 */

import * as THREE from 'three';
import { ProjectileKind, Team, type BossId, type EventBus } from '../../core/types';
import { TAU, WORLD_UP, clamp01, scratchVec3A, scratchVec3B, scratchVec3C, scratchVec3D } from '../../core/math';
import { palette } from '../../render/palette';
import type { ProjectileSystem } from '../../combat/projectiles';

/** Shared, preallocated spawn record — bosses emit hundreds of shots per volley. */
const spawn = {
  kind: ProjectileKind.Linear as ProjectileKind,
  team: Team.Enemy as Team,
  ownerId: -1,
  x: 0, y: 0, z: 0,
  dx: 0, dy: 0, dz: 0,
  speed: 60,
  damage: 10,
  radius: 1.6,
  life: 8,
  pierce: 0,
  fork: 0,
  homingRate: 0,
  targetId: -1,
  proximity: 0,
  aoe: 0,
  colorIndex: 0,
  scale: 1,
  sourceWeapon: 'boss' as const,
};

export interface BossContext {
  projectiles: ProjectileSystem;
  events: EventBus;
  playerPos: THREE.Vector3;
  playerVel: THREE.Vector3;
  playerAlive: boolean;
  arenaRadius: number;
  elapsed: number;
  /** Called when the boss lands damage-worthy contact, so the wiring layer can react. */
  onTelegraph: (x: number, y: number, z: number, radius: number, seconds: number, lethal: boolean) => void;
}

/** One scripted beat in a phase. Bosses cycle through their phase's move list. */
export interface BossMove {
  readonly name: string;
  /** Seconds of wind-up before the move fires. 0 for instant moves. */
  readonly telegraph: number;
  /** Seconds the move occupies once it starts firing. */
  readonly duration: number;
  /** Seconds of recovery afterwards — the window the player uses to attack. */
  readonly recovery: number;
  /** True if standing still through this is lethal, which selects the red telegraph. */
  readonly lethal: boolean;
  /** Called every step while the move is firing. `t` is 0..1 progress. */
  readonly fire: (boss: Boss, ctx: BossContext, t: number, dt: number) => void;
}

export interface BossPhase {
  /** Hull fraction at or below which this phase becomes active. */
  readonly startsBelow: number;
  readonly moves: readonly BossMove[];
  /** Index into palette().bossPhase, so each phase reads as a distinct colour. */
  readonly colorIndex: number;
  /** Movement speed multiplier for this phase. */
  readonly speed: number;
}

const MoveState = {
  Telegraph: 0,
  Firing: 1,
  Recovery: 2,
} as const;
type MoveState = (typeof MoveState)[keyof typeof MoveState];

/**
 * Base boss. Subclasses supply phases and override `move()` for locomotion; the scheduler,
 * phase gating, and damage handling live here so all three bosses behave consistently.
 */
export abstract class Boss {
  readonly id: BossId;
  readonly displayName: string;
  readonly subtitle: string;

  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();

  hull = 1000;
  maxHull = 1000;
  radius = 22;
  /** 0..1 emissive hit-flash. */
  flash = 0;
  alive = true;
  age = 0;

  protected phaseIndex = 0;
  protected moveIndex = 0;
  protected moveState: MoveState = MoveState.Telegraph;
  protected moveTimer = 0;
  /** True while the boss is invulnerable during a phase transition. */
  protected transitioning = false;
  protected transitionTimer = 0;

  protected readonly root = new THREE.Group();
  /** Last known player position, cached each `update()` so subclasses (Hexard's nearest-add
   * lock point) can reason about the player without threading a fresh vector through getters. */
  protected readonly playerPosCache = new THREE.Vector3();

  constructor(id: BossId, displayName: string, subtitle: string) {
    this.id = id;
    this.displayName = displayName;
    this.subtitle = subtitle;
  }

  abstract get phases(): readonly BossPhase[];
  /** Builds the boss mesh. Called once on spawn. */
  protected abstract build(): void;
  /** Locomotion for this phase. */
  protected abstract move(ctx: BossContext, dt: number): void;

  get phase(): BossPhase {
    return this.phases[Math.min(this.phaseIndex, this.phases.length - 1)]!;
  }

  get phaseCount(): number {
    return this.phases.length;
  }

  get currentPhaseIndex(): number {
    return this.phaseIndex;
  }

  get object(): THREE.Object3D {
    return this.root;
  }

  get hullFraction(): number {
    return this.maxHull > 0 ? clamp01(this.hull / this.maxHull) : 0;
  }

  /**
   * World point the targeting/HUD layer should lock onto (playtester feedback #5: bosses were
   * entirely invisible to lock-on, which made the mobile Vashkan very hard to track with
   * keyboard aiming). Defaults to the collision centre; a boss with a rotating single weak
   * point (Maw Core's lit plate, Hexard's live add) overrides this so the reticle and aim
   * assist track the thing that actually takes full damage rather than the whole hurtbox.
   */
  get lockPoint(): THREE.Vector3 {
    return this.position;
  }

  /**
   * Radius paired with `lockPoint` for the lock cone / "already close" aim-assist test. Kept
   * separate from `radius` (the collision hitbox) because a weak-point lock should read as a
   * tighter, more deliberate reticle than "anywhere on this 30-unit hull".
   */
  get lockRadius(): number {
    return this.radius;
  }

  /**
   * True while the boss cannot be damaged (spawn intro, phase-transition grace window). Locking
   * onto something the player cannot currently hurt would read as a broken lock, so the
   * boss-to-`EnemyQuery` adapter in `enemies/bosses/index.ts` withholds the boss entirely while
   * this is true.
   */
  get invulnerable(): boolean {
    return this.transitioning;
  }

  /** Places the boss in the scene and starts phase 0. */
  spawn(scene: THREE.Scene, hullPoints: number, arenaRadius: number): void {
    this.maxHull = hullPoints;
    this.hull = hullPoints;
    this.alive = true;
    this.age = 0;
    this.phaseIndex = 0;
    this.moveIndex = 0;
    this.moveState = MoveState.Telegraph;
    this.moveTimer = 0;
    this.transitioning = false;

    this.position.set(0, 0, -arenaRadius * 0.45);
    this.velocity.set(0, 0, 0);
    this.quaternion.identity();

    this.build();
    this.root.position.copy(this.position);
    scene.add(this.root);
  }

  update(ctx: BossContext, dt: number): void {
    if (!this.alive) return;
    this.age += dt;
    this.playerPosCache.copy(ctx.playerPos);
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 12);

    if (this.transitioning) {
      this.transitionTimer -= dt;
      if (this.transitionTimer <= 0) this.transitioning = false;
      this.move(ctx, dt);
      this.syncTransform();
      return;
    }

    this.move(ctx, dt);
    this.advanceMove(ctx, dt);
    this.syncTransform();
  }

  private syncTransform(): void {
    this.root.position.copy(this.position);
    this.root.quaternion.copy(this.quaternion);
  }

  /**
   * The scheduler. Telegraph → fire → recover, then advance to the next move in the phase.
   * Keeping recovery explicit is what gives the player a guaranteed window to deal damage,
   * rather than a boss that fires continuously and can only be out-sustained.
   */
  private advanceMove(ctx: BossContext, dt: number): void {
    const moves = this.phase.moves;
    if (moves.length === 0) return;
    const move = moves[this.moveIndex % moves.length]!;

    this.moveTimer += dt;

    switch (this.moveState) {
      case MoveState.Telegraph: {
        if (this.moveTimer === dt && move.telegraph > 0) {
          // Fire the tell once, at the start of the wind-up.
          ctx.onTelegraph(this.position.x, this.position.y, this.position.z, this.radius * 2.4, move.telegraph, move.lethal);
        }
        if (this.moveTimer >= move.telegraph) {
          this.moveState = MoveState.Firing;
          this.moveTimer = 0;
        }
        break;
      }
      case MoveState.Firing: {
        const t = move.duration > 0 ? clamp01(this.moveTimer / move.duration) : 1;
        move.fire(this, ctx, t, dt);
        if (this.moveTimer >= move.duration) {
          this.moveState = MoveState.Recovery;
          this.moveTimer = 0;
        }
        break;
      }
      case MoveState.Recovery: {
        if (this.moveTimer >= move.recovery) {
          this.moveState = MoveState.Telegraph;
          this.moveTimer = 0;
          this.moveIndex = (this.moveIndex + 1) % moves.length;
        }
        break;
      }
    }
  }

  /** Applies damage. Returns true if this hit killed the boss. */
  damage(amount: number, ctx: BossContext): boolean {
    if (!this.alive || this.transitioning) return false;
    this.hull -= amount;
    this.flash = 1;

    const fraction = this.hullFraction;
    const next = this.phaseIndex + 1;
    if (next < this.phases.length && fraction <= this.phases[next]!.startsBelow) {
      this.enterPhase(next, ctx);
    }

    if (this.hull <= 0) {
      this.hull = 0;
      this.alive = false;
      ctx.events.emit('boss:died', { id: this.id });
      return true;
    }
    return false;
  }

  protected enterPhase(index: number, ctx: BossContext): void {
    this.phaseIndex = index;
    this.moveIndex = 0;
    this.moveState = MoveState.Telegraph;
    this.moveTimer = 0;
    this.transitioning = true;
    this.transitionTimer = 1.2;
    this.onPhaseEnter(index);
    ctx.events.emit('boss:phaseChanged', { id: this.id, phase: index });
  }

  /** Hook for subclasses to restructure themselves between phases. */
  protected onPhaseEnter(_index: number): void {}

  dispose(): void {
    this.root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) for (const m of mat) m.dispose();
      else if (mat) mat.dispose();
    });
    this.root.clear();
    this.root.removeFromParent();
  }
}

/* ------------------------------------------------------------------------------------------- */
/* The named pattern library                                                                     */
/*                                                                                               */
/* Every one of these emits a shape the player can name after seeing it once. That is the whole  */
/* design intent — legible chaos rather than noise.                                              */
/* ------------------------------------------------------------------------------------------- */

/** Shortest absolute angular distance between two angles, wrapped to [0, PI]. */
function angularDistance(a: number, b: number): number {
  let d = (a - b) % TAU;
  if (d < 0) d += TAU;
  return d > Math.PI ? TAU - d : d;
}

function baseSpawn(ctx: BossContext, x: number, y: number, z: number, damage: number, speed: number, colorIndex: number): void {
  spawn.kind = ProjectileKind.Linear;
  spawn.team = Team.Enemy;
  spawn.ownerId = -1;
  spawn.x = x;
  spawn.y = y;
  spawn.z = z;
  spawn.speed = speed;
  spawn.damage = damage;
  spawn.radius = 1.8;
  spawn.life = 9;
  spawn.pierce = 0;
  spawn.fork = 0;
  spawn.homingRate = 0;
  spawn.targetId = -1;
  spawn.proximity = 0;
  spawn.aoe = 0;
  spawn.colorIndex = colorIndex;
  spawn.scale = 1.1;
  ctx.projectiles.spawn(spawn);
}

/**
 * Builds an orthonormal basis (`outA`, `outB`) spanning the plane perpendicular to `axis`, with
 * `axis === WORLD_UP` reproducing the historical X/Z basis exactly (`outA` = +X, `outB` = +Z) so
 * every pre-existing horizontal-ring call site is bit-for-bit unaffected by this function
 * existing. Non-default axes are what let a boss rotate its firing plane between volleys
 * (playtester feedback #6: sector 1 and 3 bosses "only shoot along one plane").
 */
function ringBasis(axis: THREE.Vector3, outA: THREE.Vector3, outB: THREE.Vector3): void {
  if (axis.x === 0 && axis.y === 1 && axis.z === 0) {
    outA.set(1, 0, 0);
    outB.set(0, 0, 1);
    return;
  }
  // Any reference not parallel to axis; Z unless axis is already nearly axial to Z.
  outA.set(0, 0, 1);
  if (Math.abs(axis.z) > 0.95) outA.set(1, 0, 0);
  outA.crossVectors(outA, axis).normalize();
  outB.crossVectors(axis, outA).normalize();
}

/**
 * A full ring in the plane perpendicular to `axis` (world-up by default, i.e. the historical
 * horizontal ring), optionally with a missing wedge the player can fly through. The travelling
 * safe wedge is Hexard's core teaching tool: it forces the player to read rotation rather than
 * react. Passing a non-default `axis` tilts the whole ring — used to break bosses out of firing
 * in a single plane without changing the gap-reading mechanic itself.
 */
export function patternRing(
  ctx: BossContext,
  origin: THREE.Vector3,
  count: number,
  speed: number,
  damage: number,
  colorIndex: number,
  phaseOffset = 0,
  gapCenter = Infinity,
  gapWidth = 0,
  axis: THREE.Vector3 = WORLD_UP,
): void {
  ringBasis(axis, scratchVec3C, scratchVec3D);
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * TAU + phaseOffset;
    if (gapWidth > 0 && Number.isFinite(gapCenter) && angularDistance(angle, gapCenter) < gapWidth * 0.5) {
      continue;
    }
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    spawn.dx = scratchVec3C.x * cos + scratchVec3D.x * sin;
    spawn.dy = scratchVec3C.y * cos + scratchVec3D.y * sin;
    spawn.dz = scratchVec3C.z * cos + scratchVec3D.z * sin;
    baseSpawn(ctx, origin.x, origin.y, origin.z, damage, speed, colorIndex);
  }
}

/** A ring tilted into 3D by spreading shots over a sphere band — used when the fight goes vertical. */
export function patternSphere(
  ctx: BossContext,
  origin: THREE.Vector3,
  count: number,
  speed: number,
  damage: number,
  colorIndex: number,
  phaseOffset = 0,
): void {
  // Fibonacci sphere: even coverage without clustering at the poles, which keeps the wall of
  // bullets uniform enough to read as a single expanding shell.
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / Math.max(1, count - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i + phaseOffset;
    spawn.dx = Math.cos(theta) * r;
    spawn.dy = y;
    spawn.dz = Math.sin(theta) * r;
    baseSpawn(ctx, origin.x, origin.y, origin.z, damage, speed, colorIndex);
  }
}

/**
 * A cone of shots aimed at the player — the readable "this one is for you" volley. `axisHint`
 * picks which way the cone opens: world-up (default) spreads it left/right, a roughly-horizontal
 * hint (e.g. the boss's own strafe axis) spreads it up/down instead. Alternating the hint across
 * volleys is what stops a fan-heavy boss from reading as "everything happens in one plane"
 * (playtester feedback #6).
 */
export function patternFan(
  ctx: BossContext,
  origin: THREE.Vector3,
  target: THREE.Vector3,
  count: number,
  spreadRadians: number,
  speed: number,
  damage: number,
  colorIndex: number,
  axisHint: THREE.Vector3 = WORLD_UP,
): void {
  scratchVec3A.copy(target).sub(origin).normalize();
  // Build a perpendicular basis so the fan opens across the player's view, not into it.
  scratchVec3B.copy(axisHint).cross(scratchVec3A).normalize();

  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : (i / (count - 1)) * 2 - 1;
    const angle = t * spreadRadians * 0.5;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    spawn.dx = scratchVec3A.x * cos + scratchVec3B.x * sin;
    spawn.dy = scratchVec3A.y * cos + scratchVec3B.y * sin;
    spawn.dz = scratchVec3A.z * cos + scratchVec3B.z * sin;
    baseSpawn(ctx, origin.x, origin.y, origin.z, damage, speed, colorIndex);
  }
}

/** A continuously rotating arm. Reads as a spiral because each shot lags the last. */
export function patternSpiral(
  ctx: BossContext,
  origin: THREE.Vector3,
  arms: number,
  angle: number,
  speed: number,
  damage: number,
  colorIndex: number,
): void {
  for (let a = 0; a < arms; a++) {
    const theta = angle + (a / arms) * TAU;
    spawn.dx = Math.cos(theta);
    spawn.dy = Math.sin(theta * 0.5) * 0.25;
    spawn.dz = Math.sin(theta);
    baseSpawn(ctx, origin.x, origin.y, origin.z, damage, speed, colorIndex);
  }
}

/** A moving wall with a single gap — the "find the door" pattern. */
export function patternWall(
  ctx: BossContext,
  origin: THREE.Vector3,
  target: THREE.Vector3,
  count: number,
  width: number,
  gapIndex: number,
  speed: number,
  damage: number,
  colorIndex: number,
): void {
  scratchVec3A.copy(target).sub(origin).normalize();
  scratchVec3B.set(0, 1, 0).cross(scratchVec3A).normalize();

  for (let i = 0; i < count; i++) {
    if (i === gapIndex || i === gapIndex + 1) continue;
    const offset = (i / Math.max(1, count - 1) - 0.5) * width;
    spawn.dx = scratchVec3A.x;
    spawn.dy = scratchVec3A.y;
    spawn.dz = scratchVec3A.z;
    baseSpawn(
      ctx,
      origin.x + scratchVec3B.x * offset,
      origin.y + scratchVec3B.y * offset,
      origin.z + scratchVec3B.z * offset,
      damage,
      speed,
      colorIndex,
    );
  }
}

/** A tight, fast burst led onto the player's predicted position. Punishes flying in a straight line. */
export function patternAimedBurst(
  ctx: BossContext,
  origin: THREE.Vector3,
  target: THREE.Vector3,
  targetVel: THREE.Vector3,
  count: number,
  speed: number,
  damage: number,
  colorIndex: number,
): void {
  // First-order lead. Deliberately imperfect so a player who keeps moving can still evade.
  const dist = origin.distanceTo(target);
  const flight = dist / Math.max(1, speed);
  scratchVec3A
    .copy(target)
    .addScaledVector(targetVel, flight * 0.8)
    .sub(origin)
    .normalize();

  for (let i = 0; i < count; i++) {
    const jitter = (i - (count - 1) / 2) * 0.045;
    scratchVec3B.set(0, 1, 0).cross(scratchVec3A).normalize().multiplyScalar(jitter);
    spawn.dx = scratchVec3A.x + scratchVec3B.x;
    spawn.dy = scratchVec3A.y + scratchVec3B.y;
    spawn.dz = scratchVec3A.z + scratchVec3B.z;
    baseSpawn(ctx, origin.x, origin.y, origin.z, damage, speed * 1.35, colorIndex);
  }
}

/** A sweeping line that rotates across the arena. The player runs ahead of it or ducks behind. */
export function patternSweep(
  ctx: BossContext,
  origin: THREE.Vector3,
  angle: number,
  length: number,
  count: number,
  speed: number,
  damage: number,
  colorIndex: number,
): void {
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);
  for (let i = 0; i < count; i++) {
    const along = (i / Math.max(1, count - 1)) * length;
    spawn.dx = dx;
    spawn.dy = 0;
    spawn.dz = dz;
    baseSpawn(ctx, origin.x + dx * along, origin.y, origin.z + dz * along, damage, speed, colorIndex);
  }
}

/** Convenience: the current phase's projectile colour index into the enemy palette. */
export function phaseColor(phase: BossPhase): number {
  const list = palette().enemyProjectile;
  return phase.colorIndex % list.length;
}
