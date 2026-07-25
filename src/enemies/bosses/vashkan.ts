/**
 * Vashkan Prime, the Lance Sovereign — the sector 2 boss.
 *
 * Where Hexard is area denial, Vashkan is a **duel**. It flies the way the player does: it
 * leads its shots, it holds an engagement range, and it breaks off when it loses the angle.
 * The lesson it teaches is drift — it will out-turn a player who only flies forward, and the
 * only reliable way to keep guns on it is to decouple heading from velocity.
 *
 * Phase 2 adds four beam pylons sweeping a rotating cross, converting a pure dogfight into
 * dodge-while-shooting. Phase 3 is the dash strike: a red vector line appears 0.9 s before it
 * fires along that exact line, which is fair, readable, and lethal to anyone standing still.
 */

import * as THREE from 'three';
import { clamp, dampVec3, lerp } from '../../core/math';
import { palette } from '../../render/palette';
import { lookRotation } from '../../ship/flight';
import {
  Boss,
  patternAimedBurst,
  patternFan,
  patternSweep,
  phaseColor,
  type BossContext,
  type BossPhase,
} from './boss';

const UP = /*#__PURE__*/ new THREE.Vector3(0, 1, 0);
const desired = /*#__PURE__*/ new THREE.Vector3();
const toPlayer = /*#__PURE__*/ new THREE.Vector3();
const lateral = /*#__PURE__*/ new THREE.Vector3();

export class Vashkan extends Boss {
  private pylonAngle = 0;
  private readonly pylons: THREE.Mesh[] = [];
  private dashDir = new THREE.Vector3(0, 0, -1);
  private dashTimer = 0;
  /** Flips periodically so it strafes both ways instead of orbiting predictably. */
  private strafeSign = 1;
  private strafeTimer = 0;

  constructor() {
    super('vashkan', 'VASHKAN PRIME', 'The Lance Sovereign');
    this.radius = 14;
  }

  override get phases(): readonly BossPhase[] {
    return VASHKAN_PHASES;
  }

  protected build(): void {
    const p = palette();
    const hullMat = new THREE.MeshStandardMaterial({
      color: p.enemyHull,
      metalness: 0.9,
      roughness: 0.28,
      emissive: new THREE.Color(p.enemyAccent).multiplyScalar(0.18),
    });

    // A long, forward-swept dart — it should read as a fighter, not a station, so the player
    // immediately understands this one will chase them.
    const body = new THREE.Mesh(new THREE.ConeGeometry(4.5, 26, 6), hullMat);
    body.rotation.x = -Math.PI / 2;
    this.root.add(body);

    const wing = new THREE.Mesh(new THREE.BoxGeometry(30, 0.9, 7), hullMat);
    wing.position.z = 3;
    this.root.add(wing);

    const engineMat = new THREE.MeshBasicMaterial({
      color: p.enemyEngine,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    const engine = new THREE.Mesh(new THREE.SphereGeometry(2.6, 12, 8), engineMat);
    engine.position.z = 12;
    this.root.add(engine);

    // Pylons stay hidden until phase 2.
    const pylonMat = new THREE.MeshStandardMaterial({
      color: 0x14161d,
      emissive: new THREE.Color(p.telegraphLethal),
      emissiveIntensity: 1.6,
      metalness: 0.6,
      roughness: 0.4,
    });
    for (let i = 0; i < 4; i++) {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 16, 6), pylonMat.clone());
      mesh.visible = false;
      this.root.add(mesh);
      this.pylons.push(mesh);
    }
  }

  protected override onPhaseEnter(index: number): void {
    for (const pylon of this.pylons) pylon.visible = index >= 1;
  }

  protected move(ctx: BossContext, dt: number): void {
    const phase = this.phase;

    if (this.dashTimer > 0) {
      // Committed dash: it flies the telegraphed line and cannot course-correct, which is what
      // makes dodging it a genuine read rather than a coin flip.
      this.dashTimer -= dt;
      this.position.addScaledVector(this.dashDir, 230 * dt);
    } else {
      toPlayer.copy(ctx.playerPos).sub(this.position);
      const dist = toPlayer.length();
      if (dist > 0.001) toPlayer.multiplyScalar(1 / dist);

      this.strafeTimer -= dt;
      if (this.strafeTimer <= 0) {
        this.strafeTimer = 2.4;
        this.strafeSign *= -1;
      }

      // Hold an engagement band: close if far, back off if the player is inside its guard.
      const engage = 110;
      const closing = clamp((dist - engage) / engage, -1, 1);
      lateral.copy(UP).cross(toPlayer).normalize().multiplyScalar(this.strafeSign);

      desired
        .copy(toPlayer)
        .multiplyScalar(closing * 150 * phase.speed)
        .addScaledVector(lateral, 95 * phase.speed);

      dampVec3(this.velocity, desired, 0.02, dt);
      this.position.addScaledVector(this.velocity, dt);
    }

    // Keep it inside the arena; a duellist that flees out of bounds is just frustrating.
    const r = this.position.length();
    const limit = ctx.arenaRadius * 0.88;
    if (r > limit) this.position.multiplyScalar(limit / r);

    // Face the player, so its nose telegraphs where it will shoot.
    toPlayer.copy(ctx.playerPos).sub(this.position);
    if (toPlayer.lengthSq() > 0.001) lookRotation(this.quaternion, toPlayer.normalize(), UP);

    // Pylons rotate as a rigid cross around it.
    this.pylonAngle += dt * 0.85 * phase.speed;
    for (let i = 0; i < this.pylons.length; i++) {
      const a = this.pylonAngle + (i / this.pylons.length) * Math.PI * 2;
      const pylon = this.pylons[i]!;
      pylon.position.set(Math.cos(a) * 30, Math.sin(a * 1.7) * 6, Math.sin(a) * 30);
      pylon.rotation.z = a;
    }
  }

