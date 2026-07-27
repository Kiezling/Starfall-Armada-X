/**
 * The game: state machine, system ownership, and the wiring between them.
 *
 * Architecture notes that matter for anyone reading this:
 *
 * - **Simulation and presentation are separated.** The simulation systems (flight, weapons,
 *   projectiles, enemies) never touch the DOM, the renderer, or the audio graph. They announce
 *   what happened on the event bus, and the wiring in `bindEvents` below turns those
 *   announcements into particles, sound, and camera shake. That is why the module graph has no
 *   cycles despite everything reacting to everything.
 *
 * - **Fixed timestep.** `simulate()` runs at exactly 60 Hz via the accumulator in GameClock, so
 *   the game behaves identically on a 60 Hz laptop and a 144 Hz monitor. Rendering happens once
 *   per animation frame regardless.
 *
 * - **`dt` versus `rawDt`.** Anything that should freeze during hit-stop takes `dt`. Anything
 *   that must keep moving through a freeze — UI, camera shake, audio — takes `rawDt`.
 */

import * as THREE from 'three';

import {
  Difficulty,
  GameState,
  type AugmentDef,
  type HullId,
  type MetaState,
  type PrimaryWeaponId,
  type InputAction,
  type RunState,
  type SecondaryWeaponId,
  type Settings,
} from './core/types';
import { ARENA, CAMERA, FEEL, LIMITS, PLAYER, RUN } from './core/constants';
import { TypedEventBus } from './core/events';
import { GameClock } from './core/time';
import { InputManager } from './core/input';
import { loadSettings, saveSettings } from './core/settings';
import { loadMeta } from './core/save';
import { Rng, randomSeed } from './core/rng';
import { clamp, clamp01, scratchVec3A, scratchVec3B, FORWARD } from './core/math';

import { RenderSystem } from './render/renderer';
import { ChaseCamera } from './render/camera';
import { Starfield, SUN_COLOR, SUN_DIRECTION } from './render/starfield';
import { Arena } from './render/arena';
import { applyEnvironment, disposeEnvironment } from './render/environment';
import { palette, setColorblindMode } from './render/palette';
import { ParticleSystem } from './render/fx/particles';
import { TrailSystem } from './render/fx/trails';
import { ImpactFX } from './render/fx/impacts';
import { ShieldFX } from './render/fx/shields';

import { audio } from './audio/engine';
import { playSfx, playSfxAt } from './audio/sfx';
import { music } from './audio/music';

import { buildShip, type ShipVisual } from './ship/geometry';
import { FlightModel } from './ship/flight';
import { PlayerSystem, createPlayerState } from './ship/player';

import { ProjectileSystem, type CombatContext } from './combat/projectiles';
import { WeaponSystem, getWeapon } from './combat/weapons';
import { TargetingSystem } from './combat/targeting';

import { EnemyManager } from './enemies/manager';
import { BossEncounter, CombinedEnemyQuery } from './enemies/bosses';
import type { BossContext } from './enemies/bosses';
import type { PlayerState } from './core/types';
import { WaveDirector } from './enemies/director';

import { rollDraft, draftOdds, takeAugment, getAugment } from './progression/augments';
import { commitRun, purchase } from './progression/meta';
import {
  AdvanceResult,
  EncounterKind,
  advanceEncounter,
  arenaRadiusFor,
  bossPowerScale,
  createRun,
  defaultLoadout,
  encounterKind,
  encounterLabel,
  formatRunTime,
  getSector,
  resetRun,
  sectorLabel,
  sectorsCleared,
} from './progression/run';

import { Hud, type HudViewModel, type TargetView } from './ui/hud';
import { DraftScreen } from './ui/draft';
import { Menus } from './ui/menus';
import { Hangar } from './ui/hangar';
import { Codex } from './ui/codex';
import './ui/styles.css';

/** Scratch reused every frame so the loop stays allocation-free. */
/** Nudges the rim light off the exact anti-sun axis so it grazes rather than back-lights. */
const RIM_OFFSET = /*#__PURE__*/ new THREE.Vector3(-40, -55, 0);
const aimDir = /*#__PURE__*/ new THREE.Vector3();
const trackDir = /*#__PURE__*/ new THREE.Vector3();
const trackPoint = /*#__PURE__*/ new THREE.Vector3();
const tmpScreen = /*#__PURE__*/ new THREE.Vector3();

export class Game {
  private readonly container: HTMLElement;

  private readonly events = new TypedEventBus();
  private readonly clock = new GameClock();
  private settings: Settings;
  private meta: MetaState;
  private rng: Rng;

  private readonly render: RenderSystem;
  private readonly chase: ChaseCamera;
  private readonly starfield: Starfield;
  private readonly arena: Arena;

  private readonly particles: ParticleSystem;
  private readonly trails: TrailSystem;
  private readonly impacts: ImpactFX;
  private readonly shields: ShieldFX;

  private readonly input: InputManager;

  private readonly playerSystem: PlayerSystem;
  private readonly flight = new FlightModel();
  private shipVisual: ShipVisual;
  private engineTrails: number[] = [];
  private playerShieldHandle = -1;

  private readonly projectiles: ProjectileSystem;
  private readonly weapons: WeaponSystem;
  private readonly targeting = new TargetingSystem();
  /**
   * The enemy roster as *targeting* sees it: the pooled enemies plus whichever boss is currently
   * targetable. Built in the constructor once `enemies` and `bosses` both exist.
   */
  private targetQuery!: CombinedEnemyQuery;
  private readonly enemies: EnemyManager;
  private readonly director: WaveDirector;
  private readonly bosses: BossEncounter;
  private readonly bossCtx: BossContext;

  private readonly hud: Hud;
  private readonly draft: DraftScreen;
  private readonly menus: Menus;
  private readonly hangar: Hangar;
  private readonly codex: Codex;

  private run: RunState;
  private state: GameState = GameState.Boot;

  private loadout: { hull: HullId; primary: PrimaryWeaponId; secondary: SecondaryWeaponId };

