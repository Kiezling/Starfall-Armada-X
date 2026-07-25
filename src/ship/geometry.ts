/**
 * Procedural construction of the player fighter meshes.
 *
 * Zero external assets: every vertex here comes out of `THREE.*Geometry` constructors combined
 * with baked affine transforms (`geometry.rotateX/scale/translate`, which correctly carry the
 * normal matrix — see BufferGeometry.applyMatrix4), and every texture is drawn to an offscreen
 * canvas. Nothing is loaded over the network.
 *
 * A ship is built as:
 *  - one merged, textured hull mesh (fuselage + wings + canards + fins + nacelle shells +
 *    greebles) — all static geometry, one material, one draw call;
 *  - one merged accent mesh (running lights, trim) — a second draw call;
 *  - one canopy mesh (its own tinted glass material);
 *  - a handful of animated parts that cannot be merged because they move independently:
 *    per-engine nozzle glow, and the elevon/rudder control surfaces.
 * That keeps a "stunning" hero ship inside a handful of draw calls, per DESIGN.md §16.1.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { HullId } from '../core/types';
import { TAU, clamp, clamp01, damp, lerp, pulse } from '../core/math';
import { palette } from '../render/palette';
import { HULL_SHAPES } from './hulls';
import type { HullShape } from './hulls';

/* ------------------------------------------------------------------------------------------ */
/* Seeded RNG                                                                                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * mulberry32, reimplemented locally rather than importing `core/rng.ts` (out of scope for this
 * module per its import allowlist). Greebles are cosmetic, never gameplay-affecting, so a
 * second small RNG living here does not risk desyncing the seeded gameplay stream in `Rng`.
 */
function mulberry32(seed: number): () => number {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Shared textures                                                                              */
/* ------------------------------------------------------------------------------------------ */

const TEX_SIZE = 512;
/** Fixed seed for the panel layout — shared textures look identical every load, by design. */
const PANEL_SEED = 0x5eed1;
/** How many times the panel texture tiles across a ship's merged UV space. */
const PANEL_REPEAT = 3;

interface PanelLayout {
  readonly cols: readonly number[];
  readonly rows: readonly number[];
  /** Per-cell brightness multiplier, indexed [row][col]. */
  readonly shade: readonly (readonly number[])[];
  /** Cell indices (row, col) that get a hazard stripe treatment. */
  readonly stripes: readonly { row: number; col: number }[];
}

/** Builds the panel grid once so the diffuse and normal maps derive from identical geometry. */
function buildPanelLayout(): PanelLayout {
  const rng = mulberry32(PANEL_SEED);
  const colCount = 9;
  const rowCount = 11;
  const cols: number[] = [0];
  const rows: number[] = [0];
  // Jitter interior boundaries so the grid reads as designed plating, not graph paper.
  for (let i = 1; i < colCount; i++) {
    const base = (i / colCount) * TEX_SIZE;
    cols.push(base + (rng() - 0.5) * (TEX_SIZE / colCount) * 0.3);
  }
  cols.push(TEX_SIZE);
  for (let i = 1; i < rowCount; i++) {
    const base = (i / rowCount) * TEX_SIZE;
    rows.push(base + (rng() - 0.5) * (TEX_SIZE / rowCount) * 0.3);
  }
  rows.push(TEX_SIZE);

  const shade: number[][] = [];
  for (let r = 0; r < rowCount; r++) {
    const rowShade: number[] = [];
    for (let c = 0; c < colCount; c++) rowShade.push(1 + (rng() - 0.5) * 0.16);
    shade.push(rowShade);
  }

  const stripes: { row: number; col: number }[] = [];
  const stripeCount = 3;
  for (let i = 0; i < stripeCount; i++) {
    stripes.push({ row: 1 + Math.floor(rng() * (rowCount - 2)), col: Math.floor(rng() * colCount) });
  }

  return { cols, rows, shade, stripes };
}

function isStriped(layout: PanelLayout, row: number, col: number): boolean {
  for (const s of layout.stripes) if (s.row === row && s.col === col) return true;
  return false;
}

/** Draws the colour panel/plating pattern shared diffuse texture uses. */
function drawDiffuse(ctx: CanvasRenderingContext2D, layout: PanelLayout): void {
  ctx.fillStyle = '#aab4c1';
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

  for (let r = 0; r < layout.rows.length - 1; r++) {
    const y0 = layout.rows[r]!;
    const y1 = layout.rows[r + 1]!;
    for (let c = 0; c < layout.cols.length - 1; c++) {
      const x0 = layout.cols[c]!;
      const x1 = layout.cols[c + 1]!;
      const m = layout.shade[r]![c]!;
      const v = Math.round(clamp01((0.66 * m)) * 255);
      ctx.fillStyle = `rgb(${Math.round(v * 1.02)},${Math.round(v * 1.05)},${Math.round(v * 1.1)})`;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

      if (isStriped(layout, r, c)) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, y0, x1 - x0, y1 - y0);
        ctx.clip();
        const stripeW = (x1 - x0) * 0.22;
        ctx.fillStyle = '#151719';
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.fillStyle = '#e8b23a';
        ctx.save();
        ctx.translate((x0 + x1) / 2, (y0 + y1) / 2);
        ctx.rotate(Math.PI / 4);
        const diag = (x1 - x0) + (y1 - y0);
        for (let sx = -diag; sx < diag; sx += stripeW * 2) {
          ctx.fillRect(sx, -diag, stripeW, diag * 2);
        }
        ctx.restore();
        ctx.restore();
      }
    }
  }

  // Seams: thin darker lines along every grid boundary so panels read as separate plates.
  ctx.strokeStyle = 'rgba(18,22,28,0.6)';
  ctx.lineWidth = 1.5;
  for (const x of layout.cols) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, TEX_SIZE);
    ctx.stroke();
  }
  for (const y of layout.rows) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(TEX_SIZE, y);
    ctx.stroke();
  }
}

