/**
 * Title, pause, settings, game-over, sector-clear, and boss-intro screens.
 *
 * All six live under a single `.menu-root` overlay and swap which `.menu-panel` is displayed,
 * matching the CSS's single-modal structure. None of these screens run per frame — they are
 * shown on state transitions — so rebuilding a panel's dynamic content on each `show*` call is
 * the right trade-off for simplicity over the change-detection discipline `hud.ts` needs.
 *
 * Every screen here answers to the same input contract (DESIGN §15): arrows/WASD move focus,
 * Enter/Space activates, Escape backs out. Focus is real DOM focus (not a synthetic overlay),
 * so the browser's native `:focus-visible` ring (already wired for `.menu-root` in styles.css)
 * is the visible-focus guarantee, and `.is-focused` supplies the second, colour-independent cue
 * the readability rules in DESIGN §13 require.
 */

import type { InputAction, Settings } from '../core/types';
import { ColorblindMode } from '../core/types';
import { DEFAULT_KEYBINDS } from '../core/settings';
import { cssColor, palette, paletteName } from '../render/palette';
import { formatRunTime } from '../progression/run';

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

/** Every action name a keybind row must cover, in a stable, player-facing order. */
const ACTION_ORDER: readonly InputAction[] = Object.keys(DEFAULT_KEYBINDS) as InputAction[];

const ACTION_LABELS: Record<InputAction, string> = {
  firePrimary: 'Fire Primary',
  fireSecondary: 'Fire Secondary',
  throttleUp: 'Throttle Up',
  throttleDown: 'Throttle Down',
  strafeLeft: 'Strafe Left',
  strafeRight: 'Strafe Right',
  rollLeft: 'Roll Left',
  rollRight: 'Roll Right',
  boost: 'Boost',
  drift: 'Drift',
  cycleTarget: 'Cycle Target',
  reroll: 'Reroll Draft',
  pause: 'Pause',
};

const DIFFICULTY_LABELS: readonly string[] = ['Cadet', 'Pilot', 'Ace', 'Nightmare'];
const AIM_ASSIST_LABELS: readonly string[] = ['Off', 'Light', 'Strong'];

/** Turns a `KeyboardEvent.code` into a short label for the rebind button. */
function prettyCode(code: string): string {
  const special: Record<string, string> = {
    Space: 'SPACE',
    Escape: 'ESC',
    Tab: 'TAB',
    ShiftLeft: 'L SHIFT',
    ShiftRight: 'R SHIFT',
    ControlLeft: 'L CTRL',
    ControlRight: 'R CTRL',
    AltLeft: 'L ALT',
    AltRight: 'R ALT',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
  };
  if (special[code]) return special[code]!;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code.toUpperCase();
}

type ScreenName = 'none' | 'title' | 'pause' | 'settings' | 'gameover' | 'sectorclear' | 'bossintro';

interface ActionButton {
  readonly label: string;
  readonly variant?: 'primary' | 'danger';
  readonly onClick: () => void;
}

/** One navigable settings control: how to read/adjust it, and what to focus. */
interface SettingsRow {
  readonly el: HTMLElement;
  readonly adjust: (dir: 1 | -1) => void;
  readonly activate: () => void;
}

export class Menus {
  private readonly root: HTMLDivElement;

  private readonly titlePanel: HTMLDivElement;
  private readonly titleStatSector: HTMLDivElement;
  private readonly titleStatScore: HTMLDivElement;
  private readonly titleStatRuns: HTMLDivElement;
  private readonly titleActions: HTMLDivElement;

  private readonly pausePanel: HTMLDivElement;
  private readonly pauseActions: HTMLDivElement;

  private readonly settingsPanel: HTMLDivElement;
  private readonly settingsGrid: HTMLDivElement;

  private readonly gameOverPanel: HTMLDivElement;
  private readonly gameOverResult: HTMLDivElement;
  private readonly gameOverStats: HTMLDivElement;
  private readonly gameOverAugmentList: HTMLDivElement;
  private readonly gameOverActions: HTMLDivElement;

