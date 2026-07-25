/**
 * The single GPU-animated particle system every effect in the game feeds.
 *
 * Per DESIGN §16.2 rule 4: the CPU writes only spawn data (origin, velocity, birth time,
 * life, size, colour, kind) into a fixed-capacity ring buffer of vertex attributes. The GPU
 * derives the *current* position, size, and alpha from `age = uTime - spawnTime` in the
 * vertex/fragment shaders. Nothing here mutates a particle's position on the CPU after spawn —
 * that would mean touching up to `LIMITS.maxParticles` floats a frame, which is exactly the
 * cost this architecture exists to avoid.
 *
 * Two `THREE.Points` objects, not one: Spark/Ember/EngineWash/Energy are additive (glow stacks
 * with itself and with what's behind it); Smoke/Dust/Shard are normally blended (they must
 * occlude/darken, not wash out the arena behind them). The spec explicitly allows this split —
 * faking both blend modes out of one additive draw call requires premultiplying alpha and
 * darkening smoke toward whatever is guessed to be "the background", which is wrong the moment
 * something bright is actually behind the smoke. Two draw calls is one extra state change; a
 * physically wrong blend on every smoke puff is not a fair trade for it.
 *
 * Ring buffer: each group keeps a write cursor that wraps at capacity, silently overwriting the
 * oldest particle. There is no per-particle "free list" — a slot is either live-and-fading or
 * about to be overwritten, and the shader discards anything whose age has exceeded its life, so
 * stomping a not-yet-expired slot just ends that particle a little early under heavy load, which
 * is the correct failure mode for a fixed-budget effect system.
 */

import * as THREE from 'three';
import type { QualityTier } from '../../core/types';
import { LIMITS, RENDER } from '../../core/constants';
import { applySpread, randomOnSphere } from '../../core/math';

export const ParticleKind = {
  Spark: 0,
  Smoke: 1,
  Ember: 2,
  Dust: 3,
  EngineWash: 4,
  Shard: 5,
  Energy: 6,
} as const;
export type ParticleKind = (typeof ParticleKind)[keyof typeof ParticleKind];

/** Additive kinds glow; everything else (Smoke, Dust, Shard) is normally blended. */
function isAdditiveKind(kind: ParticleKind): boolean {
  return (
    kind === ParticleKind.Spark ||
    kind === ParticleKind.Ember ||
    kind === ParticleKind.EngineWash ||
    kind === ParticleKind.Energy
  );
}

/* ------------------------------------------------------------------------------------------ */
/* Shaders                                                                                      */
/* ------------------------------------------------------------------------------------------ */

// Shared by both materials: turns (spawnTime, life, kind, seed) into the per-kind drag/gravity/
// size-curve constants the GPU integrates analytically, and the screen-space stretch axis used
// by EngineWash. `age`, `lifeFrac` and `vDir` are handed to the fragment stage as varyings.
const VERTEX_HEADER = /* glsl */ `
uniform float uTime;
uniform float uAtten;

attribute vec3 aVelocity;
attribute vec3 aColor;
attribute vec4 aParams; // x: spawnTime, y: life, z: size, w: kind
attribute float aSeed;

varying vec3 vColor;
varying float vAlpha;
varying float vKind;
varying float vSeed;
varying float vAge;
varying vec2 vDir;
`;

