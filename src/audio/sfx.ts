/**
 * The synthesised sound bank.
 *
 * Every id maps to a small graph of oscillators/noise built fresh per call and torn down the
 * instant its envelope finishes — there is nothing to decode or stream, so "playing a sound"
 * here just means "schedule some AudioParam automation and call start()". Voices register with
 * the engine's budget tracker so a heavy wave can't pile up unbounded live nodes, and every
 * one-shot randomises its pitch by a few percent so rapid fire doesn't machine-gun into one
 * static tone.
 *
 * Two ids — `lanceCharge` and `phaseLance` — are sustained rather than one-shot; they're driven
 * through `startLoop`/`setLoopParam`/`stopLoop` instead of `playSfx`.
 */

import { audio } from './engine';
import type { VoiceToken } from './engine';
import { clamp, clamp01, lerp } from '../core/math';

export type SfxId =
  | 'pulseRepeater' | 'lanceDriver' | 'lanceCharge' | 'scatterVents' | 'arcTether' | 'flakBattery' | 'singularityCoil'
  | 'swarmMissiles' | 'novaMine' | 'phaseLance' | 'gravityWell' | 'aegisPulse'
  | 'hitFlesh' | 'hitShield' | 'hitArmor'
  | 'enemyDeathSmall' | 'enemyDeathLarge' | 'eliteDeath' | 'bossPhase' | 'bossDeath'
  | 'playerHit' | 'shieldBreak' | 'shieldRecharge' | 'lowHull' | 'overheat' | 'vented'
  | 'boost' | 'drift' | 'lockOn' | 'telegraph' | 'telegraphLethal'
  | 'waveStart' | 'waveClear' | 'sectorClear' | 'draftOpen' | 'draftPick' | 'uiHover' | 'uiClick' | 'uiBack' | 'salvage' | 'gameOver';

/* ------------------------------------------------------------------------------------------ */
/* Shared synthesis primitives                                                                  */
/* ------------------------------------------------------------------------------------------ */

interface BuiltVoice {
  stop: () => void;
  /** Seconds until the envelope is silent — feeds the engine's voice-budget clock. */
  duration: number;
}

/** ±3%, applied per-voice so identical repeated fire never sounds like a single locked tone. */
function pitchJitter(): number {
  return 1 + (Math.random() * 2 - 1) * 0.03;
}

let sharedNoise: AudioBuffer | null = null;
let sharedNoiseCtx: AudioContext | null = null;

/** A 2s white-noise buffer, generated once and reused via random start offsets. Regenerating
 *  fresh random data per burst would be real CPU cost under sustained fire — this way the only
 *  per-call cost is a BufferSourceNode. */
function getNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (sharedNoise && sharedNoiseCtx === ctx) return sharedNoise;
  const len = Math.floor(ctx.sampleRate * 2);
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  sharedNoise = buffer;
  sharedNoiseCtx = ctx;
  return buffer;
}

function noiseSource(ctx: AudioContext): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  const buffer = getNoiseBuffer(ctx);
  src.buffer = buffer;
  src.loop = true;
  src.loopStart = 0;
  src.loopEnd = buffer.duration;
  src.start(ctx.currentTime, Math.random() * (buffer.duration - 0.1));
  return src;
}

interface EnvOpts {
  peak: number;
  attack: number;
  hold?: number;
  release: number;
}

/** Standard attack/hold/exponential-decay envelope. Every builder below routes through this so
 *  gain shaping stays consistent and click-free. */
function envGain(ctx: AudioContext, dest: AudioNode, opts: EnvOpts): { gain: GainNode; duration: number } {
  const hold = opts.hold ?? 0;
  const gain = ctx.createGain();
  gain.connect(dest);
  const now = ctx.currentTime;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(opts.peak, now + opts.attack);
  gain.gain.setValueAtTime(opts.peak, now + opts.attack + hold);
  gain.gain.exponentialRampToValueAtTime(Math.max(opts.peak * 0.02, 0.0001), now + opts.attack + hold + opts.release);
  return { gain, duration: opts.attack + hold + opts.release };
}

interface ToneOpts extends EnvOpts {
  type: OscillatorType;
  freq: number;
  freqEnd?: number;
  detune?: number;
}

/** A single oscillator with an optional exponential frequency sweep — the workhorse for cracks,
 *  pings, whines and stabs. */
