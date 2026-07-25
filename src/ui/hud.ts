/**
 * The in-flight HUD: vitals, weapon state, 3D radar, off-screen threat arrows, lock-on reticle,
 * boss bar, banners, damage numbers, and the boundary vignette.
 *
 * Performance contract (DESIGN.md §16.2, and the brief for this module): `update()` and
 * `updateTracking()` run every simulation frame alongside a busy 3D scene, so this file never
 * calls `innerHTML`, `createElement`, or `querySelector` outside the constructor. Every DOM
 * write goes through a change-detection cache (`changed()`) so an unchanged value costs a
 * `Map.get` and nothing else. The radar is a single `<canvas>` redraw (cheap, precise, and the
 * only sane way to place N enemy blips without N DOM nodes); off-screen arrows and damage
 * numbers are fixed-size pools of pre-built elements that are shown/hidden, never
 * created/destroyed.
 */

import * as THREE from 'three';
import { ARENA } from '../core/constants';
import { palette, cssColor } from '../render/palette';

export interface HudViewModel {
  hullFraction: number;
  hullValue: number;
  hullMax: number;
  shieldFraction: number;
  shieldValue: number;
  heatFraction: number;
  venting: boolean;
  boostFraction: number;
  batteryFraction: number; // Kinetic Battery augment; hide the element when 0
  primaryName: string;
  secondaryName: string;
  secondaryCharges: number;
  secondaryCooldownFraction: number;
  chargeFraction: number; // charge-type primaries
  sectorLabel: string;
  encounterLabel: string;
  enemiesRemaining: number;
  runTime: string;
  score: number;
  salvage: number;
  driftReady: boolean;
  driftCooldownFraction: number;
  boundaryWarning: number; // 0..1
  lowHull: boolean;
}

export interface TargetView {
  count: number;
  get(
    i: number,
    outPos: THREE.Vector3,
  ): { id: number; isElite: boolean; isFiring: boolean; hullFraction: number } | null;
}

/* Tunables local to the HUD's own presentation — not gameplay, so they live here rather than
 * in core/constants.ts. */
const RADAR_RANGE = ARENA.radius * 0.55;
const RADAR_VERTICAL_RANGE = 60;
const RADAR_VERTICAL_CARET_THRESHOLD = 8;
const ARROW_POOL_SIZE = 12;
const ARROW_MARGIN = 34;
const ARROW_MIN_SCALE = 0.7;
const ARROW_MAX_SCALE = 1.6;
const ARROW_MAX_DISTANCE = ARENA.radius * 0.9;
const DAMAGE_NUMBER_POOL_SIZE = 48;
const SECONDARY_PIP_MAX = 6;
const BOSS_SEGMENT_MAX = 8;
const LEAD_PIP_TIME = 0.28;

interface ArrowSlot {
  readonly root: HTMLDivElement;
  visible: boolean;
  angleDeg: number;
  scale: number;
}

interface DamageSlot {
  readonly anchor: HTMLDivElement;
  readonly text: HTMLSpanElement;
}

/** Tiny DOM-construction helper, used only in the constructor — never in a per-frame path. */
function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent.appendChild(node);
  return node;
}

export class Hud {
  private readonly root: HTMLDivElement;
  private readonly cache = new Map<string, unknown>();

  /* Vitals */
  private readonly hullStat: HTMLDivElement;
  private readonly hullFill: HTMLDivElement;
  private readonly hullValueEl: HTMLSpanElement;
  private readonly shieldFill: HTMLDivElement;
  private readonly shieldValueEl: HTMLSpanElement;
  private readonly heatStat: HTMLDivElement;
  private readonly heatFill: HTMLDivElement;
  private readonly heatValueEl: HTMLSpanElement;
  private readonly boostFill: HTMLDivElement;
  private readonly boostValueEl: HTMLSpanElement;
  private readonly batteryRow: HTMLDivElement;
  private readonly batteryFill: HTMLDivElement;
  private readonly batteryValueEl: HTMLSpanElement;

  /* Weapons */
  private readonly primaryNameEl: HTMLDivElement;
  private readonly primaryChargeFill: HTMLDivElement;
  private readonly secondaryNameEl: HTMLDivElement;
  private readonly secondaryPips: HTMLDivElement[] = [];
  private readonly secondaryCooldownFill: HTMLDivElement;

