/**
 * The player entity: hull, shields, heat, invulnerability, and transient augment buffs.
 *
 * This module owns *simulation* state only. It never touches the DOM, never imports the
 * renderer or the audio engine, and communicates outward purely by emitting events. The
 * wiring layer subscribes and drives the visuals. That separation is what keeps the module
 * graph acyclic and makes the whole thing testable without a canvas.
 */

import * as THREE from 'three';
import type {
  Difficulty,
  EventBus,
  HullDef,
  HullId,
  PlayerState,
  PrimaryWeaponId,
  SecondaryWeaponId,
} from '../core/types';
import { PLAYER } from '../core/constants';
import { clamp, clamp01 } from '../core/math';
import { getHull } from './hulls';
import { createBaseStats, recomputeStats } from '../progression/augments';

export interface PlayerInit {
  hullId: HullId;
  primary: PrimaryWeaponId;
  secondary: SecondaryWeaponId;
  difficulty: Difficulty;
}

/** Builds a fresh PlayerState. Called once; subsequent runs go through `reset`. */
export function createPlayerState(init: PlayerInit): PlayerState {
  const def: HullDef = getHull(init.hullId);
  const stats = createBaseStats(def, init.difficulty);

  return {
    hullId: init.hullId,
    def,

    position: new THREE.Vector3(0, 0, 0),
    velocity: new THREE.Vector3(0, 0, 0),
    quaternion: new THREE.Quaternion(),
    angular: new THREE.Vector3(0, 0, 0),

    hull: stats.maxHull,
    shield: stats.maxShield,
    heat: 0,
    venting: false,
    boost: PLAYER.boostMax,
    boosting: false,

    driftTimer: 0,
    driftCooldown: 0,
    drifting: false,
    driftVector: new THREE.Vector3(0, 0, -1),

    invuln: 0,
    timeSinceDamage: 999,

    primary: init.primary,
    secondary: init.secondary,
    altPrimary: null,

    primaryCooldown: 0,
    secondaryCooldown: 0,
    secondaryCharges: 0,
    charge: 0,

    lockedTargetId: -1,
    hardLock: false,

    stats,
    alive: true,
  };
}

/**
 * Owns the per-step bookkeeping around PlayerState: regeneration, cooldowns, and the transient
 * buffs that augments proc. Buff timers deliberately live here rather than on PlayerState so
 * every module reads one authoritative multiplier instead of reimplementing the decay.
 */
export class PlayerSystem {
  readonly state: PlayerState;
  private readonly events: EventBus;

  /** Seconds remaining on the Slipstream (on-kill) speed buff. */
  private killSpeedTimer = 0;
  /** Seconds remaining on the Evasive Protocols (on-hit) speed buff. */
  private hitSpeedTimer = 0;
  /** Seconds remaining on the Reactive Armour damage-reduction window. */
  private reactiveTimer = 0;
  /** Kinetic Battery accumulated damage. */
  private battery = 0;
  /** Second Wind is once per sector, so it needs its own consumed flag. */
  private secondWindUsed = false;
  /** Latches so the low-hull warning fires on the threshold crossing, not every frame. */
  private lowHullWarned = false;

  private ventTimer = 0;

  constructor(state: PlayerState, events: EventBus) {
    this.state = state;
    this.events = events;
  }

  /* Derived multipliers --------------------------------------------------------------------- */

  /** Combined transient speed multiplier from augment procs. */
  get speedBuffMult(): number {
    const s = this.state.stats;
    let mult = 1;
    if (this.killSpeedTimer > 0) mult *= 1 + s.killSpeedBonus;
    if (this.hitSpeedTimer > 0) mult *= 1 + s.hitSpeedBonus;
    return mult;
  }

  /** Damage reduction currently in effect, including the Reactive Armour window. */
  get effectiveDamageReduction(): number {
    const s = this.state.stats;
    let dr = s.damageReduction;
    if (this.state.shield > 0) dr += s.shieldedDR;
    if (this.reactiveTimer > 0) dr += s.reactiveArmor;
    // Hard ceiling: the player must always be killable.
    return clamp(dr, 0, 0.85);
  }

  /** 0..1 Kinetic Battery charge, for the HUD. Returns 0 when the augment is not held. */
  get batteryFraction(): number {
    const need = this.state.stats.kineticBatteryCharge;
    return need > 0 ? clamp01(this.battery / need) : 0;
  }

  get isBatteryFull(): boolean {
    const need = this.state.stats.kineticBatteryCharge;
    return need > 0 && this.battery >= need;
  }

  consumeBattery(): void {
    this.battery = 0;
  }

  /* Per-step -------------------------------------------------------------------------------- */

