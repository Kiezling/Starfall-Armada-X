/**
 * Unified keyboard + mouse + gamepad input.
 *
 * **The keyboard is the primary device.** Steering lives on the arrow-key cluster and comes
 * through the same smoothed axes a stick would produce, so the game is fully playable — and
 * feels analog — with no pointer at all. A mouse or gamepad, if present, writes the same two
 * steering numbers; whichever device was touched most recently owns them. Critically, when
 * the player is on the keyboard the steering axes rest at exactly zero, so releasing the keys
 * holds the current heading instead of drifting the nose toward a stale cursor position.
 *
 * Every action also carries a fixed alternate binding (`ALT_KEYBINDS`) chosen so both hands
 * have a comfortable reach: the WASD cluster and the arrow cluster each expose fire, boost,
 * drift, and lock without crossing hands.
 *
 * Every listener is a bound arrow-function class field created once in the constructor, and
 * every per-frame method (`update`, `endStep`) only mutates pre-allocated fields — no `new`,
 * no literals, no closures on the hot path.
 */

import type { InputAction, InputState, Settings } from './types';
import { ALT_KEYBINDS } from './settings';
import { clamp, clamp01, damp, springDamp } from './math';

/** Every action the game understands; also the set of keys a keybind record must cover. */
const ACTIONS: readonly InputAction[] = [
  'firePrimary',
  'fireSecondary',
  'pitchUp',
  'pitchDown',
  'yawLeft',
  'yawRight',
  'throttleUp',
  'throttleDown',
  'strafeLeft',
  'strafeRight',
  'rollLeft',
  'rollRight',
  'boost',
  'drift',
  'cycleTarget',
  'lockTarget',
  'swapWeapon',
  'reroll',
  'pause',
];

/** Codes the browser would otherwise use to scroll the page or move focus during play. */
const PREVENT_DEFAULT_CODES = new Set<string>([
  'Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Slash',
]);

/** Digital WASD/QE axes approach their target over roughly this many seconds. */
const AXIS_SMOOTH_TIME = 0.12;
/**
 * Steering keys ramp in faster than the throttle axes — a slow ramp on the nose reads as lag,
 * not weight — but still fast enough that a tap is a nudge rather than a jerk.
 */
const AIM_SMOOTH_TIME = 0.075;
/** Fraction of the pointer-lock reticle's offset from centre retained after one second. */
const RETICLE_DRIFT_RETAIN = 0.88;
/**
 * Units of throttle setpoint per second while a throttle key is held in cruise mode. At 1.4 a
 * full stop-to-max sweep takes ~0.7 s — brisk enough to feel responsive, slow enough that a tap
 * is a fine adjustment rather than a jump to the stop.
 */
const CRUISE_RAMP_RATE = 1.4;
/** Pixel-to-NDC scale at `mouseSensitivity` == 1, before the user's multiplier is applied. */
const MOUSE_PIXEL_SCALE = 0.0022;

/** Which device last produced input. Steering reads from whichever this names. */
const enum Device {
  Keyboard,
  Mouse,
  Gamepad,
}

const GAMEPAD_DEADZONE = 0.18;
const GAMEPAD_TRIGGER_THRESHOLD = 0.25;

/** W3C Standard Gamepad button indices used by this mapping. */
const GP_BUTTON_A = 0;
const GP_BUTTON_B = 1;
const GP_BUTTON_X = 2;
const GP_BUTTON_Y = 3;
const GP_BUTTON_LB = 4;
const GP_BUTTON_RB = 5;
const GP_BUTTON_LT = 6;
const GP_BUTTON_RT = 7;
const GP_BUTTON_START = 9;

function buildActionRecord(): Record<InputAction, boolean> {
  const rec = {} as Record<InputAction, boolean>;
  for (const action of ACTIONS) rec[action] = false;
  return rec;
}

export class InputManager implements InputState {
  private readonly canvas: HTMLElement;
  private settings: Settings;

