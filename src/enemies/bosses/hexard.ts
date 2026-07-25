/**
 * Hexard, the Splitting Fortress — the sector 1 boss.
 *
 * Teaching goals, in order: **read rotation**, then **prioritise targets**, then **use cover**.
 * Each phase isolates one of those so the player learns them separately before The Maw asks for
 * all three at once.
 *
 * Phase 1 fires radial rings with a *travelling* safe wedge. Reacting is hopeless; reading the
 * rotation and flying to where the gap will be is trivial. That gap is the whole lesson.
 *
 * Phase 2 splits the hull into three orbiting segments, each with its own fan. Killing a segment
 * permanently removes its pattern, so the fight gets easier exactly as fast as the player
 * focuses fire — the reward for prioritising is immediate and legible.
 *
 * Phase 3 exposes the core and charges an arena-wide sweep that cannot be out-run in the open,
 * which is what pushes the player behind the Debris Belt's asteroids.
 */

import * as THREE from 'three';
import { TAU } from '../../core/math';
import { palette } from '../../render/palette';
import {
  Boss,
  patternAimedBurst,
  patternFan,
  patternRing,
  patternSweep,
  phaseColor,
  type BossContext,
  type BossPhase,
} from './boss';

interface Segment {
  mesh: THREE.Mesh;
  alive: boolean;
  hull: number;
  angle: number;
  readonly offset: THREE.Vector3;
}

export class Hexard extends Boss {
  private ringAngle = 0;
  private gapAngle = 0;
  private sweepAngle = 0;
  private readonly segments: Segment[] = [];
  private core: THREE.Mesh | null = null;

  constructor() {
    super('hexard', 'HEXARD', 'The Splitting Fortress');
    this.radius = 26;
  }

  override get phases(): readonly BossPhase[] {
    return HEXARD_PHASES;
  }

  protected build(): void {
    const p = palette();

    const hullMat = new THREE.MeshStandardMaterial({
      color: p.enemyHull,
      metalness: 0.85,
      roughness: 0.35,
      emissive: new THREE.Color(p.enemyAccent).multiplyScalar(0.12),
    });

    // A hexagonal prism reads as "fortress" instantly and makes the six-fold ring patterns feel
    // like they come from the shape rather than from nowhere.
    const body = new THREE.Mesh(new THREE.CylinderGeometry(20, 20, 9, 6), hullMat);
    body.rotation.x = Math.PI / 2;
    this.root.add(body);

    const coreMat = new THREE.MeshStandardMaterial({
      color: 0x111318,
      emissive: new THREE.Color(p.bossPhase[0]!),
      emissiveIntensity: 2.2,
      metalness: 0.4,
      roughness: 0.5,
    });
    this.core = new THREE.Mesh(new THREE.IcosahedronGeometry(7, 1), coreMat);
    this.root.add(this.core);

    // Three armoured segments, hidden until phase 2 detaches them.
    const segMat = new THREE.MeshStandardMaterial({
      color: p.enemyHull,
      metalness: 0.8,
      roughness: 0.4,
      emissive: new THREE.Color(p.enemyAccent).multiplyScalar(0.2),
    });
    for (let i = 0; i < 3; i++) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(11, 5, 11), segMat.clone());
      mesh.visible = false;
      this.root.add(mesh);
      this.segments.push({
        mesh,
        alive: true,
        hull: 1,
        angle: (i / 3) * TAU,
        offset: new THREE.Vector3(),
      });
    }
  }

  protected override onPhaseEnter(index: number): void {
    const p = palette();
    if (this.core) {
      const mat = this.core.material as THREE.MeshStandardMaterial;
      mat.emissive.set(p.bossPhase[Math.min(index, p.bossPhase.length - 1)]!);
    }
    if (index >= 1) {
      for (const seg of this.segments) seg.mesh.visible = seg.alive;
    }
    if (index >= 2) {
      // The core exposes: segments fall away and stop contributing patterns.
      for (const seg of this.segments) {
        seg.alive = false;
        seg.mesh.visible = false;
      }
    }
  }

  protected move(ctx: BossContext, dt: number): void {
    const phase = this.phase;

    // Hexard holds the centre and rotates. It is a fortress, not a duellist — its threat comes
    // from area denial, so drifting slowly keeps it readable.
    this.position.x = Math.sin(this.age * 0.25) * 40;
    this.position.z = -ctx.arenaRadius * 0.35 + Math.cos(this.age * 0.2) * 30;
    this.position.y = Math.sin(this.age * 0.4) * 12;

    this.ringAngle += dt * 0.9 * phase.speed;
    this.gapAngle += dt * 1.35 * phase.speed;
    this.quaternion.setFromAxisAngle(UP, this.ringAngle * 0.5);

    // Orbiting segments.
    for (const seg of this.segments) {
      if (!seg.alive) continue;
      seg.angle += dt * 0.8 * phase.speed;
      seg.offset.set(Math.cos(seg.angle) * 34, Math.sin(seg.angle * 1.3) * 8, Math.sin(seg.angle) * 34);
      seg.mesh.position.copy(seg.offset);
      seg.mesh.rotation.y = seg.angle;
    }
  }

  /** World position of a live segment, for its own fire patterns. */
  private segmentWorld(seg: Segment, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.position).add(seg.offset);
  }

  /* Pattern entry points used by the phase tables ----------------------------------------- */

  fireRing(ctx: BossContext, damage: number): void {
    patternRing(ctx, this.position, 34, 52, damage, phaseColor(this.phase), this.ringAngle, this.gapAngle, 0.9);
  }

  fireSegmentFans(ctx: BossContext, damage: number): void {
    for (const seg of this.segments) {
      if (!seg.alive) continue;
      this.segmentWorld(seg, SEG_WORLD);
      patternFan(ctx, SEG_WORLD, ctx.playerPos, 5, 0.5, 62, damage, phaseColor(this.phase));
    }
  }

  fireAimed(ctx: BossContext, damage: number): void {
    patternAimedBurst(ctx, this.position, ctx.playerPos, ctx.playerVel, 3, 78, damage, phaseColor(this.phase));
  }

  fireSweep(ctx: BossContext, damage: number, dt: number): void {
    this.sweepAngle += dt * 1.6;
    patternSweep(ctx, this.position, this.sweepAngle, 240, 22, 46, damage, phaseColor(this.phase));
  }

  get liveSegments(): number {
    let n = 0;
    for (const seg of this.segments) if (seg.alive) n++;
    return n;
  }
}