const ADDITIVE_VERTEX = /* glsl */ `
${VERTEX_HEADER}
void main() {
  float spawnTime = aParams.x;
  float life = aParams.y;
  float size = aParams.z;
  float kind = aParams.w;
  float age = uTime - spawnTime;
  float lifeFrac = clamp(age / max(life, 1e-4), 0.0, 1.0);
  bool dead = age < 0.0 || age > life;

  // Per-kind analytic motion: drag decelerates velocity exponentially (integrated in closed
  // form below, no per-frame stepping), gravityY is a constant world-space acceleration.
  float drag = 1.0;
  float gravityY = 0.0;
  float sizeCurve = 1.0;
  if (kind < 0.5) {
    // Spark: snappy deceleration, slight downward tug, shrinks a little as it dies.
    drag = 2.2; gravityY = -4.0; sizeCurve = 1.0 - 0.35 * lifeFrac;
  } else if (kind > 1.5 && kind < 2.5) {
    // Ember: floats, flickers in size — the flicker frequency is per-particle via aSeed so a
    // burst of embers desyncs instead of pulsing in lockstep.
    drag = 0.5; gravityY = -6.0; sizeCurve = 1.0 + 0.35 * sin(age * 24.0 + aSeed * 37.0);
  } else if (kind > 3.5 && kind < 4.5) {
    // EngineWash: high drag so the wash stays close behind the emitter, fades as it thins.
    drag = 1.6; gravityY = 0.0; sizeCurve = 1.0 - 0.5 * lifeFrac;
  } else {
    // Energy: nearly stationary, pulses.
    drag = 1.2; gravityY = 0.0; sizeCurve = 1.0 + 0.25 * sin(age * 10.0 + aSeed * 51.0);
  }

  // Closed-form displacement of v0 under exponential drag: integral of v0*exp(-k*t) dt.
  float k = max(drag, 1e-3);
  float decay = (1.0 - exp(-k * age)) / k;
  vec3 pos = position + aVelocity * decay;
  pos.y += 0.5 * gravityY * age * age;

  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = dead ? 0.0 : size * sizeCurve * (uAtten / max(-mvPosition.z, 1.0));

  float fadeIn = smoothstep(0.0, 0.06, lifeFrac);
  float fadeOut = 1.0 - smoothstep(0.55, 1.0, lifeFrac);
  vAlpha = dead ? 0.0 : fadeIn * fadeOut;
  vColor = aColor;
  vKind = kind;
  vSeed = aSeed;
  vAge = age;

  // EngineWash stretches along true screen-space velocity: project a point a hair further
  // along the velocity vector and diff the two clip-space positions. This tracks camera angle
  // for free instead of needing a separate billboard rotation uniform per particle.
  vec3 aheadPos = pos + aVelocity * 0.05;
  vec4 aheadClip = projectionMatrix * modelViewMatrix * vec4(aheadPos, 1.0);
  vec2 d = aheadClip.xy / max(aheadClip.w, 1e-4) - gl_Position.xy / max(gl_Position.w, 1e-4);
  vDir = length(d) > 1e-6 ? normalize(d) : vec2(1.0, 0.0);
}
`;

const ADDITIVE_FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vKind;
varying float vSeed;
varying float vAge;
varying vec2 vDir;