  /* Patterns ------------------------------------------------------------------------------- */

  fireLead(ctx: BossContext, damage: number): void {
    patternAimedBurst(ctx, this.position, ctx.playerPos, ctx.playerVel, 3, 96, damage, phaseColor(this.phase));
  }

  fireFan(ctx: BossContext, damage: number): void {
    patternFan(ctx, this.position, ctx.playerPos, 7, 0.7, 70, damage, phaseColor(this.phase));
  }

  firePylons(ctx: BossContext, damage: number): void {
    for (let i = 0; i < this.pylons.length; i++) {
      const pylon = this.pylons[i]!;
      PYLON_WORLD.copy(pylon.position).add(this.position);
      const angle = this.pylonAngle + (i / this.pylons.length) * Math.PI * 2;
      patternSweep(ctx, PYLON_WORLD, angle, 120, 12, 58, damage, phaseColor(this.phase));
    }
  }

  /** Locks the dash line in. Called at the end of the telegraph so the line stays honest. */
  beginDash(ctx: BossContext): void {
    this.dashDir.copy(ctx.playerPos).sub(this.position).normalize();
    this.dashTimer = 0.75;
    ctx.onTelegraph(ctx.playerPos.x, ctx.playerPos.y, ctx.playerPos.z, 26, 0.2, true);
  }

  /** 0..1 dash charge, so the wiring layer can draw the red vector line. */
  get dashCharge(): number {
    return this.dashTimer > 0 ? 1 : 0;
  }

  get dashDirection(): THREE.Vector3 {
    return this.dashDir;
  }
}

const PYLON_WORLD = /*#__PURE__*/ new THREE.Vector3();

const tickState = new WeakMap<object, number>();
function tick(boss: object, dt: number, interval: number): boolean {
  const acc = (tickState.get(boss) ?? 0) + dt;
  if (acc >= interval) {
    tickState.set(boss, 0);
    return true;
  }
  tickState.set(boss, acc);
  return false;
}

const VASHKAN_PHASES: readonly BossPhase[] = [
  {
    startsBelow: 1,
    colorIndex: 0,
    speed: 1,
    moves: [
      {
        name: 'Duel',
        telegraph: 0.35,
        duration: 2.4,
        recovery: 1.3,
        lethal: false,
        fire: (boss, ctx, _t, dt) => {
          if (tick(boss, dt, 0.36)) (boss as Vashkan).fireLead(ctx, 12);
        },
      },
      {
        name: 'Scatter Fan',
        telegraph: 0.5,
        duration: 1.4,
        recovery: 1.5,
        lethal: false,
        fire: (boss, ctx, _t, dt) => {
          if (tick(boss, dt, 0.55)) (boss as Vashkan).fireFan(ctx, 11);
        },
      },
    ],
  },
  {
    startsBelow: 0.66,
    colorIndex: 1,
    speed: 1.2,
    moves: [
      {
        name: 'Pylon Cross',
        telegraph: 0.8,
        duration: 3.2,
        recovery: 1.2,
        lethal: false,
        fire: (boss, ctx, _t, dt) => {
          if (tick(boss, dt, 0.28)) (boss as Vashkan).firePylons(ctx, 12);
        },
      },
      {
        name: 'Duel',
        telegraph: 0.3,
        duration: 2.0,
        recovery: 1.0,
        lethal: false,
        fire: (boss, ctx, _t, dt) => {
          if (tick(boss, dt, 0.3)) (boss as Vashkan).fireLead(ctx, 13);
        },
      },
    ],
  },
  {
    startsBelow: 0.33,
    colorIndex: 2,
    speed: 1.45,
    moves: [
      {
        name: 'Dash Strike',
        // 0.9 s of red vector line, exactly as specified in DESIGN §11.2. Long enough to read,
        // short enough to demand a decision.
        telegraph: 0.9,
        duration: 0.8,
        recovery: 1.1,
        lethal: true,
        fire: (boss, ctx, t) => {
          if (t < 0.05) (boss as Vashkan).beginDash(ctx);
        },
      },
      {
        name: 'Pylon Cross',
        telegraph: 0.6,
        duration: 2.6,
        recovery: 0.9,
        lethal: false,
        fire: (boss, ctx, _t, dt) => {
          if (tick(boss, dt, 0.22)) (boss as Vashkan).firePylons(ctx, 14);
        },
      },
      {
        name: 'Desperation Fan',
        telegraph: 0.35,
        duration: 1.6,
        recovery: 0.8,
        lethal: false,
        fire: (boss, ctx, _t, dt) => {
          if (tick(boss, dt, 0.3)) (boss as Vashkan).fireFan(ctx, lerp(12, 16, 0.5));
        },
      },
    ],
  },
];
