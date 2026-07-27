/**
 * The Codex — a reference browser for enemies, weapons, and augments.
 *
 * The enemies tab is the load-bearing one: DESIGN.md §10 states every archetype must answer
 * "how do I beat it?" through silhouette and colour alone during play, but a player who wants
 * the explicit answer spelled out gets it here. The counters transcribed below are the actual
 * DESIGN.md §10 table entries, not invented flavour text.
 */

import type { EnemyTypeId } from '../core/types';
import { cssColor, palette } from '../render/palette';
import { ENEMY_DEFS, ENEMY_ORDER } from '../enemies/types';
import { AUGMENTS, CATEGORY_NAMES, RARITY_NAMES } from '../progression/augments';
import { AugmentCategory } from '../core/types';

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

/** DESIGN.md §10's Silhouette / Counter columns, transcribed verbatim — this is the one piece
 * of genuinely load-bearing information the codex exists to surface. */
const SILHOUETTE: Record<EnemyTypeId, string> = {
  waspDrone: 'Small, angular, fast.',
  interceptor: 'Sleek delta.',
  lancer: 'Long, thin, glowing spine.',
  bulwark: 'Wide, plated, front-heavy.',
  carrier: 'Bulky, hangar-lit.',
  mineLayer: 'Segmented, blinking.',
};
const BEHAVIOR: Record<EnemyTypeId, string> = {
  waspDrone: 'Swarms and closes for kamikaze arcs.',
  interceptor: 'Dogfights: strafes and dodges once locked.',
  lancer: 'Stationary sniper with a 1.4s beam telegraph.',
  bulwark: 'Advances slowly behind a frontal shield arc.',
  carrier: 'Spawns Wasp Drones continuously.',
  mineLayer: 'Drops persistent proximity mines.',
};
const COUNTER: Record<EnemyTypeId, string> = {
  waspDrone: 'Any AoE clears them fast — don’t get surrounded.',
  interceptor: 'Lead your shots; drift to hold the angle on its dodges.',
  lancer: 'Break line of sight, or close the gap before the beam fires.',
  bulwark: 'Flank it — the rear is unarmoured. The front shield arc reduces damage hard.',
  carrier: 'Priority target. Every second it lives is more Wasps in the fight.',
  mineLayer: 'Range it down; don’t chase it through its own minefield.',
};

/**
 * combat/weapons.ts does not exist yet in this codebase (it is being written in parallel with
 * this file), so this tab reads from a hand-transcribed table of DESIGN.md §8 instead of the
 * real module. Once combat/weapons.ts lands, this table should be replaced with an import of
 * its real WEAPONS definitions so the codex can never drift from the live numbers.
 */
interface WeaponEntry {
  readonly name: string;
  readonly tag: string;
  readonly description: string;
}
const PRIMARY_WEAPONS: readonly WeaponEntry[] = [
  { name: 'Pulse Repeater', tag: 'PRIMARY', description: 'Fast, tight, forgiving — the baseline. Lowest per-shot damage; poor against armour.' },
  { name: 'Lance Driver', tag: 'PRIMARY', description: 'Charge-and-release railgun. Pierces everything in a line. Charging commits you — missing costs the whole cycle.' },
  { name: 'Scatter Vents', tag: 'PRIMARY', description: 'Shotgun cone. Deletes things at knife range. Damage falls off hard past 140m.' },
  { name: 'Arc Tether', tag: 'PRIMARY', description: 'Auto-connecting chain lightning, hits up to 4 targets. Low single-target damage; needs crowds to pay off.' },
  { name: 'Flak Battery', tag: 'PRIMARY', description: 'Proximity-fused AoE shells. Slow projectiles; punishes bad leading.' },
  { name: 'Singularity Coil', tag: 'PRIMARY', description: 'Slow orb that drags enemies into a clump. Almost no direct damage — a setup tool.' },
];
const SECONDARY_WEAPONS: readonly WeaponEntry[] = [
  { name: 'Swarm Missiles', tag: 'SECONDARY', description: 'Locks up to 6 targets, fires a homing volley.' },
  { name: 'Nova Mine', tag: 'SECONDARY', description: 'Deployable proximity charge with a large blast radius.' },
  { name: 'Phase Lance', tag: 'SECONDARY', description: 'Sustained piercing beam while held; drains a meter.' },
  { name: 'Gravity Well', tag: 'SECONDARY', description: 'Thrown singularity. Pulls and slows everything caught in it for 4s.' },
  { name: 'Aegis Pulse', tag: 'SECONDARY', description: 'Shockwave that clears incoming bullets and refills shields.' },
];

