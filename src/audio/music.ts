/**
 * Procedural layered score.
 *
 * Four persistent layers — drone, arp, percussion, boss bass — are built once and never torn
 * down mid-track; only their gain (per-layer level) and per-note AudioParam automation change
 * as intensity/sector/boss-mode shift. This is what keeps the node count flat regardless of how
 * long a run lasts, which matters because this runs alongside a busy 3D scene.
 *
 * Note timing uses a classic lookahead scheduler: a `setInterval` timer wakes up every 25ms and
 * schedules any notes due to start within the next 200ms using the AudioContext's own sample
 * clock (`setValueAtTime` etc.). The *audible* timing is therefore Web-Audio-accurate regardless
 * of GC pauses or frame-rate hitches in the timer callback itself — only "did we wake up in time
 * to queue the next note" depends on the timer, and 200ms of lookahead is a large safety margin
 * for that. Driving this from `requestAnimationFrame` instead would tie musical timing to
 * render frame rate, which is exactly what this avoids.
 */

import { audio } from './engine';
import { clamp01, lerp, remap } from '../core/math';

const STEP_DURATION = 0.3; // eighth notes at 100 BPM
const LOOKAHEAD = 0.2;
const SCHEDULE_INTERVAL_MS = 25;

/** Minor-mode root notes, one per sector — a fixed set so a sector transition reads as a
 *  deliberate key change rather than a random retune. */
const SECTOR_ROOTS = [110, 98, 130.81] as const; // A2, G2, C3

/** Natural minor (Aeolian) scale, semitone offsets from the root. */
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10] as const;

/** Scale-degree indices the arp cycles through, one octave above the drone root. */
const ARP_PATTERN = [0, 2, 4, 3, 5, 4, 2, 1] as const;

/** Semitone offsets from the root for the boss bass line — root/fifth/root/third, driving eighths. */
const BASS_PATTERN = [0, 0, 7, 0, 5, 0, 7, 3] as const;

function freqFromSemitones(root: number, semitones: number): number {
  return root * Math.pow(2, semitones / 12);
}

let sharedNoise: AudioBuffer | null = null;
let sharedNoiseCtx: AudioContext | null = null;

/** A short noise buffer for the percussive layer, generated once and looped — the "hit" is the
 *  envelope gating it, not the buffer itself, so one source node serves every hit. */
function getPercNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (sharedNoise && sharedNoiseCtx === ctx) return sharedNoise;
  const len = Math.floor(ctx.sampleRate * 1);
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  sharedNoise = buffer;
  sharedNoiseCtx = ctx;
  return buffer;
}

export class MusicDirector {
  private ctx: AudioContext | null = null;
  private dest: GainNode | null = null;

  private wantsToPlay = false;
  private built = false;
  private timer: number | null = null;
  private step = 0;
  private nextStepTime = 0;

  private intensity = 0;
  private bossMode = false;
  private root: number = SECTOR_ROOTS[0];

  private droneGain: GainNode | null = null;
  private droneOscA: OscillatorNode | null = null;
  private droneOscB: OscillatorNode | null = null;

  private arpLayerGain: GainNode | null = null;
  private arpEnvGain: GainNode | null = null;
  private arpOsc: OscillatorNode | null = null;

  private percLayerGain: GainNode | null = null;
  private percEnvGain: GainNode | null = null;
  private percFilter: BiquadFilterNode | null = null;
  private percNoise: AudioBufferSourceNode | null = null;

  private bassLayerGain: GainNode | null = null;
  private bassEnvGain: GainNode | null = null;
  private bassOsc: OscillatorNode | null = null;

  /** Bound once as a field so it can be handed to `setInterval` without a fresh closure per call. */
  private readonly tick = (): void => {
    if (!this.ctx) return;
    while (this.nextStepTime < this.ctx.currentTime + LOOKAHEAD) {
      this.scheduleStep(this.step, this.nextStepTime);
      this.nextStepTime += STEP_DURATION;
      this.step++;
    }
  };

  start(): void {
    this.wantsToPlay = true;
    this.tryBegin();
  }

  stop(): void {
    this.wantsToPlay = false;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.teardownGraph();
  }

  setIntensity(value: number): void {
    this.intensity = clamp01(value);
    this.applyLayerGains();
  }

  setSector(sector: number): void {
    const idx = ((sector % SECTOR_ROOTS.length) + SECTOR_ROOTS.length) % SECTOR_ROOTS.length;
    this.root = SECTOR_ROOTS[idx];
    if (!this.ctx || !this.droneOscA || !this.droneOscB) return;
    const now = this.ctx.currentTime;
    this.droneOscA.frequency.setTargetAtTime(this.root, now, 1.2);
    this.droneOscB.frequency.setTargetAtTime(this.root * 1.5, now, 1.2); // perfect fifth above
  }

