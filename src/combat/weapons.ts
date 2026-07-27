/**
 * Weapon definitions and firing logic.
 *
 * Balance principle from DESIGN §8, and the reason the table below is auditable: **all six
 * primaries sit within ±15% of the same sustained DPS.** They are not differentiated by how
 * much damage they do, but by *how you have to earn it* — range, spread, projectile speed,
 * charge commitment, heat cost, and what they combo with. That is what makes weapon choice a
 * real decision rather than a strict upgrade path.
 *
 * ── Sustained DPS audit (baseline stats, no augments) ────────────────────────────────────────
 *
 *   weapon           damage × shots ÷ interval   = raw DPS   heat/s   effective*   vs baseline
 *   pulseRepeater     9 × 1 ÷ 0.11                 81.8       45.5      81.8          100%
 *   lanceDriver      95 × 1 ÷ 1.15 (incl. charge)  82.6       26.1      82.6          101%
 *   scatterVents      7 × 8 ÷ 0.62                 90.3       48.4      76.8***       94%
 *   arcTether        13 × 1 ÷ 0.18 (1 target)      72.2       38.9      86.7**       106%
 *   flakBattery      30 × 1 ÷ 0.42                 71.4       40.5      78.6****      96%
 *   singularityCoil  10 × 1 ÷ 0.55                 18.2       21.8      ~20           25% (utility)
 *
 *   *    effective = raw DPS adjusted for the weapon's realistic hit profile
 *   **   Arc Tether chains to up to 4 targets; single-target is deliberately below baseline
 *   ***  Scatter Vents assumes ~85% pellet connection at its effective range
 *   **** Flak assumes partial AoE overlap on a single target
 *
 * Singularity Coil is intentionally outside the band: it is a setup tool, not a damage weapon,
 * and its value is the clump it creates for everything else.
 */

import * as THREE from 'three';
import {
  ProjectileKind,
  Team,
  type EventBus,
  type PlayerState,
  type PrimaryWeaponId,
  type SecondaryWeaponId,
  type WeaponId,
} from '../core/types';
import { PLAYER } from '../core/constants';
import { applySpread, clamp01, scratchVec3A, scratchVec3D } from '../core/math';
import type { Rng } from '../core/rng';
import type { CombatContext, ProjectileSpawnParams } from './projectiles';
import { ProjectileSystem } from './projectiles';
import type { TargetingSystem } from './targeting';
import { computePlayerDamage } from './damage';

export interface WeaponDef {
  readonly id: WeaponId;
  readonly displayName: string;
  readonly description: string;
  readonly isPrimary: boolean;
  readonly damage: number;
  readonly fireInterval: number;
  readonly projectileSpeed: number;
  readonly heatPerShot: number;
  readonly spread: number;
  readonly shots: number;
  readonly chargeTime: number;
  readonly range: number;
  readonly aoe: number;
  readonly pierce: number;
  readonly cooldown: number;
  readonly charges: number;
  readonly colorIndex: number;
}