  // --- Reticle sources -----------------------------------------------------------------------
  /** Pointer-lock accumulator / absolute-cursor NDC position. */
  private mouseAimX = 0;
  private mouseAimY = 0;
  /** Left-stick derived aim, recomputed each gamepad poll. */
  private gamepadAimX = 0;
  private gamepadAimY = 0;
  /** Arrow-cluster steering, spring-smoothed so held keys read as a stick deflection. */
  private keyAimX = 0;
  private keyAimY = 0;
  private readonly keyAimXVel = { value: 0 };
  private readonly keyAimYVel = { value: 0 };

  private _aimX = 0;
  private _aimY = 0;
  private _steering = false;

  // --- Analog axes -----------------------------------------------------------------------------
  private throttleSmoothed = 0;
  private strafeSmoothed = 0;
  private rollSmoothed = 0;
  private readonly throttleVel = { value: 0 };
  private readonly strafeVel = { value: 0 };
  private readonly rollVel = { value: 0 };

  private gamepadThrottle = 0;
  private gamepadStrafe = 0;
  private gamepadThrottleActive = false;
  private gamepadStrafeActive = false;

  private _throttle = 0;
  private _strafe = 0;
  private _roll = 0;

  // --- Digital state ---------------------------------------------------------------------------
  private readonly keyDown = new Set<string>();
  private readonly actionKeyDown = buildActionRecord();
  private readonly actionGamepadDown = buildActionRecord();
  /** Just-pressed edges, cleared by `endStep`. */
  private readonly actionPressed = buildActionRecord();

  private mouseLeftDown = false;
  private mouseRightDown = false;

  /*
   * Rollover-relief latches. These are pure input-layer state: `isDown` reports the latch in
   * place of the raw key, so every downstream system — weapons, flight, HUD — keeps reading a
   * plain held-or-not boolean and needs no knowledge that toggling exists.
   */
  private fireLatched = false;
  private boostLatched = false;
  /** Persistent throttle setpoint in -1..1, used only while `cruiseThrottle` is enabled. */
  private cruiseSetpoint = 0;
  /*
   * Previous-frame physical state for the latched actions. The latches flip on a rising edge
   * detected here rather than off `actionPressed`, because `actionPressed` is cleared by
   * `endStep` on the *simulation* cadence while `update` runs on the *frame* cadence — above
   * 60 fps a single press would otherwise be observed several times and toggle several times.
   */
  private firePrevPhysical = false;
  private boostPrevPhysical = false;

  private device: Device = Device.Keyboard;
  private rebindTarget: InputAction | null = null;
  private rebindDone: (() => void) | null = null;

  constructor(canvas: HTMLElement, settings: Settings) {
    this.canvas = canvas;
    this.settings = settings;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onWindowBlur);
    this.canvas.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('mouseup', this.onMouseUp);
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  get aimX(): number {
    return this._aimX;
  }

  get aimY(): number {
    return this._aimY;
  }

  get steering(): boolean {
    return this._steering;
  }

  get throttle(): number {
    return this._throttle;
  }

  get strafe(): number {
    return this._strafe;
  }

  get roll(): number {
    return this._roll;
  }

  get pointerLocked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  get usingGamepad(): boolean {
    return this.device === Device.Gamepad;
  }

  /** True while steering comes from the keyboard — the HUD hides the mouse reticle then. */
  get usingKeyboardAim(): boolean {
    return this.device === Device.Keyboard;
  }

  get rebinding(): InputAction | null {
    return this.rebindTarget;
  }

  isDown(action: InputAction): boolean {
    // Latched actions answer from the latch alone. Falling back to the raw key as well would
    // make a toggle-off press read as "still down" for exactly as long as the player held it,
    // which lands as an unresponsive control rather than a toggle.
    if (action === 'firePrimary' && this.settings.toggleFire) return this.fireLatched;
    if (action === 'boost' && this.settings.toggleBoost) return this.boostLatched;
    return this.isPhysicallyDown(action);
  }

  /** The raw device state, before any rollover-relief latching. */
  private isPhysicallyDown(action: InputAction): boolean {
    if (this.actionKeyDown[action] || this.actionGamepadDown[action]) return true;
    if (action === 'firePrimary') return this.mouseLeftDown;
    if (action === 'fireSecondary') return this.mouseRightDown;
    return false;
  }

