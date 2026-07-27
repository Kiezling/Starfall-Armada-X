/**
 * Shared type contract for Starfall Armada X.
 *
 * This module is the architectural contract: every other module imports from here and
 * nothing here imports from anywhere except Three.js. Changing a type in this file is a
 * cross-cutting decision, not a local one.
 *
 * Enum-like values use `as const` objects rather than TypeScript `enum` so they stay
 * erasable under `isolatedModules` and compile to plain numbers in the hot loop.
 */

import type * as THREE from 'three';

/* ------------------------------------------------------------------------------------------ */
/* Fundamentals                                                                                 */
/* ------------------------------------------------------------------------------------------ */

export const Team = {
  Player: 0,
  Enemy: 1,
  Neutral: 2,
} as const;
export type Team = (typeof Team)[keyof typeof Team];

/** Coarse run phase. Drives which systems tick and which UI is mounted. */
export const GameState = {
  Boot: 0,
  Title: 1,
  Hangar: 2,
  Playing: 3,
  Drafting: 4,
  Paused: 5,
  BossIntro: 6,
  SectorClear: 7,
  GameOver: 8,
  Victory: 9,
} as const;
export type GameState = (typeof GameState)[keyof typeof GameState];

export const Difficulty = {
  Cadet: 0,
  Pilot: 1,
  Ace: 2,
  Nightmare: 3,
} as const;
export type Difficulty = (typeof Difficulty)[keyof typeof Difficulty];

/* ------------------------------------------------------------------------------------------ */
/* Weapons                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export type PrimaryWeaponId =
  | 'pulseRepeater'
  | 'lanceDriver'
  | 'scatterVents'
  | 'arcTether'
  | 'flakBattery'
  | 'singularityCoil';

export type SecondaryWeaponId =
  | 'swarmMissiles'
  | 'novaMine'
  | 'phaseLance'
  | 'gravityWell'
  | 'aegisPulse';

export type WeaponId = PrimaryWeaponId | SecondaryWeaponId;

/** How a projectile behaves once it exists. Combined via flags on the projectile itself. */
export const ProjectileKind = {
  Linear: 0,
  Homing: 1,
  Piercing: 2,
  Proximity: 3,
  Orbit: 4,
  Beam: 5,
  Mine: 6,
  Singularity: 7,
} as const;
export type ProjectileKind = (typeof ProjectileKind)[keyof typeof ProjectileKind];

/**
 * A single live projectile. Pooled — every field is overwritten on spawn and no field may
 * hold a reference that survives release. `position`/`velocity` are owned Three vectors that
 * are mutated in place, never reassigned.
 */
export interface Projectile {
  active: boolean;
  /** Pool slot index; stable for the lifetime of the pool. */
  readonly index: number;

  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Previous position, for swept collision against fast movers. */
  prevPosition: THREE.Vector3;

  kind: ProjectileKind;
  team: Team;
  damage: number;
  radius: number;
  speed: number;
  /** Seconds remaining before self-destruct. */
  life: number;
  /** Total lifetime it was spawned with, for age-based shader effects. */
  maxLife: number;

  /** Remaining pierces; 0 means the next hit consumes it. */
  pierce: number;
  /** Remaining forks; each fork spawns children on impact. */
  fork: number;
  /** Homing turn rate in radians/second. 0 disables homing. */
  homingRate: number;
  /** Entity id of the homing target, or -1. */
  targetId: number;
  /** Proximity fuse trigger radius. 0 disables. */
  proximity: number;
  /** Area-of-effect radius applied on detonation. 0 means single-target. */
  aoe: number;

  /** Render colour index into the palette's projectile ramp. */
  colorIndex: number;
  /** Visual scale multiplier. */
  scale: number;
  /** Which weapon spawned this, for augment hooks and audio. */
  sourceWeapon: WeaponId | 'enemy' | 'boss';
  /** Owning entity id, so a shooter cannot hit itself. */
  ownerId: number;
}