  /* Drift */
  private readonly driftRoot: HTMLDivElement;
  private readonly driftText: HTMLSpanElement;

  /* Status strip */
  private readonly sectorEl: HTMLDivElement;
  private readonly encounterEl: HTMLDivElement;
  private readonly enemiesEl: HTMLDivElement;
  private readonly timeEl: HTMLDivElement;
  private readonly scoreEl: HTMLDivElement;
  private readonly salvageEl: HTMLDivElement;

  /* Radar */
  private readonly radarRoot: HTMLDivElement;
  private readonly radarCanvas: HTMLCanvasElement;
  private readonly radarCtx: CanvasRenderingContext2D;

  /* Boss bar */
  private readonly bossRoot: HTMLDivElement;
  private readonly bossNameEl: HTMLDivElement;
  private readonly bossFill: HTMLDivElement;
  private readonly bossPhaseEl: HTMLDivElement;
  private readonly bossSegments: HTMLDivElement[] = [];

  /* Banner */
  private readonly bannerRoot: HTMLDivElement;
  private readonly bannerTitleEl: HTMLDivElement;
  private readonly bannerSubtitleEl: HTMLDivElement;
  private bannerHideAt = 0;

  /* Off-screen arrows (pooled) */
  private readonly arrows: ArrowSlot[] = [];

  /* Damage numbers (pooled) */
  private readonly dmgLayer: HTMLDivElement;
  private readonly damageSlots: DamageSlot[] = [];
  private dmgCursor = 0;

  /* Boundary vignette */
  private readonly boundaryEl: HTMLDivElement;

  /* Full-screen overlay canvas: lock reticle + lead pip */
  private readonly overlayCanvas: HTMLCanvasElement;
  private readonly overlayCtx: CanvasRenderingContext2D;

  /* Scratch — borrowed within a single updateTracking() call, never retained. */
  private readonly scratchPos = new THREE.Vector3();
  private readonly scratchRel = new THREE.Vector3();
  private readonly scratchLocal = new THREE.Vector3();
  private readonly scratchInvQuat = new THREE.Quaternion();
  private readonly scratchCamForward = new THREE.Vector3();
  private readonly scratchToTarget = new THREE.Vector3();
  private readonly scratchNdc = new THREE.Vector3();
  private readonly lockedWorldPos = new THREE.Vector3();

  /* Lead-pip estimation: we are not handed target velocity, so the lead pip is derived from the
   * locked target's own frame-to-frame screen motion — a legible approximation that needs no
   * extra data from the caller. */
  private prevLockId = -1;
  private prevLockScreenX = 0;
  private prevLockScreenY = 0;
  private prevLockTime = 0;

  private readonly onResize = (): void => this.resizeCanvases();