export const WEAPONS: Readonly<Record<WeaponId, WeaponDef>> = {
  pulseRepeater: {
    id: 'pulseRepeater', displayName: 'Pulse Repeater', isPrimary: true,
    description: 'Fast, tight, forgiving. The baseline every other weapon is measured against.',
    // Spread ~3° (0.052 rad). This is the rapid-fire baseline, so it earns the most spray of
    // any single-target primary short of the shotgun: at close range (~30m) the cone is
    // ~1.6 units wide — about one small enemy's radius, so it still lands close to reliably —
    // but by 200m it has opened to ~10 units, wide enough that landing every shot on a small,
    // moving target takes real aim rather than a locked reticle doing the work. Lance Driver
    // stays at 0 spread below on purpose; this is the weapon that should *not* feel pinpoint.
    damage: 9, fireInterval: 0.11, projectileSpeed: 420, heatPerShot: 5, spread: 0.052, shots: 1,
    chargeTime: 0, range: 900, aoe: 0, pierce: 0, cooldown: 0, charges: 0, colorIndex: 0,
  },
  lanceDriver: {
    id: 'lanceDriver', displayName: 'Lance Driver', isPrimary: true,
    description: 'Charge and release. Pierces everything in a line. Missing costs the whole cycle.',
    damage: 95, fireInterval: 0.35, projectileSpeed: 700, heatPerShot: 30, spread: 0, shots: 1,
    chargeTime: 0.8, range: 1200, aoe: 0, pierce: 6, cooldown: 0, charges: 0, colorIndex: 2,
  },
  scatterVents: {
    id: 'scatterVents', displayName: 'Scatter Vents', isPrimary: true,
    description: 'Shotgun cone. Deletes things at knife range, falls off hard past 140m.',
    damage: 7, fireInterval: 0.62, projectileSpeed: 300, heatPerShot: 30, spread: 0.22, shots: 8,
    chargeTime: 0, range: 140, aoe: 0, pierce: 0, cooldown: 0, charges: 0, colorIndex: 4,
  },
  arcTether: {
    id: 'arcTether', displayName: 'Arc Tether', isPrimary: true,
    description: 'Auto-connecting chain lightning. Hits up to 4 targets. Needs crowds to pay off.',
    damage: 13, fireInterval: 0.18, projectileSpeed: 0, heatPerShot: 7, spread: 0, shots: 1,
    chargeTime: 0, range: 260, aoe: 0, pierce: 0, cooldown: 0, charges: 0, colorIndex: 1,
  },
  flakBattery: {
    id: 'flakBattery', displayName: 'Flak Battery', isPrimary: true,
    description: 'Proximity-fused shells. Slow projectiles punish bad leading, reward good.',
    // ~2.3° (0.04 rad) — a smaller bump than Pulse Repeater's. Flak's skill test is leading a
    // slow shell, not raw aim, and its 34-radius proximity fuse already forgives near misses;
    // stacking a wide cone on top of both would erase the "reward good leading" identity.
    damage: 30, fireInterval: 0.42, projectileSpeed: 210, heatPerShot: 17, spread: 0.04, shots: 1,
    chargeTime: 0, range: 700, aoe: 34, pierce: 0, cooldown: 0, charges: 0, colorIndex: 5,
  },
  singularityCoil: {
    id: 'singularityCoil', displayName: 'Singularity Coil', isPrimary: true,
    description: 'A slow orb that drags enemies into a clump. Almost no damage — a setup tool.',
    damage: 10, fireInterval: 0.55, projectileSpeed: 95, heatPerShot: 12, spread: 0, shots: 1,
    chargeTime: 0, range: 600, aoe: 70, pierce: 0, cooldown: 0, charges: 0, colorIndex: 3,
  },

  swarmMissiles: {
    id: 'swarmMissiles', displayName: 'Swarm Missiles', isPrimary: false,
    description: 'Locks up to 6 targets and fires a homing volley.',
    damage: 34, fireInterval: 0.05, projectileSpeed: 260, heatPerShot: 0, spread: 0.35, shots: 6,
    chargeTime: 0, range: 800, aoe: 12, pierce: 0, cooldown: 7, charges: 2, colorIndex: 3,
  },
  novaMine: {
    id: 'novaMine', displayName: 'Nova Mine', isPrimary: false,
    description: 'Deployable proximity charge with a large blast.',
    damage: 140, fireInterval: 0.2, projectileSpeed: 60, heatPerShot: 0, spread: 0, shots: 1,
    chargeTime: 0, range: 400, aoe: 85, pierce: 0, cooldown: 9, charges: 2, colorIndex: 4,
  },
  phaseLance: {
    id: 'phaseLance', displayName: 'Phase Lance', isPrimary: false,
    description: 'Sustained piercing beam while held. Drains its meter fast.',
    damage: 70, fireInterval: 0.06, projectileSpeed: 0, heatPerShot: 0, spread: 0, shots: 1,
    chargeTime: 0, range: 520, aoe: 0, pierce: 99, cooldown: 10, charges: 1, colorIndex: 1,
  },
  gravityWell: {
    id: 'gravityWell', displayName: 'Gravity Well', isPrimary: false,
    description: 'Thrown singularity. Pulls and slows everything nearby for four seconds.',
    damage: 20, fireInterval: 0.2, projectileSpeed: 130, heatPerShot: 0, spread: 0, shots: 1,
    chargeTime: 0, range: 600, aoe: 110, pierce: 0, cooldown: 12, charges: 1, colorIndex: 3,
  },
  aegisPulse: {
    id: 'aegisPulse', displayName: 'Aegis Pulse', isPrimary: false,
    description: 'Shockwave that clears incoming fire and refills your shields.',
    damage: 55, fireInterval: 0.2, projectileSpeed: 0, heatPerShot: 0, spread: 0, shots: 1,
    chargeTime: 0, range: 150, aoe: 150, pierce: 0, cooldown: 14, charges: 1, colorIndex: 5,
  },
};