  private readonly sectorClearPanel: HTMLDivElement;
  private readonly sectorClearHeading: HTMLDivElement;
  private readonly sectorClearName: HTMLDivElement;
  private readonly sectorClearTime: HTMLDivElement;

  private readonly bossIntroPanel: HTMLDivElement;
  private readonly bossIntroName: HTMLDivElement;
  private readonly bossIntroSubtitle: HTMLDivElement;
  private bossIntroTimeout: number | null = null;

  private currentScreen: ScreenName = 'none';

  /** Simple vertical button lists (title/pause/game-over) share one focus mechanism. */
  private actionFocusables: HTMLButtonElement[] = [];
  private actionFocusIndex = 0;

  /** Settings has richer per-row semantics (sliders adjust, toggles flip, selects cycle). */
  private settingsRows: SettingsRow[] = [];
  private settingsFocusIndex = 0;
  private listeningAction: InputAction | null = null;

  private settings: Settings;
  private onSettingsClose: () => void = () => {};
  private onSettingsChange: (s: Settings) => void = () => {};
  private onSettingsRebind: (action: string) => void = () => {};

  private onPauseResume: () => void = () => {};

  constructor(container: HTMLElement, settings: Settings) {
    this.settings = settings;
    this.root = make('div', 'menu-root', container);

    // --- Title -------------------------------------------------------------------------------
    this.titlePanel = make('div', 'menu-panel', this.root);
    const titleHeading = make('div', 'menu-title-game', this.titlePanel);
    titleHeading.append('STARFALL ');
    const accent = make('span', 'accent', titleHeading);
    accent.textContent = 'ARMADA X';
    make('div', 'menu-subtitle', this.titlePanel).textContent =
      'Hold the corridor. Go deeper than the last pilot did.';
    const titleStats = make('div', 'menu-stats', this.titlePanel);
    this.titleStatSector = this.buildStat(titleStats, 'Best Sector');
    this.titleStatScore = this.buildStat(titleStats, 'Best Score');
    this.titleStatRuns = this.buildStat(titleStats, 'Runs Flown');
    this.titleActions = make('div', 'menu-actions', this.titlePanel);

    // --- Pause -------------------------------------------------------------------------------
    this.pausePanel = make('div', 'menu-panel', this.root);
    make('div', 'menu-heading', this.pausePanel).textContent = 'PAUSED';
    this.pauseActions = make('div', 'menu-actions', this.pausePanel);

    // --- Settings ----------------------------------------------------------------------------
    this.settingsPanel = make('div', 'menu-panel', this.root);
    make('div', 'menu-heading', this.settingsPanel).textContent = 'SETTINGS';
    this.settingsGrid = make('div', 'settings-grid', this.settingsPanel);
    const settingsCloseRow = make('div', 'menu-close-row', this.settingsPanel);
    const settingsCloseBtn = make('button', 'menu-button menu-button--primary', settingsCloseRow);
    settingsCloseBtn.type = 'button';
    settingsCloseBtn.textContent = 'BACK';
    settingsCloseBtn.addEventListener('click', () => this.onSettingsClose());

    // --- Game over ---------------------------------------------------------------------------
    this.gameOverPanel = make('div', 'menu-panel', this.root);
    this.gameOverResult = make('div', 'gameover-result', this.gameOverPanel);
    this.gameOverStats = make('div', 'menu-stats', this.gameOverPanel);
    const gameOverAugments = make('div', 'gameover-augments', this.gameOverPanel);
    make('div', 'gameover-augments-title', gameOverAugments).textContent = 'AUGMENTS TAKEN';
    this.gameOverAugmentList = make('div', 'gameover-augment-list', gameOverAugments);
    this.gameOverActions = make('div', 'menu-actions', this.gameOverPanel);

    // --- Sector clear --------------------------------------------------------------------------
    this.sectorClearPanel = make('div', 'menu-panel', this.root);
    this.sectorClearHeading = make('div', 'menu-heading', this.sectorClearPanel);
    this.sectorClearName = make('div', 'sectorclear-name', this.sectorClearPanel);
    this.sectorClearTime = make('div', 'sectorclear-time', this.sectorClearPanel);

    // --- Boss intro --------------------------------------------------------------------------
    this.bossIntroPanel = make('div', 'menu-panel', this.root);
    this.bossIntroName = make('div', 'bossintro-name', this.bossIntroPanel);
    this.bossIntroSubtitle = make('div', 'bossintro-subtitle', this.bossIntroPanel);

    this.hideAllPanels();
    this.applyPalette();
  }

