/**
 * The Maw Core — the sector 3 boss, and the exam.
 *
 * It asks for everything the first two taught, at once. Phase 1 is target prioritisation under
 * pressure: six shield plates must be destroyed in the order they light up, while turret rings
 * suppress. Phase 2 adds a gravity field that drags the player inward, so holding position now
 * costs thrust. Phase 3 contracts the arena to 40% and fires an expanding spiral wall — the only
 * survival is precise drift through the gaps.
 *
 * The plates are the interesting mechanic: they are individually targetable, only the lit one
 * is vulnerable, and shooting the wrong one does nothing. That converts raw DPS into a
 * readable sequencing puzzle without ever hiding information from the player.
 */

import * as THREE from 'three';
import { TAU, clamp01 } from '../../core/math';
import { palette } from '../../render/palette';
import {
  Boss,
  patternRing,
  patternSphere,
  patternSpiral,
  phaseColor,
  type BossContext,
  type BossPhase,
} from './boss';

const PLATE_COUNT = 6;
const UP = /*#__PURE__*/ new THREE.Vector3(0, 1, 0);
const pull = /*#__PURE__*/ new THREE.Vector3();

interface Plate {
  mesh: THREE.Mesh;
  alive: boolean;
  hull: number;
  maxHull: number;
  readonly angle: number;
}

export class MawCore extends Boss {
  private readonly plates: Plate[] = [];
  /** Index of the currently vulnerable plate; -1 once all are destroyed. */
  private litPlate = 0;
  private spiralAngle = 0;
  private ringAngle = 0;
  private core: THREE.Mesh | null = null;

  constructor() {
    super('mawCore', 'THE MAW CORE', 'Where the Armada was built');
    this.radius = 34;
  }

  override get phases(): readonly BossPhase[] {
    return MAW_PHASES;
  }

  protected build(): void {
    const p = palette();

    const coreMat = new THREE.MeshStandardMaterial({
      color: 0x0d0f16,
      emissive: new THREE.Color(p.bossPhase[0]!),
      emissiveIntensity: 2.6,
      metalness: 0.3,
      roughness: 0.6,
    });
    this.core = new THREE.Mesh(new THREE.IcosahedronGeometry(14, 2), coreMat);
    this.root.add(this.core);

    const plateMat = new THREE.MeshStandardMaterial({
      color: p.enemyHull,
      metalness: 0.9,
      roughness: 0.3,
      emissive: new THREE.Color(0x000000),
    });

    for (let i = 0; i < PLATE_COUNT; i++) {
      const angle = (i / PLATE_COUNT) * TAU;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(16, 4, 10), plateMat.clone());
      mesh.position.set(Math.cos(angle) * 30, 0, Math.sin(angle) * 30);
      mesh.rotation.y = -angle;
      this.root.add(mesh);
      this.plates.push({ mesh, alive: true, hull: 1, maxHull: 1, angle });
    }
    this.refreshPlateEmissive();
  }

  /** Sets plate hull once the boss's total HP is known. */
  configurePlates(totalHull: number): void {
    const per = (totalHull * 0.5) / PLATE_COUNT;
    for (const plate of this.plates) {
      plate.hull = per;
      plate.maxHull = per;
      plate.alive = true;
    }
    this.litPlate = 0;
    this.refreshPlateEmissive();
  }

  /**
   * Only the lit plate glows, and only the lit plate takes damage. Colour alone would not be
   * enough (DESIGN §13), so the lit plate also scales up slightly — shape reinforces state.
   */
  private refreshPlateEmissive(): void {
    const p = palette();
    for (let i = 0; i < this.plates.length; i++) {
      const plate = this.plates[i]!;
      const mat = plate.mesh.material as THREE.MeshStandardMaterial;
      const lit = i === this.litPlate && plate.alive;
      mat.emissive.set(lit ? p.telegraphAimed : 0x000000);
      mat.emissiveIntensity = lit ? 2.4 : 0;
      plate.mesh.scale.setScalar(lit ? 1.18 : 1);
      plate.mesh.visible = plate.alive;
    }
  }

  /** Advances to the next surviving plate, wrapping. Returns false when none remain. */
  private advanceLitPlate(): boolean {
    for (let step = 1; step <= PLATE_COUNT; step++) {
      const idx = (this.litPlate + step) % PLATE_COUNT;
      if (this.plates[idx]!.alive) {
        this.litPlate = idx;
        this.refreshPlateEmissive();
        return true;
      }
    }
    this.litPlate = -1;
    this.refreshPlateEmissive();
    return false;
  }

  /**
   * Damage routing. While plates remain, only the lit plate absorbs — the core is immune. That
   * is what makes phase 1 a sequencing problem rather than a damage race.
   */
  override damage(amount: number, ctx: BossContext): boolean {
    if (this.litPlate >= 0) {
      const plate = this.plates[this.litPlate];
      if (plate && plate.alive) {
        plate.hull -= amount;
        this.flash = 1;
        if (plate.hull <= 0) {
          plate.alive = false;
          plate.mesh.visible = false;
          this.advanceLitPlate();
        }
        // Plate damage still counts toward the boss bar so progress stays legible.
        return super.damage(amount * 0.5, ctx);
      }
    }
    return super.damage(amount, ctx);
  }

  protected override onPhaseEnter(index: number): void {
    const p = palette();
    if (this.core) {
      const mat = this.core.material as THREE.MeshStandardMaterial;
      mat.emissive.set(p.bossPhase[Math.min(index, p.bossPhase.length - 1)]!);
    }
    if (index >= 2) {
      // Final phase: the shell is gone entirely, the core is naked, everything hits.
      for (const plate of this.plates) {
        plate.alive = false;
        plate.mesh.visible = false;
      }
      this.litPlate = -1;
    }
  }

  protected move(_ctx: BossContext, dt: number): void {
    const phase = this.phase;

    // The core is the arena's anchor: it sits near the centre and rotates.
    this.position.set(0, Math.sin(this.age * 0.3) * 10, 0);
    this.ringAngle += dt * 0.5 * phase.speed;
    this.quaternion.setFromAxisAngle(UP, this.ringAngle);

    for (const plate of this.plates) {
      if (!plate.alive) continue;
      const a = plate.angle + this.ringAngle;
      plate.mesh.position.set(Math.cos(a) * 30, 0, Math.sin(a) * 30);
      plate.mesh.rotation.y = -a;
    }
  }

  /** Gravity field: drags the player inward. Phase 2 onward. */
  applyGravity(ctx: BossContext, strength: number, dt: number): void {
    pull.copy(this.position).sub(ctx.playerPos);
    const dist = pull.length();
    if (dist < 1) return;
    pull.multiplyScalar(1 / dist);
    // Falls off with distance so the edge of the arena is still escapable.
    const falloff = clamp01(1 - dist / (ctx.arenaRadius * 1.1));
    ctx.playerVel.addScaledVector(pull, strength * falloff * dt);
  }

  fireTurretRing(ctx: BossContext, damage: number): void {
    patternRing(ctx, this.position, 26, 48, damage, phaseColor(this.phase), this.ringAngle);
  }

  fireShell(ctx: BossContext, damage: number): void {
    patternSphere(ctx, this.position, 44, 44, damage, phaseColor(this.phase), this.ringAngle);
  }

  fireSpiral(ctx: BossContext, damage: number, dt: number): void {
    this.spiralAngle += dt * 2.4;
    patternSpiral(ctx, this.position, 4, this.spiralAngle, 52, damage, phaseColor(this.phase));
  }

  get platesRemaining(): number {
    let n = 0;
    for (const plate of this.plates) if (plate.alive) n++;
    return n;
  }
}

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

