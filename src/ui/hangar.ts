/**
 * The Hangar — the meta-progression spending screen (DESIGN.md §7.2, §9).
 *
 * The one thing this screen must never let the player misread: salvage buys *options*, never
 * raw power. Every purchase widens what a run can contain (a weapon, a hull, a blueprint, a
 * livery) rather than making the next run's numbers bigger. The tagline says so in plain text,
 * and every node's four possible states (owned / affordable / unaffordable / locked) are
 * distinguished by shape and label as well as colour, per DESIGN §13/§15.
 */

import type { HullId, MetaState, PrimaryWeaponId, SecondaryWeaponId } from '../core/types';
import { cssColor, palette } from '../render/palette';
import {
  canAfford,
  getNode,
  isNodeAvailable,
  isNodeOwned,
  nodesOfKind,
  type UnlockNode,
} from '../progression/meta';
import { HULLS, HULL_ORDER } from '../ship/hulls';
import { defaultLoadout } from '../progression/run';

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

/**
 * combat/weapons.ts does not exist yet in this codebase (it is being written in parallel), so
 * these labels are transcribed from DESIGN.md §8 purely for the loadout picker's button text.
 * Unlock-tree node names/descriptions already come from progression/meta.ts — this table only
 * covers the two starting weapons, which have no unlock node of their own.
 */
const PRIMARY_NAMES: Record<PrimaryWeaponId, string> = {
  pulseRepeater: 'Pulse Repeater',
  lanceDriver: 'Lance Driver',
  scatterVents: 'Scatter Vents',
  arcTether: 'Arc Tether',
  flakBattery: 'Flak Battery',
  singularityCoil: 'Singularity Coil',
};
const SECONDARY_NAMES: Record<SecondaryWeaponId, string> = {
  swarmMissiles: 'Swarm Missiles',
  novaMine: 'Nova Mine',
  phaseLance: 'Phase Lance',
  gravityWell: 'Gravity Well',
  aegisPulse: 'Aegis Pulse',
};
const PRIMARY_ORDER: readonly PrimaryWeaponId[] = [
  'pulseRepeater', 'lanceDriver', 'scatterVents', 'arcTether', 'flakBattery', 'singularityCoil',
];
const SECONDARY_ORDER: readonly SecondaryWeaponId[] = [
  'swarmMissiles', 'novaMine', 'phaseLance', 'gravityWell', 'aegisPulse',
];

type NodeState = 'owned' | 'affordable' | 'unaffordable' | 'locked';

function nodeState(meta: MetaState, node: UnlockNode): NodeState {
  if (isNodeOwned(meta, node)) return 'owned';
  if (!isNodeAvailable(meta, node)) return 'locked';
  if (canAfford(meta, node)) return 'affordable';
  return 'unaffordable';
}

const STATE_LABEL: Record<NodeState, string> = {
  owned: 'OWNED',
  affordable: 'AVAILABLE',
  unaffordable: 'NEED SALVAGE',
  locked: 'LOCKED',
};

const scratchNodes: UnlockNode[] = [];

export class Hangar {
  private readonly root: HTMLDivElement;
  private readonly salvageValue: HTMLSpanElement;
  private readonly weaponsGrid: HTMLDivElement;
  private readonly hullsGrid: HTMLDivElement;
  private readonly blueprintsGrid: HTMLDivElement;
  private readonly liveriesGrid: HTMLDivElement;
  private readonly hullGroup: HTMLDivElement;
  private readonly primaryGroup: HTMLDivElement;
  private readonly secondaryGroup: HTMLDivElement;
  private readonly closeBtn: HTMLButtonElement;

  private meta: MetaState | null = null;
  private onPurchase: (nodeId: string) => void = () => {};
  private onSelectLoadout: (hull: HullId, primary: PrimaryWeaponId, secondary: SecondaryWeaponId) => void =
    () => {};
  private onClose: () => void = () => {};

  private selectedHull: HullId = 'starfall';
  private selectedPrimary: PrimaryWeaponId = 'pulseRepeater';
  private selectedSecondary: SecondaryWeaponId = 'swarmMissiles';

  private focusables: HTMLElement[] = [];
  private focusIndex = 0;
  private _visible = false;