function tone(ctx: AudioContext, dest: AudioNode, opts: ToneOpts): BuiltVoice {
  const osc = ctx.createOscillator();
  osc.type = opts.type;
  const now = ctx.currentTime;
  const jitter = pitchJitter();
  osc.frequency.setValueAtTime(opts.freq * jitter, now);
  if (opts.detune) osc.detune.setValueAtTime(opts.detune, now);
  const { gain, duration } = envGain(ctx, dest, opts);
  if (opts.freqEnd !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(opts.freqEnd * jitter, 1), now + duration);
  }
  osc.connect(gain);
  const end = now + duration + 0.05;
  osc.start(now);
  osc.stop(end);
  osc.onended = () => { try { osc.disconnect(); gain.disconnect(); } catch { /* already torn down */ } };
  const stop = () => { try { osc.stop(); } catch { /* already stopped */ } };
  return { stop, duration };
}

interface NoiseOpts extends EnvOpts {
  filterType: BiquadFilterType;
  freq: number;
  freqEnd?: number;
  Q?: number;
}

/** Filtered noise burst — the basis for whooshes, cracks, hisses and explosions. */
function noiseBurst(ctx: AudioContext, dest: AudioNode, opts: NoiseOpts): BuiltVoice {
  const src = noiseSource(ctx);
  const filter = ctx.createBiquadFilter();
  filter.type = opts.filterType;
  filter.Q.value = opts.Q ?? 1;
  const now = ctx.currentTime;
  const jitter = pitchJitter();
  filter.frequency.setValueAtTime(opts.freq * jitter, now);
  const { gain, duration } = envGain(ctx, dest, opts);
  if (opts.freqEnd !== undefined) {
    filter.frequency.exponentialRampToValueAtTime(Math.max(opts.freqEnd * jitter, 20), now + duration);
  }
  src.connect(filter);
  filter.connect(gain);
  const end = now + duration + 0.05;
  src.stop(end);
  src.onended = () => { try { src.disconnect(); filter.disconnect(); gain.disconnect(); } catch { /* already torn down */ } };
  const stop = () => { try { src.stop(); } catch { /* already stopped */ } };
  return { stop, duration };
}

interface Note {
  freq: number;
  start: number;
  dur: number;
  type?: OscillatorType;
  peak?: number;
}

/** A short sequence of independent blips sharing one stop/duration handle — UI feedback,
 *  fanfares, and the shield-break "glass shard" cluster all boil down to this. */
function blipSeq(ctx: AudioContext, dest: AudioNode, notes: Note[]): BuiltVoice {
  const now = ctx.currentTime;
  const oscs: OscillatorNode[] = [];
  let maxEnd = 0;
  for (const n of notes) {
    const osc = ctx.createOscillator();
    osc.type = n.type ?? 'triangle';
    const t0 = now + n.start;
    osc.frequency.setValueAtTime(n.freq * pitchJitter(), t0);
    const gain = ctx.createGain();
    gain.connect(dest);
    const peak = n.peak ?? 0.5;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + n.dur * 0.15);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak * 0.02, 0.0001), t0 + n.dur);
    osc.connect(gain);
    osc.start(t0);
    osc.stop(t0 + n.dur + 0.03);
    osc.onended = () => { try { osc.disconnect(); gain.disconnect(); } catch { /* already torn down */ } };
    oscs.push(osc);
    maxEnd = Math.max(maxEnd, n.start + n.dur);
  }
  const stop = () => { for (const o of oscs) { try { o.stop(); } catch { /* already stopped */ } } };
  return { stop, duration: maxEnd + 0.05 };
}

/* ------------------------------------------------------------------------------------------ */
/* Per-weapon voices                                                                            */
/* ------------------------------------------------------------------------------------------ */

function buildPulseRepeater(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  return tone(ctx, dest, { type: 'square', freq: 900, freqEnd: 420, attack: 0.004, hold: 0, release: 0.06, peak: 0.5 * volume });
}

function buildLanceDriver(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  const sub = tone(ctx, dest, { type: 'sine', freq: 110, freqEnd: 45, attack: 0.005, hold: 0.02, release: 0.24, peak: 0.9 * volume });
  const transient = noiseBurst(ctx, dest, { filterType: 'highpass', freq: 1200, attack: 0.001, hold: 0, release: 0.03, peak: 0.7 * volume });
  const sweep = tone(ctx, dest, { type: 'sawtooth', freq: 600, freqEnd: 60, attack: 0.005, hold: 0, release: 0.32, peak: 0.35 * volume });
  const stop = () => { sub.stop(); transient.stop(); sweep.stop(); };
  return { stop, duration: Math.max(sub.duration, transient.duration, sweep.duration) };
}

function buildScatterVents(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  return noiseBurst(ctx, dest, { filterType: 'bandpass', freq: 4200, freqEnd: 700, Q: 0.8, attack: 0.004, hold: 0.02, release: 0.15, peak: 0.6 * volume });
}