  setBossMode(active: boolean): void {
    this.bossMode = active;
    this.applyLayerGains();
  }

  /** Called every frame. The score itself is timer-scheduled (see `tick`); this only handles
   *  the case where `start()` was called before the AudioContext existed (i.e. before the
   *  player's first gesture unlocked it) and retries once audio becomes ready. */
  update(rawDt: number): void {
    void rawDt;
    if (this.wantsToPlay && !this.built) this.tryBegin();
  }

  dispose(): void {
    this.stop();
  }

  private tryBegin(): void {
    if (this.built || !this.wantsToPlay) return;
    if (!audio.ready || !audio.context || !audio.musicBus) return;
    this.ctx = audio.context;
    this.dest = audio.musicBus;
    this.buildGraph();
  }

  private buildGraph(): void {
    const ctx = this.ctx;
    const dest = this.dest;
    if (!ctx || !dest) return;
    const now = ctx.currentTime;

    // Drone — always present, two detuned oscillators a fifth apart forming the harmonic bed.
    this.droneGain = ctx.createGain();
    this.droneGain.gain.setValueAtTime(0, now);
    this.droneGain.connect(dest);
    this.droneOscA = ctx.createOscillator();
    this.droneOscA.type = 'triangle';
    this.droneOscA.frequency.setValueAtTime(this.root, now);
    this.droneOscA.detune.setValueAtTime(-4, now);
    this.droneOscB = ctx.createOscillator();
    this.droneOscB.type = 'sine';
    this.droneOscB.frequency.setValueAtTime(this.root * 1.5, now);
    this.droneOscB.detune.setValueAtTime(4, now);
    this.droneOscA.connect(this.droneGain);
    this.droneOscB.connect(this.droneGain);
    this.droneOscA.start(now);
    this.droneOscB.start(now);

    // Arp — a single oscillator reused for every note; only frequency and envelope move per step.
    this.arpLayerGain = ctx.createGain();
    this.arpLayerGain.gain.setValueAtTime(0, now);
    this.arpLayerGain.connect(dest);
    this.arpEnvGain = ctx.createGain();
    this.arpEnvGain.gain.setValueAtTime(0.0001, now);
    this.arpEnvGain.connect(this.arpLayerGain);
    this.arpOsc = ctx.createOscillator();
    this.arpOsc.type = 'triangle';
    this.arpOsc.frequency.setValueAtTime(this.root * 2, now);
    this.arpOsc.connect(this.arpEnvGain);
    this.arpOsc.start(now);

    // Percussive industrial layer — one filtered, looping noise source gated per hit.
    this.percLayerGain = ctx.createGain();
    this.percLayerGain.gain.setValueAtTime(0, now);
    this.percLayerGain.connect(dest);
    this.percEnvGain = ctx.createGain();
    this.percEnvGain.gain.setValueAtTime(0.0001, now);
    this.percEnvGain.connect(this.percLayerGain);
    this.percFilter = ctx.createBiquadFilter();
    this.percFilter.type = 'bandpass';
    this.percFilter.frequency.setValueAtTime(1600, now);
    this.percFilter.Q.value = 2;
    this.percFilter.connect(this.percEnvGain);
    this.percNoise = ctx.createBufferSource();
    this.percNoise.buffer = getPercNoiseBuffer(ctx);
    this.percNoise.loop = true;
    this.percNoise.connect(this.percFilter);
    this.percNoise.start(now);

    // Bass — boss-only driving sequence; silent (gain 0) outside boss mode.
    this.bassLayerGain = ctx.createGain();
    this.bassLayerGain.gain.setValueAtTime(0, now);
    this.bassLayerGain.connect(dest);
    this.bassEnvGain = ctx.createGain();
    this.bassEnvGain.gain.setValueAtTime(0.0001, now);
    this.bassEnvGain.connect(this.bassLayerGain);
    this.bassOsc = ctx.createOscillator();
    this.bassOsc.type = 'sawtooth';
    this.bassOsc.frequency.setValueAtTime(this.root * 0.5, now);
    this.bassOsc.connect(this.bassEnvGain);
    this.bassOsc.start(now);

    this.built = true;
    this.step = 0;
    this.nextStepTime = now + 0.05;
    this.applyLayerGains();
    this.timer = window.setInterval(this.tick, SCHEDULE_INTERVAL_MS);
  }

