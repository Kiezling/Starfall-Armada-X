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
 * Phase 2 splits the hull into three orbiting segments, each with its own fan and its own hit
 * points (see `findSegmentHit`/`damageSegment`, called from `index.ts` before the core sphere
 * test — segments orbit outside the core's own `radius`, so without a dedicated test a shot that
 * visibly connects with one would silently do nothing). Killing a segment removes its pattern
 * permanently, and while any segment is alive the core itself takes only 12% damage (see
 * `damage()`): playtester feedback #19 wanted the adds to matter, and a full-immunity gate reads
 * as "my hits are being ignored" (the standard failure mode of this pattern), so this is heavy
 * resistance rather than immunity — every hit still counts, focusing the adds is just far faster.
 * The state is legible on three independent channels so it never depends on colour alone: the
 * hull visibly darkens, a wireframe shield shell shimmers around the core, and `coreResistant`
 * exposes the same boolean for the HUD.
 *
 * Phase 3 exposes the core and charges an arena-wide sweep that cannot be out-run in the open,
 * which is what pushes the player behind the Debris Belt's asteroids.
 */

import * as THREE from 'three';
import { TAU, sweptSphereHit } from '../../core/math';
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
  maxHull: number;
  angle: number;
  readonly offset: THREE.Vector3;
}

/**
 * Playtester feedback #6: sector 1/3 bosses were "incredibly easy to hit" from a fixed spot but
 * also too small to feel like a real boss. 26 -> 32 world units (+23%) on the core hull; the
 * three segment "adds" deliberately keep their original size (see `SEGMENT_HIT_RADIUS`) so they
 * read as distinct, precisely-aimed targets rather than just more core.
 */
const OLD_RADIUS = 26;
const NEW_RADIUS = 32;
const HIT_SCALE = NEW_RADIUS / OLD_RADIUS;

/** Hit-test radius for a live segment. Smaller than the core so a segment reads as a precise,
 * deliberate target rather than an extension of the main hull. */
const SEGMENT_HIT_RADIUS = 8;

/** Fraction of a segment kill's damage that also drains the boss's overall hull bar, mirroring
 * Maw Core's plate credit (`mawcore.ts`) so overall progress still reads on the boss bar even
 * though segments have their own separate hit points. */
const SEGMENT_HULL_CREDIT = 0.5;

/** Segment pool as a fraction of total boss HP, split three ways. Deliberately modest — the
 * gate exists to force a priority switch, not to double the fight's length — but real enough
 * that skipping the adds and just grinding the (88%-reduced) core is clearly the worse plan. */
const SEGMENT_HULL_FRACTION = 0.18;

/**
 * Core damage multiplier while any segment is alive: 12% through (an 88% reduction), inside the
 * 85-90% band that keeps every hit meaningfully registering — full immunity was rejected
 * specifically because it makes the player's damage feel ignored, which is the documented
 * failure mode of hard damage-gates (see the file header for the design reasoning).
 */
const CORE_RESISTANCE_WHILE_ADDS_ALIVE = 0.12;

/** How fast the darken/shimmer visual settles onto its target state, as the fraction of the way
 * *not yet* travelled after one second (same convention as `core/math.ts`'s `damp`). */
const RESISTANCE_VISUAL_SMOOTHING = 0.001;

const UP = /*#__PURE__*/ new THREE.Vector3(0, 1, 0);
const RIGHT = /*#__PURE__*/ new THREE.Vector3(1, 0, 0);
const SEG_WORLD = /*#__PURE__*/ new THREE.Vector3();
const SEG_HIT_WORLD = /*#__PURE__*/ new THREE.Vector3();
const LOCK_POINT_WORLD = /*#__PURE__*/ new THREE.Vector3();
const RING_AXIS = /*#__PURE__*/ new THREE.Vector3(0, 1, 0);

export class Hexard extends Boss {
  private ringAngle = 0;
  private gapAngle = 0;
  private sweepAngle = 0;
  private readonly segments: Segment[] = [];
  private core: THREE.Mesh | null = null;

  /** True once phase 1 has actually spawned the segments — before that they exist internally
   * (built in `build()`) but are invisible and inert, so they must not gate core damage yet. */
  private segmentsActive = false;

  private hullMat: THREE.MeshStandardMaterial | null = null;
  private readonly baseHullColor = new THREE.Color();
  private readonly darkHullColor = new THREE.Color();
  private shieldShell: THREE.Mesh | null = null;