  private buildStat(parent: HTMLElement, label: string): HTMLDivElement {
    const stat = make('div', 'menu-stat', parent);
    make('div', 'menu-stat-value', stat).textContent = '0';
    make('div', 'menu-stat-label', stat).textContent = label;
    return stat.querySelector<HTMLDivElement>('.menu-stat-value')!;
  }

  private applyPalette(): void {
    const p = palette();
    const s = this.root.style;
    s.setProperty('--hud-primary', cssColor(p.hudPrimary));
    s.setProperty('--hud-dim', cssColor(p.hudDim));
    s.setProperty('--hud-warning', cssColor(p.hudWarning));
    s.setProperty('--hud-danger', cssColor(p.hudDanger));
    s.setProperty('--hud-good', cssColor(p.hudGood));
    s.setProperty('--enemy-accent', cssColor(p.enemyAccent));
  }

  private hideAllPanels(): void {
    this.titlePanel.style.display = 'none';
    this.pausePanel.style.display = 'none';
    this.settingsPanel.style.display = 'none';
    this.gameOverPanel.style.display = 'none';
    this.sectorClearPanel.style.display = 'none';
    this.bossIntroPanel.style.display = 'none';
  }

  private showScreen(screen: ScreenName, panel: HTMLDivElement): void {
    this.clearBossIntroTimer();
    this.hideAllPanels();
    panel.style.display = '';
    this.currentScreen = screen;
    this.root.classList.add('is-visible');
  }

  /* --- Simple vertical action-button screens (title / pause / game over) ------------------- */

  private buildActionButtons(container: HTMLDivElement, buttons: readonly ActionButton[]): HTMLButtonElement[] {
    container.innerHTML = '';
    const els: HTMLButtonElement[] = [];
    for (const b of buttons) {
      const variantClass = b.variant ? ` menu-button--${b.variant}` : '';
      const btn = make('button', `menu-button${variantClass}`, container);
      btn.type = 'button';
      btn.textContent = b.label;
      btn.addEventListener('click', b.onClick);
      btn.addEventListener('focus', () => {
        this.actionFocusIndex = els.indexOf(btn);
        this.syncActionFocusClasses();
      });
      els.push(btn);
    }
    return els;
  }

  private syncActionFocusClasses(): void {
    for (let i = 0; i < this.actionFocusables.length; i++) {
      this.actionFocusables[i]!.classList.toggle('is-focused', i === this.actionFocusIndex);
    }
  }

  private focusFirstAction(): void {
    this.actionFocusIndex = 0;
    this.syncActionFocusClasses();
    requestAnimationFrame(() => {
      if (this.actionFocusables.length > 0) this.actionFocusables[0]!.focus({ preventScroll: true });
    });
  }

  private moveActionFocus(delta: number): void {
    const n = this.actionFocusables.length;
    if (n === 0) return;
    this.actionFocusIndex = (this.actionFocusIndex + delta + n) % n;
    this.syncActionFocusClasses();
    this.actionFocusables[this.actionFocusIndex]!.focus({ preventScroll: true });
  }