  /** Deferred combat context, rebuilt in place each step so it never allocates. */
  private readonly combatCtx: CombatContext;
  private readonly enemyCtx: {
    playerPos: THREE.Vector3;
    playerVel: THREE.Vector3;
    playerAlive: boolean;
    arenaRadius: number;
    elapsed: number;
    difficulty: Difficulty;
    chainReaction: number;
    onKill: (enemy: { position: THREE.Vector3; def: { salvage: number; score: number }; isElite: boolean }) => void;
  };

  private readonly targetView: TargetView;
  private readonly queryScratch = new Int32Array(LIMITS.maxQueryResults);

  private deathTimer = 0;
  private waveClearTimer = 0;
  private frameHandle = 0;
  private disposed = false;
  private speedFraction = 0;
  private boundaryWarning = 0;
  /** 0..1 saturation of the lock-tracking assist, surfaced on the HUD lock readout. */
  private lockTracking = 0;
  /** Decays to 0 in updatePresentation; the renderer holds no decay of its own. */
  private damagePulse = 0;

  constructor(container: HTMLElement) {
    this.container = container;

    this.settings = loadSettings();
    this.meta = loadMeta();
    setColorblindMode(this.settings.colorblind);
    this.rng = new Rng(randomSeed());

    // --- Rendering -----------------------------------------------------------------------
    this.render = new RenderSystem(container);
    applyEnvironment(this.render.scene, this.render.renderer);
    this.chase = new ChaseCamera(this.render.camera);
    this.starfield = new Starfield(this.render.scene, 1337);
    this.arena = new Arena(this.render.scene, 4242);

    this.addLights();

    // --- Effects -------------------------------------------------------------------------
    this.particles = new ParticleSystem(this.render.scene);
    this.trails = new TrailSystem(this.render.scene, 64);
    this.impacts = new ImpactFX(this.render.scene, this.particles);
    this.shields = new ShieldFX(this.render.scene, 32);

    // --- Input ---------------------------------------------------------------------------
    this.input = new InputManager(this.render.domElement, this.settings);

    // --- Player --------------------------------------------------------------------------
    this.loadout = defaultLoadout(this.meta);
    const playerState = createPlayerState({
      hullId: this.loadout.hull,
      primary: this.loadout.primary,
      secondary: this.loadout.secondary,
      difficulty: this.settings.difficulty,
    });
    this.playerSystem = new PlayerSystem(playerState, this.events);
    this.shipVisual = buildShip(this.loadout.hull);
    this.render.scene.add(this.shipVisual.root);
    this.acquirePlayerVisuals();

    // --- Combat --------------------------------------------------------------------------
    this.projectiles = new ProjectileSystem(this.render.scene, this.events);
    this.weapons = new WeaponSystem(this.projectiles, this.events, this.rng);
    this.enemies = new EnemyManager(this.render.scene, this.events, this.projectiles, this.rng);
    this.director = new WaveDirector(this.enemies, this.events, this.rng);
    this.bosses = new BossEncounter(this.render.scene, this.events, this.projectiles);

    this.run = createRun({ ...this.loadout, difficulty: this.settings.difficulty });

    // --- UI ------------------------------------------------------------------------------
    this.hud = new Hud(container);
    this.draft = new DraftScreen(container);
    this.menus = new Menus(container, this.settings);
    this.hangar = new Hangar(container);
    this.codex = new Codex(container);

    // --- Deferred contexts ----------------------------------------------------------------
    this.combatCtx = {
      player: playerState,
      playerAlive: true,
      arenaRadius: ARENA.radius,
      enemies: this.enemies,
      damageEnemy: (id, amount, crit, hx, hy, hz) => this.enemies.damage(id, amount, crit, hx, hy, hz),
      damagePlayer: (amount, dx, dy, dz) => {
        this.playerSystem.takeDamage(amount, dx, dy, dz);
      },
      blockedByTerrain: (fx, fy, fz, tx, ty, tz, radius) => {
        scratchVec3A.set(fx, fy, fz);
        scratchVec3B.set(tx, ty, tz);
        return this.arena.raycastAsteroids(scratchVec3A, scratchVec3B, radius) >= 0;
      },
      pullEnemies: (x, y, z, radius, strength, dt) => this.enemies.pull(x, y, z, radius, strength, dt),
    };

    this.enemyCtx = {
      playerPos: playerState.position,
      playerVel: playerState.velocity,
      playerAlive: true,
      arenaRadius: ARENA.radius,
      elapsed: 0,
      difficulty: this.settings.difficulty,
      chainReaction: 0,
      onKill: (enemy) => {
        this.run.kills += 1;
        this.run.salvage += enemy.def.salvage;
        this.run.score += enemy.def.score;
        this.playerSystem.onKill();
      },
    };

    this.bossCtx = {
      projectiles: this.projectiles,
      events: this.events,
      playerPos: playerState.position,
      playerVel: playerState.velocity,
      playerAlive: true,
      arenaRadius: ARENA.radius,
      elapsed: 0,
      onTelegraph: (x, y, z, radius, seconds, lethal) => {
        const p = palette();
        this.impacts.shockwave(x, y, z, radius, seconds, lethal ? p.telegraphLethal : p.telegraphAimed);
        playSfxAt(lethal ? 'telegraphLethal' : 'telegraph', x, y, z, 1);
      },
    };

    this.targetQuery = new CombinedEnemyQuery(this.enemies, this.bosses);

    this.targetView = {
      count: 0,
      get: (i, outPos) => {
        // Ordinals past the live pooled enemies address the boss, which `simulate` accounts for
        // when it sets `count`. Without this the boss has no radar blip and no off-screen arrow,
        // so a mobile boss that leaves the frame — Vashkan, mostly — becomes unfindable.
        if (i >= this.enemies.liveCount) {
          const boss = this.bosses.targetableEnemy;
          if (!boss) return null;
          outPos.copy(boss.position);
          return {
            id: boss.id,
            isElite: false,
            isFiring: boss.telegraph > 0,
            hullFraction: this.bosses.hullFraction,
          };
        }
        // `i` here is a plain ordinal over `[0, count)` (see the loop in hud.ts's
        // `updateTracking`), not a permanent enemy-pool slot identity — `getByIndex` expects the
        // latter (it's what spatial-grid queries return) and silently drops or mis-resolves most
        // of the roster once a few enemies have spawned and died, which was the actual cause of
        // enemies going missing from the minimap/off-screen arrows. `getLiveByOrdinal` is the
        // pool-ordinal-safe counterpart — see its doc comment in enemies/manager.ts.
        const enemy = this.enemies.getLiveByOrdinal(i);
        if (!enemy) return null;
        outPos.copy(enemy.position);
        return {
          id: enemy.id,
          isElite: enemy.isElite,
          isFiring: enemy.telegraph > 0 || enemy.fireCooldown < 0.25,
          hullFraction: enemy.maxHull > 0 ? enemy.hull / enemy.maxHull : 0,
        };
      },
    };

    this.bindEvents();
    this.bindDom();
  }

