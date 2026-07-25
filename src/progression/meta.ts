/**
 * Meta-progression — the Hangar.
 *
 * The single most important rule here, and the one the genre most often gets wrong: **salvage
 * buys options, never raw power.** There is no "+5% damage forever" node. Every purchase adds
 * a weapon, a hull, or an augment to the pool of things a run *can* contain.
 *
 * The reasoning, from the research in DESIGN.md §2: stat-based meta-progression makes early
 * runs feel artificially bad and late runs trivially easy, and it drives experienced players
 * away because the only thing left to buy is a bigger number. Unlocking options instead means
 * a veteran's run 200 has more *variety* than their run 1, not more damage.
 *
 * A corollary the code enforces: everything unlocked is immediately available on the next run,
 * and nothing that is locked is ever required to win.
 */

import type {
  HullId,
  MetaState,
  PrimaryWeaponId,
  SecondaryWeaponId,
} from '../core/types';
import { RUN } from '../core/constants';
import { saveMeta, unlock } from '../core/save';
import { AUGMENTS, getAugment } from './augments';

export type UnlockKind = 'hull' | 'primary' | 'secondary' | 'augment' | 'livery';

export interface UnlockNode {
  readonly id: string;
  readonly kind: UnlockKind;
  readonly name: string;
  readonly description: string;
  readonly cost: number;
  /** Ids of nodes that must be owned first. Keeps the tree readable rather than a flat shop. */
  readonly requires: readonly string[];
  /** Livery nodes carry the colours they grant. */
  readonly liveryHull?: number;
  readonly liveryAccent?: number;
}

/**
 * The tree. Costs are tuned against the salvage formula in DESIGN.md §6: a full clear of
 * sector 1 yields roughly 400-500 salvage, so the first tier is reachable in two or three
 * runs and the deepest nodes take a committed session.
 */