/** Draws a matching greyscale height field — seams are grooves, panels are near-flat. */
function drawHeight(ctx: CanvasRenderingContext2D, layout: PanelLayout): void {
  ctx.fillStyle = '#bdbdbd';
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

  for (let r = 0; r < layout.rows.length - 1; r++) {
    const y0 = layout.rows[r]!;
    const y1 = layout.rows[r + 1]!;
    for (let c = 0; c < layout.cols.length - 1; c++) {
      const x0 = layout.cols[c]!;
      const x1 = layout.cols[c + 1]!;
      const m = layout.shade[r]![c]!;
      const v = Math.round(clamp01(0.72 * m + 0.1) * 255);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
  }

  ctx.strokeStyle = '#202020';
  ctx.lineWidth = 2.5;
  for (const x of layout.cols) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, TEX_SIZE);
    ctx.stroke();
  }
  for (const y of layout.rows) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(TEX_SIZE, y);
    ctx.stroke();
  }
}

/** Sobel-style height-to-normal conversion so panel seams catch light correctly. */
function heightCanvasToNormalMap(height: HTMLCanvasElement): HTMLCanvasElement {
  const w = height.width;
  const h = height.height;
  const src = height.getContext('2d')!.getImageData(0, 0, w, h).data;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const outCtx = out.getContext('2d')!;
  const dst = outCtx.createImageData(w, h);

  const heightAt = (x: number, y: number): number => {
    const xi = (x + w) % w;
    const yi = (y + h) % h;
    return src[(yi * w + xi) * 4]! / 255;
  };

  const strength = 2.4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (heightAt(x - 1, y) - heightAt(x + 1, y)) * strength;
      const dy = (heightAt(x, y - 1) - heightAt(x, y + 1)) * strength;
      const len = Math.sqrt(dx * dx + dy * dy + 1);
      const idx = (y * w + x) * 4;
      dst.data[idx] = Math.round((dx / len) * 0.5 * 255 + 127.5);
      dst.data[idx + 1] = Math.round((dy / len) * 0.5 * 255 + 127.5);
      dst.data[idx + 2] = Math.round((1 / len) * 0.5 * 255 + 127.5);
      dst.data[idx + 3] = 255;
    }
  }
  outCtx.putImageData(dst, 0, 0);
  return out;
}

let sharedHullTexture: THREE.CanvasTexture | null = null;
let sharedNormalTexture: THREE.CanvasTexture | null = null;

/** Shared panel/plating diffuse texture, built once and reused across every ship instance. */
export function getHullTexture(): THREE.Texture {
  if (sharedHullTexture) return sharedHullTexture;
  const layout = buildPanelLayout();
  const canvas = document.createElement('canvas');
  canvas.width = TEX_SIZE;
  canvas.height = TEX_SIZE;
  drawDiffuse(canvas.getContext('2d')!, layout);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(PANEL_REPEAT, PANEL_REPEAT);
  sharedHullTexture = tex;
  return tex;
}