  /* Setup ------------------------------------------------------------------------------- */

  /**
   * Three-point lighting, deliberately motivated by what is actually in the sky.
   *
   * The key sits exactly on `SUN_DIRECTION`, the same vector the nebula shader draws the sun
   * along, so a hull's brightest edge always faces the visible light source. Getting that
   * agreement is most of what separates "3D models in front of a space picture" from a scene.
   *
   * The rim is the opposite hemisphere in the player's accent cyan, standing in for nebula
   * bounce, and it is what keeps a dark ship legible against dark space — a silhouette needs a
   * bright edge, not more ambient. Ambient itself stays low so metal keeps its contrast.
   */
  private addLights(): void {
    const p = palette();
    const key = new THREE.DirectionalLight(SUN_COLOR, 3.1);
    key.position.copy(SUN_DIRECTION).multiplyScalar(100);
    this.render.scene.add(key);

    const rim = new THREE.DirectionalLight(p.playerAccent, 1.35);
    rim.position.copy(SUN_DIRECTION).multiplyScalar(-100).add(RIM_OFFSET);
    this.render.scene.add(rim);

    // A dim warm kick from below, so undersides never read as flat black holes.
    const bounce = new THREE.DirectionalLight(0xff9b6a, 0.35);
    bounce.position.set(20, -90, -30);
    this.render.scene.add(bounce);

    this.render.scene.add(new THREE.AmbientLight(0x2a3448, 0.45));
  }

  private acquirePlayerVisuals(): void {
    for (const handle of this.engineTrails) this.trails.release(handle);
    this.engineTrails.length = 0;

    const p = palette();
    for (let i = 0; i < this.shipVisual.enginePoints.length; i++) {
      const handle = this.trails.acquire(p.playerEngine, 0.55, 0.45);
      if (handle >= 0) this.engineTrails.push(handle);
    }

    if (this.playerShieldHandle >= 0) this.shields.release(this.playerShieldHandle);
    this.playerShieldHandle = this.shields.acquire(4.2, p.playerShield);
  }

  /**
   * Turns simulation announcements into presentation. This is the only place that knows both
   * sides, which is what keeps every other module free of render/audio imports.
   */
  private bindEvents(): void {
    const p = palette();

    this.events.on('weapon:fired', (e) => {
      const def = getWeapon(e.weapon);
      this.impacts.muzzleFlash(e.x, e.y, e.z, aimDir.x, aimDir.y, aimDir.z, 0.6 + def.damage * 0.02, p.playerProjectile[def.colorIndex % p.playerProjectile.length]!);
      playSfx(e.weapon as never, 0.7);
      this.chase.addTrauma(0.03);
    });

    this.events.on('weapon:impact', (e) => {
      const isPlayerShot = e.weapon !== 'enemy' && e.weapon !== 'boss';
      const colour = isPlayerShot ? p.playerProjectile[0]! : p.enemyProjectile[0]!;
      this.impacts.hit(e.x, e.y, e.z, e.nx, e.ny, e.nz, e.damage, colour);
      if (e.damage > 0) playSfxAt('hitArmor', e.x, e.y, e.z, 0.35);
    });

    this.events.on('enemy:damaged', (e) => {
      if (!this.settings.showDamageNumbers) return;
      tmpScreen.set(e.x, e.y, e.z).project(this.render.camera);
      if (tmpScreen.z > 1) return;
      const sx = (tmpScreen.x * 0.5 + 0.5) * this.container.clientWidth;
      const sy = (-tmpScreen.y * 0.5 + 0.5) * this.container.clientHeight;
      this.hud.showDamageNumber(sx, sy, e.amount, e.crit);
    });

    this.events.on('enemy:died', (e) => {
      const colour = e.isElite ? p.eliteAura : p.explosionMid;
      if (e.isElite) {
        this.impacts.bigExplosion(e.x, e.y, e.z, 1.8, colour);
        this.chase.addTrauma(FEEL.traumaEliteKill);
        this.clock.applyHitStop(FEEL.hitStopEliteKill);
        playSfxAt('eliteDeath', e.x, e.y, e.z, 1);
      } else {
        this.impacts.explosion(e.x, e.y, e.z, 1, colour);
        this.chase.addTrauma(FEEL.traumaKill);
        this.clock.applyHitStop(FEEL.hitStopKill);
        playSfxAt('enemyDeathSmall', e.x, e.y, e.z, 0.8);
      }
    });

    this.events.on('enemy:spawned', (e) => {
      const enemy = this.enemies.getById(e.id);
      if (!enemy) return;
      this.impacts.warpIn(enemy.position.x, enemy.position.y, enemy.position.z, e.isElite ? 2 : 1, p.enemyAccent);
    });

    this.events.on('player:damaged', (e) => {
      this.chase.addTrauma(FEEL.traumaPlayerHit);
      this.chase.addImpulse(e.dirX, e.dirY, e.dirZ, 1.2);
      this.clock.applyHitStop(FEEL.hitStopPlayerHit);
      this.damagePulse = 1;
      playSfx('playerHit', 0.9);
      if (e.shieldHit && this.playerShieldHandle >= 0) {
        const player = this.playerSystem.state;
        this.shields.ripple(this.playerShieldHandle, player.position.x - e.dirX * 4, player.position.y - e.dirY * 4, player.position.z - e.dirZ * 4, 1);
      }
    });

    this.events.on('player:shieldBreak', (e) => {
      this.chase.addTrauma(FEEL.traumaShieldBreak);
      if (this.playerShieldHandle >= 0) this.shields.breakShield(this.playerShieldHandle, e.x, e.y, e.z);
      playSfx('shieldBreak', 1);
      audio.duck(0.5, 0.5);
    });

    this.events.on('player:overheat', () => playSfx('overheat', 0.9));
    this.events.on('player:vented', () => playSfx('vented', 0.6));
    this.events.on('player:died', () => this.onPlayerDied());

    this.events.on('boss:phaseChanged', () => {
      // Time dilation + camera punch + audio sweep, so a phase break lands as an event.
      this.clock.applyHitStop(FEEL.hitStopBossPhase);
      this.clock.setSlowMotion(FEEL.bossPhaseScale);
      this.waveClearTimer = FEEL.bossPhaseSlowMo;
      this.chase.addTrauma(FEEL.traumaBossPhase);
      this.chase.addFovPunch(6);
      playSfx('bossPhase', 1);
      audio.duck(0.4, 0.8);
    });

    this.events.on('wave:started', () => playSfx('waveStart', 0.7));
    this.events.on('wave:cleared', () => {
      playSfx('waveClear', 0.9);
      this.clock.setSlowMotion(FEEL.waveClearScale);
      this.waveClearTimer = FEEL.waveClearSlowMo;
    });
  }