type TabId = 'enemies' | 'weapons' | 'augments';
const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'enemies', label: 'ENEMIES' },
  { id: 'weapons', label: 'WEAPONS' },
  { id: 'augments', label: 'AUGMENTS' },
];

export class Codex {
  private readonly root: HTMLDivElement;
  private readonly tabsRow: HTMLDivElement;
  private readonly tabButtons: HTMLButtonElement[] = [];
  private readonly content: HTMLDivElement;
  private readonly closeBtn: HTMLButtonElement;

  private activeTab: TabId = 'enemies';
  private entryFocusables: HTMLElement[] = [];
  private focusIndex = 0;
  private onClose: () => void = () => {};
  private _visible = false;

  constructor(container: HTMLElement) {
    this.root = make('div', 'codex-root', container);
    const panel = make('div', 'codex-panel', this.root);
    make('div', 'codex-title', panel).textContent = 'CODEX';

    this.tabsRow = make('div', 'codex-tabs', panel);
    for (const tab of TABS) {
      const btn = make('button', 'codex-tab', this.tabsRow);
      btn.type = 'button';
      btn.textContent = tab.label;
      btn.addEventListener('click', () => this.selectTab(tab.id));
      btn.addEventListener('focus', () => this.syncFocusIndexFor(btn));
      this.tabButtons.push(btn);
    }

    this.content = make('div', 'codex-content', panel);

    const closeRow = make('div', 'codex-close-row', panel);
    this.closeBtn = make('button', 'menu-button', closeRow);
    this.closeBtn.type = 'button';
    this.closeBtn.textContent = 'CLOSE';
    this.closeBtn.addEventListener('click', () => this.onClose());

    this.applyPalette();
  }

  private applyPalette(): void {
    const p = palette();
    const s = this.root.style;
    s.setProperty('--hud-primary', cssColor(p.hudPrimary));
    s.setProperty('--hud-dim', cssColor(p.hudDim));
    s.setProperty('--hud-good', cssColor(p.hudGood));
    s.setProperty('--cat-offense', cssColor(p.category[0]!));
    s.setProperty('--cat-defense', cssColor(p.category[1]!));
    s.setProperty('--cat-mobility', cssColor(p.category[2]!));
    s.setProperty('--cat-systems', cssColor(p.category[3]!));
    s.setProperty('--rarity-common', cssColor(p.rarity[0]!));
    s.setProperty('--rarity-rare', cssColor(p.rarity[1]!));
    s.setProperty('--rarity-prototype', cssColor(p.rarity[2]!));
  }

  show(onClose: () => void): void {
    this.onClose = onClose;
    this.applyPalette();
    this.selectTab(this.activeTab);
    this.root.classList.add('is-visible');
    this._visible = true;
    this.focusIndex = 0;
    this.syncAllFocusClasses();
    requestAnimationFrame(() => this.tabButtons[this.tabIndexOf(this.activeTab)]?.focus({ preventScroll: true }));
  }

  hide(): void {
    this.root.classList.remove('is-visible');
    this._visible = false;
  }

  get visible(): boolean {
    return this._visible;
  }

  private tabIndexOf(id: TabId): number {
    return TABS.findIndex((t) => t.id === id);
  }

  private selectTab(id: TabId): void {
    this.activeTab = id;
    for (let i = 0; i < this.tabButtons.length; i++) {
      this.tabButtons[i]!.classList.toggle('is-active', TABS[i]!.id === id);
    }

    this.content.innerHTML = '';
    this.entryFocusables = [];

    if (id === 'enemies') this.renderEnemies();
    else if (id === 'weapons') this.renderWeapons();
    else this.renderAugments();

    this.rebuildFullFocusList();
  }

  private renderEnemies(): void {
    for (const id of ENEMY_ORDER) {
      const def = ENEMY_DEFS[id];
      const entry = make('div', 'codex-entry', this.content);
      entry.tabIndex = 0;

      const head = make('div', 'codex-entry-head', entry);
      make('div', 'codex-entry-name', head).textContent = def.displayName;
      if (def.armorArc > 0) {
        make('div', 'codex-entry-tag', head).textContent = 'ARMOURED FRONT';
      }

      const statParts = [`HULL ${def.hull}`];
      if (def.shield > 0) statParts.push(`SHIELD ${def.shield}`);
      statParts.push(`SPEED ${def.speed}`, `DAMAGE ${def.damage}`, `THREAT ${def.threat}`);
      make('div', 'codex-entry-stats', entry).textContent = statParts.join(' · ');

      make('div', 'codex-entry-desc', entry).textContent = `${SILHOUETTE[id]} ${BEHAVIOR[id]}`;

      const counter = make('div', 'codex-entry-counter', entry);
      make('span', 'label', counter).textContent = 'COUNTER';
      counter.append(COUNTER[id]);

      entry.addEventListener('focus', () => this.syncFocusIndexFor(entry));
      this.entryFocusables.push(entry);
    }
  }