  showTitle(opts: {
    onPlay: () => void;
    onHangar: () => void;
    onSettings: () => void;
    onCodex: () => void;
    bestSector: number;
    bestScore: number;
    runsPlayed: number;
  }): void {
    this.applyPalette();
    this.titleStatSector.textContent = `${opts.bestSector}`;
    this.titleStatScore.textContent = `${Math.round(opts.bestScore)}`;
    this.titleStatRuns.textContent = `${opts.runsPlayed}`;

    this.actionFocusables = this.buildActionButtons(this.titleActions, [
      { label: 'LAUNCH', variant: 'primary', onClick: opts.onPlay },
      { label: 'HANGAR', onClick: opts.onHangar },
      { label: 'SETTINGS', onClick: opts.onSettings },
      { label: 'CODEX', onClick: opts.onCodex },
    ]);

    this.showScreen('title', this.titlePanel);
    this.focusFirstAction();
  }

  showPause(opts: { onResume: () => void; onSettings: () => void; onQuit: () => void }): void {
    this.applyPalette();
    this.onPauseResume = opts.onResume;

    this.actionFocusables = this.buildActionButtons(this.pauseActions, [
      { label: 'RESUME', variant: 'primary', onClick: opts.onResume },
      { label: 'SETTINGS', onClick: opts.onSettings },
      { label: 'QUIT TO TITLE', variant: 'danger', onClick: opts.onQuit },
    ]);

    this.showScreen('pause', this.pausePanel);
    this.focusFirstAction();
  }

  showGameOver(opts: {
    victory: boolean;
    score: number;
    salvage: number;
    sectorReached: number;
    kills: number;
    time: string;
    augments: readonly { name: string; stacks: number }[];
    onRetry: () => void;
    onHangar: () => void;
    onTitle: () => void;
  }): void {
    this.applyPalette();
    this.gameOverResult.textContent = opts.victory ? 'VICTORY' : 'RUN ENDED';
    this.gameOverResult.classList.toggle('is-victory', opts.victory);
    this.gameOverResult.classList.toggle('is-defeat', !opts.victory);

    this.gameOverStats.innerHTML = '';
    const stat = (label: string, value: string): void => {
      const el = make('div', 'menu-stat', this.gameOverStats);
      make('div', 'menu-stat-value', el).textContent = value;
      make('div', 'menu-stat-label', el).textContent = label;
    };
    stat('Score', `${Math.round(opts.score)}`);
    stat('Salvage', `${Math.round(opts.salvage)}`);
    stat('Sector', `${opts.sectorReached}`);
    stat('Kills', `${opts.kills}`);
    stat('Time', opts.time);

    this.gameOverAugmentList.innerHTML = '';
    if (opts.augments.length === 0) {
      const chip = make('div', 'gameover-augment-chip', this.gameOverAugmentList);
      chip.textContent = 'None taken';
    } else {
      for (const a of opts.augments) {
        const chip = make('div', 'gameover-augment-chip', this.gameOverAugmentList);
        chip.append(a.name);
        if (a.stacks > 1) {
          const stacks = make('span', 'stacks', chip);
          stacks.textContent = `×${a.stacks}`;
        }
      }
    }

    this.actionFocusables = this.buildActionButtons(this.gameOverActions, [
      { label: 'RETRY', variant: 'primary', onClick: opts.onRetry },
      { label: 'HANGAR', onClick: opts.onHangar },
      { label: 'TITLE', onClick: opts.onTitle },
    ]);

    this.showScreen('gameover', this.gameOverPanel);
    this.focusFirstAction();
  }

  showSectorClear(sector: number, name: string, seconds: number): void {
    this.applyPalette();
    this.sectorClearHeading.textContent = `SECTOR ${sector} CLEARED`;
    this.sectorClearName.textContent = name;
    this.sectorClearTime.textContent = formatRunTime(seconds);
    this.actionFocusables = [];
    this.showScreen('sectorclear', this.sectorClearPanel);
  }

  showBossIntro(name: string, subtitle: string, seconds: number): void {
    this.applyPalette();
    this.bossIntroName.textContent = name;
    this.bossIntroSubtitle.textContent = subtitle;
    this.actionFocusables = [];
    this.showScreen('bossintro', this.bossIntroPanel);

    this.clearBossIntroTimer();
    this.bossIntroTimeout = window.setTimeout(() => {
      this.bossIntroTimeout = null;
      if (this.currentScreen === 'bossintro') this.hideAll();
    }, Math.max(0, seconds) * 1000);
  }