/** Shared normal map matching `getHullTexture()`'s panel layout so seams pick up specular. */
export function getPanelNormalTexture(): THREE.Texture {
  if (sharedNormalTexture) return sharedNormalTexture;
  const layout = buildPanelLayout();
  const heightCanvas = document.createElement('canvas');
  heightCanvas.width = TEX_SIZE;
  heightCanvas.height = TEX_SIZE;
  drawHeight(heightCanvas.getContext('2d')!, layout);
  const normalCanvas = heightCanvasToNormalMap(heightCanvas);

  const tex = new THREE.CanvasTexture(normalCanvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(PANEL_REPEAT, PANEL_REPEAT);
  sharedNormalTexture = tex;
  return tex;
}

/** Releases the shared textures. Call only when no ship remains that references them. */
export function disposeSharedShipAssets(): void {
  sharedHullTexture?.dispose();
  sharedNormalTexture?.dispose();
  sharedHullTexture = null;
  sharedNormalTexture = null;
}

/* ------------------------------------------------------------------------------------------ */
/* Fuselage profile                                                                             */
/* ------------------------------------------------------------------------------------------ */

/**
 * Radius (as a fraction of half body-width) at fractional position `t` along the fuselage,
 * `t = 0` at the tail, `t = 1` at the nose tip. Shared by the lathe profile and by greeble
 * placement so detailing always sits flush with the hull surface.
 */
const HULL_PROFILE: readonly (readonly [t: number, r: number])[] = [
  [0, 0.5],
  [0.07, 0.68],
  [0.3, 1.0],
  [0.55, 0.9],
  [0.8, 0.5],
  [0.94, 0.18],
  [1, 0],
];

function hullRadiusFraction(t: number): number {
  const c = clamp01(t);
  for (let i = 0; i < HULL_PROFILE.length - 1; i++) {
    const [t0, r0] = HULL_PROFILE[i]!;
    const [t1, r1] = HULL_PROFILE[i + 1]!;
    if (c >= t0 && c <= t1) return lerp(r0, r1, t1 > t0 ? (c - t0) / (t1 - t0) : 0);
  }
  return HULL_PROFILE[HULL_PROFILE.length - 1]![1];
}

/* ------------------------------------------------------------------------------------------ */
/* Merge safety                                                                                 */
/* ------------------------------------------------------------------------------------------ */

/**
 * `BufferGeometryUtils.mergeGeometries` silently returns `null` if its inputs are not
 * uniformly indexed or uniformly non-indexed, or if their attribute sets differ (see
 * BufferGeometryUtils.js) — it logs a console.error and hands back `null` rather than
 * throwing. This file mixes primitives that are indexed by construction (Lathe, Circle, Box,
 * Cylinder, Cone, Sphere) with `ExtrudeGeometry`, which THREE builds non-indexed. Merging them
 * directly hits exactly that mismatch.
 *
 * This wrapper normalises every input to non-indexed first (index attributes carry no
 * information mergeGeometries needs to preserve here — nothing downstream relies on shared
 * vertices), verifies the attribute sets line up, and throws a descriptive error instead of
 * ever letting a `null` reach a `THREE.Mesh` constructor.
 */
function mergeSafely(geometries: readonly THREE.BufferGeometry[], label: string): THREE.BufferGeometry {
  if (geometries.length === 0) throw new Error(`ship/geometry: mergeSafely("${label}") got zero geometries.`);

  const normalized = geometries.map((g) => (g.index ? g.toNonIndexed() : g));

  const reference = Object.keys(normalized[0]!.attributes).sort();
  for (let i = 1; i < normalized.length; i++) {
    const attrs = Object.keys(normalized[i]!.attributes).sort();
    const matches = attrs.length === reference.length && attrs.every((a, idx) => a === reference[idx]);
    if (!matches) {
      throw new Error(
        `ship/geometry: mergeSafely("${label}") attribute mismatch at index ${i}: ` +
          `[${attrs.join(',')}] vs [${reference.join(',')}].`,
      );
    }
  }

  const merged = mergeGeometries(normalized as THREE.BufferGeometry[], false);

  // toNonIndexed() allocates a brand-new geometry when it converts one; those copies are pure
  // merge scratch and must be disposed here. Inputs that were already non-indexed are returned
  // by reference (normalized[i] === geometries[i]) and remain the caller's to dispose.
  for (let i = 0; i < geometries.length; i++) {
    if (normalized[i] !== geometries[i]) normalized[i]!.dispose();
  }

  if (!merged) {
    throw new Error(
      `ship/geometry: mergeGeometries("${label}") returned null — see the preceding ` +
        `THREE.BufferGeometryUtils console.error for which input broke uniformity.`,
    );
  }
  return merged;
}

/* ------------------------------------------------------------------------------------------ */
/* Geometry builders — everything below returns a fresh BufferGeometry in "assembly space":    */
/* tail at z = 0, nose at z = -length. buildShip() shifts the finished assembly by +length/2   */
/* so the ship's root origin lands on its geometric centre, as the interface contract requires.*/
/* ------------------------------------------------------------------------------------------ */

function buildFuselage(shape: HullShape): THREE.BufferGeometry {
  const halfWidth = shape.bodyWidth / 2;
  const halfHeight = shape.bodyHeight / 2;
  const points = HULL_PROFILE.map(([t, r]) => new THREE.Vector2(Math.max(r * halfWidth, 0.001), t * shape.length));
  const radialSegments = 16;
  const body = new THREE.LatheGeometry(points, radialSegments);
  body.rotateX(-Math.PI / 2);
  body.scale(1, halfHeight / halfWidth, 1);

  const tailRadius = HULL_PROFILE[0]![1] * halfWidth;
  const cap = new THREE.CircleGeometry(tailRadius, radialSegments);
  cap.scale(1, halfHeight / halfWidth, 1);

  const merged = mergeSafely([body, cap], 'fuselage');
  body.dispose();
  cap.dispose();
  return merged;
}

/**
 * A swept delta panel with real thickness — used for wings, canards and fins. `orientation`
 * picks whether the panel spans the X axis (a wing/canard) or the Y axis (a vertical fin);
 * the extra `rotateZ` for the vertical case swaps which local axis becomes "span".
 */
function buildDeltaPanel(opts: {
  halfSpan: number;
  sweep: number;
  rootChord: number;
  thickness: number;
  orientation: 'horizontal' | 'vertical';
}): THREE.BufferGeometry {
  const { halfSpan, sweep, rootChord, thickness } = opts;
  // Leading edge sweeps back from the apex to the tip; the trailing edge stays a straight line
  // across the whole span (classic delta). Clamping keeps the tip chord from going negative on
  // very swept, short-root panels.
  const leadTipZ = halfSpan * Math.tan(sweep);
  const trailZ = Math.max(rootChord, leadTipZ + rootChord * 0.15);

  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(halfSpan, leadTipZ);
  shape.lineTo(halfSpan, trailZ);
  shape.lineTo(-halfSpan, trailZ);
  shape.lineTo(-halfSpan, leadTipZ);
  shape.lineTo(0, 0);

  const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 1 });
  // Recentre thickness around the panel's own mid-plane before any further transform.
  geo.translate(0, 0, -thickness / 2);
  geo.rotateX(Math.PI / 2);
  if (opts.orientation === 'vertical') geo.rotateZ(Math.PI / 2);
  return geo;
}

