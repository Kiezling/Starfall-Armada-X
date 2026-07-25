/**
 * Fixed-timestep clock with time dilation and hit-stop.
 *
 * Simulation runs at a fixed 60 Hz regardless of display refresh rate, so behaviour is
 * identical on a 60 Hz laptop and a 144 Hz monitor. Rendering happens once per animation
 * frame with an interpolation alpha for smooth motion between simulation steps.
 *
 * Hit-stop and slow-motion scale the *simulation* delta, not the step rate. The loop still
 * ticks at 60 Hz; each tick just advances less world time.
 */

import { clamp, damp } from './math';

export const FIXED_STEP = 1 / 60;
/** Beyond this many catch-up steps we drop world time rather than spiral. */
const MAX_STEPS_PER_FRAME = 5;
/** Ignore absurd frame gaps (tab restored, breakpoint hit) instead of simulating them. */
const MAX_FRAME_DELTA = 0.25;

interface Dilation {
  /** Target scale while this dilation is active. */
  scale: number;
  /** Seconds of real time remaining. */
  remaining: number;
  /** Seconds spent easing back to 1.0 once `remaining` hits zero. */
  release: number;
  active: boolean;
}

export class GameClock {
  private accumulator = 0;
  private lastTime = 0;
  private started = false;

  /** Unscaled seconds since the clock started. */
  rawElapsed = 0;
  /** Scaled seconds — world time. */
  elapsed = 0;

  /** Current effective time scale, including hit-stop and slow-motion. */
  timeScale = 1;
  /** Real seconds elapsed in the last rendered frame, clamped. */
  rawDelta = 0;
  /** Interpolation alpha in [0, 1) between the last two simulation steps. */
  alpha = 0;

  /** Persistent slow-motion (death cameras, boss intros). Set directly. */
  private baseScale = 1;
  private baseScaleTarget = 1;

  /** Short, sharp freezes stacked by impacts. Only the strongest one is honoured. */
  private readonly hitStop: Dilation = { scale: 1, remaining: 0, release: 0, active: false };

  /** Scales every hit-stop duration; wired to the accessibility slider. */
  hitStopIntensity = 1;

  /** Advances the clock and returns how many fixed simulation steps to run this frame. */
  beginFrame(nowMs: number): number {
    if (!this.started) {
      this.started = true;
      this.lastTime = nowMs;
      return 0;
    }

    let frameDelta = (nowMs - this.lastTime) / 1000;
    this.lastTime = nowMs;
    if (frameDelta < 0) frameDelta = 0;
    if (frameDelta > MAX_FRAME_DELTA) frameDelta = MAX_FRAME_DELTA;

    this.rawDelta = frameDelta;
    this.rawElapsed += frameDelta;
    this.updateDilation(frameDelta);

    this.accumulator += frameDelta;

    let steps = 0;
    while (this.accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
      this.accumulator -= FIXED_STEP;
      steps++;
    }
    // Dropped time when we hit the cap, so the accumulator cannot grow without bound.
    if (this.accumulator > FIXED_STEP * MAX_STEPS_PER_FRAME) {
      this.accumulator = 0;
    }

    this.alpha = this.accumulator / FIXED_STEP;
    this.elapsed += FIXED_STEP * this.timeScale * steps;
    return steps;
  }

  /** Scaled delta for one simulation step. */
  get stepDelta(): number {
    return FIXED_STEP * this.timeScale;
  }

  /**
   * Freezes the world briefly. Stacking rules: a stronger (lower-scale) or longer freeze
   * replaces a weaker one, so a kill during an existing hit-stop cannot shorten it.
   */
  applyHitStop(durationSeconds: number, scale = 0.02): void {
    const duration = durationSeconds * this.hitStopIntensity;
    if (duration <= 0) return;
    const stop = this.hitStop;
    if (!stop.active || duration > stop.remaining || scale < stop.scale) {
      stop.scale = scale;
      stop.remaining = Math.max(stop.active ? stop.remaining : 0, duration);
      stop.release = 0.08;
      stop.active = true;
    }
  }

  /** Sets sustained slow-motion. `1` restores normal speed. Eased, not instant. */
  setSlowMotion(scale: number): void {
    this.baseScaleTarget = clamp(scale, 0.05, 4);
  }

  /** Immediately snaps the base scale, skipping the ease. */
  snapSlowMotion(scale: number): void {
    this.baseScaleTarget = clamp(scale, 0.05, 4);
    this.baseScale = this.baseScaleTarget;
  }

  private updateDilation(frameDelta: number): void {
    this.baseScale = damp(this.baseScale, this.baseScaleTarget, 0.001, frameDelta);

    const stop = this.hitStop;
    let stopScale = 1;
    if (stop.active) {
      if (stop.remaining > 0) {
        stop.remaining -= frameDelta;
        stopScale = stop.scale;
      } else {
        stop.release -= frameDelta;
        if (stop.release <= 0) {
          stop.active = false;
        } else {
          // Ease back out so the world does not snap to full speed.
          const t = 1 - clamp(stop.release / 0.08, 0, 1);
          stopScale = stop.scale + (1 - stop.scale) * t;
        }
      }
    }

    this.timeScale = this.baseScale * stopScale;
  }

  /** Clears dilation and world time. Called when a run restarts. */
  reset(): void {
    this.accumulator = 0;
    this.elapsed = 0;
    this.timeScale = 1;
    this.baseScale = 1;
    this.baseScaleTarget = 1;
    this.hitStop.active = false;
    this.hitStop.remaining = 0;
    this.hitStop.release = 0;
  }

  /**
   * Discards accumulated real time without simulating it. Call after a pause or a long
   * synchronous load so the game does not fast-forward to catch up.
   */
  skipMissedTime(nowMs: number): void {
    this.lastTime = nowMs;
    this.accumulator = 0;
  }
}
