/**
 * Enemy archetype definitions and their procedural meshes (DESIGN.md §10).
 *
 * Every archetype ships as exactly one merged `BufferGeometry` + one `Material`, so the
 * manager can drive it with a single `InstancedMesh` (one draw call per archetype, per the
 * §16.2 instancing rule). Silhouette is the primary readability channel (§13): each shape is
 * built from genuinely different primitives so a pilot can name the archetype from its outline
 * alone, before colour or the HUD ever helps them.
 *
 * Stats are hand-balanced against `PLAYER` in core/constants.ts (base speed 115, base turn
 * rate 2.0 rad/s): fast/fragile archetypes out-turn and out-run the player, slow/tanky ones
 * fall well short of both.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { EnemyDef, EnemyTypeId } from '../core/types';
import { palette } from '../render/palette';

/* ------------------------------------------------------------------------------------------ */
/* Stats                                                                                        */
/* ------------------------------------------------------------------------------------------ */

/**
 * Salvage and score are kept perfectly proportional to `threat` (salvage = threat * 4,
 * score = threat * 18) so the wave director's threat budget doubles as the reward curve —
 * a harder enemy is always worth more, by a fixed, legible ratio.
 */
function reward(threat: number): { salvage: number; score: number } {
  return { salvage: Math.round(threat * 4), score: Math.round(threat * 18) };
}

export const ENEMY_DEFS: Readonly<Record<EnemyTypeId, EnemyDef>> = {
  // Small, fast, disposable — the swarm. No shield so any splash damage clears them, which is
  // the point: they punish a player who has no AoE, not one who is merely inaccurate.
  waspDrone: {
    id: 'waspDrone',
    displayName: 'Wasp Drone',
    hull: 18,
    shield: 0,
    radius: 1.6,
    speed: 140,
    turnRate: 4.2,
    engageRange: 12,
    fireRange: 14,
    fireInterval: 0.6,
    damage: 8,
    ...reward(1),
    armorArc: 0,
    armorReduction: 0,
    threat: 1,
  },

  // The dogfighter. Out-turns the player by a wide margin and holds a mid-range brawl; the
  // stated counter ("lead your shots; drift to hold the angle") only works because it actually
  // strafes and jinks rather than flying a straight intercept line.
  interceptor: {
    id: 'interceptor',
    displayName: 'Interceptor',
    hull: 55,
    shield: 20,
    radius: 2.4,
    speed: 120,
    turnRate: 2.6,
    engageRange: 90,
    fireRange: 130,
    fireInterval: 0.5,
    damage: 7,
    ...reward(2.5),
    armorArc: 0,
    armorReduction: 0,
    threat: 2.5,
  },

  // Stationary sniper. Slower than the player and turns sluggishly, so its entire threat lives
  // in range and the telegraph — it has no answer once a player closes the distance.
  lancer: {
    id: 'lancer',
    displayName: 'Lancer',
    hull: 45,
    shield: 0,
    radius: 2.6,
    speed: 45,
    turnRate: 1.6,
    engageRange: 320,
    fireRange: 320,
    fireInterval: 3.2,
    damage: 26,
    ...reward(3),
    armorArc: 0,
    armorReduction: 0,
    threat: 3,
  },

  // Front-heavy brick. `armorArc`/`armorReduction` only matter if the AI keeps its nose on the
  // player (see ai.ts) — that is what makes "flank it" a real, learnable counter rather than a
  // tooltip.
  bulwark: {
    id: 'bulwark',
    displayName: 'Bulwark',
    hull: 190,
    shield: 60,
    radius: 4.4,
    speed: 55,
    turnRate: 1.7,
    engageRange: 140,
    fireRange: 150,
    fireInterval: 1.1,
    damage: 14,
    ...reward(4),
    armorArc: 1.2,
    armorReduction: 0.75,
    threat: 4,
  },

  // Highest hull pool in the base roster and the softest turn rate — it never chases. Its
  // danger is entirely in what it spawns, which is why "priority target" is the stated counter.
  carrier: {
    id: 'carrier',
    displayName: 'Carrier',
    hull: 260,
    shield: 40,
    radius: 7.0,
    speed: 38,
    turnRate: 0.9,
    engageRange: 260,
    fireRange: 200,
    fireInterval: 2.6,
    damage: 8,
    ...reward(5),
    armorArc: 0,
    armorReduction: 0,
    threat: 5,
  },

  // Avoids engagement entirely; its weapon exists mostly to punish a player who parks inside
  // its field rather than to threaten head-on.
  mineLayer: {
    id: 'mineLayer',
    displayName: 'Mine Layer',
    hull: 90,
    shield: 20,
    radius: 2.5,
    speed: 70,
    turnRate: 2.0,
    engageRange: 180,
    fireRange: 150,
    fireInterval: 2.2,
    damage: 10,
    ...reward(3),
    armorArc: 0,
    armorReduction: 0,
    threat: 3,
  },
};