export const PRIMARY_ORDER: readonly PrimaryWeaponId[] = [
  'pulseRepeater', 'lanceDriver', 'scatterVents', 'arcTether', 'flakBattery', 'singularityCoil',
];

export const SECONDARY_ORDER: readonly SecondaryWeaponId[] = [
  'swarmMissiles', 'novaMine', 'phaseLance', 'gravityWell', 'aegisPulse',
];

export function getWeapon(id: WeaponId): WeaponDef {
  return WEAPONS[id];
}

export interface WeaponFireInput {
  primary: boolean;
  secondary: boolean;
}

const muzzleOffset = /*#__PURE__*/ new THREE.Vector3();
const shotDir = /*#__PURE__*/ new THREE.Vector3();
const chainFrom = /*#__PURE__*/ new THREE.Vector3();

export class WeaponSystem {
  private readonly projectiles: ProjectileSystem;
  private readonly events: EventBus;
  private readonly rng: Rng;

  private readonly params: ProjectileSpawnParams;
  private readonly chainResults = new Int32Array(64);
  private readonly chainHit = new Set<number>();

  /** Counts shots for the Echo Rounds augment. */
  private shotCounter = 0;
  /** Pending echo: fires a delayed phantom copy of a previous shot. */
  private echoTimer = 0;
  private echoActive = false;
  private readonly echoDir = new THREE.Vector3();
  private readonly echoOrigin = new THREE.Vector3();

  private overchargePending = false;
  /** Phase Lance sustain meter, 0..1. */
  private beamMeter = 1;

  constructor(projectiles: ProjectileSystem, events: EventBus, rng: Rng) {
    this.projectiles = projectiles;
    this.events = events;
    this.rng = rng;

    this.params = {
      kind: ProjectileKind.Linear, team: Team.Player, ownerId: 0,
      x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: -1,
      speed: 0, damage: 0, radius: 1.2, life: 3,
      pierce: 0, fork: 0, homingRate: 0, targetId: -1,
      proximity: 0, aoe: 0, colorIndex: 0, scale: 1,
      sourceWeapon: 'pulseRepeater',
    };
  }

  consumeOverchargeDetonation(): boolean {
    const value = this.overchargePending;
    this.overchargePending = false;
    return value;
  }

  reset(): void {
    this.shotCounter = 0;
    this.echoActive = false;
    this.echoTimer = 0;
    this.overchargePending = false;
    this.beamMeter = 1;
    this.chainHit.clear();
  }

  update(
    player: PlayerState,
    input: WeaponFireInput,
    aimDir: THREE.Vector3,
    ctx: CombatContext,
    targeting: TargetingSystem,
    dt: number,
  ): void {
    const stats = player.stats;

    if (player.primaryCooldown > 0) player.primaryCooldown -= dt;
    if (player.secondaryCooldown > 0) player.secondaryCooldown -= dt;

    // Secondary charges refill on the cooldown, capped by the weapon plus augment bonuses.
    const secondaryDef = getWeapon(player.secondary);
    const maxCharges = secondaryDef.charges + stats.secondaryCharges;
    if (player.secondaryCharges < maxCharges && player.secondaryCooldown <= 0) {
      player.secondaryCharges = Math.min(maxCharges, player.secondaryCharges + 1);
      if (player.secondaryCharges < maxCharges) {
        player.secondaryCooldown = secondaryDef.cooldown * stats.secondaryCooldownMult;
      }
    }

    this.updateEcho(player, ctx, dt);

    // Beam meter recovers whenever the beam is not firing.
    if (!(input.secondary && player.secondary === 'phaseLance')) {
      this.beamMeter = clamp01(this.beamMeter + dt * 0.35);
    }

    this.updatePrimary(player, input, aimDir, ctx, targeting, dt);
    this.updateSecondary(player, input, aimDir, ctx, targeting, dt);
  }

