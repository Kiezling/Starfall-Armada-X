/**
 * Ribbon trails for engines and fast projectiles.
 *
 * Every live trail is a fixed-length ring buffer of points rendered as a camera-facing ribbon.
 * Per DESIGN §16.2 rules 1-3, all trails share one `BufferGeometry` and one draw call: it is
 * sized for `maxTrails * POINTS_PER_TRAIL` points up front, and each trail owns a fixed vertex
 * and index range within it forever — there is no per-trail allocation or resizing.
 *
 * Two buffer layers, deliberately kept separate:
 *  - a "raw" layer (`rawPos`/`rawColor`/`rawAge`), indexed by ring slot, written by `push` —
 *    this is just the path the trail has actually flown.
 *  - a "render" layer (`positions`/`colors`/`params`), indexed by strip position (tail=0,
 *    head=count-1), rewritten every frame by `update` from the raw layer and uploaded to the
 *    GPU. `update` expands each raw point into a camera-facing left/right pair and bakes in the
 *    width/alpha taper.
 * They must stay separate arrays: reading a ring point and writing its strip-ordered expansion
 * both touch index ranges that span the same `[0, POINTS_PER_TRAIL)` domain per trail, so
 * aliasing them would let a later write in the same frame clobber a point an earlier iteration
 * still needs to read (as its tangent neighbour, in particular).
 *
 * Unlike the particle system, a ribbon's edges trace an actual path only the simulation knows —
 * there is no closed-form "position at age t" for the GPU to integrate, so the CPU does the
 * per-point work here. What *is* pushed to the GPU is the one-draw-call billboard expansion and
 * the taper, which is exactly the part that would otherwise be redundant per-trail state.
 */

import * as THREE from 'three';
import { clamp01 } from '../../core/math';

/** Points stored per trail ring buffer. Higher reads smoother curves at a fixed vertex cost. */
const POINTS_PER_TRAIL = 24;

const scratchTangent = /*#__PURE__*/ new THREE.Vector3();
const scratchToCam = /*#__PURE__*/ new THREE.Vector3();
const scratchRight = /*#__PURE__*/ new THREE.Vector3();

interface TrailSlot {
  active: boolean;
  colorHex: number;
  width: number;
  lifeSeconds: number;
  /** Ring cursor: ring index of the most recently pushed point. -1 means never pushed. */
  head: number;
  /** Number of points written so far, capped at POINTS_PER_TRAIL. */
  count: number;
  intensity: number;
}

export class TrailSystem {
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;

  private readonly maxTrails: number;
  private readonly slots: TrailSlot[];

  // Raw layer: one point per ring slot, written by `push`.
  private readonly rawPos: Float32Array;
  private readonly rawColor: Float32Array;
  private readonly rawAge: Float32Array;

  // Render layer: two vertices (ribbon left/right) per strip slot, written by `update`.
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly params: Float32Array; // x: taper 0..1, y: width, z: intensity
  private readonly sides: Float32Array; // -1 (left) / +1 (right), fixed at construction
  private readonly indices: Uint32Array;

  private readonly positionAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;
  private readonly paramsAttr: THREE.BufferAttribute;