function buildArcTether(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  const now = ctx.currentTime;
  const duration = 0.22;
  const carrier = ctx.createOscillator();
  carrier.type = 'sawtooth';
  const baseFreq = 520 * pitchJitter();
  carrier.frequency.setValueAtTime(baseFreq, now);
  const steps = Math.floor(duration / 0.012);
  for (let i = 1; i <= steps; i++) {
    carrier.frequency.setValueAtTime(baseFreq * (0.85 + Math.random() * 0.5), now + i * 0.012);
  }
  const modulator = ctx.createOscillator();
  modulator.type = 'sine';
  modulator.frequency.setValueAtTime(180, now);
  const ringGain = ctx.createGain();
  ringGain.gain.value = 0; // ring-mod carries no signal of its own — output is carrier * modulator
  modulator.connect(ringGain.gain);
  carrier.connect(ringGain);

  const { gain, duration: envDur } = envGain(ctx, dest, { peak: 0.5 * volume, attack: 0.005, hold: 0.05, release: duration - 0.055 });
  ringGain.connect(gain);

  const end = now + Math.max(duration, envDur) + 0.05;
  carrier.start(now); carrier.stop(end);
  modulator.start(now); modulator.stop(end);
  carrier.onended = () => { try { carrier.disconnect(); modulator.disconnect(); ringGain.disconnect(); gain.disconnect(); } catch { /* already torn down */ } };
  const stop = () => { try { carrier.stop(); } catch { /* noop */ } try { modulator.stop(); } catch { /* noop */ } };
  return { stop, duration: Math.max(duration, envDur) };
}

function buildFlakBattery(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  const now = ctx.currentTime;
  const thump = tone(ctx, dest, { type: 'sine', freq: 140, freqEnd: 70, attack: 0.002, hold: 0.01, release: 0.12, peak: 0.7 * volume });

  // The crack is a second, later-scheduled voice rather than a DelayNode — it's a discrete
  // one-shot burst, not a continuous signal that needs delaying through the graph.
  const crackDelay = 0.05;
  const src = noiseSource(ctx);
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.setValueAtTime(2500, now + crackDelay);
  src.connect(filter);
  const crackGain = ctx.createGain();
  filter.connect(crackGain);
  crackGain.connect(dest);
  const t0 = now + crackDelay;
  crackGain.gain.setValueAtTime(0, t0);
  crackGain.gain.linearRampToValueAtTime(0.45 * volume, t0 + 0.006);
  crackGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.09);
  const crackEnd = t0 + 0.1;
  src.stop(crackEnd);
  src.onended = () => { try { src.disconnect(); filter.disconnect(); crackGain.disconnect(); } catch { /* already torn down */ } };

  const stop = () => { thump.stop(); try { src.stop(); } catch { /* already stopped */ } };
  return { stop, duration: Math.max(thump.duration, crackDelay + 0.1) };
}

function buildSingularityCoil(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  const now = ctx.currentTime;
  const duration = 0.6;
  const tremolo = ctx.createOscillator();
  tremolo.type = 'sine';
  tremolo.frequency.setValueAtTime(5, now);
  const tremGain = ctx.createGain();
  tremGain.gain.setValueAtTime(0.3, now);
  tremolo.connect(tremGain);

  const { gain, duration: envDur } = envGain(ctx, dest, { peak: 0.55 * volume, attack: 0.01, hold: 0.1, release: duration - 0.11 });
  tremGain.connect(gain.gain); // audio-rate modulation sums onto the envelope's own curve

  const oscA = ctx.createOscillator(); oscA.type = 'sine';
  const oscB = ctx.createOscillator(); oscB.type = 'sine';
  const base = 260 * pitchJitter();
  oscA.detune.setValueAtTime(-8, now);
  oscB.detune.setValueAtTime(8, now);
  oscA.frequency.setValueAtTime(base, now);
  oscB.frequency.setValueAtTime(base, now);
  oscA.frequency.exponentialRampToValueAtTime(Math.max(base * 0.35, 20), now + duration);
  oscB.frequency.exponentialRampToValueAtTime(Math.max(base * 0.35, 20), now + duration);
  oscA.connect(gain); oscB.connect(gain);

  const end = now + Math.max(duration, envDur) + 0.05;
  tremolo.start(now); tremolo.stop(end);
  oscA.start(now); oscA.stop(end);
  oscB.start(now); oscB.stop(end);
  oscA.onended = () => {
    try { tremolo.disconnect(); tremGain.disconnect(); oscA.disconnect(); oscB.disconnect(); gain.disconnect(); } catch { /* already torn down */ }
  };
  const stop = () => { try { tremolo.stop(); } catch { /* noop */ } try { oscA.stop(); } catch { /* noop */ } try { oscB.stop(); } catch { /* noop */ } };
  return { stop, duration: Math.max(duration, envDur) };
}