  private clearBossIntroTimer(): void {
    if (this.bossIntroTimeout !== null) {
      window.clearTimeout(this.bossIntroTimeout);
      this.bossIntroTimeout = null;
    }
  }

  hideAll(): void {
    this.clearBossIntroTimer();
    this.hideAllPanels();
    this.root.classList.remove('is-visible');
    this.currentScreen = 'none';
    this.actionFocusables = [];
    this.settingsRows = [];
    this.listeningAction = null;
  }

  get visible(): boolean {
    return this.currentScreen !== 'none';
  }

  /* --- Settings ------------------------------------------------------------------------------ */

  private emitChange(): void {
    this.onSettingsChange(this.settings);
  }

  private buildRow(
    label: string,
  ): { row: HTMLDivElement; control: HTMLDivElement } {
    const row = make('div', 'settings-row', this.settingsGrid.lastElementChild as HTMLDivElement);
    make('div', 'settings-label', row).textContent = label;
    const control = make('div', 'settings-control', row);
    return { row, control };
  }

  private buildSection(title: string): void {
    const section = make('div', 'settings-section', this.settingsGrid);
    make('div', 'settings-section-title', section).textContent = title;
  }

  private buildSlider(
    label: string,
    min: number,
    max: number,
    step: number,
    get: () => number,
    set: (v: number) => void,
    format: (v: number) => string,
  ): void {
    const { control } = this.buildRow(label);
    const slider = make('input', 'settings-slider', control);
    slider.type = 'range';
    slider.min = `${min}`;
    slider.max = `${max}`;
    slider.step = `${step}`;
    slider.value = `${get()}`;
    const valueEl = make('span', 'settings-value', control);
    valueEl.textContent = format(get());

    const apply = (v: number): void => {
      set(v);
      valueEl.textContent = format(get());
      this.emitChange();
    };
    slider.addEventListener('input', () => apply(parseFloat(slider.value)));
    slider.addEventListener('focus', () => this.syncSettingsFocusIndex(slider));

    this.settingsRows.push({
      el: slider,
      adjust: (dir) => {
        const next = Math.min(max, Math.max(min, get() + dir * step));
        slider.value = `${next}`;
        apply(next);
      },
      activate: () => {},
    });
  }

  private buildToggle(label: string, get: () => boolean, set: (v: boolean) => void): void {
    const { control } = this.buildRow(label);
    const btn = make('button', 'settings-toggle', control);
    btn.type = 'button';
    btn.setAttribute('role', 'switch');
    const sync = (): void => btn.setAttribute('aria-checked', get() ? 'true' : 'false');
    sync();

    const flip = (): void => {
      set(!get());
      sync();
      this.emitChange();
    };
    btn.addEventListener('click', flip);
    btn.addEventListener('focus', () => this.syncSettingsFocusIndex(btn));

    this.settingsRows.push({ el: btn, adjust: () => flip(), activate: flip });
  }

  private buildSelect(
    label: string,
    options: readonly string[],
    get: () => number,
    set: (v: number) => void,
  ): void {
    const { control } = this.buildRow(label);
    const select = make('select', 'settings-select', control);
    for (let i = 0; i < options.length; i++) {
      const opt = document.createElement('option');
      opt.value = `${i}`;
      opt.textContent = options[i]!;
      select.appendChild(opt);
    }
    select.value = `${get()}`;

    const apply = (v: number): void => {
      set(v);
      select.value = `${v}`;
      this.emitChange();
    };
    select.addEventListener('change', () => apply(parseInt(select.value, 10)));
    select.addEventListener('focus', () => this.syncSettingsFocusIndex(select));

    this.settingsRows.push({
      el: select,
      adjust: (dir) => {
        const next = Math.min(options.length - 1, Math.max(0, get() + dir));
        apply(next);
      },
      activate: () => {},
    });
  }