/* ------------------------------------------------------------------------------------------ */
/* Enemies                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export type EnemyTypeId =
  | 'waspDrone'
  | 'interceptor'
  | 'lancer'
  | 'bulwark'
  | 'carrier'
  | 'mineLayer'
  | 'mortar'
  | 'warden';

export type BossId = 'hexard' | 'vashkan' | 'mawCore';

/** Immutable per-archetype definition. */
export interface EnemyDef {
  readonly id: EnemyTypeId;
  readonly displayName: string;
  readonly hull: number;
  readonly shield: number;
  readonly radius: number;
  /** Units per second at full throttle. */
  readonly speed: number;
  /** Radians per second. */
  readonly turnRate: number;
  /** Preferred distance from the player when engaging. */
  readonly engageRange: number;
  /** Maximum range at which it will open fire. */
  readonly fireRange: number;
  /** Seconds between attacks. */
  readonly fireInterval: number;
  readonly damage: number;
  /** Salvage awarded on death. */
  readonly salvage: number;
  /** Score awarded on death. */
  readonly score: number;
  /** Front-arc armour in radians; damage inside this cone is reduced. 0 for none. */
  readonly armorArc: number;
  readonly armorReduction: number;
  /** Threat weight used by the wave director when composing a wave budget. */
  readonly threat: number;
}

/** A live enemy. Pooled, same rules as Projectile. */
export interface Enemy {
  active: boolean;
  readonly index: number;
  /** Globally unique entity id, reassigned on each spawn. */
  id: number;

  typeId: EnemyTypeId;
  def: EnemyDef;

  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Unit forward vector; also drives the rendered orientation. */
  forward: THREE.Vector3;
  quaternion: THREE.Quaternion;

  hull: number;
  maxHull: number;
  shield: number;
  maxShield: number;

  /** Seconds until this enemy may fire again. */
  fireCooldown: number;
  /** Seconds remaining in a wind-up telegraph; > 0 means an attack is committed. */
  telegraph: number;
  /** 0..1 emissive hit-flash, decays each frame. */
  flash: number;
  /** Seconds since spawn, for warp-in animation and AI state timing. */
  age: number;

  isElite: boolean;
  /** Per-brain scratch state. Meaning is defined by the archetype's brain. */
  aiState: number;
  aiTimer: number;
  /** Stable per-instance random offset so identical enemies desync. */
  seed: number;
}

/* ------------------------------------------------------------------------------------------ */
/* Player                                                                                       */
/* ------------------------------------------------------------------------------------------ */

export type HullId = 'starfall' | 'vireo' | 'bastion' | 'wraith';

export interface HullDef {
  readonly id: HullId;
  readonly displayName: string;
  readonly description: string;
  readonly maxHull: number;
  readonly maxShield: number;
  /** Seconds out of combat before shields begin regenerating. */
  readonly shieldDelay: number;
  readonly shieldRegen: number;
  readonly maxSpeed: number;
  readonly acceleration: number;
  readonly turnRate: number;
  readonly boostMultiplier: number;
  readonly driftCooldown: number;
  readonly extraRerolls: number;
  /** Heat generated per shot is divided by this. */
  readonly heatCapacity: number;
}

/**
 * All mutable player state for a run. Augments write into `stats`; base values live on the
 * hull definition, so a stat reset is a recompute rather than a rollback.
 */
export interface PlayerState {
  hullId: HullId;
  def: HullDef;

  position: THREE.Vector3;
  velocity: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** Angular velocity as pitch/yaw/roll in radians per second. */
  angular: THREE.Vector3;

  hull: number;
  shield: number;
  heat: number;
  /** True while venting after an overheat; primary fire is locked out. */
  venting: boolean;
  /** Blink charge, 0..`PLAYER.boostMax`. Regenerates continuously; a blink spends `blinkCost`. */
  boost: number;
  /** True for the duration of a blink. Drives the speed multiplier, the trail, and the engine. */
  boosting: boolean;
  /** Seconds remaining in the current blink; <= 0 when not blinking. */
  blinkTimer: number;

  driftTimer: number;
  driftCooldown: number;
  drifting: boolean;
  /** Velocity direction locked in at drift start. */
  driftVector: THREE.Vector3;

  /** Seconds of invulnerability remaining after taking a hit. */
  invuln: number;
  /** Seconds since last damage taken, gates shield regeneration. */
  timeSinceDamage: number;

  primary: PrimaryWeaponId;
  secondary: SecondaryWeaponId;
  /** Wraith hull only: the stowed second primary. */
  altPrimary: PrimaryWeaponId | null;

  primaryCooldown: number;
  secondaryCooldown: number;
  secondaryCharges: number;
  /** 0..1 charge level for charge-type primaries. */
  charge: number;