function buildSwarmMissiles(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  const notes: Note[] = [];
  for (let i = 0; i < 4; i++) {
    notes.push({ freq: 900 + Math.random() * 200, start: i * 0.035, dur: 0.05, type: 'square', peak: 0.3 * volume });
  }
  const clicks = blipSeq(ctx, dest, notes);
  const whoosh = noiseBurst(ctx, dest, { filterType: 'bandpass', freq: 2500, freqEnd: 900, Q: 0.6, attack: 0.01, hold: 0.05, release: 0.15, peak: 0.35 * volume });
  const stop = () => { clicks.stop(); whoosh.stop(); };
  return { stop, duration: Math.max(clicks.duration, whoosh.duration) };
}

function buildNovaMine(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  const thunk = tone(ctx, dest, { type: 'sine', freq: 130, freqEnd: 70, attack: 0.003, hold: 0.01, release: 0.1, peak: 0.5 * volume });
  const arm = tone(ctx, dest, { type: 'triangle', freq: 500, freqEnd: 900, attack: 0.08, hold: 0.02, release: 0.1, peak: 0.3 * volume });
  const stop = () => { thunk.stop(); arm.stop(); };
  return { stop, duration: Math.max(thunk.duration, arm.duration) };
}

function buildGravityWell(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  const now = ctx.currentTime;
  const duration = 0.5;
  const tremolo = ctx.createOscillator();
  tremolo.type = 'sine';
  tremolo.frequency.setValueAtTime(4, now);
  const tremGain = ctx.createGain();
  tremGain.gain.setValueAtTime(0.25, now);
  tremolo.connect(tremGain);

  const { gain, duration: envDur } = envGain(ctx, dest, { peak: 0.6 * volume, attack: 0.03, hold: 0.1, release: duration - 0.13 });
  tremGain.connect(gain.gain);

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  const base = 90 * pitchJitter();
  osc.frequency.setValueAtTime(base, now);
  osc.frequency.exponentialRampToValueAtTime(Math.max(base * 0.5, 20), now + duration);
  osc.connect(gain);

  const end = now + Math.max(duration, envDur) + 0.05;
  tremolo.start(now); tremolo.stop(end);
  osc.start(now); osc.stop(end);
  osc.onended = () => { try { tremolo.disconnect(); tremGain.disconnect(); osc.disconnect(); gain.disconnect(); } catch { /* already torn down */ } };
  const stop = () => { try { tremolo.stop(); } catch { /* noop */ } try { osc.stop(); } catch { /* noop */ } };
  return { stop, duration: Math.max(duration, envDur) };
}

function buildAegisPulse(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  const sweep = tone(ctx, dest, { type: 'sine', freq: 300, freqEnd: 1100, attack: 0.02, hold: 0.05, release: 0.22, peak: 0.45 * volume });
  const shimmer = noiseBurst(ctx, dest, { filterType: 'highpass', freq: 3500, Q: 0.5, attack: 0.02, hold: 0.05, release: 0.2, peak: 0.25 * volume });
  const stop = () => { sweep.stop(); shimmer.stop(); };
  return { stop, duration: Math.max(sweep.duration, shimmer.duration) };
}

/* ------------------------------------------------------------------------------------------ */
/* Impacts, deaths, status                                                                      */
/* ------------------------------------------------------------------------------------------ */

function buildHitShield(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  const now = ctx.currentTime;
  const ratios = [1, 2.41, 3.8]; // inharmonic partials read as metal, not a musical tone
  const base = 1300 * pitchJitter();
  const gain = ctx.createGain();
  gain.connect(dest);
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.5 * volume, now + 0.003);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
  const oscs: OscillatorNode[] = [];
  for (const r of ratios) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(base * r, now);
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + 0.17);
    oscs.push(osc);
  }
  oscs[0].onended = () => { try { for (const o of oscs) o.disconnect(); gain.disconnect(); } catch { /* already torn down */ } };
  const stop = () => { for (const o of oscs) { try { o.stop(); } catch { /* already stopped */ } } };
  return { stop, duration: 0.15 };
}

function buildHitArmor(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  const thunk = tone(ctx, dest, { type: 'triangle', freq: 180, freqEnd: 90, attack: 0.002, hold: 0.01, release: 0.08, peak: 0.5 * volume });
  const clank = noiseBurst(ctx, dest, { filterType: 'lowpass', freq: 900, freqEnd: 300, Q: 1, attack: 0.002, hold: 0.01, release: 0.09, peak: 0.35 * volume });
  const stop = () => { thunk.stop(); clank.stop(); };
  return { stop, duration: Math.max(thunk.duration, clank.duration) };
}