/** Roughly threat-ascending, matching the DESIGN.md §10 table order. */
export const ENEMY_ORDER: readonly EnemyTypeId[] = [
  'waspDrone',
  'interceptor',
  'lancer',
  'bulwark',
  'carrier',
  'mineLayer',
];

export function getEnemyDef(id: EnemyTypeId): EnemyDef {
  return ENEMY_DEFS[id];
}

/**
 * Scales an EnemyDef's stats for sector/threat-level scaling without mutating the shared def
 * (every enemy of a type shares the same immutable `EnemyDef` object, so writing to it would
 * corrupt every other live instance).
 *
 * Hull and shield scale linearly with `powerScale` — that is the readable "takes longer to
 * kill" difficulty knob. Damage is dampened by a sqrt curve: scaling it 1:1 with hull would let
 * a high-Threat-Level Bulwark one-shot a fresh hull from a positioning mistake, which is a
 * spike rather than a curve.
 */
export function scaleEnemyStats(
  def: EnemyDef,
  powerScale: number,
  out: { hull: number; shield: number; damage: number },
): void {
  const clamped = powerScale > 0 ? powerScale : 0;
  out.hull = def.hull * clamped;
  out.shield = def.shield * clamped;
  out.damage = def.damage * Math.sqrt(clamped);
}

/* ------------------------------------------------------------------------------------------ */
/* Geometry construction helpers                                                               */
/* ------------------------------------------------------------------------------------------ */
/*
 * Everything below runs once, at asset-build time (never in the per-frame path), so ordinary
 * allocation is fine here — the zero-allocation rule governs ai.ts and the manager's update
 * loop, not mesh construction.
 */

/** Paints every vertex of `geo` with a single flat colour so parts can be told apart once
 * merged into one archetype geometry sharing one material. */