  private buildKeybindRow(action: InputAction): void {
    const { control } = this.buildRow(ACTION_LABELS[action]);
    const btn = make('button', 'settings-keybind', control);
    btn.type = 'button';
    btn.textContent = prettyCode(this.settings.keybinds[action] ?? DEFAULT_KEYBINDS[action]);

    const beginRebind = (): void => {
      this.listeningAction = action;
      btn.classList.add('is-listening');
      btn.textContent = 'PRESS A KEY';
      this.onSettingsRebind(action);
    };
    btn.addEventListener('click', beginRebind);
    btn.addEventListener('focus', () => this.syncSettingsFocusIndex(btn));

    this.settingsRows.push({ el: btn, adjust: () => {}, activate: beginRebind });
  }

  private buildSettingsGrid(): void {
    this.settingsGrid.innerHTML = '';
    this.settingsRows = [];

    this.buildSection('Audio');
    this.buildSlider(
      'Master Volume', 0, 1, 0.01,
      () => this.settings.masterVolume, (v) => (this.settings.masterVolume = v),
      (v) => `${Math.round(v * 100)}%`,
    );
    this.buildSlider(
      'Music Volume', 0, 1, 0.01,
      () => this.settings.musicVolume, (v) => (this.settings.musicVolume = v),
      (v) => `${Math.round(v * 100)}%`,
    );
    this.buildSlider(
      'SFX Volume', 0, 1, 0.01,
      () => this.settings.sfxVolume, (v) => (this.settings.sfxVolume = v),
      (v) => `${Math.round(v * 100)}%`,
    );

    this.buildSection('Accessibility');
    this.buildSlider(
      'Screen Shake', 0, 1, 0.01,
      () => this.settings.screenShake, (v) => (this.settings.screenShake = v),
      (v) => `${Math.round(v * 100)}%`,
    );
    this.buildSlider(
      'Hit-Stop', 0, 1, 0.01,
      () => this.settings.hitStop, (v) => (this.settings.hitStop = v),
      (v) => `${Math.round(v * 100)}%`,
    );
    this.buildToggle(
      'Reduce Flash / Bloom',
      () => this.settings.reduceFlash,
      (v) => (this.settings.reduceFlash = v),
    );
    this.buildToggle(
      'Damage Numbers',
      () => this.settings.showDamageNumbers,
      (v) => (this.settings.showDamageNumbers = v),
    );
    this.buildSelect(
      'Colourblind Mode',
      [
        paletteName(ColorblindMode.Default),
        paletteName(ColorblindMode.Deuteranopia),
        paletteName(ColorblindMode.Protanopia),
        paletteName(ColorblindMode.Tritanopia),
      ],
      () => this.settings.colorblind,
      (v) => (this.settings.colorblind = v as Settings['colorblind']),
    );
    this.buildSelect(
      'Aim Assist',
      AIM_ASSIST_LABELS,
      () => this.settings.aimAssist,
      (v) => (this.settings.aimAssist = v as Settings['aimAssist']),
    );
    this.buildToggle(
      'Performance Overlay',
      () => this.settings.showPerfOverlay,
      (v) => (this.settings.showPerfOverlay = v),
    );

    this.buildSection('Gameplay');
    this.buildSelect(
      'Difficulty',
      DIFFICULTY_LABELS,
      () => this.settings.difficulty,
      (v) => (this.settings.difficulty = v as Settings['difficulty']),
    );
    this.buildToggle(
      'Invert Y',
      () => this.settings.invertY,
      (v) => (this.settings.invertY = v),
    );
    this.buildSlider(
      'Mouse Sensitivity', 0.2, 3, 0.1,
      () => this.settings.mouseSensitivity, (v) => (this.settings.mouseSensitivity = v),
      (v) => `${v.toFixed(1)}x`,
    );

    this.buildSection('Controls');
    for (const action of ACTION_ORDER) this.buildKeybindRow(action);
  }

  private syncSettingsFocusIndex(el: HTMLElement): void {
    const idx = this.settingsRows.findIndex((r) => r.el === el);
    if (idx >= 0) this.settingsFocusIndex = idx;
  }