  lockedTargetId: number;
  /** True while the player holds hard lock on a live target — drives the HUD lock state. */
  hardLock: boolean;

  stats: PlayerStats;
  alive: boolean;
}

/**
 * Derived combat statistics, recomputed from hull + augments whenever the augment set
 * changes. Multipliers are 1.0 at baseline; flat bonuses are 0.
 */
export interface PlayerStats {
  damageMult: number;
  fireRateMult: number;
  projectileSpeedMult: number;
  critChance: number;
  critMult: number;

  maxHull: number;
  maxShield: number;
  shieldRegenMult: number;
  damageReduction: number;

  speedMult: number;
  turnRateMult: number;
  boostMult: number;

  heatMult: number;
  aoeMult: number;
  /** Extra projectiles added to multi-shot weapons. */
  extraShots: number;
  /** Extra pierces granted to every projectile. */
  pierceBonus: number;
  /** Extra forks granted to every projectile. */
  forkBonus: number;
  /** Lifesteal as a fraction of damage dealt. */
  lifesteal: number;
  /** Fraction of an enemy's max HP detonated on death. 0 disables Chain Reaction. */
  chainReaction: number;

  /* --- Rule-changing flags, set by Systems augments -------------------------------------- */
  /* These are the build-defining picks. Each one is a branch in a system, not a number. */

  /** Heat no longer locks out firing; overheating detonates around the player instead. */
  overchargeVents: boolean;
  /** Every Nth shot fires a delayed phantom copy. 0 disables. */
  echoRoundsEvery: number;
  /** Damage required to charge a free Lance shot. 0 disables. */
  kineticBatteryCharge: number;
  /** Seconds of slow-motion granted by a near miss. 0 disables. */
  nearMissSlowMo: number;
  /** Shields reflect the projectile that broke them. */
  aegisReversal: boolean;
  /** Healing above max hull becomes temporary shield. */
  overhealToShield: boolean;
  /** Once-per-sector survival of an otherwise lethal hit. */
  secondWind: boolean;
  /** Damage reduction granted for 3s after taking a hit. 0 disables. */
  reactiveArmor: number;
  /** Extra damage reduction that applies only while shields are up. */
  shieldedDR: number;
  /** Fraction of shields restored when they break. */
  shieldBreakRefund: number;

  /** Bonus damage multiplier applied within `pointBlankRange`. 0 disables. */
  pointBlankBonus: number;
  pointBlankRange: number;
  /** Bonus damage multiplier against enemies below 25% hull. 0 disables. */
  executeBonus: number;
  /** Bonus damage multiplier at full speed, scaling from 0. 0 disables. */
  momentumBonus: number;
  /** Bonus damage multiplier against the currently locked target. */
  lockedTargetBonus: number;
  /** Speed multiplier granted for 2s on kill. 0 disables. */
  killSpeedBonus: number;
  /** Speed multiplier granted for 1.5s after taking damage. 0 disables. */
  hitSpeedBonus: number;
  /** Turn-rate multiplier that applies only while drifting. */
  driftTurnBonus: number;
  /** Drift cooldown multiplier. */
  driftCooldownMult: number;

  /** Homing turn rate granted to projectiles that would otherwise fly straight. */
  homingBonus: number;
  /** Salvage pickup radius multiplier. */
  magnetMult: number;
  /** Extra secondary charges. */
  secondaryCharges: number;
  secondaryCooldownMult: number;
  /** Additive bonus to the Prototype rarity weight in drafts. */
  prototypeLuck: number;
}

/* ------------------------------------------------------------------------------------------ */
/* Progression                                                                                  */
/* ------------------------------------------------------------------------------------------ */

export const AugmentCategory = {
  Offense: 0,
  Defense: 1,
  Mobility: 2,
  Systems: 3,
} as const;
export type AugmentCategory = (typeof AugmentCategory)[keyof typeof AugmentCategory];

export const Rarity = {
  Common: 0,
  Rare: 1,
  Prototype: 2,
} as const;
export type Rarity = (typeof Rarity)[keyof typeof Rarity];