  constructor() {
    super('hexard', 'HEXARD', 'The Splitting Fortress');
    this.radius = NEW_RADIUS;
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
    this.hullMat = hullMat;
    this.baseHullColor.set(p.enemyHull);
    // ~78% darker — "significantly darken" per the design brief, not just a tint shift, so the
    // resistant state reads correctly even at a glance and regardless of colourblind remapping.
    this.darkHullColor.copy(this.baseHullColor).multiplyScalar(0.22);

    // A hexagonal prism reads as "fortress" instantly and makes the six-fold ring patterns feel
    // like they come from the shape rather than from nowhere. Dimensions scaled by HIT_SCALE
    // (see above) to match the enlarged collision radius.
    const body = new THREE.Mesh(new THREE.CylinderGeometry(20 * HIT_SCALE, 20 * HIT_SCALE, 9 * HIT_SCALE, 6), hullMat);
    body.rotation.x = Math.PI / 2;
    this.root.add(body);

    const coreMat = new THREE.MeshStandardMaterial({
      color: 0x111318,
      emissive: new THREE.Color(p.bossPhase[0]!),
      emissiveIntensity: 2.2,
      metalness: 0.4,
      roughness: 0.5,
    });
    this.core = new THREE.Mesh(new THREE.IcosahedronGeometry(7 * HIT_SCALE, 1), coreMat);
    this.root.add(this.core);

    // Shield shimmer: a faceted wireframe shell around the core, invisible until the core is
    // resistant. Shape + motion carries the "you can't hurt this much right now" read — colour
    // alone is explicitly disallowed by DESIGN §13 (colourblind modes remap hue), and combining
    // it with the hull darkening above gives two independent visual channels plus the HUD flag.
    const shieldMat = new THREE.MeshBasicMaterial({
      color: p.telegraphAimed,
      wireframe: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.shieldShell = new THREE.Mesh(new THREE.IcosahedronGeometry(20 * HIT_SCALE * 1.15, 1), shieldMat);
    this.shieldShell.visible = false;
    this.root.add(this.shieldShell);

    // Three armoured segments, hidden until phase 2 detaches them. Left at their original size
    // (not scaled by HIT_SCALE) so they read as distinctly smaller "adds" next to the enlarged
    // core, per `damageSegment`'s doc comment.
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
        maxHull: 1,
        angle: (i / 3) * TAU,
        offset: new THREE.Vector3(),
      });
    }
  }

  /** Sets segment hit points once the boss's total HP is known — called by the wiring layer
   * right after `spawn()`, mirroring Maw Core's `configurePlates`. */
  configureSegments(totalHull: number): void {
    const per = (totalHull * SEGMENT_HULL_FRACTION) / this.segments.length;
    for (const seg of this.segments) {
      seg.hull = per;
      seg.maxHull = per;
      seg.alive = true;
    }
    this.segmentsActive = false;
  }

  protected override onPhaseEnter(index: number): void {
    const p = palette();
    if (this.core) {
      const mat = this.core.material as THREE.MeshStandardMaterial;
      mat.emissive.set(p.bossPhase[Math.min(index, p.bossPhase.length - 1)]!);
    }
    if (index >= 1) {
      for (const seg of this.segments) seg.mesh.visible = seg.alive;
      this.segmentsActive = true;
    }
    if (index >= 2) {
      // The core exposes: segments fall away and stop contributing patterns. Any that are still
      // alive stop gating core damage in the same step, since `anyLiveSegment` reads `alive`.
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

    this.updateResistanceVisual(dt);
  }

  /**
   * Darkens the hull and fades the shield shimmer in/out toward whatever `anyLiveSegment`
   * currently says, using a framerate-independent exponential approach (same formula as
   * `core/math.ts`'s `damp`) rather than a hard cut, so the state change itself reads as an
   * event rather than a flicker.
   */
  private updateResistanceVisual(dt: number): void {
    const resistant = this.anyLiveSegment;
    const t = 1 - Math.pow(RESISTANCE_VISUAL_SMOOTHING, dt);

    if (this.hullMat) {
      const target = resistant ? this.darkHullColor : this.baseHullColor;
      this.hullMat.color.lerp(target, t);
    }
    if (this.shieldShell) {
      const mat = this.shieldShell.material as THREE.MeshBasicMaterial;
      const targetOpacity = resistant ? 0.5 : 0;
      mat.opacity += (targetOpacity - mat.opacity) * t;
      this.shieldShell.visible = mat.opacity > 0.01;
      this.shieldShell.rotation.y += dt * 0.8;
      this.shieldShell.rotation.x += dt * 0.5;
    }
  }

  /** World position of a live segment, for its own fire patterns and for hit resolution. */
  private segmentWorld(seg: Segment, out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.position).add(seg.offset);
  }

  /**
   * True while any segment is a live, gating target — i.e. phase 1 has actually spawned them
   * (`segmentsActive`) and at least one hasn't died yet. Drives the core damage resistance, the
   * darken/shimmer visual, and the weak-point lock override below.
   */
  private get anyLiveSegment(): boolean {
    if (!this.segmentsActive) return false;
    for (const seg of this.segments) if (seg.alive) return true;
    return false;
  }

  /** HUD-facing mirror of `anyLiveSegment` — see the wiring note in `enemies/bosses/index.ts`
   * for the exact field name/path the HUD should read this through. */
  get coreResistant(): boolean {
    return this.anyLiveSegment;
  }

  override get lockPoint(): THREE.Vector3 {
    if (!this.anyLiveSegment) return this.position;
    // Lock the add nearest the player, not just the first alive index — "nearest" reads as
    // intentional targeting help, an arbitrary pick would not.
    let best: Segment | null = null;
    let bestDistSq = Infinity;
    for (const seg of this.segments) {
      if (!seg.alive) continue;
      this.segmentWorld(seg, SEG_HIT_WORLD);
      const d = SEG_HIT_WORLD.distanceToSquared(this.playerPosCache);
      if (d < bestDistSq) {
        bestDistSq = d;
        best = seg;
      }
    }
    if (!best) return this.position;
    return this.segmentWorld(best, LOCK_POINT_WORLD);
  }

  override get lockRadius(): number {
    return this.anyLiveSegment ? SEGMENT_HIT_RADIUS : this.radius;
  }

  /**
   * 88% core damage reduction while any add is alive (see the file header for why this is heavy
   * resistance and not immunity). `super.damage` still runs the normal phase-gate/death checks
   * on the reduced amount, so a determined player ignoring the adds is slow, not stalled.
   */
  override damage(amount: number, ctx: BossContext): boolean {
    const mult = this.anyLiveSegment ? CORE_RESISTANCE_WHILE_ADDS_ALIVE : 1;
    return super.damage(amount * mult, ctx);
  }

  /**
   * Swept hit-test against every live segment. Segments orbit at radius 34 from the core, well
   * outside the core's own `radius` (32), so the wiring layer must call this *before* its core
   * sphere test — otherwise a shot that visibly connects with a "pop-up" add silently does
   * nothing, which is exactly the confusion in playtester feedback #19. Returns the hit
   * segment's index, or -1.
   */
  findSegmentHit(prev: THREE.Vector3, curr: THREE.Vector3, projRadius: number): number {
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i]!;
      if (!seg.alive) continue;
      this.segmentWorld(seg, SEG_HIT_WORLD);
      if (sweptSphereHit(prev, curr, projRadius, SEG_HIT_WORLD, SEGMENT_HIT_RADIUS)) return i;
    }
    return -1;
  }

  /** World position of a live segment, for the wiring layer's impact FX after `findSegmentHit`
   * reports a hit. */
  segmentWorldPosition(index: number, out: THREE.Vector3): THREE.Vector3 {
    const seg = this.segments[index];
    return seg ? this.segmentWorld(seg, out) : out.copy(this.position);
  }

  /**
   * Applies damage to one live segment. Segments always take full damage — the core's
   * resistance above is what creates "kill the adds first" pressure, so the adds themselves must
   * never share it, or there would be nothing to prioritise. A fraction also credits the overall
   * hull bar (`SEGMENT_HULL_CREDIT`) so boss-bar progress stays legible while adds are being
   * cleared. Returns true if this hit killed the whole boss (only via that credit; vanishingly
   * rare in practice).
   */
  damageSegment(index: number, amount: number, ctx: BossContext): boolean {
    const seg = this.segments[index];
    if (!seg || !seg.alive) return false;
    seg.hull -= amount;
    this.flash = 1;
    if (seg.hull <= 0) {
      seg.alive = false;
      seg.mesh.visible = false;
    }
    return super.damage(amount * SEGMENT_HULL_CREDIT, ctx);
  }

  /* Pattern entry points used by the phase tables ----------------------------------------- */

  fireRing(ctx: BossContext, damage: number): void {
    if (this.currentPhaseIndex >= 2) {
      // Final-phase variant only: phases 0-1 stay perfectly flat because that consistency is
      // the actual "read the rotation" lesson (DESIGN §2) and must not be muddied while the
      // player is still learning it. Once it's learned, this adds a slow precession so the
      // ring's plane keeps drifting through the vertical — same gap-reading skill, one more axis
      // to track (playtester feedback #6: "only shoots along one plane").
      const tilt = 0.55; // ~31 deg off vertical: enough to force a vertical read, not enough to hide the gap
      RING_AXIS.set(Math.sin(this.age * 0.35) * tilt, 1, Math.cos(this.age * 0.35) * tilt).normalize();
      patternRing(ctx, this.position, 34, 52, damage, phaseColor(this.phase), this.ringAngle, this.gapAngle, 0.9, RING_AXIS);
    } else {
      patternRing(ctx, this.position, 34, 52, damage, phaseColor(this.phase), this.ringAngle, this.gapAngle, 0.9);
    }
  }

  fireSegmentFans(ctx: BossContext, damage: number): void {
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i]!;
      if (!seg.alive) continue;
      this.segmentWorld(seg, SEG_WORLD);
      // Alternate axis by segment index so the three adds cover different planes at once,
      // rather than all three fanning out across the same horizontal slice.
      const axisHint = i % 2 === 0 ? UP : RIGHT;
      patternFan(ctx, SEG_WORLD, ctx.playerPos, 5, 0.5, 62, damage, phaseColor(this.phase), axisHint);
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