  wasPressed(action: InputAction): boolean {
    return this.actionPressed[action];
  }

  setSettings(s: Settings): void {
    // Keybinds, sensitivity, and invertY are all read live off `this.settings` elsewhere, so
    // swapping the reference is the whole job.
    this.settings = s;
  }

  exitPointerLock(): void {
    if (this.pointerLocked) document.exitPointerLock();
  }

  /**
   * Starts listening for the next key and binds it to `action`.
   *
   * `onDone` fires once the capture resolves — including when Escape cancels it — and is what
   * lets the caller persist the new binding and drop the menu's "PRESS A KEY" state. Without
   * it the row would sit listening forever, since nothing else observes the capture.
   */
  beginRebind(action: InputAction, onDone?: () => void): void {
    this.rebindTarget = action;
    this.rebindDone = onDone ?? null;
  }

  private finishRebind(): void {
    this.rebindTarget = null;
    const done = this.rebindDone;
    this.rebindDone = null;
    // The captured key was never routed into the action tables, so nothing is held; clearing
    // the raw set keeps a key pressed during capture from looking held once play resumes.
    this.keyDown.clear();
    if (done) done();
  }

  /** Advances analog smoothing. Called once per rendered frame with an unscaled delta. */
  update(rawDt: number): void {
    // The pointer-lock accumulator has no natural rest position, so it is pulled back toward
    // centre; the absolute-cursor fallback already tracks the live cursor and needs no drift.
    if (this.pointerLocked) {
      this.mouseAimX = damp(this.mouseAimX, 0, RETICLE_DRIFT_RETAIN, rawDt);
      this.mouseAimY = damp(this.mouseAimY, 0, RETICLE_DRIFT_RETAIN, rawDt);
    }

    // Steering keys. The spring is what turns two digital keys into an axis that eases in and
    // — just as importantly — eases back to a true zero, so letting go holds the heading.
    const aimXTarget = (this.isDown('yawRight') ? 1 : 0) - (this.isDown('yawLeft') ? 1 : 0);
    const aimYTarget = (this.isDown('pitchUp') ? 1 : 0) - (this.isDown('pitchDown') ? 1 : 0);
    const signedYTarget = this.settings.invertY ? -aimYTarget : aimYTarget;
    this.keyAimX = springDamp(this.keyAimX, aimXTarget, this.keyAimXVel, AIM_SMOOTH_TIME, rawDt);
    this.keyAimY = springDamp(this.keyAimY, signedYTarget, this.keyAimYVel, AIM_SMOOTH_TIME, rawDt);

    this.updateLatches(rawDt);

    const throttleKeys = (this.isDown('throttleUp') ? 1 : 0) - (this.isDown('throttleDown') ? 1 : 0);
    // In cruise mode the keys ramp a setpoint that persists once released; otherwise they are
    // the target directly and releasing them coasts the ship back to a stop.
    const throttleTarget = this.settings.cruiseThrottle ? this.cruiseSetpoint : throttleKeys;
    const strafeTarget = (this.isDown('strafeRight') ? 1 : 0) - (this.isDown('strafeLeft') ? 1 : 0);
    const rollTarget = (this.isDown('rollRight') ? 1 : 0) - (this.isDown('rollLeft') ? 1 : 0);

    this.throttleSmoothed = springDamp(this.throttleSmoothed, throttleTarget, this.throttleVel, AXIS_SMOOTH_TIME, rawDt);
    this.strafeSmoothed = springDamp(this.strafeSmoothed, strafeTarget, this.strafeVel, AXIS_SMOOTH_TIME, rawDt);
    this.rollSmoothed = springDamp(this.rollSmoothed, rollTarget, this.rollVel, AXIS_SMOOTH_TIME, rawDt);

    // Gamepad analog axes bypass the spring entirely — they are already continuous.
    this._throttle = this.gamepadThrottleActive ? this.gamepadThrottle : clamp(this.throttleSmoothed, -1, 1);
    this._strafe = this.gamepadStrafeActive ? this.gamepadStrafe : clamp(this.strafeSmoothed, -1, 1);
    this._roll = clamp(this.rollSmoothed, -1, 1);

    // A held steering key always reclaims ownership of the axes, even mid-mouse-move: the
    // keyboard is the primary device and must never be talked over by a stale cursor.
    if (aimXTarget !== 0 || aimYTarget !== 0) this.device = Device.Keyboard;

    if (this.device === Device.Gamepad) {
      this._aimX = this.gamepadAimX;
      this._aimY = this.gamepadAimY;
    } else if (this.device === Device.Mouse) {
      this._aimX = this.mouseAimX;
      this._aimY = this.mouseAimY;
    } else {
      this._aimX = clamp(this.keyAimX, -1, 1);
      this._aimY = clamp(this.keyAimY, -1, 1);
    }

    // "Steering" is about intent, not the smoothed value: the assist must yield the instant a
    // key goes down and resume the instant it is released, not trail the spring's tail.
    this._steering =
      this.device === Device.Keyboard
        ? aimXTarget !== 0 || aimYTarget !== 0
        : Math.abs(this._aimX) > 0.08 || Math.abs(this._aimY) > 0.08;
  }