export interface AugmentDef {
  readonly id: string;
  readonly name: string;
  /** Player-facing text. Must state the actual numbers. */
  readonly description: string;
  readonly category: AugmentCategory;
  readonly rarity: Rarity;
  /** How many times this augment may be taken in one run. */
  readonly maxStacks: number;
  /** True if this augment is locked behind a meta unlock. */
  readonly requiresUnlock?: boolean;
  /**
   * Applies this augment's contribution to the derived stats. Called once per stack during
   * a full recompute, so it must be a pure accumulation with no side effects.
   */
  readonly apply: (stats: PlayerStats, stacks: number) => void;
  /** Marks this augment as changing a rule rather than a number, for UI emphasis. */
  readonly ruleChanging?: boolean;
}

export interface RunState {
  seed: number;
  /** 0-based sector index; wraps with an incremented threat level. */
  sector: number;
  /** 0-based wave index within the sector. */
  wave: number;
  threatLevel: number;
  difficulty: Difficulty;

  /** Augment id -> stack count. */
  augments: Map<string, number>;
  /** Draft rerolls left for the current draft. */
  rerolls: number;
  /** Waves since the last Prototype offer, for the pity timer. */
  wavesSincePrototype: number;

  salvage: number;
  score: number;
  kills: number;
  bossesKilled: number;
  /** Seconds of elapsed run time. */
  time: number;
}

export interface MetaState {
  totalSalvage: number;
  unlockedHulls: HullId[];
  unlockedPrimaries: PrimaryWeaponId[];
  unlockedSecondaries: SecondaryWeaponId[];
  unlockedAugments: string[];
  bestSector: number;
  bestScore: number;
  runsPlayed: number;
  /** True once the player has finished the tutorial prompts. */
  onboarded: boolean;
}

/* ------------------------------------------------------------------------------------------ */
/* Settings                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export const ColorblindMode = {
  Default: 0,
  Deuteranopia: 1,
  Protanopia: 2,
  Tritanopia: 3,
} as const;
export type ColorblindMode = (typeof ColorblindMode)[keyof typeof ColorblindMode];

export const AimAssist = {
  Off: 0,
  Light: 1,
  Strong: 2,
} as const;
export type AimAssist = (typeof AimAssist)[keyof typeof AimAssist];

export interface Settings {
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;

  /** 0..1 multiplier on all camera trauma. */
  screenShake: number;
  /** 0..1 multiplier on all hit-stop durations. */
  hitStop: number;
  /** Caps bloom and removes strobing effects. */
  reduceFlash: boolean;
  showDamageNumbers: boolean;

  colorblind: ColorblindMode;
  aimAssist: AimAssist;
  difficulty: Difficulty;

  invertY: boolean;
  mouseSensitivity: number;

  /**
   * Throttle becomes a persistent setpoint that W/S ramp and then hold, instead of a key that
   * must stay down to keep moving.
   *
   * This exists for key rollover. Most non-gaming keyboards are matrix-scanned with limited
   * N-key rollover: past three or four simultaneous keys further presses are silently dropped,
   * and the arrow cluster is a frequent casualty. Nothing in software can make the hardware
   * report a key it never sent, so the only real fix is to need fewer keys held at once, and
   * throttle is the key that would otherwise be held for an entire run. This is also the
   * flight-sim convention (a throttle notch), so it costs nothing in feel.
   *
   * Fire and boost used to have matching toggle options for the same reason. They are gone:
   * boost is now a tapped blink rather than a held drain (see `PLAYER.blinkDuration`), and
   * overheat now actually latches, so sustained fire is bounded by heat rather than by how
   * long a finger can stay on a key. Neither needs a toggle any more.
   */
  cruiseThrottle: boolean;

  /** Action name -> KeyboardEvent.code. */
  keybinds: Record<string, string>;

  showPerfOverlay: boolean;
}

/* ------------------------------------------------------------------------------------------ */
/* Input                                                                                        */
/* ------------------------------------------------------------------------------------------ */

/** Named actions the game reads. Input maps devices onto this and nothing else. */
export type InputAction =
  | 'firePrimary'
  | 'fireSecondary'
  | 'pitchUp'
  | 'pitchDown'
  | 'yawLeft'
  | 'yawRight'
  | 'throttleUp'
  | 'throttleDown'
  | 'strafeLeft'
  | 'strafeRight'
  | 'rollLeft'
  | 'rollRight'
  | 'boost'
  | 'drift'
  | 'cycleTarget'
  | 'lockTarget'
  | 'swapWeapon'
  | 'reroll'
  | 'pause';

