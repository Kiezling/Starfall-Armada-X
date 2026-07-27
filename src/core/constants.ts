/**
 * Central tunables.
 *
 * Anything a designer would want to change lives here rather than buried in a system. Values
 * are in world units (roughly 1 unit = 1 metre) and seconds.
 */

/* Arena ------------------------------------------------------------------------------------- */

export const ARENA = {
  /** Base playable radius. Sector modifiers may shrink this. */
  radius: 520,
  /** Fraction of the radius at which the boundary warning and inward push begin. */
  warnFraction: 0.9,
  /** Inward acceleration applied in the warning band. */
  pushAcceleration: 90,
  /** Radius The Maw contracts to at its final phase, as a fraction of the base. */
  mawMinFraction: 0.4,
  /** Enemies spawn on a shell this far outside the arena and fly in. */
  spawnMargin: 60,
  /** Minimum distance a spawn must keep from the player. */
  minSpawnDistanceFromPlayer: 140,
} as const;

/* Simulation limits ------------------------------------------------------------------------- */

export const LIMITS = {
  maxProjectiles: 2400,
  maxEnemies: 220,
  maxParticles: 12000,
  maxDamageNumbers: 96,
  maxDebris: 400,
  /** Cap on broad-phase candidates returned for a single query. */
  maxQueryResults: 256,
  /** Spatial grid cell edge length. */
  gridCellSize: 40,
} as const;

/* Player defaults --------------------------------------------------------------------------- */

export const PLAYER = {
  /** Base forward speed at full throttle, before hull and augment multipliers. */
  baseSpeed: 115,
  /** How much of base speed reverse throttle gives. */
  reverseFraction: 0.35,
  /** Lateral strafe speed as a fraction of base speed. */
  strafeFraction: 0.55,
  /** Exponential approach factor for velocity; lower is snappier. */
  velocitySmoothing: 0.0008,

  /** Maximum pitch/yaw rate in radians per second. */
  baseTurnRate: 2.0,
  /** Angular acceleration in radians per second squared — this is what gives the ship heft. */
  angularAcceleration: 9.0,
  angularDamping: 0.0001,
  /** Manual roll rate. */
  rollRate: 2.6,
  /** Seconds for auto-levelling to return roll to arena-up. */
  autoLevelTime: 1.2,
  /** Visual bank angle at maximum yaw rate, in radians. */
  maxBankAngle: 0.75,

  boostMultiplier: 1.85,
  boostDrain: 34,
  boostRegen: 18,
  boostMax: 100,
  /** Boost must reach this much before it can be re-engaged after emptying. */
  boostRearmThreshold: 20,

  driftDuration: 1.5,
  driftCooldown: 4.0,
  /** Turn-rate bonus while drifting — drift is for pointing the nose, so it turns faster. */
  driftTurnBonus: 1.6,

  /** Seconds of invulnerability after taking a hit. */
  invulnTime: 0.6,
  /** Seconds out of combat before shields start recharging. */
  shieldDelay: 3.5,

  /**
   * Heat model arithmetic, derived from the base loadout (Pulse Repeater — "the baseline
   * every other weapon is measured against", see weapons.ts's DPS audit header):
   *
   *   Pulse Repeater generates heatPerShot / fireInterval = 5 / 0.11 = 45.45 heat/s while the
   *   trigger is held. Cooling (heatCooling, below) runs concurrently with firing — it is not
   *   gated on "not shooting" — so the real climb rate is 45.45 - heatCooling. At
   *   heatCooling = 26/s that is a net 19.45 heat/s, so a trigger held from empty reaches
   *   heatMax in 65 / 19.45 ≈ 3.34s: inside the "hold for 3-4s" target. Every other primary's
   *   heat/s (see the audit table above) sits below Pulse Repeater's except Scatter Vents,
   *   whose shotgun identity earns a faster cap on purpose (~2.9s) — that is the accepted
   *   trade for its knife-range burst damage, not an oversight.
   */
  heatMax: 65,
  /**
   * Heat shed per second, unconditionally — whether or not the lockout below is active. This
   * is also what sets recovery pace: cooling straight from heatMax to zero takes
   * heatMax / heatCooling = 65 / 26 = 2.5s, landing in the "full cool in 2-3s" target.
   */
  heatCooling: 26,
  /**
   * Heat must bleed back under this before the primary can fire again after an overheat —
   * mirrors `boostRearmThreshold`'s idiom exactly: crossing the cap latches a lockout flag
   * (`PlayerState.venting`) that clears only once heat has fallen back past this line, rather
   * than after a fixed timer, so anything that changes the cooling rate automatically changes
   * recovery time too. Set to 20% of heatMax — the same fraction `boostRearmThreshold` (20) is
   * of `boostMax` (100). Recovery time from a full cap is
   * (heatMax - heatRearmThreshold) / heatCooling = (65 - 13) / 26 = 2.0s: a brief punish, not
   * a dead zone.
   */
  heatRearmThreshold: 13,

  /** Distance the reticle sits in front of the ship, for aim projection. */
  reticleDistance: 300,

  /* Lock-on tracking assist (see FlightModel.applyTrackingAssist) ---------------------------- */
  /** Proportional gain, in 1/seconds, converging the nose onto the locked intercept point. */
  trackConvergence: 3.2,
  /** Assist rate ceiling as a fraction of the ship's own turn rate, at full lock strength. */
  trackMaxRateFraction: 0.85,
  /** Assist authority while a target is merely locked, with hard lock *not* held. */
  softLockStrength: 0.4,
} as const;

