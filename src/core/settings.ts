/**
 * Player-facing settings: persistence and defaults.
 *
 * Everything here round-trips through `JSON.stringify`/`JSON.parse` via localStorage, so the
 * shape on disk is untrusted input — a hand-edited or stale-schema blob must never produce a
 * `Settings` object with a value outside the ranges the rest of the game assumes.
 */

import { AimAssist, ColorblindMode, Difficulty } from './types';
import type { InputAction, Settings } from './types';
import { STORAGE } from './constants';
import { clamp, clamp01 } from './math';

/**
 * KeyboardEvent.code bindings, per DESIGN.md §4. `Tab`/`Space`/arrows are also the codes
 * input.ts prevents default browser behaviour for, since those are the ones a browser would
 * otherwise intercept (scrolling, focus traversal).
 */
export const DEFAULT_KEYBINDS: Record<InputAction, string> = {
  firePrimary: 'Space',
  fireSecondary: 'ShiftLeft',
  throttleUp: 'KeyW',
  throttleDown: 'KeyS',
  strafeLeft: 'KeyA',
  strafeRight: 'KeyD',
  rollLeft: 'KeyQ',
  rollRight: 'KeyE',
  boost: 'KeyF',
  drift: 'ControlLeft',
  cycleTarget: 'Tab',
  reroll: 'KeyR',
  pause: 'Escape',
};

/** The only action names a keybind entry may legally refer to. */
const KNOWN_ACTIONS = Object.keys(DEFAULT_KEYBINDS) as InputAction[];

const MOUSE_SENSITIVITY_MIN = 0.2;
const MOUSE_SENSITIVITY_MAX = 3;

export function createDefaultSettings(): Settings {
  return {
    masterVolume: 0.8,
    musicVolume: 0.75,
    sfxVolume: 0.85,

    screenShake: 1,
    hitStop: 1,
    reduceFlash: false,
    showDamageNumbers: true,

    colorblind: ColorblindMode.Default,
    aimAssist: AimAssist.Light,
    difficulty: Difficulty.Pilot,

    invertY: false,
    mouseSensitivity: 1,
    keybinds: { ...DEFAULT_KEYBINDS },

    showPerfOverlay: false,
  };
}

/** True when `value` is one of the numeric members of an `as const` enum-like object. */
function isEnumValue(enumObj: Record<string, number>, value: unknown): boolean {
  if (typeof value !== 'number' || !Number.isInteger(value)) return false;
  for (const key in enumObj) {
    if (enumObj[key] === value) return true;
  }
  return false;
}

/**
 * Rebuilds a full keybind record on top of the defaults so a partial or corrupted save never
 * leaves an action unbound. Unknown action keys (e.g. from a future or edited schema) are
 * silently dropped rather than propagated.
 */
function sanitizeKeybinds(raw: unknown): Record<InputAction, string> {
  const out: Record<InputAction, string> = { ...DEFAULT_KEYBINDS };
  if (raw !== null && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    for (const action of KNOWN_ACTIONS) {
      const bound = rec[action];
      if (typeof bound === 'string' && bound.length > 0) out[action] = bound;
    }
  }
  return out;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Merges whatever is in localStorage over the defaults. Every numeric field is clamped to its
 * documented range regardless of what was stored, so an edited or corrupted save can degrade
 * settings but never hand a system an out-of-contract value.
 */
export function loadSettings(): Settings {
  const defaults = createDefaultSettings();

  let parsed: unknown;
  try {
    const stored = localStorage.getItem(STORAGE.settings);
    if (!stored) return defaults;
    parsed = JSON.parse(stored);
  } catch {
    return defaults;
  }
  if (parsed === null || typeof parsed !== 'object') return defaults;
  const rec = parsed as Record<string, unknown>;

  return {
    masterVolume: clamp01(readNumber(rec.masterVolume, defaults.masterVolume)),
    musicVolume: clamp01(readNumber(rec.musicVolume, defaults.musicVolume)),
    sfxVolume: clamp01(readNumber(rec.sfxVolume, defaults.sfxVolume)),

    screenShake: clamp01(readNumber(rec.screenShake, defaults.screenShake)),
    hitStop: clamp01(readNumber(rec.hitStop, defaults.hitStop)),
    reduceFlash: readBool(rec.reduceFlash, defaults.reduceFlash),
    showDamageNumbers: readBool(rec.showDamageNumbers, defaults.showDamageNumbers),

    colorblind: isEnumValue(ColorblindMode, rec.colorblind)
      ? (rec.colorblind as ColorblindMode)
      : defaults.colorblind,
    aimAssist: isEnumValue(AimAssist, rec.aimAssist) ? (rec.aimAssist as AimAssist) : defaults.aimAssist,
    difficulty: isEnumValue(Difficulty, rec.difficulty) ? (rec.difficulty as Difficulty) : defaults.difficulty,

    invertY: readBool(rec.invertY, defaults.invertY),
    mouseSensitivity: clamp(
      readNumber(rec.mouseSensitivity, defaults.mouseSensitivity),
      MOUSE_SENSITIVITY_MIN,
      MOUSE_SENSITIVITY_MAX,
    ),
    keybinds: sanitizeKeybinds(rec.keybinds),

    showPerfOverlay: readBool(rec.showPerfOverlay, defaults.showPerfOverlay),
  };
}

/** localStorage.setItem can throw (private browsing, quota, disabled storage) — never fatal. */
export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE.settings, JSON.stringify(s));
  } catch {
    // Settings simply won't persist this session; gameplay is unaffected.
  }
}

export function resetSettings(): Settings {
  const defaults = createDefaultSettings();
  saveSettings(defaults);
  return defaults;
}