function paint(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const count = geo.attributes.position!.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

/**
 * A flattened, tapered box used for wings and armour plates: wide at +Z (root, toward the
 * rear) and narrower at -Z (tip, toward the nose), which reads as a swept-back wing/plate
 * silhouette without needing a bespoke vertex layout.
 */
function buildTaperedSlab(span: number, rootDepth: number, thickness: number, tipFraction: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(span, thickness, rootDepth, 1, 1, 1);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    if (z < 0) pos.setX(i, x * tipFraction);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Merges pre-transformed, pre-painted parts into a single geometry and centres it on the
 * origin's bounding sphere so instance scale/rotation behaves predictably.
 *
 * Normalising indexing before the merge is load-bearing, not defensive: three's primitives are
 * not uniform about it. ConeGeometry/BoxGeometry/CylinderGeometry are indexed, but anything
 * built on PolyhedronGeometry (IcosahedronGeometry here) is NOT. mergeGeometries requires all
 * inputs to be uniformly indexed or uniformly non-indexed and returns null otherwise, so
 * mixing them — as every archetype builder below does — silently fails without this. */
function mergeParts(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (parts.length === 0) throw new Error('enemies/types: mergeParts got zero geometries');

  const normalized = parts.map((g) => (g.index ? g.toNonIndexed() : g));

  const reference = Object.keys(normalized[0]!.attributes).sort();
  for (let i = 1; i < normalized.length; i++) {
    const attrs = Object.keys(normalized[i]!.attributes).sort();
    const matches = attrs.length === reference.length && attrs.every((a, idx) => a === reference[idx]);
    if (!matches) {
      throw new Error(
        `enemies/types: mergeParts attribute mismatch at index ${i}: ` +
          `[${attrs.join(',')}] vs [${reference.join(',')}].`,
      );
    }
  }

  const merged = mergeGeometries(normalized as THREE.BufferGeometry[], false);

  // toNonIndexed() allocates a new geometry when it converts one; those copies exist only for
  // the merge. Inputs already non-indexed come back by reference and are the caller's.
  for (let i = 0; i < parts.length; i++) {
    if (normalized[i] !== parts[i]) normalized[i]!.dispose();
  }

  if (!merged) {
    throw new Error(
      'enemies/types: mergeGeometries returned null — see the preceding ' +
        'THREE.BufferGeometryUtils console.error for which input broke uniformity.',
    );
  }

  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}

/* Per-archetype builders ---------------------------------------------------------------------
 * Every part is built pointing/centred correctly, then painted, then merged. Forward is -Z
 * throughout, matching `FORWARD` in core/math.ts. */

function buildWaspDroneGeometry(): THREE.BufferGeometry {
  const p = palette();

  // Angular arrow-shaped body: a 4-sided cone gives a faceted, insectile fuselage rather than
  // a smooth aerodynamic one.
  const body = new THREE.ConeGeometry(0.5, 2.6, 4, 1);
  body.rotateX(-Math.PI / 2);
  paint(body, p.enemyHull);

  // Glowing core sits mid-body — the one part of a Wasp Drone that reads instantly at range.
  const core = new THREE.IcosahedronGeometry(0.42, 0);
  core.translate(0, 0, 0.1);
  paint(core, p.enemyAccent);

  // Two thin, forward-swept blades — the "insect mandible" read. Mirrored across X.
  const bladeGeo = () => new THREE.BoxGeometry(1.7, 0.05, 0.32);
  const bladeL = bladeGeo();
  bladeL.translate(0, 0, 0.65);
  bladeL.rotateY(0.55);
  bladeL.translate(-0.85, 0.05, -0.35);
  paint(bladeL, p.enemyAccent);

  const bladeR = bladeGeo();
  bladeR.translate(0, 0, 0.65);
  bladeR.rotateY(-0.55);
  bladeR.translate(0.85, 0.05, -0.35);
  paint(bladeR, p.enemyAccent);

  // Small dorsal stabiliser at the tail for silhouette variety when viewed from the side.
  const fin = new THREE.BoxGeometry(0.06, 0.5, 0.7);
  fin.translate(0, 0.35, 1.1);
  paint(fin, p.enemyHull);

  return mergeParts([body, core, bladeL, bladeR, fin]);
}

function buildInterceptorGeometry(): THREE.BufferGeometry {
  const p = palette();

  // Angular delta fuselage: a 4-sided cone reads as a sleek wedge rather than a round fighter.
  const fuselage = new THREE.ConeGeometry(0.55, 4.2, 4, 1);
  fuselage.rotateX(-Math.PI / 2);
  paint(fuselage, p.enemyHull);

  // Swept delta wings, wide at the root (rear) tapering toward the nose.
  const wingL = buildTaperedSlab(3.4, 3.0, 0.16, 0.18);
  wingL.translate(-1.9, -0.05, 0.5);
  paint(wingL, p.enemyHull);
  const wingR = buildTaperedSlab(3.4, 3.0, 0.16, 0.18);
  wingR.translate(1.9, -0.05, 0.5);
  paint(wingR, p.enemyHull);

  // Bright wingtip accents — small, but exactly where the eye lands on a delta silhouette.
  const tipL = new THREE.BoxGeometry(0.4, 0.2, 0.5);
  tipL.translate(-3.55, -0.05, -0.6);
  paint(tipL, p.enemyAccent);
  const tipR = new THREE.BoxGeometry(0.4, 0.2, 0.5);
  tipR.translate(3.55, -0.05, -0.6);
  paint(tipR, p.enemyAccent);

  // Single engine nozzle at the tail, per DESIGN's "swept wings and a single engine".
  const engine = new THREE.CylinderGeometry(0.42, 0.5, 1.1, 8);
  engine.rotateX(Math.PI / 2);
  engine.translate(0, 0, 2.15);
  paint(engine, p.enemyEngine);

  // Single dorsal fin.
  const fin = new THREE.BoxGeometry(0.08, 0.7, 1.4);
  fin.translate(0, 0.5, 1.3);
  paint(fin, p.enemyHull);

  return mergeParts([fuselage, wingL, wingR, tipL, tipR, engine, fin]);
}

function buildLancerGeometry(): THREE.BufferGeometry {
  const p = palette();

  // Long, thin main hull.
  const hull = new THREE.CylinderGeometry(0.4, 0.4, 6.2, 8);
  hull.rotateX(Math.PI / 2);
  paint(hull, p.enemyHull);

  // Prominent glowing dorsal spine running the length of the body — the defining silhouette
  // element per DESIGN.md's "long, thin, glowing spine".
  const spine = new THREE.CylinderGeometry(0.12, 0.12, 6.6, 6);
  spine.rotateX(Math.PI / 2);
  spine.translate(0, 0.42, 0);
  paint(spine, p.enemyAccent);

  // Glowing muzzle cap at the nose, where the beam actually originates.
  const muzzle = new THREE.ConeGeometry(0.22, 0.6, 6);
  muzzle.rotateX(-Math.PI / 2);
  muzzle.translate(0, 0, -3.3);
  paint(muzzle, p.enemyAccent);

  // Two small stabiliser fins near the tail, angled outward.
  const finL = new THREE.BoxGeometry(0.06, 0.9, 1.0);
  finL.rotateZ(0.35);
  finL.translate(-0.55, 0.1, 2.6);
  paint(finL, p.enemyHull);
  const finR = new THREE.BoxGeometry(0.06, 0.9, 1.0);
  finR.rotateZ(-0.35);
  finR.translate(0.55, 0.1, 2.6);
  paint(finR, p.enemyHull);

  return mergeParts([hull, spine, muzzle, finL, finR]);
}

function buildBulwarkGeometry(): THREE.BufferGeometry {
  const p = palette();

  // Wide, blocky core hull.
  const core = new THREE.BoxGeometry(3.2, 1.7, 3.0, 1, 1, 1);
  core.translate(0, 0, 0.3);
  paint(core, p.enemyHull);

  // The frontal shield plate — visibly larger than the hull cross-section behind it, and in a
  // distinct colour, so "attack from behind" reads as an obvious rule rather than trivia.
  const plate = new THREE.BoxGeometry(4.2, 2.3, 0.6, 1, 1, 1);
  plate.translate(0, 0.1, -2.1);
  paint(plate, p.enemyAccent);

  // Side plating widens the silhouette further and sells "plated".
  const sideL = new THREE.BoxGeometry(0.5, 1.3, 2.6);
  sideL.translate(-1.95, -0.1, 0.2);
  paint(sideL, p.enemyHull);
  const sideR = new THREE.BoxGeometry(0.5, 1.3, 2.6);
  sideR.translate(1.95, -0.1, 0.2);
  paint(sideR, p.enemyHull);

  // Exposed, unarmoured engine block at the rear — the visual promise the armour plate makes.
  const engine = new THREE.BoxGeometry(1.6, 1.0, 0.7);
  engine.translate(0, -0.2, 2.05);
  paint(engine, p.enemyEngine);

  return mergeParts([core, plate, sideL, sideR, engine]);
}

function buildCarrierGeometry(): THREE.BufferGeometry {
  const p = palette();

  // Big, bulky rectangular hull — the largest, boxiest silhouette of the roster.
  const hull = new THREE.BoxGeometry(4.2, 3.2, 9.0, 1, 1, 1);
  paint(hull, p.enemyHull);

  // A raised command block toward the stern for a less-uniform top profile.
  const bridge = new THREE.BoxGeometry(1.8, 1.1, 2.2);
  bridge.translate(0, 2.1, 2.6);
  paint(bridge, p.enemyHull);

  // Lit hangar bay recesses along both flanks — DESIGN's "hangar-lit" tell, and the reason a
  // priority-target counter reads clearly even at range.
  const parts: THREE.BufferGeometry[] = [hull, bridge];
  const bayZ = [-2.6, 0, 2.6];
  for (const z of bayZ) {
    const bayL = new THREE.BoxGeometry(0.3, 1.1, 1.4);
    bayL.translate(-2.2, -0.2, z);
    paint(bayL, p.enemyEngine);
    parts.push(bayL);

    const bayR = new THREE.BoxGeometry(0.3, 1.1, 1.4);
    bayR.translate(2.2, -0.2, z);
    paint(bayR, p.enemyEngine);
    parts.push(bayR);
  }

  return mergeParts(parts);
}

function buildMineLayerGeometry(): THREE.BufferGeometry {
  const p = palette();

  // Three segments read as "segmented body" — the gaps between them are the tell.
  const segFront = new THREE.OctahedronGeometry(0.85, 0);
  segFront.translate(0, 0, -1.7);
  paint(segFront, p.enemyHull);
  const segMid = new THREE.OctahedronGeometry(0.95, 0);
  paint(segMid, p.enemyHull);
  const segRear = new THREE.OctahedronGeometry(0.85, 0);
  segRear.translate(0, 0, 1.7);
  paint(segRear, p.enemyHull);

  // Thin connecting rods bridging the segment gaps.
  const linkA = new THREE.CylinderGeometry(0.18, 0.18, 0.9, 6);
  linkA.rotateX(Math.PI / 2);
  linkA.translate(0, 0, -0.85);
  paint(linkA, p.enemyHull);
  const linkB = new THREE.CylinderGeometry(0.18, 0.18, 0.9, 6);
  linkB.rotateX(Math.PI / 2);
  linkB.translate(0, 0, 0.85);
  paint(linkB, p.enemyHull);

  // Blinking dispenser pods slung to either side of the mid segment.
  const podL = new THREE.SphereGeometry(0.4, 8, 6);
  podL.translate(-0.95, -0.15, 0.15);
  paint(podL, p.enemyAccent);
  const podR = new THREE.SphereGeometry(0.4, 8, 6);
  podR.translate(0.95, -0.15, 0.15);
  paint(podR, p.enemyAccent);

  return mergeParts([segFront, segMid, segRear, linkA, linkB, podL, podR]);
}

const GEOMETRY_BUILDERS: Readonly<Record<EnemyTypeId, () => THREE.BufferGeometry>> = {
  waspDrone: buildWaspDroneGeometry,
  interceptor: buildInterceptorGeometry,
  lancer: buildLancerGeometry,
  bulwark: buildBulwarkGeometry,
  carrier: buildCarrierGeometry,
  mineLayer: buildMineLayerGeometry,
};

/* ------------------------------------------------------------------------------------------ */
/* Asset cache                                                                                  */
/* ------------------------------------------------------------------------------------------ */
/*
 * Geometries/materials are memoized per archetype so repeated calls (e.g. a manager rebuilding
 * its InstancedMesh set after a settings change) return the same GPU resource rather than
 * silently leaking a duplicate. `disposeSharedEnemyAssets` is the matching teardown.
 */

const geometryCache = new Map<EnemyTypeId, THREE.BufferGeometry>();
const materialCache = new Map<EnemyTypeId, THREE.Material>();
const eliteMaterialCache = new Map<EnemyTypeId, THREE.Material>();
let auraGeometryCache: THREE.BufferGeometry | null = null;
let auraMaterialCache: THREE.Material | null = null;

export function buildEnemyGeometry(id: EnemyTypeId): THREE.BufferGeometry {
  let geo = geometryCache.get(id);
  if (!geo) {
    geo = GEOMETRY_BUILDERS[id]();
    geometryCache.set(id, geo);
  }
  return geo;
}

export function buildEnemyMaterial(id: EnemyTypeId): THREE.Material {
  let mat = materialCache.get(id);
  if (!mat) {
    const p = palette();
    // Vertex colours carry the hull/accent/engine distinction baked into the merged geometry;
    // the material stays white so it never washes that distinction out. A modest emissive tint
    // in the archetype's accent colour keeps the glowing parts reading as "lit" even in the
    // arena's low ambient light, and gives the brightest parts a shot at clearing the bloom
    // threshold (RENDER.bloomThreshold in core/constants.ts).
    mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      color: 0xffffff,
      roughness: 0.55,
      metalness: 0.3,
      emissive: new THREE.Color(p.enemyAccent),
      emissiveIntensity: 0.35,
    });
    materialCache.set(id, mat);
  }
  return mat;
}