  constructor(private readonly container: HTMLElement) {
    this.root = make('div', 'hud-root', container);

    /* --- Vitals ------------------------------------------------------------------------- */
    const vitals = make('div', 'hud-panel hud-vitals', this.root);
    this.hullStat = make('div', 'hud-stat hud-bar--hull', vitals);
    this.hullFill = this.buildBarStat(this.hullStat, 'Hull');
    this.hullValueEl = this.hullStat.querySelector<HTMLSpanElement>('.hud-stat-value')!;

    const shieldStat = make('div', 'hud-stat hud-bar--shield', vitals);
    this.shieldFill = this.buildBarStat(shieldStat, 'Shield');
    this.shieldValueEl = shieldStat.querySelector<HTMLSpanElement>('.hud-stat-value')!;

    this.heatStat = make('div', 'hud-stat hud-bar--heat', vitals);
    this.heatFill = this.buildBarStat(this.heatStat, 'Heat');
    this.heatValueEl = this.heatStat.querySelector<HTMLSpanElement>('.hud-stat-value')!;

    const boostStat = make('div', 'hud-stat hud-bar--boost', vitals);
    this.boostFill = this.buildBarStat(boostStat, 'Boost');
    this.boostValueEl = boostStat.querySelector<HTMLSpanElement>('.hud-stat-value')!;

    this.batteryRow = make('div', 'hud-stat hud-bar--battery', vitals);
    this.batteryFill = this.buildBarStat(this.batteryRow, 'Kinetic Battery');
    this.batteryValueEl = this.batteryRow.querySelector<HTMLSpanElement>('.hud-stat-value')!;

    /* --- Weapons -------------------------------------------------------------------------- */
    const weapons = make('div', 'hud-panel hud-weapons', this.root);
    const primaryRow = make('div', 'hud-weapon-row', weapons);
    this.primaryNameEl = make('div', 'hud-weapon-name', primaryRow);
    const primaryChargeTrack = make('div', 'hud-bar-track', primaryRow);
    this.primaryChargeFill = make('div', 'hud-bar-fill', primaryChargeTrack);

    const secondaryRow = make('div', 'hud-weapon-row', weapons);
    this.secondaryNameEl = make('div', 'hud-weapon-name', secondaryRow);
    const pipsRow = make('div', 'hud-charges', secondaryRow);
    for (let i = 0; i < SECONDARY_PIP_MAX; i++) {
      this.secondaryPips.push(make('div', 'hud-charge-pip', pipsRow));
    }
    const secondaryCdTrack = make('div', 'hud-bar-track', secondaryRow);
    this.secondaryCooldownFill = make('div', 'hud-bar-fill', secondaryCdTrack);

    /* --- Drift ------------------------------------------------------------------------- */
    this.driftRoot = make('div', 'hud-panel hud-drift', this.root);
    make('div', 'hud-drift-glyph', this.driftRoot);
    this.driftText = make('span', 'hud-drift-text', this.driftRoot);

    /* --- Status strip -------------------------------------------------------------------- */
    const status = make('div', 'hud-panel hud-status', this.root);
    this.sectorEl = this.buildStatusBlock(status, 'sector');
    this.encounterEl = this.buildStatusBlock(status, 'encounter');
    this.enemiesEl = this.buildStatusBlock(status, 'hostiles');
    this.timeEl = this.buildStatusBlock(status, 'time');
    this.scoreEl = this.buildStatusBlock(status, 'score');
    this.salvageEl = this.buildStatusBlock(status, 'salvage');

    /* --- Radar ------------------------------------------------------------------------- */
    this.radarRoot = make('div', 'hud-panel hud-radar', this.root);
    this.radarCanvas = make('canvas', '', this.radarRoot);
    const radarCtx = this.radarCanvas.getContext('2d');
    if (!radarCtx) throw new Error('[hud] 2D canvas context unavailable for radar');
    this.radarCtx = radarCtx;

    /* --- Boss bar ------------------------------------------------------------------------ */
    this.bossRoot = make('div', 'hud-panel hud-boss', this.root);
    this.bossNameEl = make('div', 'hud-boss-name', this.bossRoot);
    const bossTrack = make('div', 'hud-boss-track', this.bossRoot);
    this.bossFill = make('div', 'hud-boss-fill', bossTrack);
    for (let i = 0; i < BOSS_SEGMENT_MAX; i++) {
      this.bossSegments.push(make('div', 'hud-boss-seg', bossTrack));
    }
    this.bossPhaseEl = make('div', 'hud-boss-phase', this.bossRoot);

    /* --- Banner ------------------------------------------------------------------------- */
    this.bannerRoot = make('div', 'hud-panel hud-banner', this.root);
    this.bannerTitleEl = make('div', 'hud-banner-title', this.bannerRoot);
    this.bannerSubtitleEl = make('div', 'hud-banner-subtitle', this.bannerRoot);

    /* --- Off-screen arrows (pooled) ------------------------------------------------------ */
    const arrowLayer = make('div', 'hud-arrow-layer', this.root);
    for (let i = 0; i < ARROW_POOL_SIZE; i++) {
      const arrowEl = make('div', 'hud-arrow', arrowLayer);
      this.arrows.push({ root: arrowEl, visible: false, angleDeg: 0, scale: 1 });
    }

    /* --- Damage numbers (pooled) ---------------------------------------------------------- */
    this.dmgLayer = make('div', 'hud-dmg-layer', this.root);
    for (let i = 0; i < DAMAGE_NUMBER_POOL_SIZE; i++) {
      const anchor = make('div', 'hud-dmg', this.dmgLayer);
      const text = make('span', 'hud-dmg-text', anchor);
      this.damageSlots.push({ anchor, text });
    }

    /* --- Boundary vignette ------------------------------------------------------------- */
    this.boundaryEl = make('div', 'hud-boundary', this.root);

    /* --- Overlay canvas: lock reticle + lead pip ------------------------------------------ */
    this.overlayCanvas = make('canvas', 'hud-overlay-canvas', this.root);
    const overlayCtx = this.overlayCanvas.getContext('2d');
    if (!overlayCtx) throw new Error('[hud] 2D canvas context unavailable for overlay');
    this.overlayCtx = overlayCtx;

    this.applyPalette();
    this.resizeCanvases();
    window.addEventListener('resize', this.onResize);
  }