void main() {
  if (vAlpha <= 0.0) discard;
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float alpha = vAlpha;
  vec3 col = vColor;

  if (vKind < 0.5) {
    // Spark: bright hot core, sharp falloff.
    float d = length(uv);
    float core = 1.0 - smoothstep(0.0, 0.35, d);
    float glow = 1.0 - smoothstep(0.0, 1.0, d);
    col += vec3(1.0) * core * 0.85;
    alpha *= glow * glow;
  } else if (vKind > 1.5 && vKind < 2.5) {
    // Ember: flickering hot speck with a warm rim.
    float d = length(uv);
    float glow = 1.0 - smoothstep(0.0, 1.0, d);
    float flicker = 0.6 + 0.4 * sin(vAge * 30.0 + vSeed * 71.0);
    col += vec3(0.7, 0.35, 0.0) * (1.0 - d);
    alpha *= glow * glow * flicker;
  } else if (vKind > 3.5 && vKind < 4.5) {
    // EngineWash: rotate the sprite's local frame onto the screen-space velocity axis so the
    // radial falloff reads as an elongated streak rather than a round puff.
    vec2 axis = vDir;
    vec2 perp = vec2(-axis.y, axis.x);
    vec2 local = vec2(dot(uv, axis) * 0.45, dot(uv, perp));
    float d = length(local);
    float glow = 1.0 - smoothstep(0.0, 1.0, d);
    alpha *= glow * glow;
  } else {
    // Energy: pulsing core, brightens on the beat.
    float d = length(uv);
    float glow = 1.0 - smoothstep(0.0, 1.0, d);
    float pulse = 0.7 + 0.3 * sin(vAge * 9.0 + vSeed * 20.0);
    col *= 1.0 + 0.5 * pulse;
    alpha *= glow * pulse;
  }

  gl_FragColor = vec4(col, alpha);
}
`;

const NORMAL_VERTEX = /* glsl */ `
${VERTEX_HEADER}
void main() {
  float spawnTime = aParams.x;
  float life = aParams.y;
  float size = aParams.z;
  float kind = aParams.w;
  float age = uTime - spawnTime;
  float lifeFrac = clamp(age / max(life, 1e-4), 0.0, 1.0);
  bool dead = age < 0.0 || age > life;

  float drag = 1.0;
  float gravityY = 0.0;
  float sizeCurve = 1.0;
  if (kind < 1.5) {
    // Smoke: buoyant, expands hugely over its life — this is what sells "puff" rather than dot.
    drag = 0.35; gravityY = 3.0; sizeCurve = 1.0 + 1.6 * lifeFrac;
  } else if (kind > 2.5 && kind < 3.5) {
    // Dust: almost no drag, drifts a long way, barely grows.
    drag = 0.08; gravityY = 0.0; sizeCurve = 1.0 + 0.15 * lifeFrac;
  } else {
    // Shard: tumbling debris — falls, shrinks sharply near the end as if receding/burning up.
    drag = 0.9; gravityY = -12.0; sizeCurve = 1.0 - 0.6 * lifeFrac * lifeFrac;
  }

  float k = max(drag, 1e-3);
  float decay = (1.0 - exp(-k * age)) / k;
  vec3 pos = position + aVelocity * decay;
  pos.y += 0.5 * gravityY * age * age;

  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = dead ? 0.0 : size * sizeCurve * (uAtten / max(-mvPosition.z, 1.0));

  float fadeIn = smoothstep(0.0, 0.06, lifeFrac);
  // Smoke lingers — fade-out starts early but runs the whole remaining life so it trails off
  // rather than popping. Dust/Shard hold near-full alpha and cut out only at the very end.
  float fadeOutStart = kind < 1.5 ? 0.15 : 0.82;
  float fadeOut = 1.0 - smoothstep(fadeOutStart, 1.0, lifeFrac);
  vAlpha = dead ? 0.0 : fadeIn * fadeOut;
  vColor = aColor;
  vKind = kind;
  vSeed = aSeed;
  vAge = age;
  vDir = vec2(1.0, 0.0);
}
`;

const NORMAL_FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
varying float vKind;
varying float vSeed;
varying float vAge;
varying vec2 vDir;

void main() {
  if (vAlpha <= 0.0) discard;
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float alpha = vAlpha;
  vec3 col = vColor;
  float d = length(uv);

  if (vKind < 1.5) {
    // Smoke: soft, broad, dark — normal blending darkens whatever is behind it, which is the
    // actual "smoke occludes" look; no colour tricks needed since it isn't additive.
    float glow = 1.0 - smoothstep(0.2, 1.0, d);
    alpha *= glow;
  } else if (vKind > 2.5 && vKind < 3.5) {
    // Dust: faint and wide, barely-there even at full alpha.
    float glow = 1.0 - smoothstep(0.0, 1.0, d);
    alpha *= glow * 0.35;
  } else {
    // Shard: hard edge, not a soft sprite — reads as a solid chunk of debris.
    alpha *= step(d, 0.8) * (0.85 + 0.15 * sin(vSeed * 40.0));
  }

  gl_FragColor = vec4(col, alpha);
}
`;

/* ------------------------------------------------------------------------------------------ */
/* Ring-buffered particle group                                                                 */
/* ------------------------------------------------------------------------------------------ */

/** One blend-mode's worth of particles: one geometry, one material, one draw call. */
class ParticleGroup {
  readonly points: THREE.Points;
  readonly capacity: number;

  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;

  private readonly posArr: Float32Array;
  private readonly velArr: Float32Array;
  private readonly colorArr: Float32Array;
  private readonly paramsArr: Float32Array;
  private readonly seedArr: Float32Array;

  private readonly posAttr: THREE.BufferAttribute;
  private readonly velAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;
  private readonly paramsAttr: THREE.BufferAttribute;
  private readonly seedAttr: THREE.BufferAttribute;

  private cursor = 0;
  private spawnedTotal = 0;
  private dirtyStart = 0;
  private dirtyCount = 0;