/* Camera ------------------------------------------------------------------------------------ */

export const CAMERA = {
  fovBase: 62,
  fovBoost: 78,
  fovPunch: 4,
  near: 0.5,
  far: 6000,

  /** Chase offset in the ship's local space: behind and above. */
  offsetBack: 26,
  offsetUp: 7.5,
  /** Look-ahead distance in front of the ship. */
  lookAhead: 45,

  /** Critically-damped spring smoothing time for position and rotation. */
  positionSmoothTime: 0.14,
  rotationSmoothTime: 0.1,

  /** Trauma decays this fast per second; shake magnitude is trauma squared. */
  traumaDecay: 1.6,
  maxTrauma: 1.0,
  /** Peak positional shake in world units at full trauma. */
  shakeTranslation: 1.6,
  /** Peak rotational shake in radians at full trauma. */
  shakeRotation: 0.045,
  /** Shake noise frequency. */
  shakeFrequency: 22,

  /** Death camera. */
  deathOrbitRadius: 34,
  deathOrbitSpeed: 0.5,
  deathSlowMotion: 0.25,
  deathDuration: 2.6,
} as const;

/* Game feel --------------------------------------------------------------------------------- */

export const FEEL = {
  hitStopHeavy: 0.045,
  hitStopKill: 0.025,
  hitStopEliteKill: 0.06,
  hitStopBossPhase: 0.12,
  hitStopPlayerHit: 0.07,

  traumaLightHit: 0.08,
  traumaHeavyHit: 0.22,
  traumaKill: 0.14,
  traumaEliteKill: 0.3,
  traumaPlayerHit: 0.45,
  traumaShieldBreak: 0.6,
  traumaBossPhase: 0.7,
  traumaExplosion: 0.35,

  /** Seconds of 0.35x time after the final kill of a wave. */
  waveClearSlowMo: 0.8,
  waveClearScale: 0.35,
  bossPhaseSlowMo: 0.9,
  bossPhaseScale: 0.15,

  /** Seconds an enemy's emissive hit-flash takes to fade. */
  hitFlashDecay: 0.06,
  /** Seconds the crimson damage flash + chromatic aberration takes to fade to zero. */
  damagePulseDecay: 0.4,
  /** Seconds a damage number lives. */
  damageNumberLife: 0.9,
} as const;

/* Run structure ----------------------------------------------------------------------------- */

