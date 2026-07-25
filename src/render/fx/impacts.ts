/**
 * Impact, explosion, shockwave, muzzle-flash, beam, and chain-lightning effects — the "weight
 * in every trigger pull" pillar (DESIGN §12).
 *
 * Three pooled, GPU-driven mechanisms cover every method on this class:
 *
 *  - `SpritePool`: one `InstancedMesh` of a camera-facing unit quad, billboarded entirely in
 *    the vertex shader (offset in view space, so no per-frame CPU work). A `style` attribute
 *    picks the fragment behaviour: an expanding ring (shockwaves, shield ripples), a fading
 *    flash (muzzle pops, explosion cores), or a converging ring (warp-in). One draw call for
 *    every ring/flash/warp effect in the game.
 *  - `BeamPool`: one `InstancedMesh` of a unit "fat line" quad, billboarded per-instance in the
 *    vertex shader from two world-space endpoints and the view matrix — a classic screen-facing
 *    ribbon between two points, recomputed for free every frame as the camera moves. Used for
 *    `beam()` directly and for `arc()`, which just acquires several beam slots along a jittered
 *    path.
 *  - The existing `ParticleSystem` for everything that is actually made of many small moving
 *    things: sparks, shards, smoke.
 *
 * Both pools use the same ring-buffer-overwrites-oldest discipline as `ParticleSystem`: nothing
 * is created or destroyed at runtime, and an effect that outlives its `duration` just stops
 * being drawn (the shader zeroes its alpha/size) rather than needing an explicit release.
 */

import * as THREE from 'three';
import type { QualityTier } from '../../core/types';
import { RENDER } from '../../core/constants';
import { clamp } from '../../core/math';
import { ParticleKind, type ParticleSystem } from './particles';

const STYLE_RING = 0;
const STYLE_FLASH = 1;
const STYLE_WARP = 2;

const SPRITE_CAPACITY = 192;
const BEAM_CAPACITY = 96;
const ECHO_CAPACITY = 16;
const ARC_SEGMENTS = 6;
/** Chain-lightning jitter as a fraction of the straight-line distance between its endpoints. */
const ARC_JITTER_FRACTION = 0.12;

/* Tuning ---------------------------------------------------------------------------------- */
const HIT_SPARK_BASE = 2;
const HIT_SPARK_PER_DAMAGE = 0.4;
const HIT_SPARK_MIN = 3;
const HIT_SPARK_MAX = 36;
const HIT_SPARK_SPREAD = 0.5;
const HIT_SPARK_SPEED = 60;
const HIT_SPARK_SIZE = 0.9;
const HIT_SPARK_LIFE = 0.35;

const SHIELD_RIPPLE_RADIUS = 6;
const SHIELD_RIPPLE_DURATION = 0.4;
const SHIELD_SPARK_COUNT = 8;

const EXPLOSION_FLASH_SCALE = 1.4;
const EXPLOSION_FLASH_DURATION = 0.16;
const EXPLOSION_RING_SCALE = 5.0;
const EXPLOSION_RING_DURATION = 0.6;
const EXPLOSION_SHARD_COUNT = 14;
const EXPLOSION_SHARD_SPEED = 40;
const EXPLOSION_SPARK_COUNT = 22;
const EXPLOSION_SPARK_SPEED = 70;
const EXPLOSION_SMOKE_COUNT = 10;
const EXPLOSION_SMOKE_SPEED = 8;
const EXPLOSION_SMOKE_LIFE = 2.2;

const BIG_EXPLOSION_SCALE_MULT = 1.8;
const BIG_EXPLOSION_ECHO_DELAYS = [0.08, 0.18] as const;
const BIG_EXPLOSION_ECHO_SCALE = [0.6, 0.4] as const;

const MUZZLE_FLASH_DURATION = 0.09;
const MUZZLE_SPARK_LIFE = 0.12;
const MUZZLE_SPARK_SPEED = 90;

const WARP_RING_DURATION_MULT = 0.9;
const WARP_PARTICLE_SPEED = 14;

