/**
 * The Web Audio graph and mixer.
 *
 * Everything is 100% synthesised — no decoded assets, no network requests — so this module's
 * only job is plumbing: a mixer bus per category, a limiter so a wall of explosions never
 * clips, a ducking stage so critical cues cut through, and a small pool of panner nodes so
 * positional playback doesn't allocate a new node per shot.
 *
 * The AudioContext is created lazily inside `unlock()` rather than the constructor, because
 * autoplay policy requires the context to be created (or resumed) from within a user gesture
 * handler. Construction is wrapped in try/catch: some browsers (locked-down incognito modes,
 * certain embeds) throw on `new AudioContext()`. In that case `ready` simply stays false and
 * every other method quietly no-ops — a missing audio backend must never crash the game.
 */

import { ARENA } from '../core/constants';
import { clamp01 } from '../core/math';

/** Concurrent SFX voices allowed before the oldest is stolen. Keeps heavy waves from piling up
 *  unbounded oscillators — the actual synthesis cost, not just the gain math, is what melts down. */
const VOICE_BUDGET = 24;

/** Panner nodes are comparatively expensive to construct, so a fixed pool is built once and
 *  reused. Smaller than VOICE_BUDGET because not every voice is positional; when the pool is
 *  exhausted `acquirePanner` returns null and the caller falls back to non-positional playback. */
const PANNER_POOL_SIZE = 16;

/** Opaque token handed back by `allocateVoice`; sfx.ts holds onto it only to pass to
 *  `releaseVoice` later. */
export interface VoiceToken {
  stop: () => void;
  /** AudioContext-clock time this voice is expected to have finished by. Infinity for loops,
   *  which are only ever removed by an explicit `releaseVoice` or by being stolen. */
  endsAt: number;
}

interface PannerSlot {
  node: PannerNode;
  busy: boolean;
  freeAt: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private _ready = false;

  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private _sfxBus: GainNode | null = null;
  private _musicBus: GainNode | null = null;
  /** Hidden post-bus gain stages that `duck()` automates, kept separate from the buses
   *  themselves so a volume-slider change and an active duck never fight over the same param. */
  private sfxDuck: GainNode | null = null;
  private musicDuck: GainNode | null = null;

  private voices: VoiceToken[] = [];
  private panners: PannerSlot[] = [];

  /** Must be called from a user gesture. Creates the AudioContext on first call, builds the
   *  mixer graph, and resumes it if a browser has it suspended. Safe to call every time the
   *  player interacts with the page — repeat calls are cheap resumes, not rebuilds. */
  unlock(): void {
    try {
      if (!this.ctx) {
        type Ctor = typeof AudioContext;
        // AudioContext is declared as a global var rather than a member of the Window
        // interface, so it has to be reached through globalThis to type-check.
        const g = globalThis as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
        const AudioCtor = g.AudioContext ?? g.webkitAudioContext;
        if (!AudioCtor) return; // No Web Audio in this environment; stay silently unready.
        const ctx = new AudioCtor();

        const master = ctx.createGain();
        const compressor = ctx.createDynamicsCompressor();
        const sfxBus = ctx.createGain();
        const musicBus = ctx.createGain();
        const sfxDuck = ctx.createGain();
        const musicDuck = ctx.createGain();

        // Gentle bus limiter: catches the sum of simultaneous explosions/weapons without
        // audibly squashing a single shot.
        compressor.threshold.value = -18;
        compressor.knee.value = 24;
        compressor.ratio.value = 12;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.25;

        sfxBus.connect(sfxDuck);
        sfxDuck.connect(compressor);
        musicBus.connect(musicDuck);
        musicDuck.connect(compressor);
        compressor.connect(master);
        master.connect(ctx.destination);

        this.ctx = ctx;
        this.master = master;
        this.compressor = compressor;
        this._sfxBus = sfxBus;
        this._musicBus = musicBus;
        this.sfxDuck = sfxDuck;
        this.musicDuck = musicDuck;
        this._ready = true;
      }
      // Re-read through a local: the graph build above may have bailed out and left ctx null.
      const ctx = this.ctx;
      if (ctx && ctx.state === 'suspended') void ctx.resume();
    } catch {
      // Construction or graph setup threw. Leave everything null/unready rather than half-built.
      this.ctx = null;
      this.master = null;
      this.compressor = null;
      this._sfxBus = null;
      this._musicBus = null;
      this.sfxDuck = null;
      this.musicDuck = null;
      this._ready = false;
    }
  }