  constructor(container: HTMLElement) {
    this.root = make('div', 'hangar-root', container);
    const panel = make('div', 'hangar-panel', this.root);

    const head = make('div', 'hangar-head', panel);
    make('div', 'hangar-title', head).textContent = 'HANGAR';
    const salvageBlock = make('div', '', head);
    make('span', 'hangar-salvage-label', salvageBlock).textContent = 'SALVAGE';
    this.salvageValue = make('span', 'hangar-salvage', salvageBlock);

    const tagline = make('div', 'hangar-tagline', panel);
    tagline.append('Salvage buys ');
    const accent = make('span', 'accent', tagline);
    accent.textContent = 'options, never raw power';
    tagline.append(
      ' — new weapons, hulls, and augment blueprints that enter every run from now on. Nothing here makes you stronger; everything here makes you more.',
    );

    const weaponsSection = make('div', 'hangar-section', panel);
    make('div', 'hangar-section-title', weaponsSection).textContent = 'WEAPONS';
    this.weaponsGrid = make('div', 'hangar-grid', weaponsSection);

    const hullsSection = make('div', 'hangar-section', panel);
    make('div', 'hangar-section-title', hullsSection).textContent = 'HULLS';
    this.hullsGrid = make('div', 'hangar-grid', hullsSection);

    const blueprintsSection = make('div', 'hangar-section', panel);
    make('div', 'hangar-section-title', blueprintsSection).textContent = 'AUGMENT BLUEPRINTS';
    this.blueprintsGrid = make('div', 'hangar-grid', blueprintsSection);

    const liveriesSection = make('div', 'hangar-section', panel);
    make('div', 'hangar-section-title', liveriesSection).textContent = 'LIVERIES';
    this.liveriesGrid = make('div', 'hangar-grid', liveriesSection);

    const loadoutSection = make('div', 'hangar-section', panel);
    make('div', 'hangar-section-title', loadoutSection).textContent = 'LOADOUT';
    const loadout = make('div', 'hangar-loadout', loadoutSection);
    this.hullGroup = this.buildLoadoutGroup(loadout, 'Hull');
    this.primaryGroup = this.buildLoadoutGroup(loadout, 'Primary');
    this.secondaryGroup = this.buildLoadoutGroup(loadout, 'Secondary');

    const closeRow = make('div', 'hangar-close-row', panel);
    this.closeBtn = make('button', 'menu-button menu-button--primary', closeRow);
    this.closeBtn.type = 'button';
    this.closeBtn.textContent = 'LAUNCH';
    this.closeBtn.addEventListener('click', () => this.onClose());

    this.applyPalette();
  }

  private buildLoadoutGroup(parent: HTMLElement, title: string): HTMLDivElement {
    const group = make('div', 'hangar-loadout-group', parent);
    make('div', 'hangar-loadout-title', group).textContent = title;
    return group;
  }

  private applyPalette(): void {
    const p = palette();
    const s = this.root.style;
    s.setProperty('--hud-primary', cssColor(p.hudPrimary));
    s.setProperty('--hud-dim', cssColor(p.hudDim));
    s.setProperty('--hud-warning', cssColor(p.hudWarning));
    s.setProperty('--hud-good', cssColor(p.hudGood));
  }

  show(
    meta: MetaState,
    onPurchase: (nodeId: string) => void,
    onSelectLoadout: (hull: HullId, primary: PrimaryWeaponId, secondary: SecondaryWeaponId) => void,
    onClose: () => void,
  ): void {
    this.onPurchase = onPurchase;
    this.onSelectLoadout = onSelectLoadout;
    this.onClose = onClose;

    const loadout = defaultLoadout(meta);
    this.selectedHull = loadout.hull;
    this.selectedPrimary = loadout.primary;
    this.selectedSecondary = loadout.secondary;

    this.render(meta);

    this.root.classList.add('is-visible');
    this._visible = true;
    this.focusIndex = 0;
    this.syncFocusClasses();
    requestAnimationFrame(() => this.focusables[0]?.focus({ preventScroll: true }));
  }

  refresh(meta: MetaState): void {
    this.render(meta);
  }

  private render(meta: MetaState): void {
    this.applyPalette();
    this.meta = meta;
    this.salvageValue.textContent = `${Math.round(meta.totalSalvage)}`;

    this.focusables = [];

    const weaponNodes = nodesOfKind('primary', scratchNodes).slice();
    weaponNodes.push(...nodesOfKind('secondary', scratchNodes));
    this.renderGrid(this.weaponsGrid, weaponNodes, meta);
    this.renderGrid(this.hullsGrid, nodesOfKind('hull', scratchNodes), meta);
    this.renderGrid(this.blueprintsGrid, nodesOfKind('augment', scratchNodes), meta);
    this.renderGrid(this.liveriesGrid, nodesOfKind('livery', scratchNodes), meta);

    this.renderLoadoutGroup(
      this.hullGroup,
      HULL_ORDER.filter((id) => meta.unlockedHulls.includes(id)),
      (id) => HULLS[id].displayName,
      this.selectedHull,
      (id) => {
        this.selectedHull = id;
        this.onSelectLoadout(this.selectedHull, this.selectedPrimary, this.selectedSecondary);
        this.render(this.meta!);
      },
    );
    this.renderLoadoutGroup(
      this.primaryGroup,
      PRIMARY_ORDER.filter((id) => meta.unlockedPrimaries.includes(id)),
      (id) => PRIMARY_NAMES[id],
      this.selectedPrimary,
      (id) => {
        this.selectedPrimary = id;
        this.onSelectLoadout(this.selectedHull, this.selectedPrimary, this.selectedSecondary);
        this.render(this.meta!);
      },
    );
    this.renderLoadoutGroup(
      this.secondaryGroup,
      SECONDARY_ORDER.filter((id) => meta.unlockedSecondaries.includes(id)),
      (id) => SECONDARY_NAMES[id],
      this.selectedSecondary,
      (id) => {
        this.selectedSecondary = id;
        this.onSelectLoadout(this.selectedHull, this.selectedPrimary, this.selectedSecondary);
        this.render(this.meta!);
      },
    );

    this.focusables.push(this.closeBtn);
    this.focusIndex = Math.min(this.focusIndex, this.focusables.length - 1);
    this.syncFocusClasses();
  }