const scratchArcDir = /*#__PURE__*/ new THREE.Vector3();
const scratchArcPerp1 = /*#__PURE__*/ new THREE.Vector3();
const scratchArcPerp2 = /*#__PURE__*/ new THREE.Vector3();
const scratchArcPrev = /*#__PURE__*/ new THREE.Vector3();
const scratchArcCurr = /*#__PURE__*/ new THREE.Vector3();

/* ------------------------------------------------------------------------------------------ */
/* SpritePool — rings, flashes, warp-in                                                        */
/* ------------------------------------------------------------------------------------------ */

class SpritePool {
  readonly mesh: THREE.InstancedMesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly capacity: number;

  private readonly center: Float32Array;
  private readonly params: Float32Array; // start, duration, maxRadius, style
  private readonly color: Float32Array;
  private readonly seed: Float32Array;

  private readonly centerAttr: THREE.InstancedBufferAttribute;
  private readonly paramsAttr: THREE.InstancedBufferAttribute;
  private readonly colorAttr: THREE.InstancedBufferAttribute;
  private readonly seedAttr: THREE.InstancedBufferAttribute;

  private cursor = 0;
  private spawnedTotal = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.center = new Float32Array(capacity * 3);
    this.params = new Float32Array(capacity * 4);
    this.color = new Float32Array(capacity * 3);
    this.seed = new Float32Array(capacity);

    const base = new THREE.InstancedBufferGeometry();
    // Unit quad in [-0.5, 0.5]; the vertex shader scales it per-instance in view space.
    const quadPos = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
    base.setAttribute('position', new THREE.BufferAttribute(quadPos, 3));
    base.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