  update(dt: number): void {
    const p = this.state;
    if (!p.alive) return;

    if (this.killSpeedTimer > 0) this.killSpeedTimer -= dt;
    if (this.hitSpeedTimer > 0) this.hitSpeedTimer -= dt;
    if (this.reactiveTimer > 0) this.reactiveTimer -= dt;
    if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);

    p.timeSinceDamage += dt;

    this.updateHeat(dt);
    this.updateShield(dt);

    if (p.primaryCooldown > 0) p.primaryCooldown -= dt;
    if (p.secondaryCooldown > 0) p.secondaryCooldown -= dt;
  }

  /**
   * Heat cools whenever the weapon system is not adding to it. Overheating locks the guns for
   * a fixed vent — unless Overcharge Vents is held, in which case the weapon system handles
   * the detonation instead and this never latches.
   */
  private updateHeat(dt: number): void {
    const p = this.state;

    if (p.venting) {
      this.ventTimer -= dt;
      // Vent drains heat over the whole window so the meter visibly empties rather than
      // snapping to zero at the end.
      p.heat = Math.max(0, p.heat - (PLAYER.heatMax / PLAYER.ventDuration) * dt);
      if (this.ventTimer <= 0) {
        p.venting = false;
        p.heat = 0;
        this.events.emit('player:vented', {});
      }
      return;
    }

    p.heat = Math.max(0, p.heat - PLAYER.heatCooling * dt);
  }

  /** Called by the weapon system after adding heat, so the overheat check happens in one place. */
  checkOverheat(): boolean {
    const p = this.state;
    if (p.venting || p.heat < PLAYER.heatMax) return false;
    if (p.stats.overchargeVents) {
      // Overcharge Vents converts the penalty into an opportunity: the weapon system detonates
      // around the player instead of locking out, so heat becomes a resource to push.
      p.heat = 0;
      return true;
    }
    p.venting = true;
    this.ventTimer = PLAYER.ventDuration;
    this.events.emit('player:overheat', {});
    return false;
  }

  private updateShield(dt: number): void {
    const p = this.state;
    const max = p.stats.maxShield;
    if (p.shield >= max) return;
    if (p.timeSinceDamage < p.def.shieldDelay) return;

    p.shield = Math.min(max, p.shield + p.def.shieldRegen * p.stats.shieldRegenMult * dt);
  }

  /* Damage and healing ------------------------------------------------------------------------ */

  /**
   * Applies incoming damage. Returns the amount actually dealt to hull+shield, so callers can
   * drive proportional feedback.
   *
   * Order of operations matters and is deliberate: invulnerability, then damage reduction,
   * then shields, then Second Wind, then hull.
   */
  takeDamage(amount: number, dirX: number, dirY: number, dirZ: number): number {
    const p = this.state;
    if (!p.alive || p.invuln > 0 || amount <= 0) return 0;

    const reduced = amount * (1 - this.effectiveDamageReduction);
    let remaining = reduced;
    let shieldHit = false;

    if (p.shield > 0) {
      shieldHit = true;
      const absorbed = Math.min(p.shield, remaining);
      p.shield -= absorbed;
      remaining -= absorbed;

      if (p.shield <= 0) {
        // A shield break is a headline event: it must be unmissable (DESIGN §12).
        p.shield = 0;
        if (p.stats.shieldBreakRefund > 0) {
          p.shield = Math.min(p.stats.maxShield, p.stats.maxShield * p.stats.shieldBreakRefund);
        }
        this.events.emit('player:shieldBreak', { x: p.position.x, y: p.position.y, z: p.position.z });
      }
    }

    if (remaining > 0) {
      if (remaining >= p.hull && p.stats.secondWind && !this.secondWindUsed) {
        // Survive at exactly 1 hull, with a window to actually escape.
        this.secondWindUsed = true;
        p.hull = 1;
        p.invuln = 2.0;
        remaining = 0;
      } else {
        p.hull -= remaining;
      }
    }

    p.timeSinceDamage = 0;
    p.invuln = Math.max(p.invuln, PLAYER.invulnTime);
    if (p.stats.reactiveArmor > 0) this.reactiveTimer = 3.0;
    if (p.stats.hitSpeedBonus > 0) this.hitSpeedTimer = 1.5;

    this.events.emit('player:damaged', {
      amount: reduced,
      dirX,
      dirY,
      dirZ,
      shieldHit,
    });

    if (p.hull <= 0) {
      p.hull = 0;
      p.alive = false;
      this.events.emit('player:died', {});
    } else if (!this.lowHullWarned && p.hull / p.stats.maxHull < 0.25) {
      this.lowHullWarned = true;
    }

    return reduced;
  }

  /** Heals the hull, routing any excess into shields when Overheal Cells is held. */
  heal(amount: number): void {
    const p = this.state;
    if (!p.alive || amount <= 0) return;

    const room = p.stats.maxHull - p.hull;
    const toHull = Math.min(room, amount);
    p.hull += toHull;

    const excess = amount - toHull;
    if (excess > 0 && p.stats.overhealToShield) {
      p.shield = Math.min(p.stats.maxShield, p.shield + excess);
    }

    if (p.hull / p.stats.maxHull >= 0.35) this.lowHullWarned = false;
  }

  /** Feeds the Kinetic Battery and applies lifesteal. Called whenever the player deals damage. */
  onDamageDealt(amount: number): void {
    const s = this.state.stats;
    if (s.lifesteal > 0) this.heal(amount * s.lifesteal);
    if (s.kineticBatteryCharge > 0) this.battery += amount;
  }

  /** Called on every kill, for Slipstream. */
  onKill(): void {
    if (this.state.stats.killSpeedBonus > 0) this.killSpeedTimer = 2.0;
  }

  /** Second Wind recharges between sectors — that is what makes it "once per sector". */
  onSectorStart(): void {
    this.secondWindUsed = false;
  }

  /* Loadout and lifecycle ---------------------------------------------------------------------- */

  /**
   * Recomputes derived stats from the current hull and augment set, preserving the *fraction*
   * of hull and shield rather than the absolute value. Taking +60 max hull mid-run should feel
   * like a reward, not like being healed to full or suddenly injured.
   */
  refreshStats(augments: ReadonlyMap<string, number>, difficulty: Difficulty): void {
    const p = this.state;
    const hullFraction = p.stats.maxHull > 0 ? p.hull / p.stats.maxHull : 1;
    const shieldFraction = p.stats.maxShield > 0 ? p.shield / p.stats.maxShield : 1;

    p.stats = recomputeStats(p.def, augments, difficulty);

    p.hull = clamp(p.stats.maxHull * hullFraction, 1, p.stats.maxHull);
    p.shield = clamp(p.stats.maxShield * shieldFraction, 0, p.stats.maxShield);
    p.secondaryCharges = Math.max(p.secondaryCharges, 0);
  }

  setHull(hullId: HullId, difficulty: Difficulty, augments: ReadonlyMap<string, number>): void {
    this.state.hullId = hullId;
    this.state.def = getHull(hullId);
    this.state.stats = recomputeStats(this.state.def, augments, difficulty);
    this.state.hull = this.state.stats.maxHull;
    this.state.shield = this.state.stats.maxShield;
  }

  /** Full repair, awarded after each boss. */
  fullRepair(): void {
    const p = this.state;
    p.hull = p.stats.maxHull;
    p.shield = p.stats.maxShield;
    p.heat = 0;
    p.venting = false;
    this.ventTimer = 0;
    this.lowHullWarned = false;
  }

  /** Returns the player to a clean pre-run state at the origin. */
  reset(init: PlayerInit, augments: ReadonlyMap<string, number>): void {
    const p = this.state;
    p.hullId = init.hullId;
    p.def = getHull(init.hullId);
    p.stats = recomputeStats(p.def, augments, init.difficulty);

    p.position.set(0, 0, 0);
    p.velocity.set(0, 0, 0);
    p.quaternion.identity();
    p.angular.set(0, 0, 0);
    p.hardLock = false;

    p.hull = p.stats.maxHull;
    p.shield = p.stats.maxShield;
    p.heat = 0;
    p.venting = false;
    p.boost = PLAYER.boostMax;
    p.boosting = false;

    p.driftTimer = 0;
    p.driftCooldown = 0;
    p.drifting = false;
    p.driftVector.set(0, 0, -1);

    p.invuln = 0;
    p.timeSinceDamage = 999;

    p.primary = init.primary;
    p.secondary = init.secondary;
    p.altPrimary = init.hullId === 'wraith' ? 'lanceDriver' : null;

    p.primaryCooldown = 0;
    p.secondaryCooldown = 0;
    p.secondaryCharges = 0;
    p.charge = 0;
    p.lockedTargetId = -1;
    p.alive = true;

    this.killSpeedTimer = 0;
    this.hitSpeedTimer = 0;
    this.reactiveTimer = 0;
    this.battery = 0;
    this.secondWindUsed = false;
    this.lowHullWarned = false;
    this.ventTimer = 0;
  }

  /** Wraith only: swap the active primary with the stowed one. */
  swapPrimary(): boolean {
    const p = this.state;
    if (!p.altPrimary) return false;
    const previous = p.primary;
    p.primary = p.altPrimary;
    p.altPrimary = previous;
    p.charge = 0;
    p.primaryCooldown = Math.max(p.primaryCooldown, 0.25);
    return true;
  }
}