  /** Builds a labelled bar-stat (name + numeric readout + track/fill) and returns the fill node. */
  private buildBarStat(parent: HTMLDivElement, label: string): HTMLDivElement {
    const head = make('div', 'hud-stat-head', parent);
    make('span', 'hud-stat-name', head).textContent = label;
    make('span', 'hud-stat-value', head);
    const track = make('div', 'hud-bar-track', parent);
    return make('div', 'hud-bar-fill', track);
  }

  private buildStatusBlock(parent: HTMLDivElement, label: string): HTMLDivElement {
    const block = make('div', 'hud-status-block', parent);
    make('div', 'hud-label', block).textContent = label;
    return make('div', 'hud-status-value', block);
  }

  private resizeCanvases(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const radarW = this.radarRoot.clientWidth || 148;
    const radarH = this.radarRoot.clientHeight || 148;
    this.radarCanvas.width = Math.round(radarW * dpr);
    this.radarCanvas.height = Math.round(radarH * dpr);
    this.radarCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.overlayCanvas.width = Math.round(w * dpr);
    this.overlayCanvas.height = Math.round(h * dpr);
    this.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** True if `key`'s cached value differs from `value`; updates the cache either way. */
  private changed(key: string, value: unknown): boolean {
    if (this.cache.get(key) === value) return false;
    this.cache.set(key, value);
    return true;
  }

  private setFraction(fill: HTMLDivElement, key: string, fraction: number): void {
    const clamped = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
    if (this.changed(key, clamped)) fill.style.transform = `scaleX(${clamped})`;
  }

  private setText(el: HTMLElement, key: string, text: string): void {
    if (this.changed(key, text)) el.textContent = text;
  }

  /* -------------------------------------------------------------------------------------- */

  update(vm: HudViewModel): void {
    this.setFraction(this.hullFill, 'hullFrac', vm.hullFraction);
    this.setText(this.hullValueEl, 'hullText', `${Math.round(vm.hullValue)} / ${Math.round(vm.hullMax)}`);
    if (this.changed('lowHull', vm.lowHull)) {
      this.hullStat.classList.toggle('hud-stat--low', vm.lowHull);
    }

    this.setFraction(this.shieldFill, 'shieldFrac', vm.shieldFraction);
    this.setText(this.shieldValueEl, 'shieldText', `${Math.round(vm.shieldValue)}`);

    this.setFraction(this.heatFill, 'heatFrac', vm.heatFraction);
    this.setText(this.heatValueEl, 'heatText', `${Math.round(vm.heatFraction * 100)}%`);
    if (this.changed('venting', vm.venting)) {
      this.heatStat.classList.toggle('hud-bar--venting', vm.venting);
    }

    this.setFraction(this.boostFill, 'boostFrac', vm.boostFraction);
    this.setText(this.boostValueEl, 'boostText', `${Math.round(vm.boostFraction * 100)}%`);

    if (this.changed('batteryVisible', vm.batteryFraction > 0)) {
      this.batteryRow.style.display = vm.batteryFraction > 0 ? '' : 'none';
    }
    if (vm.batteryFraction > 0) {
      this.setFraction(this.batteryFill, 'batteryFrac', vm.batteryFraction);
      this.setText(this.batteryValueEl, 'batteryText', `${Math.round(vm.batteryFraction * 100)}%`);
    }

    this.setText(this.primaryNameEl, 'primaryName', vm.primaryName);
    this.setFraction(this.primaryChargeFill, 'chargeFrac', vm.chargeFraction);

    this.setText(this.secondaryNameEl, 'secondaryName', vm.secondaryName);
    if (this.changed('secondaryCharges', vm.secondaryCharges)) {
      for (let i = 0; i < this.secondaryPips.length; i++) {
        this.secondaryPips[i]!.classList.toggle('is-full', i < vm.secondaryCharges);
      }
    }
    this.setFraction(this.secondaryCooldownFill, 'secondaryCd', vm.secondaryCooldownFraction);

    if (this.changed('driftReady', vm.driftReady)) {
      this.driftRoot.classList.toggle('is-ready', vm.driftReady);
    }
    const driftText = vm.driftReady ? 'DRIFT READY' : `DRIFT ${Math.round(vm.driftCooldownFraction * 100)}%`;
    this.setText(this.driftText, 'driftText', driftText);

    this.setText(this.sectorEl, 'sector', vm.sectorLabel);
    this.setText(this.encounterEl, 'encounter', vm.encounterLabel);
    this.setText(this.enemiesEl, 'enemies', `${vm.enemiesRemaining}`);
    this.setText(this.timeEl, 'time', vm.runTime);
    this.setText(this.scoreEl, 'score', `${Math.round(vm.score)}`);
    this.setText(this.salvageEl, 'salvage', `${Math.round(vm.salvage)}`);

    if (this.changed('boundaryWarning', vm.boundaryWarning)) {
      this.boundaryEl.style.opacity = String(vm.boundaryWarning);
      this.boundaryEl.classList.toggle('is-danger', vm.boundaryWarning > 0.85);
    }
  }

  /**
   * Radar + off-screen arrows + lock reticle need world/camera data, so they get their own
   * per-frame entry point. A single pass over `targets` computes the radar blip, decides
   * whether the target qualifies for an off-screen arrow, and remembers the locked target's
   * world position for the reticle pass that follows.
   */
  updateTracking(
    playerPos: THREE.Vector3,
    playerQuat: THREE.Quaternion,
    camera: THREE.Camera,
    targets: TargetView,
    lockedId: number,
  ): void {
    const now = performance.now();

    // Banner auto-hide piggybacks on this guaranteed-once-per-frame hook rather than a timer.
    if (this.bannerRoot.classList.contains('is-visible') && now >= this.bannerHideAt) {
      this.bannerRoot.classList.remove('is-visible');
    }

    this.drawRadarBackground();
    this.scratchInvQuat.copy(playerQuat).invert();
    camera.getWorldDirection(this.scratchCamForward);

    let lockedFound = false;
    let arrowsUsed = 0;

    for (let i = 0; i < targets.count; i++) {
      const meta = targets.get(i, this.scratchPos);
      if (!meta) continue;

      this.drawRadarBlip(meta.id === lockedId, meta.isElite, meta.isFiring, playerPos);

      if (meta.id === lockedId) {
        lockedFound = true;
        this.lockedWorldPos.copy(this.scratchPos);
      }

      if (meta.isFiring && arrowsUsed < ARROW_POOL_SIZE) {
        if (this.assignArrow(arrowsUsed, camera, playerPos)) arrowsUsed++;
      }
    }

    for (let i = arrowsUsed; i < ARROW_POOL_SIZE; i++) this.hideArrow(i);

    this.drawOverlay(lockedFound, camera, now);
  }

  private drawRadarBackground(): void {
    const ctx = this.radarCtx;
    const w = this.radarRoot.clientWidth || 148;
    const h = this.radarRoot.clientHeight || 148;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) / 2 - 4;
    const p = palette();

    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = cssColor(p.hudDim);
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Forward marker: a small triangle at top-centre, since "up" on the radar is always the
    // player's own forward direction (the radar rotates with the ship, not the world).
    ctx.fillStyle = cssColor(p.hudPrimary);
    ctx.beginPath();
    ctx.moveTo(cx, cy - r - 2);
    ctx.lineTo(cx - 4, cy - r + 6);
    ctx.lineTo(cx + 4, cy - r + 6);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = cssColor(p.playerAccent);
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();

    // Stash geometry for drawRadarBlip in this same tick.
    this.radarGeom.cx = cx;
    this.radarGeom.cy = cy;
    this.radarGeom.r = r;
  }