export const UNLOCK_TREE: readonly UnlockNode[] = [
  /* Primaries — the widest axis of build variety, so they come cheapest. */
  {
    id: 'w_lanceDriver',
    kind: 'primary',
    name: 'Lance Driver',
    description: 'Charge-and-release railgun. Pierces everything in a line.',
    cost: 400,
    requires: [],
  },
  {
    id: 'w_scatterVents',
    kind: 'primary',
    name: 'Scatter Vents',
    description: 'Shotgun cone. Deletes things at knife range.',
    cost: 500,
    requires: [],
  },
  {
    id: 'w_arcTether',
    kind: 'primary',
    name: 'Arc Tether',
    description: 'Auto-connecting chain lightning. Hits up to four targets.',
    cost: 700,
    requires: ['w_lanceDriver'],
  },
  {
    id: 'w_flakBattery',
    kind: 'primary',
    name: 'Flak Battery',
    description: 'Proximity-fused shells. Punishes bad leading, rewards good.',
    cost: 850,
    requires: ['w_scatterVents'],
  },
  {
    id: 'w_singularityCoil',
    kind: 'primary',
    name: 'Singularity Coil',
    description: 'Drags enemies into a clump. Almost no damage — a setup tool.',
    cost: 1100,
    requires: ['w_arcTether'],
  },

  /* Secondaries */
  {
    id: 's_novaMine',
    kind: 'secondary',
    name: 'Nova Mine',
    description: 'Deployable proximity charge with a large blast.',
    cost: 350,
    requires: [],
  },
  {
    id: 's_phaseLance',
    kind: 'secondary',
    name: 'Phase Lance',
    description: 'Sustained piercing beam while held.',
    cost: 600,
    requires: ['s_novaMine'],
  },
  {
    id: 's_gravityWell',
    kind: 'secondary',
    name: 'Gravity Well',
    description: 'Thrown singularity. Pulls and slows for four seconds.',
    cost: 750,
    requires: ['s_novaMine'],
  },
  {
    id: 's_aegisPulse',
    kind: 'secondary',
    name: 'Aegis Pulse',
    description: 'Shockwave that clears enemy fire and refills your shields.',
    cost: 900,
    requires: ['s_phaseLance'],
  },

  /* Hulls — whole playstyles, so they cost more. */
  {
    id: 'h_vireo',
    kind: 'hull',
    name: 'Vireo',
    description: 'Glass-cannon interceptor. Far faster, far more fragile, unlimited drift.',
    cost: 650,
    requires: [],
  },
  {
    id: 'h_bastion',
    kind: 'hull',
    name: 'Bastion',
    description: 'Assault gunship. Heavy hull, shields that regenerate mid-fight.',
    cost: 950,
    requires: ['h_vireo'],
  },
  {
    id: 'h_wraith',
    kind: 'hull',
    name: 'Wraith',
    description: 'Technical hull. Carries two primaries and swaps between them freely.',
    cost: 1500,
    requires: ['h_bastion'],
  },

  /* Augment blueprints — these widen the draft pool itself. */
  {
    id: 'a_kineticBattery',
    kind: 'augment',
    name: 'Blueprint: Kinetic Battery',
    description: 'Adds Kinetic Battery to the Prototype draft pool.',
    cost: 500,
    requires: [],
  },
  {
    id: 'a_timeDilationCore',
    kind: 'augment',
    name: 'Blueprint: Time Dilation Core',
    description: 'Adds Time Dilation Core to the Prototype draft pool.',
    cost: 700,
    requires: ['a_kineticBattery'],
  },
  {
    id: 'a_momentumCore',
    kind: 'augment',
    name: 'Blueprint: Momentum Core',
    description: 'Adds Momentum Core to the Prototype draft pool.',
    cost: 700,
    requires: ['a_kineticBattery'],
  },
  {
    id: 'a_secondWind',
    kind: 'augment',
    name: 'Blueprint: Second Wind',
    description: 'Adds Second Wind to the Prototype draft pool.',
    cost: 850,
    requires: ['a_timeDilationCore'],
  },
  {
    id: 'a_aegisReversal',
    kind: 'augment',
    name: 'Blueprint: Aegis Reversal',
    description: 'Adds Aegis Reversal to the Prototype draft pool.',
    cost: 1000,
    requires: ['a_secondWind'],
  },
  {
    id: 'a_overchargeVents',
    kind: 'augment',
    name: 'Blueprint: Overcharge Vents',
    description: 'Adds Overcharge Vents to the Prototype draft pool.',
    cost: 1300,
    requires: ['a_aegisReversal'],
  },

  /* Liveries — pure cosmetics, deliberately cheap. */
  {
    id: 'l_ember',
    kind: 'livery',
    name: 'Livery: Ember',
    description: 'Burnt orange plating with a white blaze.',
    cost: 200,
    requires: [],
    liveryHull: 0xd8734a,
    liveryAccent: 0xffd8a8,
  },
  {
    id: 'l_void',
    kind: 'livery',
    name: 'Livery: Void',
    description: 'Matte black with violet running lights.',
    cost: 300,
    requires: ['l_ember'],
    liveryHull: 0x22242e,
    liveryAccent: 0xa87dff,
  },
  {
    id: 'l_frost',
    kind: 'livery',
    name: 'Livery: Frost',
    description: 'Pale ice with cyan seams.',
    cost: 400,
    requires: ['l_void'],
    liveryHull: 0xdff0fa,
    liveryAccent: 0x6fe3ff,
  },
];

const NODE_BY_ID = new Map<string, UnlockNode>();
for (const node of UNLOCK_TREE) {
  if (NODE_BY_ID.has(node.id)) throw new Error(`[meta] duplicate unlock node "${node.id}"`);
  NODE_BY_ID.set(node.id, node);
}

/** Maps an unlock node onto the id it grants in MetaState. */
function grantedId(node: UnlockNode): string {
  // Node ids are prefixed for readability in the tree; the granted id is the bare game id.
  const underscore = node.id.indexOf('_');
  return underscore >= 0 ? node.id.slice(underscore + 1) : node.id;
}

export function getNode(id: string): UnlockNode | undefined {
  return NODE_BY_ID.get(id);
}

/* Ownership --------------------------------------------------------------------------------- */

export function isNodeOwned(meta: MetaState, node: UnlockNode): boolean {
  const id = grantedId(node);
  switch (node.kind) {
    case 'hull':
      return meta.unlockedHulls.includes(id as HullId);
    case 'primary':
      return meta.unlockedPrimaries.includes(id as PrimaryWeaponId);
    case 'secondary':
      return meta.unlockedSecondaries.includes(id as SecondaryWeaponId);
    case 'augment':
    case 'livery':
      return meta.unlockedAugments.includes(id);
  }
}

/** True when every prerequisite is owned, so the node may be shown as purchasable. */
export function isNodeAvailable(meta: MetaState, node: UnlockNode): boolean {
  for (const req of node.requires) {
    const prereq = NODE_BY_ID.get(req);
    if (!prereq || !isNodeOwned(meta, prereq)) return false;
  }
  return true;
}

export function canAfford(meta: MetaState, node: UnlockNode): boolean {
  return meta.totalSalvage >= node.cost;
}