  /**
   * Advances the rollover-relief latches: the fire/boost toggles and the cruise setpoint.
   *
   * Each option is inert while disabled, and its latch is reset rather than left holding a
   * stale value — flipping the setting off mid-flight must not leave the guns welded on.
   */
  private updateLatches(rawDt: number): void {
    const firePhysical = this.isPhysicallyDown('firePrimary');
    if (this.settings.toggleFire) {
      if (firePhysical && !this.firePrevPhysical) this.fireLatched = !this.fireLatched;
    } else {
      this.fireLatched = false;
    }
    this.firePrevPhysical = firePhysical;

    const boostPhysical = this.isPhysicallyDown('boost');
    if (this.settings.toggleBoost) {
      if (boostPhysical && !this.boostPrevPhysical) this.boostLatched = !this.boostLatched;
    } else {
      this.boostLatched = false;
    }
    this.boostPrevPhysical = boostPhysical;

    if (this.settings.cruiseThrottle) {
      // Read the throttle keys physically: cruise is about how long they are *held*, and the
      // latching above deliberately does not apply to them.
      const ramp =
        (this.isPhysicallyDown('throttleUp') ? 1 : 0) - (this.isPhysicallyDown('throttleDown') ? 1 : 0);
      if (ramp !== 0) {
        this.cruiseSetpoint = clamp(this.cruiseSetpoint + ramp * CRUISE_RAMP_RATE * rawDt, -1, 1);
      }
    } else {
      this.cruiseSetpoint = 0;
    }
  }

  /** Zeroes the cruise setpoint. Called when a run starts so each life begins at a dead stop. */
  resetCruise(): void {
    this.cruiseSetpoint = 0;
  }