/** Elites reuse the same geometry with a visibly different material: brighter, tinted toward
 * `eliteAura`, and noticeably shinier — the "unmistakable" requirement in DESIGN.md §10. */
export function buildEliteMaterial(id: EnemyTypeId): THREE.Material {
  let mat = eliteMaterialCache.get(id);
  if (!mat) {
    const p = palette();
    const tint = new THREE.Color(p.eliteAura).lerp(new THREE.Color(0xffffff), 0.35);
    mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      color: tint,
      roughness: 0.3,
      metalness: 0.5,
      emissive: new THREE.Color(p.eliteAura),
      emissiveIntensity: 0.9,
    });
    eliteMaterialCache.set(id, mat);
  }
  return mat;
}

/** Unit ring, lying flat (normal along +Y), for the elite aura. The manager scales this per
 * instance to match that enemy's radius rather than this module baking in per-archetype size. */
export function buildEliteAuraGeometry(): THREE.BufferGeometry {
  if (!auraGeometryCache) {
    const geo = new THREE.TorusGeometry(1.0, 0.06, 8, 28);
    geo.rotateX(Math.PI / 2);
    auraGeometryCache = geo;
  }
  return auraGeometryCache;
}

export function buildEliteAuraMaterial(): THREE.Material {
  if (!auraMaterialCache) {
    const p = palette();
    auraMaterialCache = new THREE.MeshBasicMaterial({
      color: new THREE.Color(p.eliteAura),
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }
  return auraMaterialCache;
}

export function disposeSharedEnemyAssets(): void {
  for (const geo of geometryCache.values()) geo.dispose();
  geometryCache.clear();
  for (const mat of materialCache.values()) mat.dispose();
  materialCache.clear();
  for (const mat of eliteMaterialCache.values()) mat.dispose();
  eliteMaterialCache.clear();
  if (auraGeometryCache) {
    auraGeometryCache.dispose();
    auraGeometryCache = null;
  }
  if (auraMaterialCache) {
    auraMaterialCache.dispose();
    auraMaterialCache = null;
  }
}