  /* Primary ------------------------------------------------------------------------------- */

  private updatePrimary(
    player: PlayerState,
    input: WeaponFireInput,
    aimDir: THREE.Vector3,
    ctx: CombatContext,
    targeting: TargetingSystem,
    dt: number,
  ): void {
    const def = getWeapon(player.primary);
    const stats = player.stats;

    // Venting locks the guns — unless Overcharge Vents replaced the lockout with a detonation.
    if (player.venting && !stats.overchargeVents) {
      player.charge = 0;
      return;
    }

    if (def.chargeTime > 0) {
      // Charge weapons commit: holding builds charge, releasing fires whatever accumulated.
      if (input.primary) {
        player.charge = clamp01(player.charge + dt / def.chargeTime);
        return;
      }
      if (player.charge > 0.05 && player.primaryCooldown <= 0) {
        this.fireCharged(player, aimDir, ctx, targeting, player.charge);
        player.charge = 0;
        player.primaryCooldown = def.fireInterval / stats.fireRateMult;
      } else {
        player.charge = 0;
      }
      return;
    }

    if (!input.primary || player.primaryCooldown > 0) return;

    if (player.primary === 'arcTether') this.fireArc(player, ctx, targeting);
    else this.fireProjectilePrimary(player, aimDir, ctx, targeting, 1);

    player.primaryCooldown = def.fireInterval / stats.fireRateMult;
    this.addHeat(player, def.heatPerShot * stats.heatMult);
  }

  private addHeat(player: PlayerState, amount: number): void {
    player.heat = Math.min(PLAYER.heatMax, player.heat + amount);
    if (player.heat >= PLAYER.heatMax) {
      if (player.stats.overchargeVents) {
        // The augment converts the penalty into an opportunity: detonate now and reset heat
        // straight back to 0. Resetting here (not just flagging) matters — without it, heat
        // sits pinned at the cap and every subsequent shot would see heat >= heatMax again and
        // re-trigger the detonation, turning one overheat into a full-auto explosion spam
        // instead of one payoff per heat-cap crossing.
        player.heat = 0;
        this.overchargePending = true;
      }
      // else: PlayerSystem.updateHeat() (ship/player.ts) latches the forced-cooldown lockout
      // the next simulation step, once it observes heat sitting at the cap.
    }
  }

  private fireProjectilePrimary(
    player: PlayerState,
    aimDir: THREE.Vector3,
    ctx: CombatContext,
    targeting: TargetingSystem,
    damageScale: number,
  ): void {
    const def = getWeapon(player.primary);
    const stats = player.stats;
    const shots = def.shots + (def.shots > 1 ? stats.extraShots : 0);

    this.muzzle(player, aimDir);

    for (let i = 0; i < shots; i++) {
      shotDir.copy(aimDir);
      if (def.spread > 0) applySpread(shotDir, def.spread, () => this.rng.next());

      const p = this.params;
      p.kind = def.aoe > 0 && def.id === 'flakBattery' ? ProjectileKind.Proximity
        : def.id === 'singularityCoil' ? ProjectileKind.Singularity
        : ProjectileKind.Linear;
      p.team = Team.Player;
      p.ownerId = 0;
      p.x = muzzleOffset.x; p.y = muzzleOffset.y; p.z = muzzleOffset.z;
      p.dx = shotDir.x; p.dy = shotDir.y; p.dz = shotDir.z;
      p.speed = def.projectileSpeed * stats.projectileSpeedMult;
      p.damage = this.rollDamage(player, def.damage * damageScale, ctx, targeting);
      p.radius = def.id === 'lanceDriver' ? 2.4 : 1.2;
      p.life = def.range / Math.max(1, p.speed);
      p.pierce = def.pierce + stats.pierceBonus;
      p.fork = stats.forkBonus;
      p.homingRate = stats.homingBonus;
      p.targetId = stats.homingBonus > 0 ? targeting.lockedId : -1;
      p.proximity = def.id === 'flakBattery' ? 22 : 0;
      p.aoe = def.aoe * stats.aoeMult;
      p.colorIndex = def.colorIndex;
      p.scale = def.id === 'lanceDriver' ? 2 : 1;
      p.sourceWeapon = def.id;
      this.projectiles.spawn(p);
    }

    this.events.emit('weapon:fired', { weapon: def.id, x: muzzleOffset.x, y: muzzleOffset.y, z: muzzleOffset.z });
    this.registerEcho(player, aimDir);
  }