const UP = /*#__PURE__*/ new THREE.Vector3(0, 1, 0);
const SEG_WORLD = /*#__PURE__*/ new THREE.Vector3();

/**
 * Phase tables. Recovery windows are generous in phase 1 and tighten as the fight goes on —
 * that ramp is what makes the boss feel like it is escalating without any stat changing.
 */
const HEXARD_PHASES: readonly BossPhase[] = [
  {
    startsBelow: 1,
    colorIndex: 0,
    speed: 1,
    moves: [
      {
        name: 'Rotating Ring',
        telegraph: 0.6,
        duration: 2.6,
        recovery: 1.4,
        lethal: false,
        fire: (boss, ctx, _t, dt) => {
          // Emit on a cadence rather than every step, so the ring reads as discrete shells.
          if (tick(boss, dt, 0.22)) (boss as Hexard).fireRing(ctx, 11);
        },
      },
      {
        name: 'Aimed Burst',
        telegraph: 0.5,
        duration: 1.2,
        recovery: 1.6,
        lethal: false,
        fire: (boss, ctx, _t, dt) => {
          if (tick(boss, dt, 0.3)) (boss as Hexard).fireAimed(ctx, 13);
        },
      },
    ],
  },
  {
    startsBelow: 0.66,
    colorIndex: 1,
    speed: 1.15,
    moves: [
      {
        name: 'Segment Fans',
        telegraph: 0.5,
        duration: 3.0,
        recovery: 1.2,
        lethal: false,
        fire: (boss, ctx, _t, dt) => {
          if (tick(boss, dt, 0.42)) (boss as Hexard).fireSegmentFans(ctx, 12);
        },
      },
      {
        name: 'Rotating Ring',
        telegraph: 0.45,
        duration: 2.4,
        recovery: 1.0,
        lethal: false,
        fire: (boss, ctx, _t, dt) => {
          if (tick(boss, dt, 0.2)) (boss as Hexard).fireRing(ctx, 12);
        },
      },
    ],
  },
  {
    startsBelow: 0.33,
    colorIndex: 2,
    speed: 1.3,
    moves: [
      {
        name: 'Core Sweep',
        // The long red wind-up is the cue to get behind an asteroid. It is deliberately
        // impossible to simply out-fly in the open.
        telegraph: 1.4,
        duration: 3.4,
        recovery: 1.8,
        lethal: true,
        fire: (boss, ctx, _t, dt) => {
          if (tick(boss, dt, 0.1)) (boss as Hexard).fireSweep(ctx, 15, dt);
        },
      },
      {
        name: 'Desperation Ring',
        telegraph: 0.4,
        duration: 2.0,
        recovery: 0.9,
        lethal: false,
        fire: (boss, ctx, _t, dt) => {
          if (tick(boss, dt, 0.16)) (boss as Hexard).fireRing(ctx, 14);
        },
      },
    ],
  },
];

/**
 * Cadence helper: returns true once every `interval` seconds of firing time.
 *
 * Stored on the boss instance rather than in a closure so the phase tables stay static data
 * and allocate nothing per frame.
 */
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