const MAW_PHASES: readonly BossPhase[] = [
  {
    startsBelow: 1,
    colorIndex: 0,
    speed: 1,
    moves: [
      {
        name: 'Suppression Ring',
        telegraph: 0.6,
        duration: 3.0,
        recovery: 1.6,
        lethal: false,
        fire: (boss, ctx, _t, dt) => {
          if (tick(boss, dt, 0.3)) (boss as MawCore).fireTurretRing(ctx, 11);
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
        name: 'Gravity Well',
        telegraph: 0.9,
        duration: 3.6,
        recovery: 1.4,
        lethal: false,
        fire: (boss, ctx, _t, dt) => {
          (boss as MawCore).applyGravity(ctx, 55, dt);
          if (tick(boss, dt, 0.34)) (boss as MawCore).fireTurretRing(ctx, 12);
        },
      },
      {
        name: 'Expanding Shell',
        telegraph: 0.7,
        duration: 1.4,
        recovery: 1.6,
        lethal: false,
        fire: (boss, ctx, _t, dt) => {
          if (tick(boss, dt, 0.7)) (boss as MawCore).fireShell(ctx, 13);
        },
      },
    ],
  },
  {
    startsBelow: 0.33,
    colorIndex: 2,
    speed: 1.4,
    moves: [
      {
        name: 'Spiral Wall',
        // The signature closing move: a continuously rotating spiral in a shrunken arena.
        // Survivable only by drifting through the gaps, which is the mechanic the whole run
        // has been teaching.
        telegraph: 1.2,
        duration: 5.0,
        recovery: 1.6,
        lethal: true,
        fire: (boss, ctx, _t, dt) => {
          (boss as MawCore).applyGravity(ctx, 38, dt);
          if (tick(boss, dt, 0.07)) (boss as MawCore).fireSpiral(ctx, 13, dt);
        },
      },
      {
        name: 'Collapse Shell',
        telegraph: 0.6,
        duration: 1.2,
        recovery: 1.2,
        lethal: false,
        fire: (boss, ctx, _t, dt) => {
          if (tick(boss, dt, 0.6)) (boss as MawCore).fireShell(ctx, 15);
        },
      },
    ],
  },
];