  private renderGrid(grid: HTMLDivElement, nodes: readonly UnlockNode[], meta: MetaState): void {
    grid.innerHTML = '';
    for (const node of nodes) {
      const state = nodeState(meta, node);
      const card = make('button', `hangar-node hangar-node--${state}`, grid);
      card.type = 'button';

      make('div', 'hangar-node-name', card).textContent = node.name;

      let descText = node.description;
      if (state === 'locked') {
        const missing = node.requires
          .map((id) => getNode(id))
          .filter((prereq): prereq is UnlockNode => prereq !== undefined && !isNodeOwned(meta, prereq))
          .map((prereq) => prereq.name);
        if (missing.length > 0) descText += ` Requires: ${missing.join(', ')}.`;
      }
      make('div', 'hangar-node-desc', card).textContent = descText;

      if (node.liveryHull !== undefined && node.liveryAccent !== undefined) {
        const swatch = make('div', 'hangar-node-swatch', card);
        swatch.style.background = `linear-gradient(135deg, ${cssColor(node.liveryHull)} 50%, ${cssColor(node.liveryAccent)} 50%)`;
      }

      const foot = make('div', 'hangar-node-foot', card);
      make('span', '', foot).textContent = `${node.cost} SALVAGE`;
      const stateEl = make('span', 'hangar-node-state', foot);
      make('span', 'hangar-node-state-glyph', stateEl);
      stateEl.append(STATE_LABEL[state]);

      // Owned/locked/unaffordable cards stay focusable (so keyboard/gamepad nav can reach and
      // read them — a card you can't yet afford is still information), they just have no click
      // effect since only an affordable node is actually purchasable.
      if (state === 'affordable') {
        card.addEventListener('click', () => {
          this.onPurchase(node.id);
          if (this.meta) this.render(this.meta);
        });
      }
      card.addEventListener('focus', () => this.syncFocusIndexFor(card));

      this.focusables.push(card);
    }
  }

  private renderLoadoutGroup<T extends string>(
    group: HTMLDivElement,
    owned: readonly T[],
    nameOf: (id: T) => string,
    selected: T,
    onSelect: (id: T) => void,
  ): void {
    // The title is the group's first child, built once in the constructor; everything after it
    // is the option list, rebuilt each render.
    while (group.children.length > 1) group.lastElementChild!.remove();

    for (const id of owned) {
      const opt = make('button', 'hangar-loadout-option', group);
      opt.type = 'button';
      opt.classList.toggle('is-selected', id === selected);
      make('span', 'hangar-loadout-option-glyph', opt);
      opt.append(nameOf(id));
      opt.addEventListener('click', () => onSelect(id));
      opt.addEventListener('focus', () => this.syncFocusIndexFor(opt));
      this.focusables.push(opt);
    }
  }

  private syncFocusIndexFor(el: HTMLElement): void {
    const idx = this.focusables.indexOf(el);
    if (idx >= 0) this.focusIndex = idx;
    this.syncFocusClasses();
  }

  private syncFocusClasses(): void {
    for (let i = 0; i < this.focusables.length; i++) {
      this.focusables[i]!.classList.toggle('is-focused', i === this.focusIndex);
    }
  }

  private moveFocus(delta: number): void {
    const n = this.focusables.length;
    if (n === 0) return;
    this.focusIndex = (this.focusIndex + delta + n) % n;
    this.syncFocusClasses();
    this.focusables[this.focusIndex]!.focus({ preventScroll: true });
  }

  hide(): void {
    this.root.classList.remove('is-visible');
    this._visible = false;
  }

  get visible(): boolean {
    return this._visible;
  }

  handleKey(code: string): boolean {
    if (!this._visible) return false;

    switch (code) {
      case 'Escape':
        this.onClose();
        return true;
      case 'ArrowLeft':
      case 'KeyA':
        this.moveFocus(-1);
        return true;
      case 'ArrowRight':
      case 'KeyD':
        this.moveFocus(1);
        return true;
      case 'ArrowUp':
      case 'KeyW': {
        // Node cards sit in a 3-column grid, so a "row up" reads better as a stride of 3; every
        // other focusable here (loadout options, the close button) is a simple vertical list.
        const current = this.focusables[this.focusIndex];
        const stride = current?.classList.contains('hangar-node') ? 3 : 1;
        this.moveFocus(-stride);
        return true;
      }
      case 'ArrowDown':
      case 'KeyS': {
        const current = this.focusables[this.focusIndex];
        const stride = current?.classList.contains('hangar-node') ? 3 : 1;
        this.moveFocus(stride);
        return true;
      }
      case 'Enter':
      case 'Space':
        this.focusables[this.focusIndex]?.click();
        return true;
      default:
        return false;
    }
  }

  dispose(): void {
    this.root.remove();
    this.focusables = [];
  }
}