  private fireCharged(
    player: PlayerState,
    aimDir: THREE.Vector3,
    ctx: CombatContext,
    targeting: TargetingSystem,
    charge: number,
  ): void {
    const def = getWeapon(player.primary);
    // Releasing early does proportionally less, so an early release is a real cost rather than
    // a free tap-fire mode.
    this.fireProjectilePrimary(player, aimDir, ctx, targeting, charge);
    this.addHeat(player, def.heatPerShot * charge * player.stats.heatMult);
  }

  /**
   * Arc Tether: no travelling projectile. It resolves instantly, chaining outward from the
   * nearest target, and reports each link so the FX layer can draw the arcs.
   */
  private fireArc(player: PlayerState, ctx: CombatContext, targeting: TargetingSystem): void {
    const def = getWeapon(player.primary);
    this.chainHit.clear();
    chainFrom.copy(player.position);

    let links = 0;
    const maxLinks = 4;

    while (links < maxLinks) {
      const count = ctx.enemies.queryNear(chainFrom.x, chainFrom.y, chainFrom.z, def.range, this.chainResults);
      let bestId = -1;
      let bestDist = Infinity;
      let bestX = 0, bestY = 0, bestZ = 0;

      for (let i = 0; i < count; i++) {
        const enemy = ctx.enemies.getByIndex(this.chainResults[i]!);
        if (!enemy || !enemy.active || this.chainHit.has(enemy.id)) continue;
        const d = enemy.position.distanceTo(chainFrom);
        if (d < bestDist) {
          bestDist = d;
          bestId = enemy.id;
          bestX = enemy.position.x; bestY = enemy.position.y; bestZ = enemy.position.z;
        }
      }

      if (bestId < 0) break;

      // Each successive link does a little less, so chaining is a bonus rather than a multiplier.
      const falloff = Math.pow(0.82, links);
      const damage = this.rollDamage(player, def.damage * falloff, ctx, targeting);
      ctx.damageEnemy(bestId, damage, false, bestX, bestY, bestZ, def.id);

      this.events.emit('weapon:impact', {
        weapon: def.id,
        x: bestX, y: bestY, z: bestZ,
        nx: bestX - chainFrom.x, ny: bestY - chainFrom.y, nz: bestZ - chainFrom.z,
        damage,
      });

      this.chainHit.add(bestId);
      chainFrom.set(bestX, bestY, bestZ);
      links++;
    }

    if (links > 0) {
      this.events.emit('weapon:fired', { weapon: def.id, x: player.position.x, y: player.position.y, z: player.position.z });
    }
  }

  /* Secondary ------------------------------------------------------------------------------ */