function buildHitFlesh(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  return noiseBurst(ctx, dest, { filterType: 'lowpass', freq: 650, freqEnd: 220, Q: 0.6, attack: 0.002, hold: 0.005, release: 0.09, peak: 0.4 * volume });
}

function buildEnemyDeathSmall(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  const boom = noiseBurst(ctx, dest, { filterType: 'bandpass', freq: 2200, freqEnd: 300, Q: 0.7, attack: 0.003, hold: 0.02, release: 0.18, peak: 0.55 * volume });
  const pop = tone(ctx, dest, { type: 'sine', freq: 260, freqEnd: 80, attack: 0.002, hold: 0, release: 0.1, peak: 0.4 * volume });
  const stop = () => { boom.stop(); pop.stop(); };
  return { stop, duration: Math.max(boom.duration, pop.duration) };
}

function buildEnemyDeathLarge(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  const boom = noiseBurst(ctx, dest, { filterType: 'lowpass', freq: 1800, freqEnd: 150, Q: 0.7, attack: 0.005, hold: 0.05, release: 0.4, peak: 0.75 * volume });
  const sub = tone(ctx, dest, { type: 'sine', freq: 90, freqEnd: 35, attack: 0.005, hold: 0.03, release: 0.35, peak: 0.6 * volume });
  const stop = () => { boom.stop(); sub.stop(); };
  return { stop, duration: Math.max(boom.duration, sub.duration) };
}

function buildEliteDeath(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  const base = buildEnemyDeathLarge(ctx, dest, volume);
  const signature = tone(ctx, dest, { type: 'sawtooth', freq: 700, freqEnd: 120, attack: 0.01, hold: 0.02, release: 0.3, peak: 0.3 * volume });
  const stop = () => { base.stop(); signature.stop(); };
  return { stop, duration: Math.max(base.duration, signature.duration) };
}

function buildBossPhase(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  const sweep = noiseBurst(ctx, dest, { filterType: 'lowpass', freq: 200, freqEnd: 5000, Q: 6, attack: 0.02, hold: 0.05, release: 0.35, peak: 0.6 * volume });
  const stab = tone(ctx, dest, { type: 'square', freq: 110, freqEnd: 55, attack: 0.005, hold: 0.05, release: 0.3, peak: 0.5 * volume });
  const stop = () => { sweep.stop(); stab.stop(); };
  return { stop, duration: Math.max(sweep.duration, stab.duration) };
}

function buildBossDeath(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  const boom = noiseBurst(ctx, dest, { filterType: 'lowpass', freq: 2200, freqEnd: 120, Q: 0.6, attack: 0.01, hold: 0.15, release: 0.7, peak: 0.85 * volume });
  const sub = tone(ctx, dest, { type: 'sine', freq: 70, freqEnd: 25, attack: 0.01, hold: 0.1, release: 0.65, peak: 0.7 * volume });
  const cluster = buildSingularityCoil(ctx, dest, volume * 0.6);
  const stop = () => { boom.stop(); sub.stop(); cluster.stop(); };
  return { stop, duration: Math.max(boom.duration, sub.duration, cluster.duration) };
}

function buildPlayerHit(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  const buzz = noiseBurst(ctx, dest, { filterType: 'bandpass', freq: 1400, freqEnd: 400, Q: 1, attack: 0.002, hold: 0.01, release: 0.12, peak: 0.6 * volume });
  const dip = tone(ctx, dest, { type: 'sawtooth', freq: 220, freqEnd: 90, attack: 0.002, hold: 0, release: 0.1, peak: 0.45 * volume });
  const stop = () => { buzz.stop(); dip.stop(); };
  return { stop, duration: Math.max(buzz.duration, dip.duration) };
}

function buildShieldBreak(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  audio.duck(0.3, 0.7); // unmissable per DESIGN §14 — the whole mix ducks under it
  const sweep = noiseBurst(ctx, dest, { filterType: 'bandpass', freq: 5000, freqEnd: 150, Q: 0.5, attack: 0.005, hold: 0.05, release: 0.45, peak: 0.8 * volume });
  const shardCount = 7;
  const notes: Note[] = [];
  for (let i = 0; i < shardCount; i++) {
    notes.push({ freq: 3200 - i * 320 + Math.random() * 150, start: i * 0.02 + Math.random() * 0.01, dur: 0.09, type: 'triangle', peak: 0.35 * volume });
  }
  const shards = blipSeq(ctx, dest, notes);
  const stop = () => { sweep.stop(); shards.stop(); };
  return { stop, duration: Math.max(sweep.duration, shards.duration) };
}

