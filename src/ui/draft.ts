/**
 * The augment draft screen (DESIGN.md §7.1) — the "runs are decisions, not dice" pillar made
 * concrete. Three cards, every number visible, rarity odds published, one reroll. Nothing here
 * is a mystery box: the player always knows exactly what they are choosing between and why.
 *
 * `show()` is called once per wave (never per frame), so rebuilding the card elements' content
 * on every call is cheap and keeps this file simple — the zero-DOM-churn discipline in hud.ts
 * exists for its per-frame update path, which this screen does not have.
 */

import type { AugmentDef } from '../core/types';
import { cssColor, palette } from '../render/palette';
import { CATEGORY_NAMES, RARITY_NAMES } from '../progression/augments';

/** Tiny DOM-construction helper, mirroring hud.ts's `make` so element wiring stays terse. */
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

interface CardRefs {
  readonly root: HTMLButtonElement;
  readonly keyEl: HTMLSpanElement;
  readonly rarityRow: HTMLDivElement;
  readonly rarityGlyph: HTMLSpanElement;
  readonly rarityText: HTMLSpanElement;
  readonly nameEl: HTMLDivElement;
  readonly categoryEl: HTMLDivElement;
  readonly categoryText: HTMLSpanElement;
  readonly descEl: HTMLDivElement;
  readonly stacksEl: HTMLDivElement;
}

/** The draft is always offered as 3 cards; a fixed pool avoids rebuilding structure per show(). */
const CARD_COUNT = 3;

export class DraftScreen {
  private readonly root: HTMLDivElement;
  private readonly oddsRow: HTMLDivElement;
  private readonly oddsCommon: HTMLSpanElement;
  private readonly oddsRare: HTMLSpanElement;
  private readonly oddsPrototype: HTMLSpanElement;
  private readonly cardsRow: HTMLDivElement;
  private readonly cards: CardRefs[] = [];
  private readonly rerollRow: HTMLDivElement;
  private readonly rerollText: HTMLSpanElement;

  private options: readonly AugmentDef[] = [];
  private rerollsLeft = 0;
  private focusIndex = 0;
  private _visible = false;

  private onPick: (a: AugmentDef) => void = () => {};
  private onReroll: () => void = () => {};

  constructor(container: HTMLElement) {
    this.root = make('div', 'draft-root', container);

    make('div', 'draft-heading', this.root).textContent = 'AUGMENT DRAFT';

    this.oddsRow = make('div', 'draft-odds', this.root);
    this.oddsCommon = make('span', 'odd-common', this.oddsRow);
    this.oddsRare = make('span', 'odd-rare', this.oddsRow);
    this.oddsPrototype = make('span', 'odd-prototype', this.oddsRow);

    this.cardsRow = make('div', 'draft-cards', this.root);
    for (let i = 0; i < CARD_COUNT; i++) {
      this.cards.push(this.buildCard(i));
    }

    this.rerollRow = make('div', 'draft-reroll', this.root);
    const rerollKey = make('span', 'draft-reroll-key', this.rerollRow);
    rerollKey.textContent = 'R';
    this.rerollText = make('span', '', this.rerollRow);

    this.applyPalette();
  }

  private buildCard(index: number): CardRefs {
    const root = make('button', 'draft-card', this.cardsRow);
    root.type = 'button';
    root.tabIndex = 0;
    root.addEventListener('click', () => this.pick(index));
    root.addEventListener('focus', () => this.setFocus(index));

    const keyEl = make('span', 'draft-card-key', root);
    const rarityRow = make('div', 'draft-card-rarity', root);
    const rarityGlyph = make('span', 'draft-rarity-glyph', rarityRow);
    const rarityText = make('span', '', rarityRow);
    const nameEl = make('div', 'draft-card-name', root);
    const categoryEl = make('div', 'draft-card-category', root);
    make('span', 'draft-category-dot', categoryEl);
    const categoryText = make('span', '', categoryEl);
    const descEl = make('div', 'draft-card-desc', root);
    const stacksEl = make('div', 'draft-card-stacks', root);

    return { root, keyEl, rarityRow, rarityGlyph, rarityText, nameEl, categoryEl, categoryText, descEl, stacksEl };
  }

  /** Refreshes the CSS custom properties this screen's own subtree reads, from the live
   * colourblind palette — see hud.ts's `applyPalette` for why this must be a per-root override
   * rather than a global `:root` edit. */
  private applyPalette(): void {
    const p = palette();
    const s = this.root.style;
    s.setProperty('--hud-primary', cssColor(p.hudPrimary));
    s.setProperty('--hud-dim', cssColor(p.hudDim));
    s.setProperty('--cat-offense', cssColor(p.category[0]!));
    s.setProperty('--cat-defense', cssColor(p.category[1]!));
    s.setProperty('--cat-mobility', cssColor(p.category[2]!));
    s.setProperty('--cat-systems', cssColor(p.category[3]!));
    s.setProperty('--rarity-common', cssColor(p.rarity[0]!));
    s.setProperty('--rarity-rare', cssColor(p.rarity[1]!));
    s.setProperty('--rarity-prototype', cssColor(p.rarity[2]!));
  }