  private updateSecondary(
    player: PlayerState,
    input: WeaponFireInput,
    aimDir: THREE.Vector3,
    ctx: CombatContext,
    targeting: TargetingSystem,
    dt: number,
  ): void {
    const def = getWeapon(player.secondary);

    // Phase Lance is a sustained beam: it drains a meter while held rather than firing shots.
    if (player.secondary === 'phaseLance') {
      if (input.secondary && this.beamMeter > 0) {
        this.beamMeter = Math.max(0, this.beamMeter - dt * 0.5);
        this.fireBeam(player, aimDir, ctx, targeting, dt);
      }
      return;
    }

    if (!input.secondary || player.secondaryCharges <= 0) return;

    player.secondaryCharges -= 1;
    player.secondaryCooldown = def.cooldown * player.stats.secondaryCooldownMult;
    this.muzzle(player, aimDir);

    switch (player.secondary) {
      case 'swarmMissiles':
        this.fireSwarm(player, aimDir, ctx, targeting);
        break;
      case 'novaMine':
        this.fireMine(player, aimDir, ctx, targeting);
        break;
      case 'gravityWell':
        this.fireGravityWell(player, aimDir, ctx, targeting);
        break;
      case 'aegisPulse':
        this.fireAegis(player, ctx);
        break;
      default:
        break;
    }

    this.events.emit('weapon:fired', { weapon: def.id, x: muzzleOffset.x, y: muzzleOffset.y, z: muzzleOffset.z });
  }

  private fireSwarm(player: PlayerState, aimDir: THREE.Vector3, ctx: CombatContext, targeting: TargetingSystem): void {
    const def = getWeapon('swarmMissiles');
    const shots = def.shots + player.stats.extraShots;

    // Spread the volley across nearby targets so it clears a cluster rather than overkilling one.
    const count = ctx.enemies.queryNear(player.position.x, player.position.y, player.position.z, def.range, this.chainResults);

    for (let i = 0; i < shots; i++) {
      shotDir.copy(aimDir);
      applySpread(shotDir, def.spread, () => this.rng.next());

      let targetId = targeting.lockedId;
      if (count > 0) {
        const enemy = ctx.enemies.getByIndex(this.chainResults[i % count]!);
        if (enemy && enemy.active) targetId = enemy.id;
      }

      const p = this.params;
      p.kind = ProjectileKind.Homing;
      p.team = Team.Player;
      p.ownerId = 0;
      p.x = muzzleOffset.x; p.y = muzzleOffset.y; p.z = muzzleOffset.z;
      p.dx = shotDir.x; p.dy = shotDir.y; p.dz = shotDir.z;
      p.speed = def.projectileSpeed * player.stats.projectileSpeedMult;
      p.damage = this.rollDamage(player, def.damage, ctx, targeting);
      p.radius = 1.6;
      p.life = 5;
      p.pierce = player.stats.pierceBonus;
      p.fork = player.stats.forkBonus;
      p.homingRate = 3.4 + player.stats.homingBonus;
      p.targetId = targetId;
      p.proximity = 10;
      p.aoe = def.aoe * player.stats.aoeMult;
      p.colorIndex = def.colorIndex;
      p.scale = 1.1;
      p.sourceWeapon = def.id;
      this.projectiles.spawn(p);
    }
  }

  private fireMine(player: PlayerState, aimDir: THREE.Vector3, ctx: CombatContext, targeting: TargetingSystem): void {
    const def = getWeapon('novaMine');
    const p = this.params;
    p.kind = ProjectileKind.Mine;
    p.team = Team.Player;
    p.ownerId = 0;
    p.x = muzzleOffset.x; p.y = muzzleOffset.y; p.z = muzzleOffset.z;
    p.dx = aimDir.x; p.dy = aimDir.y; p.dz = aimDir.z;
    p.speed = def.projectileSpeed;
    p.damage = this.rollDamage(player, def.damage, ctx, targeting);
    p.radius = 2.4;
    p.life = 18;
    p.pierce = 0;
    p.fork = 0;
    p.homingRate = 0;
    p.targetId = -1;
    p.proximity = 26;
    p.aoe = def.aoe * player.stats.aoeMult;
    p.colorIndex = def.colorIndex;
    p.scale = 1.6;
    p.sourceWeapon = def.id;
    this.projectiles.spawn(p);
  }