function buildWings(shape: HullShape): THREE.BufferGeometry {
  const halfSpan = shape.wingSpan / 2;
  const rootChord = shape.length * 0.42;
  const thickness = Math.max(shape.bodyHeight * 0.12, 0.12);
  const wing = buildDeltaPanel({ halfSpan, sweep: shape.wingSweep, rootChord, thickness, orientation: 'horizontal' });
  // Apex sits a little forward of mid-body; trailing edge lands near the tail.
  const apexZ = -shape.length * 0.46;
  wing.translate(0, -shape.bodyHeight * 0.05, apexZ);
  return wing;
}

function buildCanards(shape: HullShape): THREE.BufferGeometry {
  const halfSpan = shape.wingSpan * 0.16;
  const rootChord = shape.length * 0.14;
  const thickness = Math.max(shape.bodyHeight * 0.08, 0.08);
  const canard = buildDeltaPanel({
    halfSpan,
    sweep: shape.wingSweep * 0.6,
    rootChord,
    thickness,
    orientation: 'horizontal',
  });
  const apexZ = -shape.length * 0.78;
  canard.translate(0, shape.bodyHeight * 0.12, apexZ);
  return canard;
}

/** Returns the static fin base and the hinge anchor (root position) for its rudder. */
function buildFin(shape: HullShape, offsetX: number, offsetZ: number): { geo: THREE.BufferGeometry; hinge: THREE.Vector3 } {
  const halfSpan = shape.bodyHeight * 0.95;
  const rootChord = shape.length * 0.22;
  const thickness = Math.max(shape.bodyWidth * 0.06, 0.06);
  const fin = buildDeltaPanel({ halfSpan, sweep: 0.5, rootChord, thickness, orientation: 'vertical' });
  // Vertical panel spans y in [0, 2*halfSpan] once built; lift it so its root sits on the hull.
  fin.translate(offsetX, shape.bodyHeight * 0.3, offsetZ);
  const hinge = new THREE.Vector3(offsetX, shape.bodyHeight * 0.3 + halfSpan * 0.8, offsetZ + rootChord * 0.85);
  return { geo: fin, hinge };
}

function buildNacelleShell(radius: number, length: number): THREE.BufferGeometry {
  // radiusTop < radiusBottom gives a gentle taper toward the nozzle end once rotated onto Z.
  const geo = new THREE.CylinderGeometry(radius * 0.82, radius, length, 12, 1, false);
  geo.rotateX(Math.PI / 2);
  return geo;
}