  constructor(capacity: number, blending: THREE.Blending, vertexShader: string, fragmentShader: string) {
    this.capacity = capacity;
    this.posArr = new Float32Array(capacity * 3);
    this.velArr = new Float32Array(capacity * 3);
    this.colorArr = new Float32Array(capacity * 3);
    this.paramsArr = new Float32Array(capacity * 4);
    this.seedArr = new Float32Array(capacity);

    this.posAttr = new THREE.BufferAttribute(this.posArr, 3);
    this.velAttr = new THREE.BufferAttribute(this.velArr, 3);
    this.colorAttr = new THREE.BufferAttribute(this.colorArr, 3);
    this.paramsAttr = new THREE.BufferAttribute(this.paramsArr, 4);
    this.seedAttr = new THREE.BufferAttribute(this.seedArr, 1);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.velAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.paramsAttr.setUsage(THREE.DynamicDrawUsage);
    this.seedAttr.setUsage(THREE.DynamicDrawUsage);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('aVelocity', this.velAttr);
    this.geometry.setAttribute('aColor', this.colorAttr);
    this.geometry.setAttribute('aParams', this.paramsAttr);
    this.geometry.setAttribute('aSeed', this.seedAttr);
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uAtten: { value: 420 } },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    // Positions written to the buffer are spawn origins, not the animated (GPU-computed)
    // positions, so three's auto bounding-sphere would be meaningless and could cull a system
    // whose visible particles have drifted well outside it.
    this.points.frustumCulled = false;
    this.points.matrixAutoUpdate = false;
    this.points.updateMatrix();
  }

  write(
    kind: ParticleKind,
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    size: number, life: number, colorHex: number,
    spawnTime: number,
  ): void {
    const i = this.cursor;
    const i3 = i * 3;
    const i4 = i * 4;

    this.posArr[i3] = x; this.posArr[i3 + 1] = y; this.posArr[i3 + 2] = z;
    this.velArr[i3] = vx; this.velArr[i3 + 1] = vy; this.velArr[i3 + 2] = vz;
    this.colorArr[i3] = ((colorHex >> 16) & 0xff) / 255;
    this.colorArr[i3 + 1] = ((colorHex >> 8) & 0xff) / 255;
    this.colorArr[i3 + 2] = (colorHex & 0xff) / 255;
    this.paramsArr[i4] = spawnTime;
    this.paramsArr[i4 + 1] = life;
    this.paramsArr[i4 + 2] = size;
    this.paramsArr[i4 + 3] = kind;
    this.seedArr[i] = Math.random();

    if (this.dirtyCount === 0) this.dirtyStart = i;
    this.dirtyCount = Math.min(this.dirtyCount + 1, this.capacity);
    this.cursor = (i + 1) % this.capacity;
    if (this.spawnedTotal < this.capacity) this.spawnedTotal++;
  }

  /** Uploads this frame's writes and re-points the draw range. Always advances `uTime`. */
  flush(elapsed: number): void {
    (this.material.uniforms['uTime'] as { value: number }).value = elapsed;

    if (this.dirtyCount > 0) {
      const end = this.dirtyStart + this.dirtyCount;
      const ranges: Array<[start: number, count: number]> =
        end <= this.capacity
          ? [[this.dirtyStart, this.dirtyCount]]
          : [
              [this.dirtyStart, this.capacity - this.dirtyStart],
              [0, this.dirtyCount - (this.capacity - this.dirtyStart)],
            ];

      // addUpdateRange operates in raw typed-array element units, so each attribute scales
      // the (vertex start, vertex count) pair by its own itemSize.
      this.applyRanges(this.posAttr, 3, ranges);
      this.applyRanges(this.velAttr, 3, ranges);
      this.applyRanges(this.colorAttr, 3, ranges);
      this.applyRanges(this.paramsAttr, 4, ranges);
      this.applyRanges(this.seedAttr, 1, ranges);
      this.dirtyCount = 0;
    }

    this.geometry.setDrawRange(0, this.spawnedTotal);
  }

  private applyRanges(
    attr: THREE.BufferAttribute,
    itemSize: number,
    ranges: ReadonlyArray<readonly [number, number]>,
  ): void {
    for (const [start, count] of ranges) attr.addUpdateRange(start * itemSize, count * itemSize);
    attr.needsUpdate = true;
  }

  /** Approximate count of particles whose age has not yet exceeded their life. */
  countLive(elapsed: number): number {
    const n = Math.min(this.spawnedTotal, this.capacity);
    let count = 0;
    for (let i = 0; i < n; i++) {
      const i4 = i * 4;
      const spawnTime = this.paramsArr[i4]!;
      const life = this.paramsArr[i4 + 1]!;
      if (elapsed - spawnTime <= life) count++;
    }
    return count;
  }

  reset(): void {
    this.cursor = 0;
    this.spawnedTotal = 0;
    this.dirtyCount = 0;
    this.dirtyStart = 0;
    this.geometry.setDrawRange(0, 0);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Public system                                                                                */
/* ------------------------------------------------------------------------------------------ */

// Sparks/embers/energy/wash are emitted far more often (every hit, every engine) than smoke/
// dust/shards (kills, explosions), so the shared LIMITS.maxParticles budget is split unevenly
// between the two draw calls rather than 50/50.
const ADDITIVE_CAPACITY = Math.floor(LIMITS.maxParticles * 0.65);
const NORMAL_CAPACITY = LIMITS.maxParticles - ADDITIVE_CAPACITY;

const scratchBurstDir = /*#__PURE__*/ new THREE.Vector3();
const scratchBurstWork = /*#__PURE__*/ new THREE.Vector3();

export class ParticleSystem {
  private readonly additive: ParticleGroup;
  private readonly normal: ParticleGroup;
  private qualityScale = 1;
  /** Last elapsed time seen by `update`; new spawns stamp this as their birth time. */
  private elapsed = 0;

  constructor(scene: THREE.Scene) {
    this.additive = new ParticleGroup(ADDITIVE_CAPACITY, THREE.AdditiveBlending, ADDITIVE_VERTEX, ADDITIVE_FRAGMENT);
    this.normal = new ParticleGroup(NORMAL_CAPACITY, THREE.NormalBlending, NORMAL_VERTEX, NORMAL_FRAGMENT);
    scene.add(this.additive.points, this.normal.points);
  }

  /** Emits one particle. Cheap enough to call hundreds of times per frame. */
  spawn(
    kind: ParticleKind,
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    size: number, life: number, colorHex: number,
  ): void {
    const group = isAdditiveKind(kind) ? this.additive : this.normal;
    group.write(kind, x, y, z, vx, vy, vz, size, life, colorHex, this.elapsed);
  }

  /** Emits `count` particles in a cone. `spread` is the half-angle in radians. */
  burst(
    kind: ParticleKind,
    x: number, y: number, z: number,
    dx: number, dy: number, dz: number,
    spread: number, speed: number, count: number,
    size: number, life: number, colorHex: number,
  ): void {
    const n = Math.round(count * this.qualityScale);
    if (n <= 0) return;

    scratchBurstDir.set(dx, dy, dz);
    if (scratchBurstDir.lengthSq() < 1e-8) scratchBurstDir.set(0, 1, 0);
    else scratchBurstDir.normalize();

    const group = isAdditiveKind(kind) ? this.additive : this.normal;
    for (let i = 0; i < n; i++) {
      scratchBurstWork.copy(scratchBurstDir);
      applySpread(scratchBurstWork, spread, Math.random);
      const s = speed * (0.75 + Math.random() * 0.5);
      const l = life * (0.8 + Math.random() * 0.4);
      group.write(
        kind, x, y, z,
        scratchBurstWork.x * s, scratchBurstWork.y * s, scratchBurstWork.z * s,
        size, l, colorHex, this.elapsed,
      );
    }
  }

  /** Emits `count` particles radially outward from a point. */
  sphereBurst(
    kind: ParticleKind,
    x: number, y: number, z: number,
    speed: number, count: number,
    size: number, life: number, colorHex: number,
  ): void {
    const n = Math.round(count * this.qualityScale);
    if (n <= 0) return;

    const group = isAdditiveKind(kind) ? this.additive : this.normal;
    for (let i = 0; i < n; i++) {
      randomOnSphere(scratchBurstWork, Math.random);
      const s = speed * (0.7 + Math.random() * 0.6);
      const l = life * (0.8 + Math.random() * 0.4);
      group.write(
        kind, x, y, z,
        scratchBurstWork.x * s, scratchBurstWork.y * s, scratchBurstWork.z * s,
        size, l, colorHex, this.elapsed,
      );
    }
  }

  /** Scales all subsequent spawn counts. Driven by the adaptive quality tier. */
  setQuality(tier: QualityTier): void {
    this.qualityScale = RENDER.particleScale[tier];
  }

  update(elapsed: number, _dt: number): void {
    this.elapsed = elapsed;
    this.additive.flush(elapsed);
    this.normal.flush(elapsed);
  }

  get liveCount(): number {
    return this.additive.countLive(this.elapsed) + this.normal.countLive(this.elapsed);
  }

  reset(): void {
    this.additive.reset();
    this.normal.reset();
  }

  dispose(): void {
    this.additive.points.parent?.remove(this.additive.points);
    this.normal.points.parent?.remove(this.normal.points);
    this.additive.dispose();
    this.normal.dispose();
  }
}