  private readonly radarGeom = { cx: 0, cy: 0, r: 0 };

  /**
   * Draws one enemy blip. `this.scratchPos` holds the target's world position (written by the
   * `targets.get` call in the caller, immediately before this runs).
   */
  private drawRadarBlip(isLocked: boolean, isElite: boolean, isFiring: boolean, playerPos: THREE.Vector3): void {
    const ctx = this.radarCtx;
    const { cx, cy, r } = this.radarGeom;
    const p = palette();

    this.scratchRel.copy(this.scratchPos).sub(playerPos);
    this.scratchLocal.copy(this.scratchRel).applyQuaternion(this.scratchInvQuat);

    // Forward (-Z) maps to "up" on the canvas; local.x maps to canvas-right.
    let px = (this.scratchLocal.x / RADAR_RANGE) * r;
    let py = (this.scratchLocal.z / RADAR_RANGE) * r;
    const dist = Math.hypot(px, py);
    if (dist > r) {
      // Clamp far contacts to the rim rather than dropping them — a threat that has fallen off
      // the edge of the radar range is still a threat.
      px = (px / dist) * r;
      py = (py / dist) * r;
    }

    const verticalMag = Math.min(1, Math.abs(this.scratchLocal.y) / RADAR_VERTICAL_RANGE);
    const proximity = 1 - Math.min(1, Math.hypot(this.scratchRel.x, this.scratchRel.y, this.scratchRel.z) / RADAR_RANGE);
    const radius = 2.3 + verticalMag * 3.2;
    const alpha = 0.45 + proximity * 0.55;

    const x = cx + px;
    const y = cy + py;

    ctx.globalAlpha = alpha;
    ctx.fillStyle = isFiring ? cssColor(p.hudDanger) : cssColor(p.enemyAccent);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();

    if (isElite) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = cssColor(p.eliteAura);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(x, y, radius + 2, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (Math.abs(this.scratchLocal.y) > RADAR_VERTICAL_CARET_THRESHOLD) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = cssColor(p.hudPrimary);
      const above = this.scratchLocal.y > 0;
      const cy2 = above ? y - radius - 5 : y + radius + 5;
      ctx.beginPath();
      if (above) {
        ctx.moveTo(x, cy2 - 3);
        ctx.lineTo(x - 3, cy2 + 3);
        ctx.lineTo(x + 3, cy2 + 3);
      } else {
        ctx.moveTo(x, cy2 + 3);
        ctx.lineTo(x - 3, cy2 - 3);
        ctx.lineTo(x + 3, cy2 - 3);
      }
      ctx.closePath();
      ctx.fill();
    }

    if (isLocked) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = cssColor(p.hudPrimary);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(x, y, radius + 4, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }

  /**
   * Projects `this.scratchPos` (the current target, set by the caller) to screen space and, if
   * it is off-screen, configures pool slot `slot` as an edge arrow. Returns true if the slot
   * was used.
   */
  private assignArrow(slot: number, camera: THREE.Camera, playerPos: THREE.Vector3): boolean {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;

    this.scratchToTarget.copy(this.scratchPos).sub(camera.position);
    const inFront = this.scratchToTarget.dot(this.scratchCamForward) > 0;

    this.scratchNdc.copy(this.scratchPos).project(camera);
    let ndcX = this.scratchNdc.x;
    let ndcY = this.scratchNdc.y;
    if (!inFront) {
      // A point behind the camera projects mirrored through the origin; flip it back so the
      // arrow points toward where the threat actually is.
      ndcX = -ndcX;
      ndcY = -ndcY;
    }

    const onScreen = inFront && ndcX >= -1 && ndcX <= 1 && ndcY >= -1 && ndcY <= 1;
    if (onScreen) return false;

    const dx = ndcX || 0.0001;
    const dy = -ndcY || 0.0001; // canvas/DOM Y grows downward; NDC Y grows upward.
    const len = Math.hypot(dx, dy) || 1;
    const dirX = dx / len;
    const dirY = dy / len;

    const halfW = w / 2 - ARROW_MARGIN;
    const halfH = h / 2 - ARROW_MARGIN;
    const t = Math.min(
      dirX !== 0 ? Math.abs(halfW / dirX) : Infinity,
      dirY !== 0 ? Math.abs(halfH / dirY) : Infinity,
    );
    const px = w / 2 + dirX * t;
    const py = h / 2 + dirY * t;

    const distance = playerPos.distanceTo(this.scratchPos);
    const proximity = 1 - Math.min(1, distance / ARROW_MAX_DISTANCE);
    const scale = ARROW_MIN_SCALE + proximity * (ARROW_MAX_SCALE - ARROW_MIN_SCALE);
    const angleDeg = (Math.atan2(dirY, dirX) * 180) / Math.PI + 90;

    const arrow = this.arrows[slot]!;
    arrow.visible = true;
    if (arrow.angleDeg !== angleDeg || arrow.scale !== scale) {
      arrow.angleDeg = angleDeg;
      arrow.scale = scale;
      arrow.root.style.transform = `translate(${px}px, ${py}px) rotate(${angleDeg}deg) scale(${scale})`;
    } else {
      arrow.root.style.transform = `translate(${px}px, ${py}px) rotate(${angleDeg}deg) scale(${scale})`;
    }
    arrow.root.classList.add('is-visible');
    return true;
  }

  private hideArrow(slot: number): void {
    const arrow = this.arrows[slot]!;
    if (!arrow.visible) return;
    arrow.visible = false;
    arrow.root.classList.remove('is-visible');
  }

  /** Lock-on reticle with a lead-indicator pip, drawn on the full-screen overlay canvas. */
  private drawOverlay(lockedFound: boolean, camera: THREE.Camera, now: number): void {
    const ctx = this.overlayCtx;
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    ctx.clearRect(0, 0, w, h);
    if (!lockedFound) {
      this.prevLockId = -1;
      return;
    }

    this.scratchToTarget.copy(this.lockedWorldPos).sub(camera.position);
    const inFront = this.scratchToTarget.dot(this.scratchCamForward) > 0;
    if (!inFront) {
      this.prevLockId = -1;
      return;
    }

    this.scratchNdc.copy(this.lockedWorldPos).project(camera);
    const sx = (this.scratchNdc.x * 0.5 + 0.5) * w;
    const sy = (1 - (this.scratchNdc.y * 0.5 + 0.5)) * h;

    const p = palette();
    ctx.strokeStyle = cssColor(p.hudPrimary);
    ctx.lineWidth = 1.6;

    // Bracket reticle: four corner ticks rather than a full circle, so it reads distinctly from
    // the radar's ring markers even at a glance.
    const size = 22;
    const gap = 8;
    const corners: [number, number, number, number][] = [
      [-1, -1, 1, 0],
      [-1, -1, 0, 1],
      [1, -1, -1, 0],
      [1, -1, 0, 1],
      [-1, 1, 1, 0],
      [-1, 1, 0, -1],
      [1, 1, -1, 0],
      [1, 1, 0, -1],
    ];
    ctx.beginPath();
    for (const [ox, oy, dx, dy] of corners) {
      const cx0 = sx + ox * size;
      const cy0 = sy + oy * size;
      ctx.moveTo(cx0, cy0);
      ctx.lineTo(cx0 + dx * gap, cy0 + dy * gap);
    }
    ctx.stroke();

    // Lead pip: extrapolated from the target's own on-screen motion since last frame. No
    // velocity is handed to the HUD, so this is a screen-space estimate rather than a physical
    // lead solution — legible, and correct in direction even if approximate in magnitude.
    if (this.prevLockId === -1) {
      this.prevLockScreenX = sx;
      this.prevLockScreenY = sy;
      this.prevLockTime = now;
    }
    const dt = Math.max(0.001, (now - this.prevLockTime) / 1000);
    const vx = (sx - this.prevLockScreenX) / dt;
    const vy = (sy - this.prevLockScreenY) / dt;
    const pipX = sx + vx * LEAD_PIP_TIME;
    const pipY = sy + vy * LEAD_PIP_TIME;

    ctx.fillStyle = cssColor(p.hudWarning);
    ctx.beginPath();
    ctx.moveTo(pipX, pipY - 5);
    ctx.lineTo(pipX - 5, pipY + 4);
    ctx.lineTo(pipX + 5, pipY + 4);
    ctx.closePath();
    ctx.fill();

    this.prevLockId = 1;
    this.prevLockScreenX = sx;
    this.prevLockScreenY = sy;
    this.prevLockTime = now;
  }

  /* -------------------------------------------------------------------------------------- */

  setBossBar(visible: boolean, name: string, fraction: number, phase: number, phaseCount: number): void {
    if (this.changed('bossVisible', visible)) {
      this.bossRoot.classList.toggle('is-visible', visible);
    }
    if (!visible) return;

    this.setText(this.bossNameEl, 'bossName', name);
    this.setFraction(this.bossFill, 'bossFrac', fraction);

    if (this.changed('bossPhaseCount', phaseCount)) {
      const clamped = Math.min(phaseCount, BOSS_SEGMENT_MAX + 1);
      for (let i = 0; i < this.bossSegments.length; i++) {
        const seg = this.bossSegments[i]!;
        const showSeg = i < clamped - 1;
        seg.classList.toggle('is-visible', showSeg);
        if (showSeg) seg.style.left = `${((i + 1) / clamped) * 100}%`;
      }
    }

    this.setText(this.bossPhaseEl, 'bossPhase', `PHASE ${phase + 1} / ${phaseCount}`);
  }

  showBanner(title: string, subtitle: string, seconds: number): void {
    this.bannerTitleEl.textContent = title;
    this.bannerSubtitleEl.textContent = subtitle;
    this.bannerRoot.classList.remove('is-visible');
    // Force a reflow so re-triggering the same banner restarts its entrance animation.
    void this.bannerRoot.offsetWidth;
    this.bannerRoot.classList.add('is-visible');
    this.bannerHideAt = performance.now() + seconds * 1000;
  }

  showDamageNumber(screenX: number, screenY: number, amount: number, crit: boolean): void {
    const slot = this.damageSlots[this.dmgCursor]!;
    this.dmgCursor = (this.dmgCursor + 1) % this.damageSlots.length;

    slot.anchor.style.transform = `translate(${screenX}px, ${screenY}px)`;
    slot.anchor.classList.toggle('is-crit', crit);
    slot.text.textContent = crit ? `${Math.round(amount)}` : `${Math.round(amount)}`;

    // Restart the CSS rise/fade animation: drop the class, force a style read, re-add it.
    slot.text.classList.remove('is-anim');
    void slot.text.offsetWidth;
    slot.text.classList.add('is-anim');
    slot.anchor.classList.add('is-visible');
  }

  setVisible(v: boolean): void {
    if (this.changed('rootVisible', v)) this.root.style.display = v ? '' : 'none';
  }

  /** Re-reads the active colourblind palette and pushes it into this HUD's CSS custom properties. */
  applyPalette(): void {
    const p = palette();
    const s = this.root.style;
    s.setProperty('--hud-primary', cssColor(p.hudPrimary));
    s.setProperty('--hud-dim', cssColor(p.hudDim));
    s.setProperty('--hud-warning', cssColor(p.hudWarning));
    s.setProperty('--hud-danger', cssColor(p.hudDanger));
    s.setProperty('--hud-good', cssColor(p.hudGood));
    s.setProperty('--player-accent', cssColor(p.playerAccent));
    s.setProperty('--player-shield', cssColor(p.playerShield));
    s.setProperty('--enemy-accent', cssColor(p.enemyAccent));
    s.setProperty('--boundary', cssColor(p.arenaBoundary));
    s.setProperty('--cat-offense', cssColor(p.category[0]!));
    s.setProperty('--cat-defense', cssColor(p.category[1]!));
    s.setProperty('--cat-mobility', cssColor(p.category[2]!));
    s.setProperty('--cat-systems', cssColor(p.category[3]!));
    s.setProperty('--rarity-common', cssColor(p.rarity[0]!));
    s.setProperty('--rarity-rare', cssColor(p.rarity[1]!));
    s.setProperty('--rarity-prototype', cssColor(p.rarity[2]!));
  }

  setReduceFlash(on: boolean): void {
    this.root.classList.toggle('reduce-flash', on);
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.root.remove();
    this.cache.clear();
  }
}