  private fireGravityWell(player: PlayerState, aimDir: THREE.Vector3, ctx: CombatContext, targeting: TargetingSystem): void {
    const def = getWeapon('gravityWell');
    const p = this.params;
    p.kind = ProjectileKind.Singularity;
    p.team = Team.Player;
    p.ownerId = 0;
    p.x = muzzleOffset.x; p.y = muzzleOffset.y; p.z = muzzleOffset.z;
    p.dx = aimDir.x; p.dy = aimDir.y; p.dz = aimDir.z;
    p.speed = def.projectileSpeed;
    p.damage = this.rollDamage(player, def.damage, ctx, targeting);
    p.radius = 3;
    p.life = 4;
    p.pierce = 0;
    p.fork = 0;
    p.homingRate = 0;
    p.targetId = -1;
    p.proximity = 0;
    p.aoe = def.aoe * player.stats.aoeMult;
    p.colorIndex = def.colorIndex;
    p.scale = 2.4;
    p.sourceWeapon = def.id;
    this.projectiles.spawn(p);
  }

  /** Aegis Pulse: clears incoming fire and refills shields. The panic button. */
  private fireAegis(player: PlayerState, ctx: CombatContext): void {
    const def = getWeapon('aegisPulse');
    const radius = def.aoe * player.stats.aoeMult;

    this.projectiles.clearTeam(Team.Enemy, player.position.x, player.position.y, player.position.z, radius);
    player.shield = player.stats.maxShield;

    const count = ctx.enemies.queryNear(player.position.x, player.position.y, player.position.z, radius, this.chainResults);
    for (let i = 0; i < count; i++) {
      const enemy = ctx.enemies.getByIndex(this.chainResults[i]!);
      if (!enemy || !enemy.active) continue;
      ctx.damageEnemy(enemy.id, def.damage * player.stats.damageMult, false, enemy.position.x, enemy.position.y, enemy.position.z, def.id);
    }

    this.events.emit('weapon:impact', {
      weapon: def.id,
      x: player.position.x, y: player.position.y, z: player.position.z,
      nx: 0, ny: 1, nz: 0,
      damage: def.damage,
    });
  }

  /** Phase Lance: instantaneous ray, damaging everything along it each tick. */
  private fireBeam(
    player: PlayerState,
    aimDir: THREE.Vector3,
    ctx: CombatContext,
    targeting: TargetingSystem,
    dt: number,
  ): void {
    const def = getWeapon('phaseLance');
    const perTick = def.damage * dt;

    scratchVec3A.copy(player.position);
    scratchVec3D.copy(player.position).addScaledVector(aimDir, def.range);

    const midX = (scratchVec3A.x + scratchVec3D.x) * 0.5;
    const midY = (scratchVec3A.y + scratchVec3D.y) * 0.5;
    const midZ = (scratchVec3A.z + scratchVec3D.z) * 0.5;

    const count = ctx.enemies.queryNear(midX, midY, midZ, def.range * 0.5 + 40, this.chainResults);
    for (let i = 0; i < count; i++) {
      const enemy = ctx.enemies.getByIndex(this.chainResults[i]!);
      if (!enemy || !enemy.active) continue;

      // Perpendicular distance from the enemy to the beam line.
      chainFrom.copy(enemy.position).sub(player.position);
      const along = chainFrom.dot(aimDir);
      if (along < 0 || along > def.range) continue;
      chainFrom.addScaledVector(aimDir, -along);
      if (chainFrom.lengthSq() > (enemy.def.radius + 4) * (enemy.def.radius + 4)) continue;

      const damage = this.rollDamage(player, perTick, ctx, targeting);
      ctx.damageEnemy(enemy.id, damage, false, enemy.position.x, enemy.position.y, enemy.position.z, def.id);
    }

    this.events.emit('weapon:impact', {
      weapon: def.id,
      x: scratchVec3D.x, y: scratchVec3D.y, z: scratchVec3D.z,
      nx: -aimDir.x, ny: -aimDir.y, nz: -aimDir.z,
      damage: perTick,
    });
  }

  /* Kinetic Battery + Echo Rounds ----------------------------------------------------------- */