  /** Clears the just-pressed edges and polls the gamepad. Called once per simulation step. */
  endStep(): void {
    for (const action of ACTIONS) this.actionPressed[action] = false;
    this.pollGamepad();
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onWindowBlur);
    this.canvas.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
  }

  // --- Mouse -------------------------------------------------------------------------------

  private ySign(): number {
    // Baseline (not inverted) maps "stick/mouse up" to positive aimY.
    return this.settings.invertY ? 1 : -1;
  }

  private clampMouseAimToCircle(): void {
    const x = this.mouseAimX;
    const y = this.mouseAimY;
    const magSq = x * x + y * y;
    if (magSq > 1) {
      const mag = Math.sqrt(magSq);
      this.mouseAimX = x / mag;
      this.mouseAimY = y / mag;
    }
  }

  private readonly onMouseMove = (e: MouseEvent): void => {
    this.device = Device.Mouse;

    if (this.pointerLocked) {
      const sens = MOUSE_PIXEL_SCALE * this.settings.mouseSensitivity;
      this.mouseAimX += e.movementX * sens;
      this.mouseAimY += e.movementY * sens * this.ySign();
      this.clampMouseAimToCircle();
      return;
    }

    // No lock (denied, or not yet requested): map the absolute cursor position onto NDC so
    // the game stays playable.
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    this.mouseAimX = ndcX;
    this.mouseAimY = this.settings.invertY ? -ndcY : ndcY;
    this.clampMouseAimToCircle();
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (e.button === 0) {
      if (!this.mouseLeftDown) this.actionPressed.firePrimary = true;
      this.mouseLeftDown = true;
    } else if (e.button === 2) {
      if (!this.mouseRightDown) this.actionPressed.fireSecondary = true;
      this.mouseRightDown = true;
    }
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) this.mouseLeftDown = false;
    else if (e.button === 2) this.mouseRightDown = false;
  };

  private readonly onContextMenu = (e: MouseEvent): void => {
    // Right mouse fires the secondary weapon; the context menu must not interrupt that.
    e.preventDefault();
  };

  // --- Keyboard ------------------------------------------------------------------------------

  /**
   * True when `code` is either the action's remappable binding or its fixed alternate. The
   * alternate exists so the arrow-key hand and the WASD hand each reach the same verbs; it is
   * skipped when the player has rebound some *other* action onto that key, so a deliberate
   * remap always wins over a built-in convenience binding.
   */
  private matchesBinding(action: InputAction, code: string): boolean {
    if (this.settings.keybinds[action] === code) return true;
    if (ALT_KEYBINDS[action] !== code) return false;
    for (const other of ACTIONS) {
      if (other !== action && this.settings.keybinds[other] === code) return false;
    }
    return true;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (PREVENT_DEFAULT_CODES.has(e.code)) e.preventDefault();

    if (this.rebindTarget) {
      // Key repeat must not re-enter the capture after it has already resolved.
      if (e.repeat) return;
      // Escape backs out of a rebind instead of binding itself, matching the common remap-UI
      // convention — otherwise a player trying to cancel would silently rebind onto pause.
      if (e.code !== 'Escape') this.settings.keybinds[this.rebindTarget] = e.code;
      this.finishRebind();
      return;
    }

    this.device = Device.Keyboard;
    if (this.keyDown.has(e.code)) return; // OS key-repeat, not a new edge.
    this.keyDown.add(e.code);

    for (const action of ACTIONS) {
      if (this.matchesBinding(action, e.code)) {
        if (!this.actionKeyDown[action]) this.actionPressed[action] = true;
        this.actionKeyDown[action] = true;
      }
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (PREVENT_DEFAULT_CODES.has(e.code)) e.preventDefault();
    this.keyDown.delete(e.code);
    for (const action of ACTIONS) {
      // Release only when no *other* still-held key maps to the same action, otherwise
      // lifting the alternate binding would cancel a press made with the primary one.
      if (!this.matchesBinding(action, e.code)) continue;
      const primary = this.settings.keybinds[action];
      const alt = ALT_KEYBINDS[action];
      // Each candidate has to pass matchesBinding in its own right. Testing only `keyDown`
      // would count an alternate that a remap has since disabled for this action — it never
      // set the action down, so letting it hold the action down means releasing the primary
      // leaves the action stuck on until the window blurs.
      const heldBy = (code: string | undefined): boolean =>
        code !== undefined && code !== e.code && this.keyDown.has(code) && this.matchesBinding(action, code);
      if (!heldBy(primary) && !heldBy(alt)) this.actionKeyDown[action] = false;
    }
  };

  private readonly onWindowBlur = (): void => {
    // Losing focus mid-keypress must not leave a held action stuck — otherwise the ship keeps
    // flying while the player is tabbed out.
    this.keyDown.clear();
    for (const action of ACTIONS) {
      this.actionKeyDown[action] = false;
      this.actionGamepadDown[action] = false;
    }
    this.mouseLeftDown = false;
    this.mouseRightDown = false;
    // A latched trigger must not keep firing while the player is tabbed out, and the edge
    // trackers have to forget the pre-blur state or the next real press reads as a repeat.
    this.fireLatched = false;
    this.boostLatched = false;
    this.firePrevPhysical = false;
    this.boostPrevPhysical = false;
  };

  // --- Gamepad ------------------------------------------------------------------------------

  private setGamepadAction(action: InputAction, down: boolean): void {
    if (down) {
      if (!this.actionGamepadDown[action]) this.actionPressed[action] = true;
      this.actionGamepadDown[action] = true;
      this.device = Device.Gamepad;
    } else {
      this.actionGamepadDown[action] = false;
    }
  }

  private pollGamepad(): void {
    const pads = navigator.getGamepads();
    let pad: Gamepad | null = null;
    for (let i = 0; i < pads.length; i++) {
      const candidate = pads[i];
      if (candidate) {
        pad = candidate;
        break;
      }
    }

    if (!pad) {
      this.gamepadThrottleActive = false;
      this.gamepadStrafeActive = false;
      return;
    }

    // Left stick: aim. Radial deadzone, then a squared response curve so small deflections
    // give fine control while the stick still reaches full deflection at its edge.
    const rawX = pad.axes[0] ?? 0;
    const rawY = pad.axes[1] ?? 0;
    const mag = Math.sqrt(rawX * rawX + rawY * rawY);
    if (mag > GAMEPAD_DEADZONE) {
      const norm = clamp01((mag - GAMEPAD_DEADZONE) / (1 - GAMEPAD_DEADZONE));
      const curved = norm * norm;
      const ux = rawX / mag;
      const uy = rawY / mag;
      this.gamepadAimX = ux * curved;
      // W3C axes convention: negative Y is "up". `ySign()` mirrors the mouse convention above
      // so up-on-stick and up-on-mouse both increase aimY by default, and invertY flips both.
      this.gamepadAimY = uy * curved * this.ySign();
      this.device = Device.Gamepad;
    } else {
      this.gamepadAimX = 0;
      this.gamepadAimY = 0;
    }

    // Right stick: throttle (Y) and strafe (X), passed through unsmoothed once past deadzone.
    const rawRX = pad.axes[2] ?? 0;
    const rawRY = pad.axes[3] ?? 0;

    if (Math.abs(rawRX) > GAMEPAD_DEADZONE) {
      this.gamepadStrafe = clamp(rawRX, -1, 1);
      this.gamepadStrafeActive = true;
      this.device = Device.Gamepad;
    } else {
      this.gamepadStrafeActive = false;
    }

    if (Math.abs(rawRY) > GAMEPAD_DEADZONE) {
      this.gamepadThrottle = clamp(-rawRY, -1, 1);
      this.gamepadThrottleActive = true;
      this.device = Device.Gamepad;
    } else {
      this.gamepadThrottleActive = false;
    }

    const buttons = pad.buttons;
    const rt = buttons[GP_BUTTON_RT]?.value ?? 0;
    const lt = buttons[GP_BUTTON_LT]?.value ?? 0;

    this.setGamepadAction('firePrimary', rt > GAMEPAD_TRIGGER_THRESHOLD);
    this.setGamepadAction('fireSecondary', lt > GAMEPAD_TRIGGER_THRESHOLD);
    this.setGamepadAction('boost', buttons[GP_BUTTON_A]?.pressed ?? false);
    this.setGamepadAction('drift', buttons[GP_BUTTON_LB]?.pressed ?? false);
    this.setGamepadAction('cycleTarget', buttons[GP_BUTTON_RB]?.pressed ?? false);
    // Hard lock sits under the thumb next to cycle-target, mirroring the keyboard's
    // Tab-then-hold pairing. Both are required verbs now, so a pad without them is not
    // actually "full gamepad support".
    this.setGamepadAction('lockTarget', buttons[GP_BUTTON_B]?.pressed ?? false);
    this.setGamepadAction('swapWeapon', buttons[GP_BUTTON_Y]?.pressed ?? false);
    this.setGamepadAction('reroll', buttons[GP_BUTTON_X]?.pressed ?? false);
    this.setGamepadAction('pause', buttons[GP_BUTTON_START]?.pressed ?? false);
  }
}