export const RUN = {
  sectorCount: 3,
  wavesPerSector: 5,
  /** The elite wave and the boss come after the normal waves. */
  eliteWaveIndex: 5,
  bossWaveIndex: 6,
  encountersPerSector: 7,

  /** Base threat budget for sector 0, wave 0. The director spends this on enemies. */
  baseThreatBudget: 6,
  /** Threat budget added per wave within a sector. */
  threatPerWave: 3.2,
  /** Threat budget multiplier per sector. */
  threatPerSector: 1.55,
  /** Threat budget multiplier per threat level once the run loops. */
  threatPerLevel: 1.4,

  /** Enemies alive at once is capped so waves stay readable. */
  maxConcurrentEnemies: 34,
  /** Seconds between spawn pulses while a wave is still spending its budget. */
  spawnInterval: 1.8,

  /** Draft rarity weights: Common, Rare, Prototype. */
  rarityWeights: [60, 30, 10] as const,
  /** Prototype weight added per wave since the last Prototype offer. */
  prototypePity: 5,
  baseRerolls: 1,

  salvagePerSector: 100,
  salvagePerKill: 2,
  salvagePerBoss: 250,
} as const;

/* Difficulty modifiers ---------------------------------------------------------------------- */

export const DIFFICULTY_MODS = [
  // Cadet
  { enemyDamage: 0.7, playerHull: 1.3, enemyCount: 0.85, label: 'Cadet' },
  // Pilot
  { enemyDamage: 1.0, playerHull: 1.0, enemyCount: 1.0, label: 'Pilot' },
  // Ace
  { enemyDamage: 1.3, playerHull: 1.0, enemyCount: 1.3, label: 'Ace' },
  // Nightmare
  { enemyDamage: 1.6, playerHull: 0.85, enemyCount: 1.45, label: 'Nightmare' },
] as const;

/* Rendering --------------------------------------------------------------------------------- */

export const RENDER = {
  /** Device pixel ratio is capped here; beyond this the cost is not worth the sharpness. */
  maxPixelRatio: 2,
  bloomStrength: 1.15,
  bloomRadius: 0.72,
  /**
   * Low on purpose. Bloom is doing structural work here, not gilding: emissives, engine
   * nozzles, projectile bolts, and nebula cores all sit just above this, so they bleed and
   * read as light sources. Raising it back toward 0.6 makes the whole scene go inert.
   */
  bloomThreshold: 0.38,
  /** ACES exposure. Slightly hot, to bring a deliberately dark palette up off the floor. */
  exposure: 1.28,
  /** Bloom renders at this fraction of the main resolution. */
  bloomResolutionScale: 0.5,

  /** Frame-time thresholds in milliseconds that drive adaptive quality tier changes. */
  qualityDownMs: 20.5,
  qualityUpMs: 13.5,
  /** Seconds of sustained bad frame time before the tier drops. */
  qualityDwell: 1.5,

  /** Particle count multipliers per quality tier: Ultra, High, Medium, Low. */
  particleScale: [1.0, 0.75, 0.45, 0.2] as const,
} as const;

/* Weapons and gimbals ----------------------------------------------------------------------- */

export const WEAPONS = {
  /**
   * Gun gimbal half-angle in radians (15°). When a locked target's lead point falls within
   * this cone, the guns physically traverse to track the intercept point. Soft edge: full
   * traverse inside 12°, linear falloff to zero traverse at 15°. This teaches leading while
   * keeping close shots reliable.
   */
  gimbalHalfAngle: 0.262,
  /**
   * Soft-edge start for gimbal traverse, in radians (12°). Below this angle, the gimbal
   * applies at full strength. Between 12° and 15°, it fades linearly to zero.
   */
  gimbalSoftStart: 0.2094,
} as const;

/* Storage keys ------------------------------------------------------------------------------ */

export const STORAGE = {
  settings: 'starfall.settings.v2',
  meta: 'starfall.meta.v1',
} as const;