  private bindDom(): void {
    window.addEventListener('resize', this.onResize);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('keydown', this.onKeyDown);
    this.render.domElement.addEventListener('pointerdown', this.onPointerDown);
  }

  /* Lifecycle --------------------------------------------------------------------------- */

  start(): void {
    this.setState(GameState.Title);
    this.showTitle();
    this.chase.snapTo(this.playerSystem.state);
    this.frameHandle = requestAnimationFrame(this.frame);
  }

  private showTitle(): void {
    this.hud.setVisible(false);
    this.menus.showTitle({
      bestSector: this.meta.bestSector,
      bestScore: this.meta.bestScore,
      runsPlayed: this.meta.runsPlayed,
      onPlay: () => this.startRun(),
      onHangar: () => this.openHangar(),
      onSettings: () => this.openSettings(),
      onCodex: () => this.openCodex(),
    });
  }

  private startRun(): void {
    this.menus.hideAll();
    this.hangar.hide();
    this.codex.hide();

    resetRun(this.run, { ...this.loadout, difficulty: this.settings.difficulty });
    this.rng = new Rng(this.run.seed);

    this.rebuildShipIfNeeded();
    this.playerSystem.reset(
      {
        hullId: this.loadout.hull,
        primary: this.loadout.primary,
        secondary: this.loadout.secondary,
        difficulty: this.settings.difficulty,
      },
      this.run.augments,
    );
    this.playerSystem.onSectorStart();

    this.projectiles.reset();
    this.weapons.reset();
    this.enemies.reset();
    this.director.reset();
    this.bosses.clear();
    this.targeting.clear();
    this.flight.reset();
    this.clock.reset();

    this.arena.reset();
    this.arena.setSector(0);
    this.starfield.setSector(0);
    this.applyArenaRadius();

    this.chase.reset();
    this.chase.snapTo(this.playerSystem.state);

    // A run that ended mid-flash must not start the next one tinted red.
    this.damagePulse = 0;
    this.render.setDamagePulse(0);
    this.render.setLowHullVignette(0);

    this.hud.setVisible(true);
    this.setState(GameState.Playing);
    this.events.emit('run:started', {});

    audio.unlock();
    music.start();
    music.setSector(0);

    this.beginEncounter();
  }

  private rebuildShipIfNeeded(): void {
    if (this.shipVisual.root.name === `ship:${this.loadout.hull}`) return;
    this.render.scene.remove(this.shipVisual.root);
    this.shipVisual.dispose();
    this.shipVisual = buildShip(this.loadout.hull);
    this.render.scene.add(this.shipVisual.root);
    this.acquirePlayerVisuals();
  }

  private beginEncounter(): void {
    const kind = encounterKind(this.run.wave);
    this.applyArenaRadius();

    if (kind === EncounterKind.Boss) {
      const sector = getSector(this.run.sector);
      const hullPoints = 2600 * bossPowerScale(this.run);
      this.bosses.start(sector.boss, hullPoints, this.arena.radius, 3);
      this.setState(GameState.BossIntro);
      this.menus.showBossIntro(this.bosses.displayName, this.bosses.subtitle, 3);
      music.setBossMode(true);
      // The director spawns nothing on a boss wave — the arena belongs to the boss.
      return;
    }

    music.setBossMode(false);
    this.director.startWave(this.run, this.arena.radius, this.playerSystem.state.position);
  }

  private applyArenaRadius(): void {
    const target = arenaRadiusFor(this.run);
    const sector = getSector(this.run.sector);
    if (sector.contracting) this.arena.shrinkTo(target, 6);
    else this.arena.setRadius(target);
    this.combatCtx.arenaRadius = target;
    this.enemyCtx.arenaRadius = target;
    this.chase.setArenaRadius(target);
  }

  /* The loop ----------------------------------------------------------------------------- */

  private readonly frame = (now: number): void => {
    if (this.disposed) return;
    this.frameHandle = requestAnimationFrame(this.frame);

    const steps = this.clock.beginFrame(now);
    const rawDt = this.clock.rawDelta;

    this.input.update(rawDt);
    audio.update(rawDt);
    music.update(rawDt);

    if (this.state === GameState.Playing || this.state === GameState.BossIntro) {
      for (let i = 0; i < steps; i++) this.simulate(this.clock.stepDelta);
    } else {
      // Menus still consume input edges, so the edge set must be cleared each frame.
      for (let i = 0; i < steps; i++) this.input.endStep();
    }

    this.updatePresentation(rawDt);
    this.render.render(rawDt);
  };

