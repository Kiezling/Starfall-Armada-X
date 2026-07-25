/**
 * Damage resolution.
 *
 * Kept as pure functions so the numbers are auditable in isolation — balance questions should
 * be answerable by reading this file, not by instrumenting a running game.
 *
 * Player damage-taking deliberately does *not* live here; it belongs to `PlayerSystem` in
 * ship/player.ts, which owns shields, invulnerability, and the augment procs that fire on being
 * hit. Splitting it across two modules would guarantee they drift apart.
 */

import { DIFFICULTY_MODS } from '../core/constants';
import { clamp01, inCone, scratchVec3A, scratchVec3B } from '../core/math';
import type { Difficulty, Enemy, PlayerStats } from '../core/types';
import type { Rng } from '../core/rng';

export interface DamageResult {
  applied: number;
  crit: boolean;
  killed: boolean;
  absorbedByShield: number;
}

/** Situational inputs for the conditional damage bonuses. */
export interface OutgoingContext {
  distance: number;
  targetHullFraction: number;
  isLockedTarget: boolean;
  /** 0..1 of the player's max speed, for Momentum Core. */
  speedFraction: number;
}

/**
 * Outgoing player damage, including every conditional bonus and the crit roll.
 *
 * Bonuses are additive with each other and multiplicative against the base. That keeps a
 * three-bonus build strong without the runaway of stacking multipliers — an important guard,
 * since several of these can be active at once by late sector 3.
 */
export function computePlayerDamage(
  base: number,
  stats: PlayerStats,
  rng: Rng,
  ctx: OutgoingContext,
): { amount: number; crit: boolean } {
  let bonus = 0;

  // Point-Blank Doctrine — rewards flying dangerously close.
  if (stats.pointBlankBonus > 0 && ctx.distance <= stats.pointBlankRange) {
    bonus += stats.pointBlankBonus;
  }

  // Executioner's Mark — finishing power against wounded targets.
  if (stats.executeBonus > 0 && ctx.targetHullFraction <= 0.25) {
    bonus += stats.executeBonus;
  }

  // Momentum Core — scales smoothly with speed rather than switching on at a threshold, so
  // there is no cliff the player has to memorise.
  if (stats.momentumBonus > 0) {
    bonus += stats.momentumBonus * clamp01(ctx.speedFraction);
  }

  // Adaptive Targeting — pays off for actually using the lock-on.
  if (stats.lockedTargetBonus > 0 && ctx.isLockedTarget) {
    bonus += stats.lockedTargetBonus;
  }

  let amount = base * stats.damageMult * (1 + bonus);

  const crit = stats.critChance > 0 && rng.next() < stats.critChance;
  if (crit) amount *= stats.critMult;

  return { amount, crit };
}

/**
 * Applies damage to an enemy, honouring its frontal armour arc.
 *
 * The arc is the whole reason the Bulwark has counterplay: hitting its face is heavily reduced,
 * hitting its flank or rear is not. A player who notices this once never forgets it.
 */
export function applyDamageToEnemy(
  enemy: Enemy,
  amount: number,
  fromX: number,
  fromY: number,
  fromZ: number,
): DamageResult {
  const result: DamageResult = { applied: 0, crit: false, killed: false, absorbedByShield: 0 };
  if (!enemy.active || amount <= 0) return result;

  let incoming = amount;

  if (enemy.def.armorArc > 0 && enemy.def.armorReduction > 0) {
    scratchVec3A.set(fromX, fromY, fromZ);
    scratchVec3B.copy(enemy.forward);
    // Half-angle: armorArc describes the full cone width.
    if (inCone(enemy.position, scratchVec3B, enemy.def.armorArc * 0.5, scratchVec3A)) {
      incoming *= 1 - enemy.def.armorReduction;
    }
  }

  // Effective damage after armour — this, not the raw request, is what the player actually
  // dealt, and what damage numbers and lifesteal should be based on.
  const effective = incoming;
  let remaining = effective;

  if (enemy.shield > 0) {
    const absorbed = Math.min(enemy.shield, remaining);
    enemy.shield -= absorbed;
    remaining -= absorbed;
    result.absorbedByShield = absorbed;
  }

  if (remaining > 0) enemy.hull -= remaining;

  enemy.flash = 1;
  result.applied = effective;

  if (enemy.hull <= 0) {
    enemy.hull = 0;
    result.killed = true;
  }
  return result;
}

/** Scales incoming enemy damage by the difficulty setting. */
export function scaleEnemyDamage(base: number, difficulty: Difficulty): number {
  const mod = DIFFICULTY_MODS[difficulty] ?? DIFFICULTY_MODS[1]!;
  return base * mod.enemyDamage;
}