/** A snapshot of input for one simulation step. Read-only to consumers. */
export interface InputState {
  /**
   * Steering axes, -1..1. Keyboard aim keys drive these directly; a mouse or gamepad, when
   * present, writes the same two numbers. Zero means "hold the current heading".
   */
  readonly aimX: number;
  readonly aimY: number;
  /** True while the player is actively steering, which suspends lock-on tracking assist. */
  readonly steering: boolean;
  /** -1..1 throttle axis. */
  readonly throttle: number;
  /** -1..1 lateral strafe axis. */
  readonly strafe: number;
  /** -1..1 manual roll axis. */
  readonly roll: number;
  isDown(action: InputAction): boolean;
  /** True only on the first step of a press. */
  wasPressed(action: InputAction): boolean;
}

/* ------------------------------------------------------------------------------------------ */
/* Events                                                                                       */
/* ------------------------------------------------------------------------------------------ */

/**
 * The typed event map. Payloads are pooled or primitive — a handler must not retain a
 * payload object past the end of its call.
 */
export interface GameEvents {
  'player:damaged': { amount: number; dirX: number; dirY: number; dirZ: number; shieldHit: boolean };
  'player:shieldBreak': { x: number; y: number; z: number };
  'player:died': Record<string, never>;
  'player:overheat': Record<string, never>;
  'player:vented': Record<string, never>;

  'enemy:spawned': { id: number; typeId: EnemyTypeId; isElite: boolean };
  'enemy:damaged': { id: number; amount: number; crit: boolean; x: number; y: number; z: number };
  'enemy:died': { id: number; typeId: EnemyTypeId; isElite: boolean; x: number; y: number; z: number };

  'weapon:fired': { weapon: WeaponId; x: number; y: number; z: number };
  'weapon:impact': {
    weapon: WeaponId | 'enemy' | 'boss';
    x: number; y: number; z: number;
    nx: number; ny: number; nz: number;
    damage: number;
  };

  'wave:started': { sector: number; wave: number; enemyCount: number };
  'wave:cleared': { sector: number; wave: number };
  'sector:cleared': { sector: number };

  'boss:spawned': { id: BossId };
  'boss:phaseChanged': { id: BossId; phase: number };
  'boss:died': { id: BossId };

  'draft:opened': Record<string, never>;
  'draft:picked': { augmentId: string };

  'run:started': Record<string, never>;
  'run:ended': { victory: boolean; score: number; salvage: number };

  'settings:changed': Record<string, never>;
  'state:changed': { from: GameState; to: GameState };
}

export type EventName = keyof GameEvents;
export type EventHandler<K extends EventName> = (payload: GameEvents[K]) => void;

export interface EventBus {
  on<K extends EventName>(name: K, handler: EventHandler<K>): () => void;
  off<K extends EventName>(name: K, handler: EventHandler<K>): void;
  emit<K extends EventName>(name: K, payload: GameEvents[K]): void;
  clear(): void;
}

/* ------------------------------------------------------------------------------------------ */
/* System interfaces                                                                            */
/* ------------------------------------------------------------------------------------------ */

/** Quality tier chosen by the adaptive quality controller. */
export const QualityTier = {
  Ultra: 0,
  High: 1,
  Medium: 2,
  Low: 3,
} as const;
export type QualityTier = (typeof QualityTier)[keyof typeof QualityTier];

/**
 * Everything a system needs to update itself. Constructed once and mutated in place, so
 * systems may hold a reference to it for the lifetime of the game.
 */
export interface GameContext {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly events: EventBus;
  readonly settings: Settings;

  /** Scaled delta for this simulation step, in seconds. Affected by hit-stop and slow-mo. */
  dt: number;
  /** Unscaled delta, for UI and effects that must ignore time dilation. */
  rawDt: number;
  /** Total scaled elapsed seconds since the run started. */
  elapsed: number;
  /** Current global time scale, 1.0 at normal speed. */
  timeScale: number;

  state: GameState;
  quality: QualityTier;

  player: PlayerState;
  run: RunState;
  meta: MetaState;

  /** Radius of the playable sphere; sector modifiers may shrink it. */
  arenaRadius: number;
}

/** Uniform interface for every simulation and render system. */
export interface System {
  update(ctx: GameContext): void;
  /** Restore to a clean pre-run state. Must release pooled objects and reset counters. */
  reset?(): void;
  /** Release GPU resources. Called on teardown only. */
  dispose?(): void;
}