  showSettings(onClose: () => void, onChange: (s: Settings) => void, onRebind: (action: string) => void): void {
    this.applyPalette();
    this.onSettingsClose = onClose;
    this.onSettingsChange = onChange;
    this.onSettingsRebind = onRebind;
    this.listeningAction = null;

    this.buildSettingsGrid();

    this.showScreen('settings', this.settingsPanel);
    this.settingsFocusIndex = 0;
    requestAnimationFrame(() => {
      this.settingsRows[0]?.el.focus({ preventScroll: true });
    });
  }

  /**
   * Re-syncs every settings control from a fresh `Settings` object without rebuilding the DOM,
   * so a value changed elsewhere (a rebind completing, a load from disk) is reflected without
   * losing scroll position or focus. Also clears any in-progress rebind's "listening" state,
   * since the only caller of this after a rebind is the code that just captured the new key.
   */
  refreshSettings(s: Settings): void {
    this.settings = s;
    this.listeningAction = null;

    if (this.currentScreen === 'settings') {
      const focused = this.settingsRows[this.settingsFocusIndex]?.el;
      this.buildSettingsGrid();
      // Rebuilding recreates elements, so re-resolve focus by position rather than by reference.
      const idx = Math.min(this.settingsFocusIndex, this.settingsRows.length - 1);
      this.settingsFocusIndex = Math.max(0, idx);
      const next = this.settingsRows[this.settingsFocusIndex]?.el;
      if (next && next !== focused) next.focus({ preventScroll: true });
    }
  }

  private moveSettingsFocus(delta: number): void {
    const n = this.settingsRows.length;
    if (n === 0) return;
    this.settingsFocusIndex = (this.settingsFocusIndex + delta + n) % n;
    this.settingsRows[this.settingsFocusIndex]!.el.focus({ preventScroll: true });
  }

  /* --- Input ---------------------------------------------------------------------------------- */

  handleKey(code: string): boolean {
    if (this.currentScreen === 'none') return false;

    if (code === 'Escape') {
      switch (this.currentScreen) {
        case 'settings':
          this.onSettingsClose();
          return true;
        case 'pause':
          this.onPauseResume();
          return true;
        case 'sectorclear':
        case 'bossintro':
          this.hideAll();
          return true;
        default:
          return true;
      }
    }

    if (this.currentScreen === 'sectorclear' || this.currentScreen === 'bossintro') {
      if (code === 'Enter' || code === 'Space') {
        this.hideAll();
        return true;
      }
      return false;
    }

    if (this.currentScreen === 'settings') {
      // A rebind is in flight; the actual key capture happens outside this class (see the
      // class doc comment), so we just swallow input until `refreshSettings` clears the flag.
      if (this.listeningAction !== null) return true;

      switch (code) {
        case 'ArrowUp':
        case 'KeyW':
          this.moveSettingsFocus(-1);
          return true;
        case 'ArrowDown':
        case 'KeyS':
          this.moveSettingsFocus(1);
          return true;
        case 'ArrowLeft':
        case 'KeyA':
          this.settingsRows[this.settingsFocusIndex]?.adjust(-1);
          return true;
        case 'ArrowRight':
        case 'KeyD':
          this.settingsRows[this.settingsFocusIndex]?.adjust(1);
          return true;
        case 'Enter':
        case 'Space':
          this.settingsRows[this.settingsFocusIndex]?.activate();
          return true;
        default:
          return false;
      }
    }

    // Title / pause / game over: a single vertical button list.
    switch (code) {
      case 'ArrowUp':
      case 'KeyW':
        this.moveActionFocus(-1);
        return true;
      case 'ArrowDown':
      case 'KeyS':
        this.moveActionFocus(1);
        return true;
      case 'Enter':
      case 'Space':
        this.actionFocusables[this.actionFocusIndex]?.click();
        return true;
      default:
        return false;
    }
  }

  dispose(): void {
    this.clearBossIntroTimer();
    this.root.remove();
    this.actionFocusables = [];
    this.settingsRows = [];
  }
}