function buildShieldRecharge(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  return tone(ctx, dest, { type: 'sine', freq: 260, freqEnd: 640, attack: 0.02, hold: 0.05, release: 0.18, peak: 0.4 * volume });
}

function buildLowHull(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  audio.duck(0.5, 0.5); // low hull is a critical cue per DESIGN §14, same as telegraph/shieldBreak
  return blipSeq(ctx, dest, [
    { freq: 320, start: 0, dur: 0.12, type: 'square', peak: 0.5 * volume },
    { freq: 320, start: 0.18, dur: 0.12, type: 'square', peak: 0.5 * volume },
  ]);
}

function buildOverheat(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  const a = tone(ctx, dest, { type: 'sawtooth', freq: 500, freqEnd: 180, attack: 0.01, hold: 0.05, release: 0.24, peak: 0.35 * volume, detune: -15 });
  const b = tone(ctx, dest, { type: 'sawtooth', freq: 500, freqEnd: 180, attack: 0.01, hold: 0.05, release: 0.24, peak: 0.35 * volume, detune: 15 });
  const stop = () => { a.stop(); b.stop(); };
  return { stop, duration: Math.max(a.duration, b.duration) };
}

function buildVented(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  return noiseBurst(ctx, dest, { filterType: 'bandpass', freq: 3000, freqEnd: 1400, Q: 0.4, attack: 0.02, hold: 0.15, release: 0.25, peak: 0.45 * volume });
}

function buildBoost(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  return noiseBurst(ctx, dest, { filterType: 'bandpass', freq: 400, freqEnd: 2600, Q: 0.5, attack: 0.05, hold: 0.05, release: 0.15, peak: 0.4 * volume });
}

function buildDrift(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  return noiseBurst(ctx, dest, { filterType: 'bandpass', freq: 2200, freqEnd: 600, Q: 0.6, attack: 0.01, hold: 0.02, release: 0.14, peak: 0.4 * volume });
}

function buildLockOn(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  return blipSeq(ctx, dest, [
    { freq: 700, start: 0, dur: 0.05, type: 'triangle', peak: 0.4 * volume },
    { freq: 1050, start: 0.06, dur: 0.06, type: 'triangle', peak: 0.45 * volume },
  ]);
}

function buildTelegraph(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  audio.duck(0.55, 0.35); // dodgeable — a firm nudge, not a full mute
  return tone(ctx, dest, { type: 'triangle', freq: 520, attack: 0.005, hold: 0.09, release: 0.08, peak: 0.45 * volume });
}

function buildTelegraphLethal(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  audio.duck(0.3, 0.5); // lethal — ducks harder and longer than the dodgeable telegraph
  return blipSeq(ctx, dest, [
    { freq: 700, start: 0, dur: 0.1, type: 'square', peak: 0.55 * volume },
    { freq: 480, start: 0.11, dur: 0.12, type: 'square', peak: 0.55 * volume },
  ]);
}

/* ------------------------------------------------------------------------------------------ */
/* Pacing and UI                                                                                */
/* ------------------------------------------------------------------------------------------ */

function buildWaveStart(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  return blipSeq(ctx, dest, [
    { freq: 392, start: 0, dur: 0.12, type: 'triangle', peak: 0.4 * volume },
    { freq: 494, start: 0.1, dur: 0.12, type: 'triangle', peak: 0.42 * volume },
    { freq: 587, start: 0.2, dur: 0.18, type: 'triangle', peak: 0.45 * volume },
  ]);
}

function buildWaveClear(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  return blipSeq(ctx, dest, [
    { freq: 660, start: 0, dur: 0.16, type: 'sine', peak: 0.4 * volume },
    { freq: 523, start: 0.12, dur: 0.2, type: 'sine', peak: 0.4 * volume },
  ]);
}

function buildSectorClear(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  return blipSeq(ctx, dest, [
    { freq: 392, start: 0, dur: 0.14, type: 'triangle', peak: 0.42 * volume },
    { freq: 494, start: 0.12, dur: 0.14, type: 'triangle', peak: 0.44 * volume },
    { freq: 587, start: 0.24, dur: 0.14, type: 'triangle', peak: 0.46 * volume },
    { freq: 784, start: 0.36, dur: 0.3, type: 'triangle', peak: 0.5 * volume },
  ]);
}

function buildDraftOpen(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  return tone(ctx, dest, { type: 'sine', freq: 220, freqEnd: 440, attack: 0.15, hold: 0.05, release: 0.2, peak: 0.3 * volume });
}