  private renderWeapons(): void {
    const renderList = (title: string, list: readonly WeaponEntry[]): void => {
      const heading = make('div', 'codex-entry-name', this.content);
      heading.textContent = title;
      for (const w of list) {
        const entry = make('div', 'codex-entry', this.content);
        entry.tabIndex = 0;
        const head = make('div', 'codex-entry-head', entry);
        make('div', 'codex-entry-name', head).textContent = w.name;
        make('div', 'codex-entry-tag', head).textContent = w.tag;
        make('div', 'codex-entry-desc', entry).textContent = w.description;
        entry.addEventListener('focus', () => this.syncFocusIndexFor(entry));
        this.entryFocusables.push(entry);
      }
    };
    renderList('Primaries', PRIMARY_WEAPONS);
    renderList('Secondaries', SECONDARY_WEAPONS);
  }

  private renderAugments(): void {
    const p = palette();
    for (let cat = 0; cat < CATEGORY_NAMES.length; cat++) {
      const inCategory = AUGMENTS.filter((a) => a.category === (cat as AugmentCategory));
      if (inCategory.length === 0) continue;

      const heading = make('div', 'codex-entry-name', this.content);
      heading.textContent = CATEGORY_NAMES[cat] ?? '';
      heading.style.color = cssColor(p.category[cat] ?? p.category[0]!);

      for (const a of inCategory) {
        const entry = make('div', 'codex-entry', this.content);
        entry.tabIndex = 0;
        const head = make('div', 'codex-entry-head', entry);
        make('div', 'codex-entry-name', head).textContent = a.name;
        const rarityTag = make('div', 'codex-entry-tag', head);
        rarityTag.textContent = a.ruleChanging ? `${RARITY_NAMES[a.rarity]} — RULE CHANGE` : RARITY_NAMES[a.rarity] ?? '';
        rarityTag.style.color = cssColor(p.rarity[a.rarity] ?? p.rarity[0]!);
        make('div', 'codex-entry-desc', entry).textContent = a.description;
        entry.addEventListener('focus', () => this.syncFocusIndexFor(entry));
        this.entryFocusables.push(entry);
      }
    }
  }

  /** The flat, reading-order focus list: tabs, then the active tab's entries, then Close. */
  private rebuildFullFocusList(): void {
    this.focusIndex = Math.min(this.focusIndex, this.tabButtons.length - 1);
    this.syncAllFocusClasses();
  }

  private get fullFocusables(): HTMLElement[] {
    return [...this.tabButtons, ...this.entryFocusables, this.closeBtn];
  }

  private syncFocusIndexFor(el: HTMLElement): void {
    const idx = this.fullFocusables.indexOf(el);
    if (idx >= 0) this.focusIndex = idx;
    this.syncAllFocusClasses();
  }

  private syncAllFocusClasses(): void {
    const all = this.fullFocusables;
    for (let i = 0; i < all.length; i++) {
      all[i]!.classList.toggle('is-focused', i === this.focusIndex);
    }
  }

  private moveFocus(delta: number): void {
    const all = this.fullFocusables;
    const n = all.length;
    if (n === 0) return;
    this.focusIndex = (this.focusIndex + delta + n) % n;
    this.syncAllFocusClasses();
    all[this.focusIndex]!.focus({ preventScroll: true });
  }

  handleKey(code: string): boolean {
    if (!this._visible) return false;

    switch (code) {
      case 'Escape':
        this.onClose();
        return true;
      case 'ArrowLeft':
      case 'ArrowUp':
      case 'KeyA':
      case 'KeyW':
        this.moveFocus(-1);
        return true;
      case 'ArrowRight':
      case 'ArrowDown':
      case 'KeyD':
      case 'KeyS':
        this.moveFocus(1);
        return true;
      case 'Enter':
      case 'Space': {
        const el = this.fullFocusables[this.focusIndex];
        if (el instanceof HTMLButtonElement) el.click();
        return true;
      }
      default:
        return false;
    }
  }

  dispose(): void {
    this.root.remove();
    this.tabButtons.length = 0;
    this.entryFocusables = [];
  }
}