  private teardownGraph(): void {
    const stopSource = (n: OscillatorNode | AudioBufferSourceNode | null) => {
      if (!n) return;
      try { n.stop(); } catch { /* already stopped */ }
      try { n.disconnect(); } catch { /* already disconnected */ }
    };
    const disconnect = (n: AudioNode | null) => {
      try { n?.disconnect(); } catch { /* already disconnected */ }
    };

    stopSource(this.droneOscA);
    stopSource(this.droneOscB);
    stopSource(this.arpOsc);
    stopSource(this.percNoise);
    stopSource(this.bassOsc);
    disconnect(this.droneGain);
    disconnect(this.arpLayerGain);
    disconnect(this.arpEnvGain);
    disconnect(this.percLayerGain);
    disconnect(this.percEnvGain);
    disconnect(this.percFilter);
    disconnect(this.bassLayerGain);
    disconnect(this.bassEnvGain);

    this.droneOscA = null;
    this.droneOscB = null;
    this.arpOsc = null;
    this.percNoise = null;
    this.bassOsc = null;
    this.droneGain = null;
    this.arpLayerGain = null;
    this.arpEnvGain = null;
    this.percLayerGain = null;
    this.percEnvGain = null;
    this.percFilter = null;
    this.bassLayerGain = null;
    this.bassEnvGain = null;
    this.built = false;
  }

  /** Smoothly ramps each layer toward its target level. Called on every intensity/boss-mode
   *  change; `setTargetAtTime` toward a fresh target each call is exactly how a continuously
   *  varying value (wave intensity) should be tracked — no discontinuity, no per-frame cost
   *  beyond scheduling one AudioParam event. */
  private applyLayerGains(): void {
    if (!this.ctx || !this.droneGain || !this.arpLayerGain || !this.percLayerGain || !this.bassLayerGain) return;
    const now = this.ctx.currentTime;
    const droneTarget = lerp(0.22, 0.32, this.intensity);
    const arpTarget = clamp01(remap(this.intensity, 0.25, 0.8, 0, 1)) * 0.22;
    const percTarget = clamp01(remap(this.intensity, 0.55, 0.95, 0, 1)) * 0.2;
    const bassTarget = this.bossMode ? 0.3 : 0;

    this.droneGain.gain.setTargetAtTime(droneTarget, now, 0.8);
    this.arpLayerGain.gain.setTargetAtTime(arpTarget, now, 0.8);
    this.percLayerGain.gain.setTargetAtTime(percTarget, now, 0.8);
    this.bassLayerGain.gain.setTargetAtTime(bassTarget, now, 0.6);
  }

  private scheduleStep(step: number, time: number): void {
    if (this.arpOsc && this.arpEnvGain && this.intensity >= 0.25) {
      const degreeIndex = ARP_PATTERN[step % ARP_PATTERN.length] % MINOR_SCALE.length;
      const freq = freqFromSemitones(this.root * 2, MINOR_SCALE[degreeIndex]);
      this.arpOsc.frequency.setValueAtTime(freq, time);
      this.arpEnvGain.gain.cancelScheduledValues(time);
      this.arpEnvGain.gain.setValueAtTime(0.0001, time);
      this.arpEnvGain.gain.exponentialRampToValueAtTime(1, time + 0.02);
      this.arpEnvGain.gain.exponentialRampToValueAtTime(0.001, time + STEP_DURATION * 0.9);
    }

    if (step % 2 === 0 && this.percEnvGain && this.intensity >= 0.55) {
      this.percEnvGain.gain.cancelScheduledValues(time);
      this.percEnvGain.gain.setValueAtTime(0.0001, time);
      this.percEnvGain.gain.exponentialRampToValueAtTime(1, time + 0.004);
      this.percEnvGain.gain.exponentialRampToValueAtTime(0.001, time + 0.12);
    }

    if (this.bassOsc && this.bassEnvGain && this.bossMode) {
      const semis = BASS_PATTERN[step % BASS_PATTERN.length];
      this.bassOsc.frequency.setValueAtTime(freqFromSemitones(this.root * 0.5, semis), time);
      this.bassEnvGain.gain.cancelScheduledValues(time);
      this.bassEnvGain.gain.setValueAtTime(0.0001, time);
      this.bassEnvGain.gain.exponentialRampToValueAtTime(1, time + 0.01);
      this.bassEnvGain.gain.exponentialRampToValueAtTime(0.001, time + STEP_DURATION * 0.8);
    }
  }
}

export const music = new MusicDirector();