function buildDraftPick(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  return blipSeq(ctx, dest, [
    { freq: 660, start: 0, dur: 0.08, type: 'triangle', peak: 0.45 * volume },
    { freq: 990, start: 0.04, dur: 0.14, type: 'triangle', peak: 0.5 * volume },
  ]);
}

function buildUiHover(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  return tone(ctx, dest, { type: 'sine', freq: 900, attack: 0.001, hold: 0, release: 0.03, peak: 0.15 * volume });
}

function buildUiClick(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  return tone(ctx, dest, { type: 'triangle', freq: 700, freqEnd: 500, attack: 0.001, hold: 0, release: 0.045, peak: 0.3 * volume });
}

function buildUiBack(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  return tone(ctx, dest, { type: 'triangle', freq: 500, freqEnd: 340, attack: 0.001, hold: 0, release: 0.05, peak: 0.28 * volume });
}

function buildSalvage(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  return blipSeq(ctx, dest, [
    { freq: 784, start: 0, dur: 0.07, type: 'square', peak: 0.35 * volume },
    { freq: 1175, start: 0.05, dur: 0.12, type: 'square', peak: 0.4 * volume },
  ]);
}

function buildGameOver(ctx: AudioContext, dest: AudioNode, volume: number): BuiltVoice {
  const a = tone(ctx, dest, { type: 'sine', freq: 220, freqEnd: 80, attack: 0.05, hold: 0.2, release: 0.9, peak: 0.5 * volume, detune: -6 });
  const b = tone(ctx, dest, { type: 'sine', freq: 196, freqEnd: 70, attack: 0.05, hold: 0.2, release: 0.95, peak: 0.4 * volume, detune: 6 });
  const stop = () => { a.stop(); b.stop(); };
  return { stop, duration: Math.max(a.duration, b.duration) };
}

/* ------------------------------------------------------------------------------------------ */
/* Sustained voices (startLoop / stopLoop / setLoopParam)                                       */
/* ------------------------------------------------------------------------------------------ */

interface LoopVoice {
  stop: () => void;
  setPitch: (value: number) => void;
  setGain: (value: number) => void;
}

function buildLanceChargeLoop(ctx: AudioContext, dest: AudioNode): LoopVoice {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(140, now);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.35, now + 0.05);
  osc.connect(gain);
  gain.connect(dest);
  osc.start(now);

  const setPitch = (value: number) => {
    osc.frequency.setTargetAtTime(lerp(140, 760, clamp01(value)), ctx.currentTime, 0.05);
  };
  const setGain = (value: number) => {
    gain.gain.setTargetAtTime(clamp01(value) * 0.35, ctx.currentTime, 0.05);
  };
  const stop = () => {
    const t = ctx.currentTime;
    gain.gain.setTargetAtTime(0, t, 0.04);
    try { osc.stop(t + 0.15); } catch { /* already stopped */ }
    osc.onended = () => { try { osc.disconnect(); gain.disconnect(); } catch { /* already torn down */ } };
  };
  return { stop, setPitch, setGain };
}

function buildPhaseLanceLoop(ctx: AudioContext, dest: AudioNode): LoopVoice {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(420, now);
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(1400, now);
  filter.Q.value = 3;

  // Subtle flutter on the filter cutoff so the sustained beam doesn't sit dead-static.
  const flutter = ctx.createOscillator();
  flutter.type = 'sine';
  flutter.frequency.setValueAtTime(7, now);
  const flutterGain = ctx.createGain();
  flutterGain.gain.setValueAtTime(60, now);
  flutter.connect(flutterGain);
  flutterGain.connect(filter.frequency);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.4, now + 0.03);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(dest);

  osc.start(now);
  flutter.start(now);

  const setPitch = (value: number) => {
    osc.frequency.setTargetAtTime(lerp(260, 900, clamp01(value)), ctx.currentTime, 0.03);
  };
  const setGain = (value: number) => {
    gain.gain.setTargetAtTime(clamp01(value) * 0.4, ctx.currentTime, 0.03);
  };
  const stop = () => {
    const t = ctx.currentTime;
    gain.gain.setTargetAtTime(0, t, 0.04);
    try { osc.stop(t + 0.15); } catch { /* already stopped */ }
    try { flutter.stop(t + 0.15); } catch { /* already stopped */ }
    osc.onended = () => {
      try { osc.disconnect(); flutter.disconnect(); flutterGain.disconnect(); filter.disconnect(); gain.disconnect(); } catch { /* already torn down */ }
    };
  };
  return { stop, setPitch, setGain };
}