  /**
   * Unit direction from the ship to where the locked target *will be* when a shot arrives, or
   * null if nothing is locked. This — not the target's current position — is what the tracking
   * assist chases, so holding lock on a crossing target actually lands hits rather than
   * trailing behind it.
   */
  private resolveTrackDirection(player: PlayerState): THREE.Vector3 | null {
    if (this.targeting.lockedId < 0) return null;
    // The augment multiplier has to be in here: weapons launch at `projectileSpeed *
    // projectileSpeedMult`, so solving the intercept from the bare definition speed would lead
    // crossing targets by the wrong amount — and the error would grow with every stack of
    // Accelerator Coils, which is the upgrade meant to make leading *easier*.
    const speed = getWeapon(player.primary).projectileSpeed * player.stats.projectileSpeedMult;
    // Beams and other hitscan weapons report zero speed; aim them straight at the target.
    const leadSpeed = speed > 0 ? speed : 1e6;
    if (!this.targeting.getLeadPoint(trackPoint, leadSpeed, this.targetQuery)) return null;

    trackDir.copy(trackPoint).sub(player.position);
    const dist = trackDir.length();
    if (dist < 1e-3) return null;
    trackDir.multiplyScalar(1 / dist);
    return trackDir;
  }

  private simulate(dt: number): void {
    const player = this.playerSystem.state;

    this.run.time += dt;
    this.enemyCtx.elapsed = this.clock.elapsed;

    if (player.alive) {
      this.playerSystem.update(dt);

      // Targeting resolves *before* flight: the tracking assist steers toward the intercept
      // point, so it has to be this step's point, not last step's.
      // Everything targeting-facing reads `targetQuery`, not `enemies`. Bosses live outside the
      // pooled enemy system entirely — BossEncounter tests projectiles itself — so targeting was
      // never handed anything that contained one, which is why bosses could not be locked or
      // aim-assisted at all. The adapter presents the live boss through the same EnemyQuery
      // shape, so targeting.ts needs no knowledge that bosses are a separate object model.
      this.targeting.update(player, this.targetQuery, this.enemies.liveCount, this.render.camera, this.settings, dt);
      if (this.input.wasPressed('cycleTarget')) {
        this.targeting.cycle(player, this.targetQuery, this.enemies.liveCount, this.render.camera);
      }
      player.lockedTargetId = this.targeting.lockedId;

      // Hard lock is a hold, not a toggle: the assist is strongest exactly while the player is
      // asking for it, and holding a key is a clearer contract than remembering a mode.
      const hardLock = this.input.isDown('lockTarget');
      const trackDir = this.resolveTrackDirection(player);
      player.hardLock = hardLock && trackDir !== null;

      const result = this.flight.update(
        player,
        this.input,
        dt,
        this.arena.radius,
        this.playerSystem.speedBuffMult,
        trackDir,
        hardLock ? 1 : PLAYER.softLockStrength,
      );
      this.speedFraction = result.speedFraction;
      this.boundaryWarning = result.atBoundary;
      this.lockTracking = result.lockTracking;

      // Guns fire along the nose; the gimbal then traverses the shot onto the locked target's
      // intercept point when it is inside the mount's envelope, and the assist cone bends it
      // slightly toward a near-miss otherwise. Both need the *actual* launch speed — the
      // augment multiplier included — or the lead they solve for is not the lead the shot flies.
      aimDir.copy(FORWARD).applyQuaternion(player.quaternion).normalize();
      const primarySpeed = getWeapon(player.primary).projectileSpeed * player.stats.projectileSpeedMult;
      this.targeting.applyAimAssist(
        aimDir,
        player.position,
        this.targetQuery,
        this.enemies.liveCount,
        this.settings,
        primarySpeed,
      );

      this.combatCtx.playerAlive = true;
      this.weapons.update(
        player,
        { primary: this.input.isDown('firePrimary'), secondary: this.input.isDown('fireSecondary') },
        aimDir,
        this.combatCtx,
        this.targeting,
        dt,
      );

      // Wraith's weapon swap. Read here rather than off a raw keydown so it honours the
      // player's binding (and its alternate) like every other action.
      if (this.input.wasPressed('swapWeapon') && this.playerSystem.swapPrimary()) {
        playSfx('uiClick', 0.6);
      }

      if (this.weapons.consumeOverchargeDetonation()) this.overchargeDetonate();
      if (this.playerSystem.isBatteryFull) {
        this.weapons.fireKineticLance(player, aimDir);
        this.playerSystem.consumeBattery();
      }
    } else {
      this.combatCtx.playerAlive = false;
    }

    this.enemyCtx.playerAlive = player.alive;
    this.enemyCtx.difficulty = this.settings.difficulty;
    this.enemyCtx.chainReaction = player.stats.chainReaction;

    this.projectiles.update(dt, this.combatCtx);
    this.enemies.update(dt, this.enemyCtx);
    this.director.update(dt, this.run, this.arena.radius, player.position);

    this.checkNearMiss();
    this.arena.update(player.position, this.clock.elapsed, dt);
    this.chase.update(player, dt, this.clock.rawDelta, this.settings);

    if (this.waveClearTimer > 0) {
      this.waveClearTimer -= dt;
      if (this.waveClearTimer <= 0) this.clock.setSlowMotion(1);
    }

    if (this.deathTimer > 0) {
      this.deathTimer -= this.clock.rawDelta;
      if (this.deathTimer <= 0) this.finishRun(false);
    }

    if (player.alive && (this.state === GameState.Playing || this.state === GameState.BossIntro)) {
      if (this.bosses.active || this.bosses.inIntro) {
        this.bossCtx.playerAlive = player.alive;
        this.bossCtx.arenaRadius = this.arena.radius;
        this.bossCtx.elapsed = this.clock.elapsed;
        const died = this.bosses.update(this.bossCtx, dt);
        if (!this.bosses.inIntro && this.state === GameState.BossIntro) this.setState(GameState.Playing);
        if (died) this.onBossDefeated();
      } else if (this.state === GameState.Playing && this.director.isCleared) {
        this.onEncounterCleared();
      }
    }

    this.input.endStep();
  }