  show(
    options: readonly AugmentDef[],
    odds: readonly number[],
    rerollsLeft: number,
    currentStacks: ReadonlyMap<string, number>,
    onPick: (a: AugmentDef) => void,
    onReroll: () => void,
  ): void {
    this.applyPalette();
    this.options = options;
    this.rerollsLeft = rerollsLeft;
    this.onPick = onPick;
    this.onReroll = onReroll;

    const p = palette();
    this.oddsCommon.textContent = `COMMON ${Math.round(odds[0] ?? 0)}%`;
    this.oddsRare.textContent = `RARE ${Math.round(odds[1] ?? 0)}%`;
    this.oddsPrototype.textContent = `PROTOTYPE ${Math.round(odds[2] ?? 0)}%`;

    for (let i = 0; i < this.cards.length; i++) {
      const card = this.cards[i]!;
      const def = options[i];
      if (!def) {
        card.root.style.display = 'none';
        continue;
      }
      card.root.style.display = '';
      card.keyEl.textContent = `${i + 1}`;

      const rarityColor = cssColor(p.rarity[def.rarity] ?? p.rarity[0]!);
      card.rarityGlyph.style.background = rarityColor;
      card.rarityRow.style.color = rarityColor;
      card.rarityText.textContent = RARITY_NAMES[def.rarity] ?? '';

      card.nameEl.textContent = def.name;

      const categoryColor = cssColor(p.category[def.category] ?? p.category[0]!);
      card.categoryEl.style.color = categoryColor;
      card.categoryText.textContent = CATEGORY_NAMES[def.category] ?? '';

      card.descEl.textContent = def.description;

      const stacks = currentStacks.get(def.id) ?? 0;
      if (stacks > 0) {
        card.stacksEl.style.display = '';
        card.stacksEl.textContent = `OWNED — STACK ${stacks} / ${def.maxStacks}`;
      } else {
        card.stacksEl.style.display = 'none';
        card.stacksEl.textContent = '';
      }

      card.root.classList.toggle('draft-card--rule-changing', def.ruleChanging === true);
    }

    this.updateRerollUi();

    this.focusIndex = 0;
    this.updateFocusClasses();

    this.root.classList.add('is-visible');
    this._visible = true;
    // Defer focus to the next frame: the card was just made visible, and some browsers ignore
    // focus() calls on elements that were `display: none` a moment ago in the same tick.
    requestAnimationFrame(() => {
      if (this._visible) this.cards[0]?.root.focus({ preventScroll: true });
    });
  }

  private updateRerollUi(): void {
    this.rerollText.textContent =
      this.rerollsLeft > 0 ? `REROLL (${this.rerollsLeft} LEFT)` : 'REROLL (NONE LEFT)';
    this.rerollRow.classList.toggle('is-disabled', this.rerollsLeft <= 0);
  }

  hide(): void {
    this.root.classList.remove('is-visible');
    this._visible = false;
  }

  get visible(): boolean {
    return this._visible;
  }

  private setFocus(index: number): void {
    this.focusIndex = index;
    this.updateFocusClasses();
  }

  private updateFocusClasses(): void {
    for (let i = 0; i < this.cards.length; i++) {
      this.cards[i]!.root.classList.toggle('is-focused', i === this.focusIndex);
    }
  }

  private moveFocus(delta: number): void {
    const n = this.options.length;
    if (n === 0) return;
    this.focusIndex = (this.focusIndex + delta + n) % n;
    this.updateFocusClasses();
    this.cards[this.focusIndex]?.root.focus({ preventScroll: true });
  }

  private pick(index: number): void {
    const def = this.options[index];
    if (!def) return;
    this.onPick(def);
  }

  private reroll(): void {
    if (this.rerollsLeft <= 0) return;
    this.onReroll();
  }

  handleKey(code: string): boolean {
    if (!this._visible) return false;

    switch (code) {
      case 'ArrowLeft':
      case 'KeyA':
        this.moveFocus(-1);
        return true;
      case 'ArrowRight':
      case 'KeyD':
        this.moveFocus(1);
        return true;
      case 'ArrowUp':
      case 'ArrowDown':
      case 'KeyW':
      case 'KeyS':
        // Single row of cards — nothing to move to vertically, but the key is still ours to
        // swallow so it doesn't leak into gameplay controls behind the overlay.
        return true;
      case 'Enter':
      case 'Space':
        this.pick(this.focusIndex);
        return true;
      case 'Digit1':
        this.pick(0);
        return true;
      case 'Digit2':
        this.pick(1);
        return true;
      case 'Digit3':
        this.pick(2);
        return true;
      case 'KeyR':
        this.reroll();
        return true;
      default:
        return false;
    }
  }

  dispose(): void {
    this.root.remove();
    this.cards.length = 0;
  }
}
