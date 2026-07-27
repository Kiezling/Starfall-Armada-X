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
 * KeyboardEvent.code bindings, per DESIGN.md §4.
 *
 * The layout is built for two hands on a keyboard and **no pointer of any kind**. The left
 * hand owns the ship's body on WASD — throttle, strafe, roll — and the right hand owns the
 * nose on the arrow cluster. Every verb either sits under a resting finger or has an
 * alternate in `ALT_KEYBINDS` that does.
 *
 * `Tab`/`Space`/arrows/`Slash` are also the codes input.ts prevents default browser behaviour
 * for, since those are the ones a browser would otherwise intercept (scrolling, focus
 * traversal, quick-find).
 */
export const DEFAULT_KEYBINDS: Record<InputAction, string> = {
  firePrimary: 'Space',
  fireSecondary: 'KeyC',
  pitchUp: 'ArrowUp',
  pitchDown: 'ArrowDown',
  yawLeft: 'ArrowLeft',
  yawRight: 'ArrowRight',
  throttleUp: 'KeyW',
  throttleDown: 'KeyS',
  strafeLeft: 'KeyA',
  strafeRight: 'KeyD',
  rollLeft: 'KeyQ',
  rollRight: 'KeyE',
  boost: 'ShiftLeft',
  drift: 'KeyX',
  cycleTarget: 'Tab',
  lockTarget: 'KeyT',
  swapWeapon: 'KeyF',
  reroll: 'KeyR',
  pause: 'Escape',
};

/**
 * Fixed second bindings, not remappable and not shown in the rebind list.
 *
 * Two hand positions are common and neither should be second-class: WASD + arrows (left hand
 * on the body, right hand on the nose), and WASD + IJKL (both hands on the home row). These
 * alternates make the second layout work and put fire/boost/drift/lock within reach of the
 * arrow hand too, so a player can steer and shoot without either hand travelling.
 *
 * A binding here is ignored whenever the player has deliberately rebound another action onto
 * the same key — an explicit remap always beats a built-in convenience.
 */
export const ALT_KEYBINDS: Partial<Record<InputAction, string>> = {
  firePrimary: 'Slash',
  fireSecondary: 'Period',
  pitchUp: 'KeyI',
  pitchDown: 'KeyK',
  yawLeft: 'KeyJ',
  yawRight: 'KeyL',
  rollLeft: 'KeyU',
  rollRight: 'KeyO',
  boost: 'ShiftRight',
  drift: 'ControlRight',
  cycleTarget: 'KeyM',
  lockTarget: 'Comma',
  pause: 'KeyP',
};

/**
 * Bumped whenever a *control-scheme* default changes in a way that must reach players who
 * already have a saved settings blob. Cosmetic or audio defaults do not need a bump.
 * 2 — pitch inverted by default (Up = nose down) alongside the removal of the pitch limit.
 * 3 — rollover-relief toggles added (toggleFire / toggleBoost / cruiseThrottle).
 */
const SETTINGS_SCHEMA = 3;

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
    aimAssist: AimAssist.Strong,
    difficulty: Difficulty.Pilot,

    // Default to stick-style pitch: Up/I pulls the nose down, Down/K pulls it up. This is what
    // the arrow cluster reads as once the pitch limit is gone and the ship can loop; the
    // "Invert Y" toggle in Settings → Gameplay flips it back for players who prefer camera-style.
    invertY: true,
    mouseSensitivity: 1,

    // All three rollover-relief options default off: they each change how the ship *feels* to
    // fly, and a player whose keyboard has full rollover should not silently get a different
    // control model than the one the flight tuning was built against. Settings → Controls
    // groups them together so a player who is losing keypresses can find them immediately.
    toggleFire: false,
    toggleBoost: false,
    cruiseThrottle: false,

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
  const storedSchema = readNumber(rec.schema, 1);

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

    // Control-scheme fields are re-defaulted when the stored schema predates a scheme change,
    // otherwise a player who has ever played keeps the old pitch direction forever and the new
    // default never reaches them. Everything else (volumes, accessibility) is preserved.
    invertY: storedSchema === SETTINGS_SCHEMA ? readBool(rec.invertY, defaults.invertY) : defaults.invertY,
    mouseSensitivity: clamp(
      readNumber(rec.mouseSensitivity, defaults.mouseSensitivity),
      MOUSE_SENSITIVITY_MIN,
      MOUSE_SENSITIVITY_MAX,
    ),
    // Rollover relief is a deliberate accessibility choice about the player's hardware, not a
    // tuning default, so it survives a schema bump rather than being reset with the rest of the
    // control scheme.
    toggleFire: readBool(rec.toggleFire, defaults.toggleFire),
    toggleBoost: readBool(rec.toggleBoost, defaults.toggleBoost),
    cruiseThrottle: readBool(rec.cruiseThrottle, defaults.cruiseThrottle),

    keybinds: sanitizeKeybinds(rec.keybinds),

    showPerfOverlay: readBool(rec.showPerfOverlay, defaults.showPerfOverlay),
  };
}

/** localStorage.setItem can throw (private browsing, quota, disabled storage) — never fatal. */
export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE.settings, JSON.stringify({ ...s, schema: SETTINGS_SCHEMA }));
  } catch {
    // Settings simply won't persist this session; gameplay is unaffected.
  }
}

export function resetSettings(): Settings {
  const defaults = createDefaultSettings();
  saveSettings(defaults);
  return defaults;
}