  constructor(scene: THREE.Scene, maxTrails: number) {
    this.maxTrails = maxTrails;
    this.slots = new Array(maxTrails);
    for (let i = 0; i < maxTrails; i++) {
      this.slots[i] = {
        active: false,
        colorHex: 0xffffff,
        width: 1,
        lifeSeconds: 1,
        head: -1,
        count: 0,
        intensity: 1,
      };
    }

    this.rawPos = new Float32Array(maxTrails * POINTS_PER_TRAIL * 3);
    this.rawColor = new Float32Array(maxTrails * POINTS_PER_TRAIL * 3);
    this.rawAge = new Float32Array(maxTrails * POINTS_PER_TRAIL);

    const vertsPerTrail = POINTS_PER_TRAIL * 2;
    const totalVerts = maxTrails * vertsPerTrail;
    this.positions = new Float32Array(totalVerts * 3);
    this.colors = new Float32Array(totalVerts * 3);
    this.params = new Float32Array(totalVerts * 3);
    // Fixed for the lifetime of the buffer: `update()` always writes the left expansion to the
    // even vertex of each pair and the right to the odd one (see the dstV writes below), so this
    // never needs to be touched again after construction.
    this.sides = new Float32Array(totalVerts);
    for (let i = 0; i < totalVerts; i++) this.sides[i] = i % 2 === 0 ? -1 : 1;

    // Two triangles per segment, POINTS_PER_TRAIL - 1 segments per trail, laid out once and
    // never touched again — only the vertex data changes frame to frame.
    const segmentsPerTrail = POINTS_PER_TRAIL - 1;
    this.indices = new Uint32Array(maxTrails * segmentsPerTrail * 6);
    for (let t = 0; t < maxTrails; t++) {
      const vBase = t * vertsPerTrail;
      const iBase = t * segmentsPerTrail * 6;
      for (let s = 0; s < segmentsPerTrail; s++) {
        const a = vBase + s * 2;
        const b = a + 1;
        const c = vBase + (s + 1) * 2;
        const d = c + 1;
        const o = iBase + s * 6;
        this.indices[o] = a; this.indices[o + 1] = b; this.indices[o + 2] = c;
        this.indices[o + 3] = b; this.indices[o + 4] = d; this.indices[o + 5] = c;
      }
    }

    this.positionAttr = new THREE.BufferAttribute(this.positions, 3);
    this.colorAttr = new THREE.BufferAttribute(this.colors, 3);
    this.paramsAttr = new THREE.BufferAttribute(this.params, 3);
    this.positionAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.paramsAttr.setUsage(THREE.DynamicDrawUsage);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', this.positionAttr);
    this.geometry.setAttribute('aColor', this.colorAttr);
    this.geometry.setAttribute('aParams', this.paramsAttr);
    this.geometry.setAttribute('aSide', new THREE.BufferAttribute(this.sides, 1));
    this.geometry.setIndex(new THREE.BufferAttribute(this.indices, 1));
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      uniforms: {},
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute vec3 aParams; // taper, width, intensity
        attribute float aSide;
        varying vec3 vColor;
        varying float vTaper;
        varying float vIntensity;
        varying float vSide;
        void main() {
          vColor = aColor;
          vTaper = aParams.x;
          vIntensity = aParams.z;
          vSide = aSide;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vTaper;
        varying float vIntensity;
        varying float vSide;
        void main() {
          // Width is already baked into the geometry on the CPU; taper alpha too so the ribbon
          // dissolves at the tail instead of ending in a hard-edged sliver.
          float alpha = vTaper * vTaper * clamp(vIntensity, 0.0, 4.0);
          if (alpha <= 0.001) discard;

          // A hot white-hot core streak down the ribbon's centreline, only at high intensity
          // (boost / near-max throttle -- see the intensity the caller pushes in) so a cruising
          // engine trail stays a flat colour and only a boosting one earns the brighter spine.
          // This is what makes throttle/boost read as a change in the trail, not just its length.
          float centre = 1.0 - abs(vSide);
          float hotCore = smoothstep(0.35, 1.0, centre) * smoothstep(0.55, 1.0, vIntensity);
          vec3 col = mix(vColor, vec3(1.0), hotCore * 0.65);

          gl_FragColor = vec4(col * (0.6 + 0.6 * vIntensity), alpha);
        }
      `,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    // Rebuilt from live trail data every frame — a static bounding sphere would be meaningless
    // and recomputing one is pure waste on a mesh that never leaves camera-relevant space.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
    scene.add(this.mesh);
  }

  /** Returns a trail handle, or -1 if none free. */
  acquire(colorHex: number, width: number, lifeSeconds: number): number {
    for (let i = 0; i < this.maxTrails; i++) {
      const slot = this.slots[i]!;
      if (!slot.active) {
        slot.active = true;
        slot.colorHex = colorHex;
        slot.width = width;
        slot.lifeSeconds = Math.max(lifeSeconds, 0.05);
        slot.head = -1;
        slot.count = 0;
        slot.intensity = 1;
        this.clearRenderVertices(i);
        return i;
      }
    }
    return -1;
  }

  /** Feeds a new point. Call once per simulation step per live trail. */
  push(handle: number, x: number, y: number, z: number, intensity: number): void {
    const slot = this.slots[handle];
    if (!slot || !slot.active) return;

    slot.head = (slot.head + 1) % POINTS_PER_TRAIL;
    slot.count = Math.min(slot.count + 1, POINTS_PER_TRAIL);
    slot.intensity = intensity;

    const ring = handle * POINTS_PER_TRAIL + slot.head;
    const p3 = ring * 3;
    this.rawPos[p3] = x; this.rawPos[p3 + 1] = y; this.rawPos[p3 + 2] = z;
    this.rawColor[p3] = ((slot.colorHex >> 16) & 0xff) / 255;
    this.rawColor[p3 + 1] = ((slot.colorHex >> 8) & 0xff) / 255;
    this.rawColor[p3 + 2] = (slot.colorHex & 0xff) / 255;
    this.rawAge[ring] = 0;
  }

  release(handle: number): void {
    const slot = this.slots[handle];
    if (!slot) return;
    // Kept alive (but inactive) until its remaining points age out in `update`, so a released
    // engine trail still trails off rather than vanishing mid-flight.
    slot.active = false;
  }

  update(cameraPos: THREE.Vector3, dt: number): void {
    for (let t = 0; t < this.maxTrails; t++) {
      const slot = this.slots[t]!;
      if (slot.count === 0) continue;

      const ringBase = t * POINTS_PER_TRAIL;
      for (let i = 0; i < POINTS_PER_TRAIL; i++) this.rawAge[ringBase + i] += dt;

      const vBaseTrail = t * POINTS_PER_TRAIL * 2 * 3;
      const pBaseTrail = t * POINTS_PER_TRAIL * 2 * 3;

      for (let strip = 0; strip < POINTS_PER_TRAIL; strip++) {
        const haveData = strip < slot.count;
        // Ring position tail(0)..head(count-1) maps strip order onto the physical ring layout.
        const ringIndex = haveData
          ? (slot.head - (slot.count - 1 - strip) + POINTS_PER_TRAIL * 2) % POINTS_PER_TRAIL
          : slot.head;
        const src = ringBase + ringIndex;
        const srcP3 = src * 3;

        const px0 = this.rawPos[srcP3]!;
        const py0 = this.rawPos[srcP3 + 1]!;
        const pz0 = this.rawPos[srcP3 + 2]!;

        // Tangent from the previous strip point (or itself, for a degenerate/hidden strip),
        // so the billboard's "right" axis stays perpendicular to the direction of travel.
        const neighborStrip = haveData ? Math.max(0, strip - 1) : strip;
        const neighborRing = haveData
          ? (slot.head - (slot.count - 1 - neighborStrip) + POINTS_PER_TRAIL * 2) % POINTS_PER_TRAIL
          : slot.head;
        const nP3 = (ringBase + neighborRing) * 3;
        scratchTangent.set(px0 - this.rawPos[nP3]!, py0 - this.rawPos[nP3 + 1]!, pz0 - this.rawPos[nP3 + 2]!);
        if (scratchTangent.lengthSq() < 1e-8) scratchTangent.set(0, 0, 1);
        else scratchTangent.normalize();

        scratchToCam.set(px0 - cameraPos.x, py0 - cameraPos.y, pz0 - cameraPos.z);
        if (scratchToCam.lengthSq() < 1e-8) scratchToCam.set(0, 0, 1);
        scratchRight.crossVectors(scratchTangent, scratchToCam);
        if (scratchRight.lengthSq() < 1e-8 || !Number.isFinite(scratchRight.x)) scratchRight.set(1, 0, 0);
        else scratchRight.normalize();

        const age = haveData ? this.rawAge[src]! : slot.lifeSeconds;
        const lifeFrac = clamp01(age / slot.lifeSeconds);
        // Width taper follows position-in-strip (tail -> point, head -> full width) so a short,
        // freshly spawned trail doesn't render as uniformly fat, and separately follows age so
        // the whole ribbon thins as it ages out even once it has reached full length.
        const posTaper = haveData ? (strip + 1) / slot.count : 0;
        const ageTaper = 1 - lifeFrac;
        const taper = haveData ? posTaper * ageTaper : 0;
        const halfWidth = slot.width * 0.5 * taper;

        const rx = scratchRight.x * halfWidth;
        const ry = scratchRight.y * halfWidth;
        const rz = scratchRight.z * halfWidth;

        const dstV = vBaseTrail + strip * 2 * 3;
        this.positions[dstV] = px0 + rx; this.positions[dstV + 1] = py0 + ry; this.positions[dstV + 2] = pz0 + rz;
        this.positions[dstV + 3] = px0 - rx; this.positions[dstV + 4] = py0 - ry; this.positions[dstV + 5] = pz0 - rz;

        const dstP = pBaseTrail + strip * 2 * 3;
        this.params[dstP] = taper; this.params[dstP + 1] = slot.width; this.params[dstP + 2] = slot.intensity;
        this.params[dstP + 3] = taper; this.params[dstP + 4] = slot.width; this.params[dstP + 5] = slot.intensity;

        const cr = this.rawColor[srcP3]!;
        const cg = this.rawColor[srcP3 + 1]!;
        const cb = this.rawColor[srcP3 + 2]!;
        this.colors[dstV] = cr; this.colors[dstV + 1] = cg; this.colors[dstV + 2] = cb;
        this.colors[dstV + 3] = cr; this.colors[dstV + 4] = cg; this.colors[dstV + 5] = cb;
      }

      if (!slot.active && this.rawAge[ringBase + slot.head]! >= slot.lifeSeconds) {
        slot.count = 0;
        this.clearRenderVertices(t);
      }
    }

    this.positionAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.paramsAttr.needsUpdate = true;
    // Every trail's fixed vertex/index range is always drawn; a fully tapered (inactive) trail
    // collapses to zero-alpha, zero-width degenerate triangles instead of needing a variable
    // draw range that would fragment this into more than one draw call.
    this.geometry.setDrawRange(0, this.indices.length);
  }

  reset(): void {
    for (let i = 0; i < this.maxTrails; i++) {
      const slot = this.slots[i]!;
      slot.active = false;
      slot.head = -1;
      slot.count = 0;
      this.clearRenderVertices(i);
    }
    this.rawAge.fill(0);
    this.positionAttr.needsUpdate = true;
    this.paramsAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }

  private clearRenderVertices(handle: number): void {
    const pBase = handle * POINTS_PER_TRAIL * 2 * 3;
    const count = POINTS_PER_TRAIL * 2 * 3;
    this.params.fill(0, pBase, pBase + count);
  }
}