    this.centerAttr = new THREE.InstancedBufferAttribute(this.center, 3);
    this.paramsAttr = new THREE.InstancedBufferAttribute(this.params, 4);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.color, 3);
    this.seedAttr = new THREE.InstancedBufferAttribute(this.seed, 1);
    this.centerAttr.setUsage(THREE.DynamicDrawUsage);
    this.paramsAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.seedAttr.setUsage(THREE.DynamicDrawUsage);
    base.setAttribute('iCenter', this.centerAttr);
    base.setAttribute('iParams', this.paramsAttr);
    base.setAttribute('iColor', this.colorAttr);
    base.setAttribute('iSeed', this.seedAttr);
    this.geometry = base;

    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        uniform float uTime;
        attribute vec3 iCenter;
        attribute vec4 iParams; // start, duration, maxRadius, style
        attribute vec3 iColor;
        attribute float iSeed;

        varying vec3 vColor;
        varying float vProgress;
        varying float vStyle;
        varying float vSeed;
        varying float vAlive;
        varying vec2 vUv;

        void main() {
          float start = iParams.x;
          float duration = iParams.y;
          float maxRadius = max(iParams.z, 1e-4);
          float style = iParams.w;
          float age = uTime - start;
          float progress = clamp(age / duration, 0.0, 1.0);
          vAlive = (age < 0.0 || age > duration) ? 0.0 : 1.0;

          // Padded so the animated ring/flash never clips the quad's own edge.
          const float PAD = 1.3;
          float halfExtent = maxRadius * PAD;
          vec4 mvPosition = modelViewMatrix * vec4(iCenter, 1.0);
          mvPosition.xy += position.xy * (2.0 * halfExtent) * vAlive;
          gl_Position = projectionMatrix * mvPosition;

          // position.xy in [-0.5,0.5] * 2 * PAD lands vUv exactly in world-radius units
          // relative to maxRadius: length(vUv) == 1.0 at the edge of the requested radius.
          vUv = position.xy * (2.0 * PAD);
          vColor = iColor;
          vProgress = progress;
          vStyle = style;
          vSeed = iSeed;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vProgress;
        varying float vStyle;
        varying float vSeed;
        varying float vAlive;
        varying vec2 vUv;

        void main() {
          if (vAlive < 0.5) discard;
          float d = length(vUv);
          float alpha = 0.0;
          vec3 col = vColor;

          if (vStyle < 0.5) {
            // Ring: an expanding band that thins and fades as it grows.
            float ringR = vProgress;
            float band = 1.0 - smoothstep(0.0, 0.1 + 0.08 * vProgress, abs(d - ringR));
            alpha = band * (1.0 - vProgress);
          } else if (vStyle < 1.5) {
            // Flash: a bright core that collapses and fades fast.
            float core = 1.0 - smoothstep(0.0, 1.0 - 0.4 * vProgress, d);
            col += vec3(1.0) * (1.0 - vProgress) * 0.6;
            alpha = core * core * (1.0 - vProgress);
          } else {
            // Warp: a ring converging inward, brightening as it arrives at the centre.
            float ringR = 1.0 - vProgress;
            float band = 1.0 - smoothstep(0.0, 0.12, abs(d - ringR));
            float flicker = 0.75 + 0.25 * sin(vProgress * 40.0 + vSeed * 30.0);
            alpha = band * vProgress * flicker;
          }

          if (alpha <= 0.001) discard;
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });

    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    // Identity for every instance: this pool never uses `instanceMatrix` (it billboards from
    // the custom `iCenter`/`iParams` attributes instead), but leaving it zeroed is needless
    // undefined state for a class other code may introspect.
    const identity = new THREE.Matrix4();
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, identity);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  spawn(x: number, y: number, z: number, maxRadius: number, duration: number, colorHex: number, style: number, spawnTime: number): void {
    const i = this.cursor;
    const i3 = i * 3;
    const i4 = i * 4;
    this.center[i3] = x; this.center[i3 + 1] = y; this.center[i3 + 2] = z;
    this.params[i4] = spawnTime; this.params[i4 + 1] = Math.max(duration, 0.02); this.params[i4 + 2] = maxRadius; this.params[i4 + 3] = style;
    this.color[i3] = ((colorHex >> 16) & 0xff) / 255;
    this.color[i3 + 1] = ((colorHex >> 8) & 0xff) / 255;
    this.color[i3 + 2] = (colorHex & 0xff) / 255;
    this.seed[i] = Math.random();

    this.centerAttr.addUpdateRange(i3, 3);
    this.paramsAttr.addUpdateRange(i4, 4);
    this.colorAttr.addUpdateRange(i3, 3);
    this.seedAttr.addUpdateRange(i, 1);
    this.centerAttr.needsUpdate = true;
    this.paramsAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.seedAttr.needsUpdate = true;

    this.cursor = (i + 1) % this.capacity;
    if (this.spawnedTotal < this.capacity) this.spawnedTotal++;
    this.mesh.count = this.spawnedTotal;
  }

  flush(elapsed: number): void {
    (this.material.uniforms['uTime'] as { value: number }).value = elapsed;
  }

  reset(): void {
    this.cursor = 0;
    this.spawnedTotal = 0;
    this.mesh.count = 0;
    this.params.fill(0);
    this.paramsAttr.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* ------------------------------------------------------------------------------------------ */
/* BeamPool — laser beams and chain-lightning segments                                         */
/* ------------------------------------------------------------------------------------------ */

class BeamPool {
  readonly mesh: THREE.InstancedMesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly capacity: number;

  private readonly p0: Float32Array;
  private readonly p1: Float32Array;
  private readonly params: Float32Array; // start, duration, width
  private readonly color: Float32Array;
  private readonly seed: Float32Array;

  private readonly p0Attr: THREE.InstancedBufferAttribute;
  private readonly p1Attr: THREE.InstancedBufferAttribute;
  private readonly paramsAttr: THREE.InstancedBufferAttribute;
  private readonly colorAttr: THREE.InstancedBufferAttribute;
  private readonly seedAttr: THREE.InstancedBufferAttribute;

  private cursor = 0;
  private spawnedTotal = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.p0 = new Float32Array(capacity * 3);
    this.p1 = new Float32Array(capacity * 3);
    this.params = new Float32Array(capacity * 3);
    this.color = new Float32Array(capacity * 3);
    this.seed = new Float32Array(capacity);

    const base = new THREE.InstancedBufferGeometry();
    // x (position.x) is progress along the beam [0,1]; y is the across-beam offset [-0.5,0.5].
    const quadPos = new Float32Array([0, -0.5, 0, 1, -0.5, 0, 1, 0.5, 0, 0, 0.5, 0]);
    base.setAttribute('position', new THREE.BufferAttribute(quadPos, 3));
    base.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

    this.p0Attr = new THREE.InstancedBufferAttribute(this.p0, 3);
    this.p1Attr = new THREE.InstancedBufferAttribute(this.p1, 3);
    this.paramsAttr = new THREE.InstancedBufferAttribute(this.params, 3);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.color, 3);
    this.seedAttr = new THREE.InstancedBufferAttribute(this.seed, 1);
    this.p0Attr.setUsage(THREE.DynamicDrawUsage);
    this.p1Attr.setUsage(THREE.DynamicDrawUsage);
    this.paramsAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.seedAttr.setUsage(THREE.DynamicDrawUsage);
    base.setAttribute('iP0', this.p0Attr);
    base.setAttribute('iP1', this.p1Attr);
    base.setAttribute('iParams', this.paramsAttr);
    base.setAttribute('iColor', this.colorAttr);
    base.setAttribute('iSeed', this.seedAttr);
    this.geometry = base;

    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        uniform float uTime;
        attribute vec3 iP0;
        attribute vec3 iP1;
        attribute vec3 iParams; // start, duration, width
        attribute vec3 iColor;
        attribute float iSeed;

        varying vec3 vColor;
        varying float vProgress;
        varying float vAlive;
        varying float vAlong;
        varying float vAcross;
        varying float vSeed;

        void main() {
          float start = iParams.x;
          float duration = iParams.y;
          float width = iParams.z;
          float age = uTime - start;
          vProgress = clamp(age / max(duration, 1e-4), 0.0, 1.0);
          vAlive = (age < 0.0 || age > duration) ? 0.0 : 1.0;

          // Billboard entirely in view space: the beam's own direction, and a perpendicular
          // derived from it, are recomputed every vertex shader invocation, so the ribbon
          // re-faces the camera every frame without any CPU work (cf. TrailSystem, which must
          // do this on the CPU because its path changes shape frame to frame — a beam's
          // endpoints don't, so the GPU can own 100% of this).
          vec4 v0 = viewMatrix * vec4(iP0, 1.0);
          vec4 v1 = viewMatrix * vec4(iP1, 1.0);
          vec3 dir = v1.xyz - v0.xyz;
          float len = max(length(dir), 1e-5);
          dir /= len;
          vec3 perp = normalize(vec3(-dir.y, dir.x, 0.0));

          float w = width * vAlive;
          vec3 viewPos = mix(v0.xyz, v1.xyz, position.x) + perp * position.y * w;
          gl_Position = projectionMatrix * vec4(viewPos, 1.0);

          vAlong = position.x;
          vAcross = position.y;
          vColor = iColor;
          vSeed = iSeed;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying vec3 vColor;
        varying float vProgress;
        varying float vAlive;
        varying float vAlong;
        varying float vAcross;
        varying float vSeed;

        void main() {
          if (vAlive < 0.5) discard;
          float across = abs(vAcross) * 2.0;
          float core = 1.0 - smoothstep(0.0, 1.0, across);
          float endTaper = smoothstep(0.0, 0.08, vAlong) * smoothstep(0.0, 0.08, 1.0 - vAlong);
          // Fast per-frame flicker (electric hum) layered on a slower per-instance jitter so a
          // burst of arc segments desyncs instead of pulsing in lockstep.
          float flicker = 0.85 + 0.15 * sin(uTime * 40.0 + vSeed * 17.0);
          float hum = 0.85 + 0.15 * sin(vProgress * 6.0 + vSeed * 60.0);
          float envelope = 1.0 - smoothstep(0.65, 1.0, vProgress);
          float alpha = core * core * endTaper * envelope * hum * flicker;
          if (alpha <= 0.001) discard;
          gl_FragColor = vec4(vColor * (1.0 + core), alpha);
        }
      `,
    });

    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    const identity = new THREE.Matrix4();
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, identity);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  spawn(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, width: number, duration: number, colorHex: number, spawnTime: number): void {
    const i = this.cursor;
    const i3 = i * 3;
    this.p0[i3] = x0; this.p0[i3 + 1] = y0; this.p0[i3 + 2] = z0;
    this.p1[i3] = x1; this.p1[i3 + 1] = y1; this.p1[i3 + 2] = z1;
    this.params[i3] = spawnTime; this.params[i3 + 1] = Math.max(duration, 0.02); this.params[i3 + 2] = width;
    this.color[i3] = ((colorHex >> 16) & 0xff) / 255;
    this.color[i3 + 1] = ((colorHex >> 8) & 0xff) / 255;
    this.color[i3 + 2] = (colorHex & 0xff) / 255;
    this.seed[i] = Math.random();

    this.p0Attr.addUpdateRange(i3, 3);
    this.p1Attr.addUpdateRange(i3, 3);
    this.paramsAttr.addUpdateRange(i3, 3);
    this.colorAttr.addUpdateRange(i3, 3);
    this.seedAttr.addUpdateRange(i, 1);
    this.p0Attr.needsUpdate = true;
    this.p1Attr.needsUpdate = true;
    this.paramsAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.seedAttr.needsUpdate = true;

    this.cursor = (i + 1) % this.capacity;
    if (this.spawnedTotal < this.capacity) this.spawnedTotal++;
    this.mesh.count = this.spawnedTotal;
  }

  flush(elapsed: number): void {
    (this.material.uniforms['uTime'] as { value: number }).value = elapsed;
  }

  reset(): void {
    this.cursor = 0;
    this.spawnedTotal = 0;
    this.mesh.count = 0;
    this.params.fill(0);
    this.paramsAttr.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Delayed echoes — the only bit of "scheduling" this module needs, for bigExplosion's chain   */
/* ------------------------------------------------------------------------------------------ */

interface Echo {
  active: boolean;
  x: number; y: number; z: number;
  scale: number;
  colorHex: number;
  remaining: number;
}

/* ------------------------------------------------------------------------------------------ */
/* ImpactFX                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export class ImpactFX {
  private readonly particles: ParticleSystem;
  private readonly rings: SpritePool;
  private readonly beams: BeamPool;
  private readonly echoes: Echo[];

  private qualityScale = 1;
  private elapsed = 0;

  constructor(scene: THREE.Scene, particles: ParticleSystem) {
    this.particles = particles;
    this.rings = new SpritePool(SPRITE_CAPACITY);
    this.beams = new BeamPool(BEAM_CAPACITY);
    this.echoes = new Array(ECHO_CAPACITY);
    for (let i = 0; i < ECHO_CAPACITY; i++) {
      this.echoes[i] = { active: false, x: 0, y: 0, z: 0, scale: 1, colorHex: 0xffffff, remaining: 0 };
    }
    scene.add(this.rings.mesh, this.beams.mesh);
  }

  /** Sparks along the reflected impact vector, count scaled by damage (DESIGN §12). */
  hit(x: number, y: number, z: number, nx: number, ny: number, nz: number, damage: number, colorHex: number): void {
    const count = clamp(Math.round(HIT_SPARK_BASE + damage * HIT_SPARK_PER_DAMAGE), HIT_SPARK_MIN, HIT_SPARK_MAX);
    this.particles.burst(
      ParticleKind.Spark, x, y, z, nx, ny, nz,
      HIT_SPARK_SPREAD, HIT_SPARK_SPEED, count, HIT_SPARK_SIZE, HIT_SPARK_LIFE, colorHex,
    );
  }

  /** Shield hit — a bright ripple rather than sparks. */
  shieldHit(x: number, y: number, z: number, nx: number, ny: number, nz: number, colorHex: number): void {
    this.rings.spawn(x, y, z, SHIELD_RIPPLE_RADIUS, SHIELD_RIPPLE_DURATION, colorHex, STYLE_RING, this.elapsed);
    this.particles.burst(
      ParticleKind.Energy, x, y, z, nx, ny, nz,
      0.7, 20, SHIELD_SPARK_COUNT, 1.0, 0.3, colorHex,
    );
  }

  /** Full kill sequence: white flash -> expanding ring shockwave -> debris chunks -> smoke. */
  explosion(x: number, y: number, z: number, scale: number, colorHex: number): void {
    this.rings.spawn(x, y, z, scale * EXPLOSION_FLASH_SCALE, EXPLOSION_FLASH_DURATION, 0xfff6d6, STYLE_FLASH, this.elapsed);
    this.rings.spawn(x, y, z, scale * EXPLOSION_RING_SCALE, EXPLOSION_RING_DURATION, colorHex, STYLE_RING, this.elapsed);

    this.particles.sphereBurst(
      ParticleKind.Spark, x, y, z, EXPLOSION_SPARK_SPEED * scale,
      Math.round(EXPLOSION_SPARK_COUNT * this.qualityScale), 1.1 * scale, 0.5, colorHex,
    );
    this.particles.sphereBurst(
      ParticleKind.Shard, x, y, z, EXPLOSION_SHARD_SPEED * scale,
      Math.round(EXPLOSION_SHARD_COUNT * this.qualityScale), 0.7 * scale, 1.1, 0x9aa0ac,
    );
    this.particles.sphereBurst(
      ParticleKind.Smoke, x, y, z, EXPLOSION_SMOKE_SPEED * scale,
      Math.round(EXPLOSION_SMOKE_COUNT * this.qualityScale), 2.4 * scale, EXPLOSION_SMOKE_LIFE, 0x3a3f52,
    );
  }

  /** Larger, chained variant for elites and bosses. */
  bigExplosion(x: number, y: number, z: number, scale: number, colorHex: number): void {
    this.explosion(x, y, z, scale * BIG_EXPLOSION_SCALE_MULT, colorHex);

    // The chain of secondary blasts is the heaviest flourish this module owns; it's the first
    // thing shed under load, mirroring DESIGN §16.2 rule 7 ("sheds particle density first").
    if (this.qualityScale < 0.5) return;
    for (let i = 0; i < BIG_EXPLOSION_ECHO_DELAYS.length; i++) {
      const echo = this.acquireEcho();
      if (!echo) break;
      const jitter = scale * 6;
      echo.active = true;
      echo.x = x + (Math.random() * 2 - 1) * jitter;
      echo.y = y + (Math.random() * 2 - 1) * jitter;
      echo.z = z + (Math.random() * 2 - 1) * jitter;
      echo.scale = scale * BIG_EXPLOSION_ECHO_SCALE[i]!;
      echo.colorHex = colorHex;
      echo.remaining = BIG_EXPLOSION_ECHO_DELAYS[i]!;
    }
  }

  /** Expanding ring only — for Aegis Pulse, boss slams, EMP fronts. */
  shockwave(x: number, y: number, z: number, maxRadius: number, seconds: number, colorHex: number): void {
    this.rings.spawn(x, y, z, maxRadius, seconds, colorHex, STYLE_RING, this.elapsed);
  }

  /** Muzzle flash oriented along a direction; `weaponScale` differentiates weapons. */
  muzzleFlash(x: number, y: number, z: number, dx: number, dy: number, dz: number, weaponScale: number, colorHex: number): void {
    this.rings.spawn(x, y, z, 0.9 * weaponScale, MUZZLE_FLASH_DURATION, colorHex, STYLE_FLASH, this.elapsed);
    // The flash sprite itself is isotropic (it billboards to the camera); directionality reads
    // through this short, tight spark cone fired straight down the muzzle vector instead.
    this.particles.burst(
      ParticleKind.Spark, x, y, z, dx, dy, dz,
      0.16, MUZZLE_SPARK_SPEED * weaponScale, Math.round(3 + 3 * weaponScale),
      0.5 * weaponScale, MUZZLE_SPARK_LIFE, colorHex,
    );
  }

  /** Beam segment for hitscan/sustained weapons; lives for `seconds`. */
  beam(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, width: number, seconds: number, colorHex: number): void {
    this.beams.spawn(x0, y0, z0, x1, y1, z1, width, seconds, colorHex, this.elapsed);
  }

  /** Chain-lightning arc with jitter, for Arc Tether. */
  arc(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, colorHex: number): void {
    scratchArcDir.set(x1 - x0, y1 - y0, z1 - z0);
    const dist = scratchArcDir.length();
    if (dist < 1e-4) return;
    scratchArcDir.multiplyScalar(1 / dist);

    scratchArcPerp1.set(0, 1, 0);
    if (Math.abs(scratchArcDir.y) > 0.9) scratchArcPerp1.set(1, 0, 0);
    scratchArcPerp1.crossVectors(scratchArcDir, scratchArcPerp1).normalize();
    scratchArcPerp2.crossVectors(scratchArcDir, scratchArcPerp1).normalize();

    const jitterMag = dist * ARC_JITTER_FRACTION;
    scratchArcPrev.set(x0, y0, z0);
    const life = 0.12;
    const width = 0.5;

    for (let seg = 1; seg <= ARC_SEGMENTS; seg++) {
      const t = seg / ARC_SEGMENTS;
      if (seg === ARC_SEGMENTS) {
        scratchArcCurr.set(x1, y1, z1);
      } else {
        scratchArcCurr.set(x0 + scratchArcDir.x * dist * t, y0 + scratchArcDir.y * dist * t, z0 + scratchArcDir.z * dist * t);
        const j1 = (Math.random() * 2 - 1) * jitterMag;
        const j2 = (Math.random() * 2 - 1) * jitterMag;
        scratchArcCurr.addScaledVector(scratchArcPerp1, j1);
        scratchArcCurr.addScaledVector(scratchArcPerp2, j2);
      }

      this.beams.spawn(
        scratchArcPrev.x, scratchArcPrev.y, scratchArcPrev.z,
        scratchArcCurr.x, scratchArcCurr.y, scratchArcCurr.z,
        width, life, colorHex, this.elapsed,
      );
      this.particles.spawn(
        ParticleKind.Spark,
        scratchArcCurr.x, scratchArcCurr.y, scratchArcCurr.z,
        0, 0, 0, 0.6, 0.15, colorHex,
      );
      scratchArcPrev.copy(scratchArcCurr);
    }
  }

  /** Warp-in effect when an enemy spawns. */
  warpIn(x: number, y: number, z: number, scale: number, colorHex: number): void {
    const duration = Math.max(scale, 1) * WARP_RING_DURATION_MULT;
    this.rings.spawn(x, y, z, scale * 3.5, duration, colorHex, STYLE_WARP, this.elapsed);
    this.particles.sphereBurst(
      ParticleKind.Energy, x, y, z, WARP_PARTICLE_SPEED,
      Math.round(18 * scale * this.qualityScale), 0.9, duration * 0.85, colorHex,
    );
  }

  setQuality(tier: QualityTier): void {
    this.qualityScale = RENDER.particleScale[tier];
  }

  update(elapsed: number, dt: number, _cameraPos: THREE.Vector3): void {
    this.elapsed = elapsed;
    this.rings.flush(elapsed);
    this.beams.flush(elapsed);

    for (let i = 0; i < this.echoes.length; i++) {
      const echo = this.echoes[i]!;
      if (!echo.active) continue;
      echo.remaining -= dt;
      if (echo.remaining <= 0) {
        echo.active = false;
        this.explosion(echo.x, echo.y, echo.z, echo.scale, echo.colorHex);
      }
    }
  }

  reset(): void {
    this.rings.reset();
    this.beams.reset();
    for (const echo of this.echoes) echo.active = false;
  }

  dispose(): void {
    this.rings.mesh.parent?.remove(this.rings.mesh);
    this.beams.mesh.parent?.remove(this.beams.mesh);
    this.rings.dispose();
    this.beams.dispose();
  }

  private acquireEcho(): Echo | null {
    for (const echo of this.echoes) if (!echo.active) return echo;
    return null;
  }
}