  /** Fires a free Lance, granted by the Kinetic Battery augment at full charge. */
  fireKineticLance(player: PlayerState, aimDir: THREE.Vector3): void {
    const def = getWeapon('lanceDriver');
    this.muzzle(player, aimDir);

    const p = this.params;
    p.kind = ProjectileKind.Linear;
    p.team = Team.Player;
    p.ownerId = 0;
    p.x = muzzleOffset.x; p.y = muzzleOffset.y; p.z = muzzleOffset.z;
    p.dx = aimDir.x; p.dy = aimDir.y; p.dz = aimDir.z;
    p.speed = def.projectileSpeed;
    p.damage = def.damage * player.stats.damageMult;
    p.radius = 2.6;
    p.life = def.range / def.projectileSpeed;
    p.pierce = def.pierce + player.stats.pierceBonus;
    p.fork = player.stats.forkBonus;
    p.homingRate = 0;
    p.targetId = -1;
    p.proximity = 0;
    p.aoe = 0;
    p.colorIndex = 1;
    p.scale = 2.4;
    p.sourceWeapon = 'lanceDriver';
    this.projectiles.spawn(p);

    this.events.emit('weapon:fired', { weapon: 'lanceDriver', x: muzzleOffset.x, y: muzzleOffset.y, z: muzzleOffset.z });
  }

  /** Echo Rounds: every Nth shot queues a delayed phantom copy. */
  private registerEcho(player: PlayerState, aimDir: THREE.Vector3): void {
    const every = player.stats.echoRoundsEvery;
    if (every <= 0) return;
    this.shotCounter++;
    if (this.shotCounter % every !== 0) return;

    this.echoActive = true;
    this.echoTimer = 0.22;
    this.echoDir.copy(aimDir);
    this.echoOrigin.copy(muzzleOffset);
  }

  private updateEcho(player: PlayerState, ctx: CombatContext, dt: number): void {
    if (!this.echoActive) return;
    this.echoTimer -= dt;
    if (this.echoTimer > 0) return;
    this.echoActive = false;

    const def = getWeapon(player.primary);
    const p = this.params;
    p.kind = ProjectileKind.Linear;
    p.team = Team.Player;
    p.ownerId = 0;
    p.x = this.echoOrigin.x; p.y = this.echoOrigin.y; p.z = this.echoOrigin.z;
    p.dx = this.echoDir.x; p.dy = this.echoDir.y; p.dz = this.echoDir.z;
    p.speed = def.projectileSpeed > 0 ? def.projectileSpeed : 400;
    p.damage = def.damage * player.stats.damageMult * 0.7;
    p.radius = 1.2;
    p.life = 2.5;
    p.pierce = player.stats.pierceBonus;
    p.fork = 0;
    p.homingRate = 0;
    p.targetId = -1;
    p.proximity = 0;
    p.aoe = 0;
    p.colorIndex = def.colorIndex;
    p.scale = 0.85;
    p.sourceWeapon = def.id;
    this.projectiles.spawn(p);
    void ctx;
  }

  /* Helpers ---------------------------------------------------------------------------------- */

  /** Places the muzzle slightly ahead of the ship so shots do not spawn inside the hull. */
  private muzzle(player: PlayerState, aimDir: THREE.Vector3): void {
    muzzleOffset.copy(player.position).addScaledVector(aimDir, 6);
  }

  private rollDamage(player: PlayerState, base: number, ctx: CombatContext, targeting: TargetingSystem): number {
    const speed = player.velocity.length();
    const maxSpeed = Math.max(1, player.def.maxSpeed * player.stats.speedMult);
    const target = targeting.lockedId >= 0 ? ctx.enemies.getById(targeting.lockedId) : null;

    const result = computePlayerDamage(base, player.stats, this.rng, {
      distance: target ? player.position.distanceTo(target.position) : 0,
      targetHullFraction: target && target.maxHull > 0 ? target.hull / target.maxHull : 1,
      isLockedTarget: target !== null,
      speedFraction: clamp01(speed / maxSpeed),
    });
    return result.amount;
  }
}
