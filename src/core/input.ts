/**
 * Unified keyboard + mouse + gamepad input.
 *
 * Devices are merged into the single `InputState` contract the rest of the game reads: digital
 * keys resolve through `settings.keybinds` so remapping is free, mouse and gamepad both drive
 * the aim reticle (whichever moved most recently wins), and gamepad sticks/buttons are OR'd
 * onto the same action set keyboard uses.
 *
 * Every listener is a bound arrow-function class field created once in the constructor, and
 * every per-frame method (`update`, `endStep`) only mutates pre-allocated fields — no `new`,
 * no literals, no closures on the hot path.
 */

import type { InputAction, InputState, Settings } from './types';
import { clamp, clamp01, damp, springDamp } from './math';

/** All 13 actions the game understands; also the set of keys a keybind record must cover. */
const ACTIONS: readonly InputAction[] = [
  'firePrimary',
  'fireSecondary',
  'throttleUp',
  'throttleDown',
  'strafeLeft',
  'strafeRight',
  'rollLeft',
  'rollRight',
  'boost',
  'drift',
  'cycleTarget',
  'reroll',
  'pause',
];

/** Codes the browser would otherwise use to scroll the page or move focus during play. */
const PREVENT_DEFAULT_CODES = new Set<string>(['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** Digital WASD/QE axes approach their target over roughly this many seconds. */
const AXIS_SMOOTH_TIME = 0.12;
/** Fraction of the pointer-lock reticle's offset from centre retained after one second. */
const RETICLE_DRIFT_RETAIN = 0.88;
/** Pixel-to-NDC scale at `mouseSensitivity` == 1, before the user's multiplier is applied. */
const MOUSE_PIXEL_SCALE = 0.0022;

const GAMEPAD_DEADZONE = 0.18;
const GAMEPAD_TRIGGER_THRESHOLD = 0.25;

/** W3C Standard Gamepad button indices used by this mapping. */
const GP_BUTTON_A = 0;
const GP_BUTTON_X = 2;
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

  private _aimX = 0;
  private _aimY = 0;

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

  private lastDeviceWasGamepad = false;
  private rebindTarget: InputAction | null = null;

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
    return this.lastDeviceWasGamepad;
  }

  get rebinding(): InputAction | null {
    return this.rebindTarget;
  }

  isDown(action: InputAction): boolean {
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

  requestPointerLock(): void {
    this.canvas.requestPointerLock();
  }

  exitPointerLock(): void {
    if (this.pointerLocked) document.exitPointerLock();
  }

  beginRebind(action: InputAction): void {
    this.rebindTarget = action;
  }

  /** Advances analog smoothing. Called once per rendered frame with an unscaled delta. */
  update(rawDt: number): void {
    // The pointer-lock accumulator has no natural rest position, so it is pulled back toward
    // centre; the absolute-cursor fallback already tracks the live cursor and needs no drift.
    if (this.pointerLocked) {
      this.mouseAimX = damp(this.mouseAimX, 0, RETICLE_DRIFT_RETAIN, rawDt);
      this.mouseAimY = damp(this.mouseAimY, 0, RETICLE_DRIFT_RETAIN, rawDt);
    }

    const throttleTarget = (this.isDown('throttleUp') ? 1 : 0) - (this.isDown('throttleDown') ? 1 : 0);
    const strafeTarget = (this.isDown('strafeRight') ? 1 : 0) - (this.isDown('strafeLeft') ? 1 : 0);
    const rollTarget = (this.isDown('rollRight') ? 1 : 0) - (this.isDown('rollLeft') ? 1 : 0);

    this.throttleSmoothed = springDamp(this.throttleSmoothed, throttleTarget, this.throttleVel, AXIS_SMOOTH_TIME, rawDt);
    this.strafeSmoothed = springDamp(this.strafeSmoothed, strafeTarget, this.strafeVel, AXIS_SMOOTH_TIME, rawDt);
    this.rollSmoothed = springDamp(this.rollSmoothed, rollTarget, this.rollVel, AXIS_SMOOTH_TIME, rawDt);

    // Gamepad analog axes bypass the spring entirely — they are already continuous.
    this._throttle = this.gamepadThrottleActive ? this.gamepadThrottle : clamp(this.throttleSmoothed, -1, 1);
    this._strafe = this.gamepadStrafeActive ? this.gamepadStrafe : clamp(this.strafeSmoothed, -1, 1);
    this._roll = clamp(this.rollSmoothed, -1, 1);

    if (this.lastDeviceWasGamepad) {
      this._aimX = this.gamepadAimX;
      this._aimY = this.gamepadAimY;
    } else {
      this._aimX = this.mouseAimX;
      this._aimY = this.mouseAimY;
    }
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
    this.lastDeviceWasGamepad = false;

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
    this.lastDeviceWasGamepad = false;
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

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (PREVENT_DEFAULT_CODES.has(e.code)) e.preventDefault();

    if (this.rebindTarget) {
      // Escape backs out of a rebind instead of binding itself, matching the common remap-UI
      // convention — otherwise a player trying to cancel would silently rebind onto pause.
      if (e.code !== 'Escape') this.settings.keybinds[this.rebindTarget] = e.code;
      this.rebindTarget = null;
      return;
    }

    this.lastDeviceWasGamepad = false;
    if (this.keyDown.has(e.code)) return; // OS key-repeat, not a new edge.
    this.keyDown.add(e.code);

    for (const action of ACTIONS) {
      if (this.settings.keybinds[action] === e.code) {
        if (!this.actionKeyDown[action]) this.actionPressed[action] = true;
        this.actionKeyDown[action] = true;
      }
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (PREVENT_DEFAULT_CODES.has(e.code)) e.preventDefault();
    this.keyDown.delete(e.code);
    for (const action of ACTIONS) {
      if (this.settings.keybinds[action] === e.code) this.actionKeyDown[action] = false;
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
  };

  // --- Gamepad ------------------------------------------------------------------------------

  private setGamepadAction(action: InputAction, down: boolean): void {
    if (down) {
      if (!this.actionGamepadDown[action]) this.actionPressed[action] = true;
      this.actionGamepadDown[action] = true;
      this.lastDeviceWasGamepad = true;
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
      this.lastDeviceWasGamepad = true;
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
      this.lastDeviceWasGamepad = true;
    } else {
      this.gamepadStrafeActive = false;
    }

    if (Math.abs(rawRY) > GAMEPAD_DEADZONE) {
      this.gamepadThrottle = clamp(-rawRY, -1, 1);
      this.gamepadThrottleActive = true;
      this.lastDeviceWasGamepad = true;
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
    this.setGamepadAction('reroll', buttons[GP_BUTTON_X]?.pressed ?? false);
    this.setGamepadAction('pause', buttons[GP_BUTTON_START]?.pressed ?? false);
  }
}