  get ready(): boolean {
    return this._ready;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  get sfxBus(): GainNode | null {
    return this._sfxBus;
  }

  get musicBus(): GainNode | null {
    return this._musicBus;
  }

  setVolumes(master: number, music: number, sfx: number): void {
    if (!this._ready || !this.ctx || !this.master || !this._musicBus || !this._sfxBus) return;
    const now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(clamp01(master), now, 0.05);
    this._musicBus.gain.setTargetAtTime(clamp01(music), now, 0.05);
    this._sfxBus.gain.setTargetAtTime(clamp01(sfx), now, 0.05);
  }

  /** Ducks the music and SFX buses for `seconds`, down to `amount` (0..1), then recovers
   *  smoothly. The cue that triggers the duck is itself on the SFX bus and starts at the same
   *  instant the duck begins — `setTargetAtTime`'s exponential approach means its first,
   *  loudest transient is barely attenuated, so it still reads as "on top of" the mix. */
  duck(amount: number, seconds: number): void {
    if (!this._ready || !this.ctx || !this.sfxDuck || !this.musicDuck) return;
    const now = this.ctx.currentTime;
    const target = clamp01(amount);
    const dur = Math.max(seconds, 0);
    for (const g of [this.sfxDuck, this.musicDuck]) {
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(g.gain.value, now);
      g.gain.setTargetAtTime(target, now, 0.05);
      g.gain.setTargetAtTime(1, now + dur, 0.3);
    }
  }

  /** Positions the Web Audio listener at the camera/player each frame so PannerNode output
   *  pans and attenuates correctly. Direct `.value` writes rather than scheduled ramps — this
   *  runs once per frame and scheduling overhead here would be pure waste. */
  setListener(
    px: number, py: number, pz: number,
    fx: number, fy: number, fz: number,
    ux: number, uy: number, uz: number,
  ): void {
    if (!this._ready || !this.ctx) return;
    const l = this.ctx.listener;
    l.positionX.value = px; l.positionY.value = py; l.positionZ.value = pz;
    l.forwardX.value = fx; l.forwardY.value = fy; l.forwardZ.value = fz;
    l.upX.value = ux; l.upY.value = uy; l.upZ.value = uz;
  }

  /** Hands out a pooled PannerNode already wired into the SFX bus, or null if every slot is
   *  busy (heavy wave, lots of off-screen fire) — callers must fall back to non-positional
   *  playback rather than block. `holdSeconds` should roughly match the caller's sound
   *  duration so the slot frees itself without needing an explicit release. */
  acquirePanner(holdSeconds: number): PannerNode | null {
    if (!this._ready || !this.ctx || !this._sfxBus) return null;
    if (this.panners.length === 0) this.buildPannerPool(this.ctx, this._sfxBus);
    const now = this.ctx.currentTime;
    const slot = this.panners.find((p) => !p.busy || p.freeAt <= now);
    if (!slot) return null;
    slot.busy = true;
    slot.freeAt = now + Math.max(holdSeconds, 0.05);
    slot.node.positionX.value = 0;
    slot.node.positionY.value = 0;
    slot.node.positionZ.value = 0;
    return slot.node;
  }

  /** Explicit early release for a panner acquired with a generous `holdSeconds`. Optional —
   *  slots reclaim themselves once `freeAt` passes regardless. */
  releasePanner(node: PannerNode): void {
    const slot = this.panners.find((p) => p.node === node);
    if (slot) slot.busy = false;
  }

  private buildPannerPool(ctx: AudioContext, dest: GainNode): void {
    for (let i = 0; i < PANNER_POOL_SIZE; i++) {
      const node = ctx.createPanner();
      node.panningModel = 'equalpower'; // HRTF is needless cost for arena-scale weapon fire.
      node.distanceModel = 'inverse';
      node.refDistance = 50;
      node.maxDistance = ARENA.radius + ARENA.spawnMargin * 2;
      node.rolloffFactor = 1;
      node.connect(dest);
      this.panners.push({ node, busy: false, freeAt: 0 });
    }
  }

  /** Registers a new voice's stop callback for budget tracking. If the budget is exceeded the
   *  oldest voice is stolen (stopped immediately) to make room — this is what stands between a
   *  heavy wave and an ever-growing pile of live oscillators. Returns a token to pass to
   *  `releaseVoice` when the sound ends (naturally, or via `stopLoop`). */
  allocateVoice(stop: () => void, durationSeconds: number): VoiceToken {
    const entry: VoiceToken = { stop, endsAt: (this.ctx?.currentTime ?? 0) + durationSeconds };
    this.voices.push(entry);
    if (this.voices.length > VOICE_BUDGET) {
      const oldest = this.voices.shift();
      if (oldest && oldest !== entry) oldest.stop();
    }
    return entry;
  }

  releaseVoice(token: VoiceToken): void {
    const i = this.voices.indexOf(token);
    if (i >= 0) this.voices.splice(i, 1);
  }

  /** Driven by the caller's frame loop. Prunes voices whose scheduled envelope has certainly
   *  finished, so long a session doesn't slowly grow the tracking array from callers that
   *  forget to release (loops always release explicitly via `stopLoop`, so they're unaffected
   *  — their `endsAt` is Infinity). */
  update(rawDt: number): void {
    void rawDt;
    if (!this._ready || !this.ctx) return;
    const now = this.ctx.currentTime;
    while (this.voices.length > 0 && this.voices[0].endsAt <= now) this.voices.shift();
  }

  /** Visibility-change handling is the caller's responsibility (this module has no DOM
   *  listeners of its own) — it just needs somewhere safe to route suspend/resume. */
  suspend(): void {
    if (!this._ready || !this.ctx) return;
    if (this.ctx.state === 'running') void this.ctx.suspend();
  }

  resume(): void {
    if (!this._ready || !this.ctx) return;
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  dispose(): void {
    if (!this.ctx) return;
    for (const v of this.voices) {
      try { v.stop(); } catch { /* already stopped */ }
    }
    this.voices.length = 0;
    for (const p of this.panners) {
      try { p.node.disconnect(); } catch { /* already disconnected */ }
    }
    this.panners.length = 0;
    try {
      this._sfxBus?.disconnect();
      this._musicBus?.disconnect();
      this.sfxDuck?.disconnect();
      this.musicDuck?.disconnect();
      this.compressor?.disconnect();
      this.master?.disconnect();
    } catch { /* nodes may already be disconnected */ }
    void this.ctx.close();
    this.ctx = null;
    this.master = null;
    this.compressor = null;
    this._sfxBus = null;
    this._musicBus = null;
    this.sfxDuck = null;
    this.musicDuck = null;
    this._ready = false;
  }
}

export const audio = new AudioEngine();