  /** Time Dilation Core: flying close to enemy fire slows the world briefly. */
  private checkNearMiss(): void {
    const window = this.playerSystem.state.stats.nearMissSlowMo;
    if (window <= 0) return;
    if (this.projectiles.closestEnemyShotDistance < 6) {
      this.clock.setSlowMotion(0.45);
      this.waveClearTimer = Math.max(this.waveClearTimer, window);
    }
  }

  /** Overcharge Vents converts an overheat into an area detonation around the player. */
  private overchargeDetonate(): void {
    const player = this.playerSystem.state;
    const p = palette();
    const radius = 60;
    this.impacts.bigExplosion(player.position.x, player.position.y, player.position.z, 2.2, p.explosionCore);
    this.chase.addTrauma(FEEL.traumaExplosion);
    playSfx('overheat', 1);

    const count = this.enemies.queryNear(player.position.x, player.position.y, player.position.z, radius, this.queryScratch);
    for (let i = 0; i < count; i++) {
      const enemy = this.enemies.getByIndex(this.queryScratch[i]!);
      if (!enemy) continue;
      this.enemies.damage(enemy.id, 90 * player.stats.damageMult, false, enemy.position.x, enemy.position.y, enemy.position.z);
    }
  }

  /* Encounter flow ------------------------------------------------------------------------ */

  /** Boss death: the run's biggest celebration beat, so it gets the biggest presentation. */
  private onBossDefeated(): void {
    const boss = this.bosses.current;
    if (boss) {
      const p = palette();
      // Chained explosions rather than one puff — a boss should come apart, not pop.
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        this.impacts.bigExplosion(
          boss.position.x + Math.cos(a) * boss.radius * 0.7,
          boss.position.y + Math.sin(a * 1.7) * boss.radius * 0.4,
          boss.position.z + Math.sin(a) * boss.radius * 0.7,
          2.4,
          i % 2 === 0 ? p.explosionCore : p.explosionMid,
        );
      }
      this.particles.sphereBurst(4, boss.position.x, boss.position.y, boss.position.z, 90, 220, 2.2, 2.4, p.explosionCore);
    }

    this.chase.addTrauma(1);
    this.clock.setSlowMotion(0.25);
    this.waveClearTimer = 2.0;
    playSfx('bossDeath', 1);
    this.hud.setBossBar(false, '', 0, 0, 1);
    this.bosses.clear();