/* ------------------------------------------------------------------------------------------ */
/* Dispatch tables and public API                                                               */
/* ------------------------------------------------------------------------------------------ */

type Builder = (ctx: AudioContext, dest: AudioNode, volume: number) => BuiltVoice;

const ONE_SHOTS: Partial<Record<SfxId, Builder>> = {
  pulseRepeater: buildPulseRepeater,
  lanceDriver: buildLanceDriver,
  scatterVents: buildScatterVents,
  arcTether: buildArcTether,
  flakBattery: buildFlakBattery,
  singularityCoil: buildSingularityCoil,
  swarmMissiles: buildSwarmMissiles,
  novaMine: buildNovaMine,
  gravityWell: buildGravityWell,
  aegisPulse: buildAegisPulse,
  hitFlesh: buildHitFlesh,
  hitShield: buildHitShield,
  hitArmor: buildHitArmor,
  enemyDeathSmall: buildEnemyDeathSmall,
  enemyDeathLarge: buildEnemyDeathLarge,
  eliteDeath: buildEliteDeath,
  bossPhase: buildBossPhase,
  bossDeath: buildBossDeath,
  playerHit: buildPlayerHit,
  shieldBreak: buildShieldBreak,
  shieldRecharge: buildShieldRecharge,
  lowHull: buildLowHull,
  overheat: buildOverheat,
  vented: buildVented,
  boost: buildBoost,
  drift: buildDrift,
  lockOn: buildLockOn,
  telegraph: buildTelegraph,
  telegraphLethal: buildTelegraphLethal,
  waveStart: buildWaveStart,
  waveClear: buildWaveClear,
  sectorClear: buildSectorClear,
  draftOpen: buildDraftOpen,
  draftPick: buildDraftPick,
  uiHover: buildUiHover,
  uiClick: buildUiClick,
  uiBack: buildUiBack,
  salvage: buildSalvage,
  gameOver: buildGameOver,
};

const LOOPS: Partial<Record<SfxId, (ctx: AudioContext, dest: AudioNode) => LoopVoice>> = {
  lanceCharge: buildLanceChargeLoop,
  phaseLance: buildPhaseLanceLoop,
};

export function playSfx(id: SfxId, volume = 1): void {
  const ctx = audio.context;
  const dest = audio.sfxBus;
  if (!audio.ready || !ctx || !dest) return;
  const build = ONE_SHOTS[id];
  if (!build) return;
  const voice = build(ctx, dest, clamp(volume, 0, 2));
  audio.allocateVoice(voice.stop, voice.duration);
}

/** Positional variant — connects through a pooled panner instead of straight to the SFX bus so
 *  enemy fire and explosions can be heard (and located) off-screen, per DESIGN §14. Falls back
 *  to non-positional playback if the panner pool is exhausted rather than dropping the cue. */
export function playSfxAt(id: SfxId, x: number, y: number, z: number, volume = 1): void {
  const ctx = audio.context;
  if (!audio.ready || !ctx || !audio.sfxBus) return;
  const build = ONE_SHOTS[id];
  if (!build) return;
  // Positional ids are all short one-shots; 1.5s comfortably covers the longest of them so the
  // pooled panner isn't reclaimed while the sound is still sounding.
  const panner = audio.acquirePanner(1.5);
  if (!panner) { playSfx(id, volume); return; }
  panner.positionX.value = x;
  panner.positionY.value = y;
  panner.positionZ.value = z;
  const voice = build(ctx, panner, clamp(volume, 0, 2));
  audio.allocateVoice(voice.stop, voice.duration);
}

interface ActiveLoop {
  voice: LoopVoice;
  token: VoiceToken;
}

const activeLoops = new Map<number, ActiveLoop>();
let nextLoopHandle = 1;

export function startLoop(id: SfxId): number {
  const ctx = audio.context;
  const dest = audio.sfxBus;
  if (!audio.ready || !ctx || !dest) return 0;
  const build = LOOPS[id];
  if (!build) return 0;
  const voice = build(ctx, dest);
  const token = audio.allocateVoice(voice.stop, Infinity);
  const handle = nextLoopHandle++;
  activeLoops.set(handle, { voice, token });
  return handle;
}

export function stopLoop(handle: number): void {
  const entry = activeLoops.get(handle);
  if (!entry) return;
  entry.voice.stop();
  audio.releaseVoice(entry.token);
  activeLoops.delete(handle);
}

export function setLoopParam(handle: number, param: 'pitch' | 'gain', value: number): void {
  const entry = activeLoops.get(handle);
  if (!entry) return;
  if (param === 'pitch') entry.voice.setPitch(value);
  else entry.voice.setGain(value);
}