export const PurchaseResult = {
  Ok: 0,
  AlreadyOwned: 1,
  Locked: 2,
  TooExpensive: 3,
  UnknownNode: 4,
} as const;
export type PurchaseResult = (typeof PurchaseResult)[keyof typeof PurchaseResult];

/**
 * Spends salvage and grants the node. Mutates `meta` and persists it.
 *
 * Every failure mode returns a distinct result rather than throwing, because the Hangar UI
 * needs to explain *why* a purchase did not happen.
 */
export function purchase(meta: MetaState, nodeId: string): PurchaseResult {
  const node = NODE_BY_ID.get(nodeId);
  if (!node) return PurchaseResult.UnknownNode;
  if (isNodeOwned(meta, node)) return PurchaseResult.AlreadyOwned;
  if (!isNodeAvailable(meta, node)) return PurchaseResult.Locked;
  if (!canAfford(meta, node)) return PurchaseResult.TooExpensive;

  meta.totalSalvage -= node.cost;

  const id = grantedId(node);
  switch (node.kind) {
    case 'hull':
      unlock(meta, 'hull', id);
      break;
    case 'primary':
      unlock(meta, 'primary', id);
      break;
    case 'secondary':
      unlock(meta, 'secondary', id);
      break;
    case 'augment':
    case 'livery':
      unlock(meta, 'augment', id);
      break;
  }

  saveMeta(meta);
  return PurchaseResult.Ok;
}

/* Run bookkeeping ---------------------------------------------------------------------------- */

/**
 * Salvage awarded for a finished run, per DESIGN.md §6. Deliberately generous on depth rather
 * than on kill count, so pushing further is always worth more than farming a cleared wave.
 */
export function computeRunSalvage(sectorReached: number, kills: number, bossesKilled: number): number {
  return (
    sectorReached * RUN.salvagePerSector + kills * RUN.salvagePerKill + bossesKilled * RUN.salvagePerBoss
  );
}

/** Folds a finished run into the persistent profile and saves. */
export function commitRun(
  meta: MetaState,
  opts: { sectorReached: number; kills: number; bossesKilled: number; score: number },
): number {
  const earned = computeRunSalvage(opts.sectorReached, opts.kills, opts.bossesKilled);
  meta.totalSalvage += earned;
  meta.runsPlayed += 1;
  if (opts.sectorReached > meta.bestSector) meta.bestSector = opts.sectorReached;
  if (opts.score > meta.bestScore) meta.bestScore = opts.score;
  saveMeta(meta);
  return earned;
}

/* Queries for the Hangar UI ------------------------------------------------------------------- */

export function ownedCount(meta: MetaState): number {
  let n = 0;
  for (const node of UNLOCK_TREE) if (isNodeOwned(meta, node)) n++;
  return n;
}

export function totalNodes(): number {
  return UNLOCK_TREE.length;
}

/** Nodes grouped for display, in tree order, filtered to a kind. */
export function nodesOfKind(kind: UnlockKind, out: UnlockNode[] = []): UnlockNode[] {
  out.length = 0;
  for (const node of UNLOCK_TREE) if (node.kind === kind) out.push(node);
  return out;
}

/** Liveries the player owns, for the cosmetic picker. Index 0 is always the default. */
export function ownedLiveries(meta: MetaState, out: UnlockNode[] = []): UnlockNode[] {
  out.length = 0;
  for (const node of UNLOCK_TREE) {
    if (node.kind === 'livery' && isNodeOwned(meta, node)) out.push(node);
  }
  return out;
}

/**
 * Development-time consistency check: every augment marked `requiresUnlock` must have a
 * purchasable blueprint node, or it would be permanently unobtainable.
 */
export function verifyUnlockTree(): string[] {
  const problems: string[] = [];

  for (const aug of AUGMENTS) {
    if (!aug.requiresUnlock) continue;
    const hasNode = UNLOCK_TREE.some((n) => n.kind === 'augment' && grantedId(n) === aug.id);
    if (!hasNode) problems.push(`augment "${aug.id}" requires unlock but has no blueprint node`);
  }

  for (const node of UNLOCK_TREE) {
    if (node.kind === 'augment' && !getAugment(grantedId(node))) {
      problems.push(`blueprint node "${node.id}" grants unknown augment "${grantedId(node)}"`);
    }
    for (const req of node.requires) {
      if (!NODE_BY_ID.has(req)) problems.push(`node "${node.id}" requires unknown node "${req}"`);
    }
  }

  return problems;
}