    this.onEncounterCleared();
  }

  private onEncounterCleared(): void {
    const wasBoss = encounterKind(this.run.wave) === EncounterKind.Boss;
    if (wasBoss) {
      this.run.bossesKilled += 1;
      this.playerSystem.fullRepair();
      music.setBossMode(false);
    }

    const advance = advanceEncounter(this.run);

    if (advance === AdvanceResult.SectorCleared || advance === AdvanceResult.LoopCompleted) {
      const cleared = getSector(advance === AdvanceResult.LoopCompleted ? RUN.sectorCount - 1 : this.run.sector - 1);
      this.playerSystem.onSectorStart();
      this.arena.setSector(this.run.sector);
      this.starfield.setSector(this.run.sector);
      music.setSector(this.run.sector);
      this.events.emit('sector:cleared', { sector: cleared.index });
      playSfx('sectorClear', 1);
      // The sector-clear card is a modal beat, not a toast fired alongside the draft: it sits at
      // a higher z-index than the draft screen (styles.css), so showing both at once means the
      // card blocks every augment pick underneath it. `openDraft` is therefore the card's
      // *dismissal* callback, not a follow-on call — the draft cannot open until the card has
      // actually hidden itself (auto-hide timer or an early Escape/Enter), which also guarantees
      // the card never survives to be seen stuck over the next encounter. See menus.ts's
      // `showSectorClear` doc comment for the bug this replaced.
      this.menus.showSectorClear(this.run.sector, cleared.name, this.run.time, () => this.openDraft());
      return;
    }

    this.openDraft();
  }

  private openDraft(): void {
    const player = this.playerSystem.state;
    const options = rollDraft(this.rng, this.run, this.meta, player.stats, 3);

    if (options.length === 0) {
      // Nothing left to offer — skip straight to the next encounter rather than showing an
      // empty screen, which would read as a bug.
      this.beginEncounter();
      return;
    }

    this.setState(GameState.Drafting);
    this.input.exitPointerLock();
    this.events.emit('draft:opened', {});
    playSfx('draftOpen', 0.8);

    const rerolls = this.run.rerolls + player.def.extraRerolls;
    this.draft.show(
      options,
      draftOdds(this.run, player.stats),
      rerolls,
      this.run.augments,
      (augment) => this.pickAugment(augment),
      () => this.rerollDraft(),
    );
  }

  private pickAugment(augment: AugmentDef): void {
    takeAugment(this.run, augment);
    this.playerSystem.refreshStats(this.run.augments, this.settings.difficulty);
    this.events.emit('draft:picked', { augmentId: augment.id });
    playSfx('draftPick', 0.9);

    this.draft.hide();
    this.setState(GameState.Playing);
    this.beginEncounter();
  }

  private rerollDraft(): void {
    if (this.run.rerolls <= 0) return;
    this.run.rerolls -= 1;
    const player = this.playerSystem.state;
    const options = rollDraft(this.rng, this.run, this.meta, player.stats, 3);
    playSfx('uiClick', 0.7);
    this.draft.show(
      options,
      draftOdds(this.run, player.stats),
      this.run.rerolls + player.def.extraRerolls,
      this.run.augments,
      (augment) => this.pickAugment(augment),
      () => this.rerollDraft(),
    );
  }

  private onPlayerDied(): void {
    const player = this.playerSystem.state;
    this.impacts.bigExplosion(player.position.x, player.position.y, player.position.z, 3, palette().explosionCore);
    this.chase.beginDeathCam(player.position.x, player.position.y, player.position.z);
    this.clock.setSlowMotion(CAMERA.deathSlowMotion);
    this.deathTimer = CAMERA.deathDuration;
    this.input.exitPointerLock();
    playSfx('gameOver', 1);
    music.setBossMode(false);
  }

  private finishRun(victory: boolean): void {
    this.setState(GameState.GameOver);
    this.clock.setSlowMotion(1);
    this.chase.endDeathCam();
    this.hud.setVisible(false);

    const earned = commitRun(this.meta, {
      sectorReached: sectorsCleared(this.run),
      kills: this.run.kills,
      bossesKilled: this.run.bossesKilled,
      score: this.run.score,
    });

    this.events.emit('run:ended', { victory, score: this.run.score, salvage: earned });

    const taken: { name: string; stacks: number }[] = [];
    for (const [id, stacks] of this.run.augments) {
      const def = getAugment(id);
      if (def) taken.push({ name: def.name, stacks });
    }

    this.menus.showGameOver({
      victory,
      score: this.run.score,
      salvage: earned,
      sectorReached: sectorsCleared(this.run),
      kills: this.run.kills,
      time: formatRunTime(this.run.time),
      augments: taken,
      onRetry: () => this.startRun(),
      onHangar: () => this.openHangar(),
      onTitle: () => this.showTitle(),
    });
  }

  /* Menus -------------------------------------------------------------------------------- */

  private openHangar(): void {
    this.menus.hideAll();
    this.setState(GameState.Hangar);
    this.hangar.show(
      this.meta,
      (nodeId) => {
        const result = purchase(this.meta, nodeId);
        playSfx(result === 0 ? 'salvage' : 'uiBack', 0.8);
        this.hangar.refresh(this.meta);
      },
      (hull, primary, secondary) => {
        this.loadout = { hull, primary, secondary };
      },
      () => {
        this.hangar.hide();
        this.showTitle();
      },
    );
  }

  private openCodex(): void {
    this.menus.hideAll();
    this.codex.show(() => {
      this.codex.hide();
      this.showTitle();
    });
  }

  private openSettings(): void {
    this.menus.showSettings(
      () => {
        if (this.state === GameState.Paused) this.menus.showPause(this.pauseOpts());
        else this.showTitle();
      },
      (next) => this.applySettings(next),
      (action) => {
        // Hand the capture to the input manager and, when it resolves, persist the new binding
        // and rebuild the settings rows so the button stops saying "PRESS A KEY".
        this.input.beginRebind(action as InputAction, () => {
          this.applySettings(this.settings);
          this.menus.refreshSettings(this.settings);
        });
      },
    );
  }

  private applySettings(next: Settings): void {
    this.settings = next;
    saveSettings(next);
    setColorblindMode(next.colorblind);
    this.hud.applyPalette();
    this.hud.setReduceFlash(next.reduceFlash);
    this.render.setReduceFlash(next.reduceFlash);
    this.clock.hitStopIntensity = next.hitStop;
    this.input.setSettings(next);
    audio.setVolumes(next.masterVolume, next.musicVolume, next.sfxVolume);
    this.events.emit('settings:changed', {});
  }

  private pauseOpts(): { onResume: () => void; onSettings: () => void; onQuit: () => void } {
    return {
      onResume: () => this.resume(),
      onSettings: () => this.openSettings(),
      onQuit: () => {
        this.menus.hideAll();
        this.hud.setVisible(false);
        this.showTitle();
      },
    };
  }

  private pause(): void {
    if (this.state !== GameState.Playing) return;
    this.setState(GameState.Paused);
    this.input.exitPointerLock();
    this.menus.showPause(this.pauseOpts());
    audio.suspend();
  }

  private resume(): void {
    this.menus.hideAll();
    this.setState(GameState.Playing);
    this.clock.skipMissedTime(performance.now());
    audio.resume();
  }

  /* Presentation -------------------------------------------------------------------------- */

  private updatePresentation(rawDt: number): void {
    const player = this.playerSystem.state;
    const elapsed = this.clock.rawElapsed;

    this.particles.setQuality(this.render.quality);
    this.impacts.setQuality(this.render.quality);

    // Tracked every frame rather than only on sector change, because a contracting arena
    // shrinks continuously and the camera clamp has to shrink with it.
    this.chase.setArenaRadius(this.arena.radius);

    // Ship visual follows simulation state.
    this.shipVisual.root.position.copy(player.position);
    this.shipVisual.root.quaternion.copy(player.quaternion);
    this.shipVisual.setThrottle(clamp01(this.speedFraction));
    this.shipVisual.setControlSurfaces(
      clamp(player.angular.x, -1, 1),
      clamp(player.angular.y, -1, 1),
      clamp(player.angular.z, -1, 1),
    );
    this.shipVisual.update(rawDt);

    // Engine trails ride the nozzles.
    for (let i = 0; i < this.engineTrails.length; i++) {
      const local = this.shipVisual.enginePoints[i];
      if (!local) continue;
      scratchVec3A.copy(local).applyQuaternion(player.quaternion).add(player.position);
      const intensity = player.boosting ? 1 : 0.35 + this.speedFraction * 0.5;
      this.trails.push(this.engineTrails[i]!, scratchVec3A.x, scratchVec3A.y, scratchVec3A.z, player.alive ? intensity : 0);
    }

    if (this.playerShieldHandle >= 0) {
      const fraction = player.stats.maxShield > 0 ? player.shield / player.stats.maxShield : 0;
      this.shields.setState(this.playerShieldHandle, player.position.x, player.position.y, player.position.z, player.alive ? fraction : 0);
    }

    this.particles.update(elapsed, rawDt);
    this.trails.update(this.render.camera.position, rawDt);
    this.impacts.update(elapsed, rawDt, this.render.camera.position);
    this.shields.update(elapsed, rawDt);
    this.starfield.update(this.render.camera.position, elapsed, rawDt);

    music.setIntensity(this.director.intensity);

    audio.setListener(
      this.render.camera.position.x, this.render.camera.position.y, this.render.camera.position.z,
      aimDir.x, aimDir.y, aimDir.z,
      0, 1, 0,
    );

    // The renderer only stores the uniform, so the decay has to live here. Driven by rawDt
    // rather than scaled time, otherwise the hit-stop fired by the same hit would stretch
    // the flash out for as long as time is frozen.
    if (this.damagePulse > 0) {
      this.damagePulse = Math.max(0, this.damagePulse - rawDt / FEEL.damagePulseDecay);
    }
    this.render.setDamagePulse(this.damagePulse);

    const hullFraction = player.stats.maxHull > 0 ? player.hull / player.stats.maxHull : 0;
    this.render.setLowHullVignette(hullFraction < 0.3 ? 1 - hullFraction / 0.3 : 0);

    if (this.state === GameState.Playing || this.state === GameState.Drafting) {
      this.hud.update(this.buildHudViewModel(hullFraction));
      this.hud.setBossBar(
        this.bosses.active,
        this.bosses.displayName,
        this.bosses.hullFraction,
        this.bosses.phase,
        this.bosses.phaseCount,
      );
      // One extra ordinal when a boss is targetable — `targetView.get` maps anything at or past
      // `liveCount` onto it, so the boss gets a radar blip and an off-screen arrow like any
      // other hostile.
      this.targetView.count = this.enemies.liveCount + (this.bosses.targetableEnemy ? 1 : 0);
      this.hud.updateTracking(
        player.position,
        player.quaternion,
        this.render.camera,
        this.targetView,
        this.targeting.lockedId,
        player.hardLock,
        this.lockTracking,
      );
    }
  }

  private readonly hudVm: HudViewModel = {
    hullFraction: 1, hullValue: 0, hullMax: 0,
    shieldFraction: 0, shieldValue: 0,
    heatFraction: 0, venting: false,
    boostFraction: 1,
    batteryFraction: 0,
    primaryName: '', secondaryName: '',
    secondaryCharges: 0, secondaryCooldownFraction: 0,
    chargeFraction: 0,
    sectorLabel: '', encounterLabel: '',
    enemiesRemaining: 0, runTime: '', score: 0, salvage: 0,
    driftReady: true, driftCooldownFraction: 0,
    boundaryWarning: 0,
    lowHull: false,
  };

  private buildHudViewModel(hullFraction: number): HudViewModel {
    const player = this.playerSystem.state;
    const vm = this.hudVm;

    vm.hullFraction = hullFraction;
    vm.hullValue = Math.ceil(player.hull);
    vm.hullMax = Math.ceil(player.stats.maxHull);
    vm.shieldFraction = player.stats.maxShield > 0 ? player.shield / player.stats.maxShield : 0;
    vm.shieldValue = Math.ceil(player.shield);
    vm.heatFraction = player.heat / PLAYER.heatMax;
    vm.venting = player.venting;
    vm.boostFraction = player.boost / PLAYER.boostMax;
    vm.batteryFraction = this.playerSystem.batteryFraction;
    vm.primaryName = getWeapon(player.primary).displayName;
    vm.secondaryName = getWeapon(player.secondary).displayName;
    vm.secondaryCharges = player.secondaryCharges;
    vm.secondaryCooldownFraction = clamp01(player.secondaryCooldown / Math.max(0.001, getWeapon(player.secondary).cooldown));
    vm.chargeFraction = player.charge;
    vm.sectorLabel = sectorLabel(this.run);
    vm.encounterLabel = encounterLabel(this.run);
    vm.enemiesRemaining = this.director.enemiesRemaining;
    vm.runTime = formatRunTime(this.run.time);
    vm.score = this.run.score;
    vm.salvage = this.run.salvage;
    vm.driftReady = player.driftCooldown <= 0;
    vm.driftCooldownFraction = clamp01(player.driftCooldown / Math.max(0.001, player.def.driftCooldown || PLAYER.driftCooldown));
    vm.boundaryWarning = this.boundaryWarning;
    vm.lowHull = hullFraction < 0.25;

    return vm;
  }

  /* DOM handlers --------------------------------------------------------------------------- */

  private readonly onResize = (): void => this.render.resize();

  private readonly onBlur = (): void => {
    if (this.state === GameState.Playing) this.pause();
  };

  private readonly onVisibility = (): void => {
    if (document.hidden) {
      audio.suspend();
      if (this.state === GameState.Playing) this.pause();
    } else {
      this.clock.skipMissedTime(performance.now());
    }
  };

  private readonly onPointerDown = (): void => {
    // Browsers require a gesture before an AudioContext may start. Note this deliberately does
    // *not* grab pointer lock: the game is keyboard-first, and silently capturing the cursor
    // on a stray click would hand steering to a device the player may not be using.
    audio.unlock();
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (this.draft.visible && this.draft.handleKey(e.code)) return;
    if (this.hangar.visible && this.hangar.handleKey(e.code)) return;
    if (this.codex.visible && this.codex.handleKey(e.code)) return;
    if (this.menus.visible && this.menus.handleKey(e.code)) return;

    if (e.code === 'Escape' || e.code === 'KeyP') {
      if (this.state === GameState.Playing) this.pause();
      else if (this.state === GameState.Paused) this.resume();
    }
  };

  private setState(next: GameState): void {
    if (this.state === next) return;
    this.events.emit('state:changed', { from: this.state, to: next });
    this.state = next;
  }

  /* Teardown ------------------------------------------------------------------------------- */

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);

    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('keydown', this.onKeyDown);
    this.render.domElement.removeEventListener('pointerdown', this.onPointerDown);

    this.input.dispose();
    this.hud.dispose();
    this.draft.dispose();
    this.menus.dispose();
    this.hangar.dispose();
    this.codex.dispose();

    this.projectiles.dispose();
    this.enemies.dispose();
    this.bosses.dispose();
    this.particles.dispose();
    this.trails.dispose();
    this.impacts.dispose();
    this.shields.dispose();
    this.starfield.dispose();
    this.arena.dispose();
    this.shipVisual.dispose();

    music.dispose();
    audio.dispose();
    disposeEnvironment();
    this.render.dispose();
    this.events.clear();
  }
}