function buildNozzleThroat(radius: number, depth: number): THREE.BufferGeometry {
  const geo = new THREE.ConeGeometry(radius * 0.78, depth, 12, 1, true);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function buildNozzleGlow(radius: number, depth: number): THREE.BufferGeometry {
  // 20 radial segments rather than 12: the plume is the brightest thing on the ship, and
  // bloom turns a coarse silhouette into a visibly faceted star.
  const geo = new THREE.ConeGeometry(radius, depth, 20, 1, true);
  // Apex to +z. The nose points down -z, so the plume streams out behind the ship.
  geo.rotateX(Math.PI / 2);
  // ConeGeometry is centred on its own axis, which would bury the throat — the hottest, most
  // important half of the gradient — inside the fuselage. Shift it so z=0 is the throat and
  // the whole plume sits aft of the nozzle where it can be seen.
  geo.translate(0, 0, depth / 2);
  return geo;
}

/**
 * The engine plume.
 *
 * Written as a shader rather than a translucent cone because the shape of the *gradient* is
 * the effect: a white-hot throat that falls through the engine colour and out to nothing, with
 * shock diamonds banded along it and a fast flicker. That gradient is also what feeds bloom —
 * only the throat clears the threshold, so the glow blooms from a point and tapers, instead of
 * the whole cone smearing into a lozenge.
 *
 * `toneMapped` is off and values run past 1.0 on purpose: this is a light source, and clamping
 * it to display range is what makes engines look like painted-on triangles.
 */
const PLUME_VERTEX = /* glsl */ `
  uniform float uDepth;
  varying float vAxial;
  varying float vRadial;
  void main() {
    // 0 at the throat, 1 at the tip of the cone (the geometry is translated so z=0 is throat).
    vAxial = clamp(position.z / uDepth, 0.0, 1.0);
    vRadial = length(position.xy);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PLUME_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uCore;
  uniform vec3 uIdleColor;
  uniform float uThrottle;
  uniform float uTime;
  varying float vAxial;
  varying float vRadial;

  void main() {
    // Length falls out of throttle: an idling engine is a stub, a boosting one is a spear.
    float reach = mix(0.35, 1.0, uThrottle);
    float along = vAxial / max(reach, 0.001);
    if (along > 1.0) discard;

    // Shock diamonds — the standing waves in a real supersonic exhaust. Tied to throttle so
    // they only appear once the engine is actually working.
    float diamonds = 0.5 + 0.5 * sin(along * 26.0 - uTime * 9.0);
    diamonds = mix(1.0, 0.55 + diamonds * 0.75, uThrottle * 0.8);

    // Combustion flicker: two detuned sines, so it never reads as a loop.
    float flicker = 0.88 + 0.12 * sin(uTime * 41.0) * sin(uTime * 27.0 + 1.7);

    // Colour temperature rises with throttle: a cold ember at idle, the livery colour in normal
    // flight, and past ~80% throttle (which reads as boost, since that is where the flight model
    // pushes speed fraction) the core itself pushes past the livery hue toward a hotter
    // blue-white -- the same cue a real afterburner gives.
    vec3 baseColor = mix(uIdleColor, uColor, smoothstep(0.05, 0.55, uThrottle));
    vec3 hotCore = mix(uCore, vec3(0.78, 0.88, 1.0), smoothstep(0.78, 1.0, uThrottle));

    // Hot core down the axis, cooling outward and along the length.
    float axialFalloff = pow(1.0 - along, 1.7);
    float core = pow(1.0 - along, 5.0);
    vec3 col = mix(baseColor, hotCore, clamp(core * 1.4, 0.0, 1.0));

    float intensity = axialFalloff * diamonds * flicker * (0.45 + uThrottle * 1.25);
    gl_FragColor = vec4(col * (1.0 + core * 2.2), clamp(intensity, 0.0, 1.0));
  }
`;

function buildCanopy(shape: HullShape): THREE.BufferGeometry {
  const geo = new THREE.SphereGeometry(1, 14, 10, 0, TAU, 0, Math.PI / 2);
  const halfWidthC = shape.bodyWidth * 0.32;
  const heightC = shape.bodyHeight * 0.55;
  const halfLenC = shape.length * 0.11;
  geo.scale(halfWidthC, heightC, halfLenC);
  const t = 0.62; // just aft of the nose taper — the cockpit sits ahead of the wing apex.
  const z = -t * shape.length;
  const surfaceY = hullRadiusFraction(t) * (shape.bodyHeight / 2) * 0.6;
  geo.translate(0, surfaceY, z);
  return geo;
}

interface GreebleParts {
  readonly hull: THREE.BufferGeometry[];
  readonly accent: THREE.BufferGeometry[];
}

/** Scatters small panels, vents and antennae over the hull using a seeded RNG. */
function buildGreebles(shape: HullShape): GreebleParts {
  const rng = mulberry32(shape.greebleSeed);
  const halfWidth = shape.bodyWidth / 2;
  const halfHeight = shape.bodyHeight / 2;
  const aspect = halfHeight / halfWidth;
  const hull: THREE.BufferGeometry[] = [];
  const accent: THREE.BufferGeometry[] = [];

  const panelCount = Math.round(9 * shape.greebleDensity);
  for (let i = 0; i < panelCount; i++) {
    const t = lerp(0.1, 0.85, rng());
    const theta = lerp(-2.5, 2.5, rng());
    const r = hullRadiusFraction(t) * halfWidth;
    const cx = r * Math.cos(theta);
    const cy = r * Math.sin(theta) * aspect;
    const z = -t * shape.length;
    const sx = lerp(0.18, 0.42, rng());
    const sy = lerp(0.05, 0.1, rng());
    const sz = lerp(0.3, 0.8, rng());
    const box = new THREE.BoxGeometry(sx, sy, sz);
    box.rotateZ(theta);
    box.translate(cx + Math.cos(theta) * sy * 0.5, cy + Math.sin(theta) * aspect * sy * 0.5, z);
    hull.push(box);
  }

  const antennaCount = Math.round(3 * shape.greebleDensity);
  for (let i = 0; i < antennaCount; i++) {
    const t = lerp(0.15, 0.5, rng());
    const theta = lerp(-0.6, 0.6, rng()); // dorsal spine only
    const r = hullRadiusFraction(t) * halfWidth;
    const cx = r * Math.cos(theta);
    const cy = r * Math.sin(theta) * aspect;
    const z = -t * shape.length;
    const len = lerp(0.4, 0.9, rng());
    const rod = new THREE.CylinderGeometry(0.02, 0.03, len, 5);
    rod.translate(0, len / 2, 0);
    rod.rotateZ(theta * 0.6);
    rod.translate(cx, cy, z);
    hull.push(rod);
  }

  const lightCount = Math.round(4 * shape.greebleDensity) + 2;
  for (let i = 0; i < lightCount; i++) {
    const t = lerp(0.05, 0.95, rng());
    const theta = rng() < 0.5 ? -1.3 : 1.3;
    const r = hullRadiusFraction(t) * halfWidth;
    const cx = r * Math.cos(theta);
    const cy = r * Math.sin(theta) * aspect;
    const z = -t * shape.length;
    const light = new THREE.SphereGeometry(0.055, 6, 6);
    light.translate(cx, cy, z);
    accent.push(light);
  }

  return { hull, accent };
}

/* ------------------------------------------------------------------------------------------ */
/* ShipVisual                                                                                   */
/* ------------------------------------------------------------------------------------------ */

export interface ShipVisual {
  /** Root object to add to the scene. Origin at centre of mass, nose pointing -Z. */
  readonly root: THREE.Group;
  /** Engine nozzle offsets in the root's local space, for trail and particle attachment. */
  readonly enginePoints: readonly THREE.Vector3[];
  /** Muzzle offsets in local space, for projectile spawn and muzzle flash. */
  readonly muzzlePoints: readonly THREE.Vector3[];
  setThrottle(value: number): void;
  setControlSurfaces(pitch: number, yaw: number, roll: number): void;
  setFlash(value: number): void;
  setLivery(primaryHex: number, accentHex: number): void;
  update(rawDt: number): void;
  dispose(): void;
}

/** A single animated hinge: a pivot at the hinge line plus the flap mesh hung off it. */
interface Hinge {
  readonly pivot: THREE.Group;
  readonly axis: 'x' | 'y';
  /** Sign applied to the shared target before the deflection is computed (mirrors L/R). */
  readonly sign: number;
  current: number;
}

const MAX_DEFLECTION = 0.5; // radians, ~29 degrees — enough to read clearly, not cartoonish.
const CONTROL_SMOOTHING = 0.0001; // per math.damp's convention: fraction remaining after 1s.
const THROTTLE_SMOOTHING = 0.02;

class ShipVisualImpl implements ShipVisual {
  readonly root: THREE.Group;
  readonly enginePoints: readonly THREE.Vector3[];
  readonly muzzlePoints: readonly THREE.Vector3[];

  private readonly hullGeometry: THREE.BufferGeometry;
  private readonly accentGeometry: THREE.BufferGeometry;
  private readonly canopyGeometry: THREE.BufferGeometry;
  private readonly hullMaterial: THREE.MeshStandardMaterial;
  private readonly accentMaterial: THREE.MeshStandardMaterial;
  private readonly canopyMaterial: THREE.MeshStandardMaterial;
  private readonly nozzleGlowMaterial: THREE.ShaderMaterial;
  private readonly nozzleGlowGeometry: THREE.BufferGeometry;
  private readonly nozzleGlowMeshes: THREE.Mesh[];
  private readonly elevonGeometry: THREE.BufferGeometry;
  private readonly rudderGeometry: THREE.BufferGeometry;
  private readonly hinges: Hinge[] = [];

  private throttleTarget = 0;
  private throttleVisual = 0;
  private pitchTarget = 0;
  private yawTarget = 0;
  private rollTarget = 0;
  private time = 0;

  constructor(hullId: HullId, shape: HullShape) {
    this.root = new THREE.Group();
    this.root.name = `ship:${hullId}`;

    const assembly = new THREE.Group();
    // Assembly-local space has the tail at z=0 and the nose at z=-length; shifting by
    // +length/2 puts the ship's centre of mass at the root's origin, per the interface contract.
    assembly.position.z = shape.length / 2;
    this.root.add(assembly);

    const p = palette();
    this.hullMaterial = new THREE.MeshStandardMaterial({
      map: getHullTexture(),
      normalMap: getPanelNormalTexture(),
      metalness: 0.85,
      roughness: 0.35,
      color: p.playerHull,
      emissive: 0xffffff,
      emissiveIntensity: 0,
    });
    this.accentMaterial = new THREE.MeshStandardMaterial({
      color: p.playerAccent,
      emissive: p.playerAccent,
      // Past 1.0 on purpose: the accent strips are the ship's running lights, and they have to
      // clear the bloom threshold to read as lit rather than merely light-coloured.
      emissiveIntensity: 1.6,
      metalness: 0.4,
      roughness: 0.35,
    });
    this.canopyMaterial = new THREE.MeshStandardMaterial({
      color: p.playerAccent,
      metalness: 0.9,
      roughness: 0.1,
      transparent: true,
      opacity: 0.55,
    });
    this.nozzleGlowMaterial = new THREE.ShaderMaterial({
      vertexShader: PLUME_VERTEX,
      fragmentShader: PLUME_FRAGMENT,
      uniforms: {
        uColor: { value: new THREE.Color(p.playerEngine) },
        // White-hot at the throat regardless of livery: a flame's core is temperature, not
        // team colour, and keeping it white is what sells the heat.
        uCore: { value: new THREE.Color(0xffffff) },
        // A dim, cooling ember tone for idle/low throttle, shared across every livery: at idle
        // the plume is barely alight, so it should read as embers, not a dimmer version of the
        // team colour.
        uIdleColor: { value: new THREE.Color(0x8a2f14) },
        uThrottle: { value: 0 },
        uTime: { value: 0 },
        uDepth: { value: 1 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    /* Static hull group ---------------------------------------------------------------------- */
    const staticParts: THREE.BufferGeometry[] = [buildFuselage(shape), buildWings(shape)];
    if (shape.canards) staticParts.push(buildCanards(shape));

    const finHinges: THREE.Vector3[] = [];
    for (let i = 0; i < shape.finCount; i++) {
      const side = shape.finCount === 1 ? 0 : i === 0 ? -1 : 1;
      // Wraith's twin boom is deliberately unmatched: the second fin sits further aft and
      // taller, which is what actually reads as "asymmetric" in silhouette.
      const stagger = hullId === 'wraith' && i === 1 ? 1 : 0;
      const offsetX = side * shape.bodyWidth * 0.62;
      const offsetZ = -shape.length * (0.06 + stagger * 0.05);
      const { geo, hinge } = buildFin(shape, offsetX, offsetZ);
      staticParts.push(geo);
      finHinges.push(hinge);
    }

    const nacelleRadius = Math.max(shape.bodyHeight * 0.26, 0.3);
    const nacelleLength = shape.length * 0.34;
    const enginePoints: THREE.Vector3[] = [];
    const enginePairs = Math.ceil(shape.engineCount / 2);
    for (let pair = 0; pair < enginePairs; pair++) {
      const spread = shape.bodyWidth * 0.5 + shape.wingSpan * (0.16 + pair * 0.4);
      const zStagger = hullId === 'wraith' ? pair * shape.length * 0.05 : 0;
      const nacelleZ = -shape.length * 0.14 + zStagger;
      for (let side = -1; side <= 1; side += 2) {
        if (pair * 2 + (side === -1 ? 0 : 1) >= shape.engineCount) continue;
        const x = spread * side;
        const y = -shape.bodyHeight * 0.08;
        const shell = buildNacelleShell(nacelleRadius, nacelleLength);
        shell.translate(x, y, nacelleZ);
        staticParts.push(shell);

        const throat = buildNozzleThroat(nacelleRadius, nacelleRadius * 0.6);
        const throatZ = nacelleZ + nacelleLength / 2;
        throat.translate(x, y, throatZ);
        staticParts.push(throat);

        enginePoints.push(new THREE.Vector3(x, y, throatZ + nacelleRadius * 0.3));
      }
    }
    this.enginePoints = enginePoints;

    const greebles = buildGreebles(shape);
    staticParts.push(...greebles.hull);

    this.hullGeometry = mergeSafely(staticParts, 'hull');
    for (const g of staticParts) g.dispose();
    const hullMesh = new THREE.Mesh(this.hullGeometry, this.hullMaterial);
    assembly.add(hullMesh);

    this.accentGeometry = mergeSafely(greebles.accent, 'accent');
    for (const g of greebles.accent) g.dispose();
    const accentMesh = new THREE.Mesh(this.accentGeometry, this.accentMaterial);
    assembly.add(accentMesh);

    /* Canopy ---------------------------------------------------------------------------------- */
    this.canopyGeometry = buildCanopy(shape);
    const canopyMesh = new THREE.Mesh(this.canopyGeometry, this.canopyMaterial);
    assembly.add(canopyMesh);

    /* Nozzle glow (animated, separate meshes so setThrottle can scale each independently) ------ */
    // A long plume: this is the ship's main light source and its clearest read of speed.
    const plumeDepth = nacelleRadius * 7.5;
    this.nozzleGlowGeometry = buildNozzleGlow(nacelleRadius * 0.92, plumeDepth);
    this.nozzleGlowMaterial.uniforms.uDepth!.value = plumeDepth;
    this.nozzleGlowMeshes = enginePoints.map((pt) => {
      const mesh = new THREE.Mesh(this.nozzleGlowGeometry, this.nozzleGlowMaterial);
      mesh.position.copy(pt);
      assembly.add(mesh);
      return mesh;
    });

    /* Control surfaces (animated) -------------------------------------------------------------- */
    const halfSpan = shape.wingSpan / 2;
    const elevonSpanFrac = 0.7;
    const elevonHalfWidth = halfSpan * 0.18;
    const elevonChord = shape.length * 0.42 * 0.3;
    this.elevonGeometry = new THREE.BoxGeometry(elevonHalfWidth * 2, Math.max(shape.bodyHeight * 0.1, 0.1), elevonChord);
    this.elevonGeometry.translate(0, 0, elevonChord / 2);
    const wingTrailZ = -shape.length * 0.46 + shape.length * 0.42;
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * halfSpan * elevonSpanFrac, -shape.bodyHeight * 0.05, wingTrailZ);
      const flap = new THREE.Mesh(this.elevonGeometry, this.hullMaterial);
      pivot.add(flap);
      assembly.add(pivot);
      this.hinges.push({ pivot, axis: 'x', sign: side, current: 0 });
    }

    const rudderHalfHeight = shape.bodyHeight * 0.5;
    const rudderChord = shape.length * 0.22 * 0.35;
    this.rudderGeometry = new THREE.BoxGeometry(Math.max(shape.bodyWidth * 0.06, 0.06), rudderHalfHeight * 2, rudderChord);
    this.rudderGeometry.translate(0, 0, rudderChord / 2);
    for (const hingePos of finHinges) {
      const pivot = new THREE.Group();
      pivot.position.copy(hingePos);
      const flap = new THREE.Mesh(this.rudderGeometry, this.hullMaterial);
      pivot.add(flap);
      assembly.add(pivot);
      this.hinges.push({ pivot, axis: 'y', sign: 1, current: 0 });
    }

    /* Muzzle points ----------------------------------------------------------------------------
     * Local-space offsets (not attached to any mesh) for weapon spawn/flash attachment. Spread
     * across the nose and, for hulls with 3+ muzzles, the wing roots. */
    const muzzles: THREE.Vector3[] = [];
    const noseZ = -shape.length * 0.92 + shape.length / 2;
    if (shape.muzzleCount <= 2) {
      const spread = shape.bodyWidth * 0.3;
      muzzles.push(new THREE.Vector3(-spread, 0, noseZ), new THREE.Vector3(spread, 0, noseZ));
    } else {
      muzzles.push(new THREE.Vector3(0, shape.bodyHeight * 0.2, noseZ));
      const wingZ = -shape.length * 0.46 + shape.length * 0.15 + shape.length / 2;
      const wingSpread = shape.wingSpan * 0.32;
      muzzles.push(new THREE.Vector3(-wingSpread, -shape.bodyHeight * 0.05, wingZ));
      muzzles.push(new THREE.Vector3(wingSpread, -shape.bodyHeight * 0.05, wingZ));
      for (let i = 3; i < shape.muzzleCount; i++) muzzles.push(new THREE.Vector3(0, 0, noseZ));
    }
    this.muzzlePoints = muzzles;
  }

  setThrottle(value: number): void {
    this.throttleTarget = clamp01(value);
  }

  setControlSurfaces(pitch: number, yaw: number, roll: number): void {
    this.pitchTarget = clamp(pitch, -1, 1);
    this.yawTarget = clamp(yaw, -1, 1);
    this.rollTarget = clamp(roll, -1, 1);
  }

  setFlash(value: number): void {
    this.hullMaterial.emissiveIntensity = clamp01(value);
  }

  setLivery(primaryHex: number, accentHex: number): void {
    this.hullMaterial.color.set(primaryHex);
    this.accentMaterial.color.set(accentHex);
    this.accentMaterial.emissive.set(accentHex);
    this.canopyMaterial.color.set(accentHex);
    (this.nozzleGlowMaterial.uniforms.uColor!.value as THREE.Color).set(accentHex);
  }

  update(rawDt: number): void {
    this.time += rawDt;

    this.throttleVisual = damp(this.throttleVisual, this.throttleTarget, THROTTLE_SMOOTHING, rawDt);
    // The plume's length lives in the shader (see uThrottle); the mesh only widens, so the
    // cone never has to be rescaled along an axis the gradient is measured in.
    const glowScale = lerp(0.62, 1.15, this.throttleVisual);
    const u = this.nozzleGlowMaterial.uniforms;
    u.uThrottle!.value = this.throttleVisual;
    u.uTime!.value = this.time;
    for (const mesh of this.nozzleGlowMeshes) mesh.scale.set(glowScale, glowScale, 1);

    const pulseValue = 0.55 + 0.45 * pulse(this.time, 0.35);
    this.accentMaterial.emissiveIntensity = pulseValue;

    for (const hinge of this.hinges) {
      const target =
        hinge.axis === 'x'
          ? (this.pitchTarget + this.rollTarget * hinge.sign) * MAX_DEFLECTION * 0.5
          : this.yawTarget * MAX_DEFLECTION * hinge.sign;
      hinge.current = damp(hinge.current, target, CONTROL_SMOOTHING, rawDt);
      if (hinge.axis === 'x') hinge.pivot.rotation.x = hinge.current;
      else hinge.pivot.rotation.y = hinge.current;
    }
  }

  dispose(): void {
    this.hullGeometry.dispose();
    this.accentGeometry.dispose();
    this.canopyGeometry.dispose();
    this.nozzleGlowGeometry.dispose();
    this.elevonGeometry.dispose();
    this.rudderGeometry.dispose();

    this.hullMaterial.dispose();
    this.accentMaterial.dispose();
    this.canopyMaterial.dispose();
    this.nozzleGlowMaterial.dispose();
    // Shared textures (map/normalMap) are intentionally not disposed here — they outlive any
    // single ship and are released only by disposeSharedShipAssets().
  }
}

export function buildShip(hullId: HullId): ShipVisual {
  const shape = HULL_SHAPES[hullId];
  return new ShipVisualImpl(hullId, shape);
}
