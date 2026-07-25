/**
 * Hex shield shell and its break — DESIGN §12's "distinct, unmissable" shield-break event, and
 * §13's requirement that the boundary/shield reads as a subtle shell that never blocks the
 * fight when viewed face-on.
 *
 * Each acquired shield is one `THREE.Mesh` sharing a single unit-radius `SphereGeometry` (scaled
 * per-instance, never rebuilt) with its own `ShaderMaterial` instance, because each shield needs
 * independent, continuously changing uniform state — health fraction, colour, and up to four
 * live ripple origins — that would otherwise require per-vertex instanced attributes for very
 * little payoff at the shield counts this game actually has (the player plus a handful of
 * shielded enemies, not thousands). The hex-cell pattern, the fresnel brightening, and the
 * ripple rings are all computed analytically in the shader from the surface direction — no
 * texture anywhere.
 *
 * The break shatter is the one place this file *does* need one draw call for many small things
 * at once (a shell can burst into dozens of shards), so it reuses the ring-buffer-instanced-mesh
 * pattern from `impacts.ts`: one shared `InstancedMesh` of tumbling hex quads plus a stationary
 * flash, discriminated by a per-instance `style` attribute, covering every shield break in the
 * game with a single draw call.
 */

import * as THREE from 'three';
import { clamp01 } from '../../core/math';

const SHARDS_PER_BREAK = 20;
const BREAK_CAPACITY_SHIELDS = 24; // how many recent breaks worth of shards stay resident
const BREAK_POOL_CAPACITY = BREAK_CAPACITY_SHIELDS * (SHARDS_PER_BREAK + 1);
const BREAK_SHARD_LIFE = 0.9;
const BREAK_SHARD_SPEED = 26;
const BREAK_FLASH_LIFE = 0.22;

const STYLE_SHARD = 0;
const STYLE_FLASH = 1;

/** Ripple slots per shield; the shader sums however many are still within their decay window. */
const RIPPLE_SLOTS = 4;

const scratchDir = /*#__PURE__*/ new THREE.Vector3();

interface ShieldSlot {
  active: boolean;
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  radius: number;
  colorHex: number;
  /** Round-robin cursor into this shield's own 4 ripple uniform slots. */
  rippleCursor: number;
}

/* ------------------------------------------------------------------------------------------ */
/* Break shatter — shared instanced pool of tumbling hex shards + flash                         */
/* ------------------------------------------------------------------------------------------ */

class BreakPool {
  readonly mesh: THREE.InstancedMesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly capacity: number;

  private readonly origin: Float32Array;
  private readonly velocity: Float32Array;
  private readonly color: Float32Array;
  private readonly params: Float32Array; // start, duration, size, style
  private readonly seed: Float32Array;

  private readonly originAttr: THREE.InstancedBufferAttribute;
  private readonly velocityAttr: THREE.InstancedBufferAttribute;
  private readonly colorAttr: THREE.InstancedBufferAttribute;
  private readonly paramsAttr: THREE.InstancedBufferAttribute;
  private readonly seedAttr: THREE.InstancedBufferAttribute;

  private cursor = 0;
  private spawnedTotal = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.origin = new Float32Array(capacity * 3);
    this.velocity = new Float32Array(capacity * 3);
    this.color = new Float32Array(capacity * 3);
    this.params = new Float32Array(capacity * 4);
    this.seed = new Float32Array(capacity);

    const base = new THREE.InstancedBufferGeometry();
    const quadPos = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
    base.setAttribute('position', new THREE.BufferAttribute(quadPos, 3));
    base.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

    this.originAttr = new THREE.InstancedBufferAttribute(this.origin, 3);
    this.velocityAttr = new THREE.InstancedBufferAttribute(this.velocity, 3);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.color, 3);
    this.paramsAttr = new THREE.InstancedBufferAttribute(this.params, 4);
    this.seedAttr = new THREE.InstancedBufferAttribute(this.seed, 1);
    this.originAttr.setUsage(THREE.DynamicDrawUsage);
    this.velocityAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.paramsAttr.setUsage(THREE.DynamicDrawUsage);
    this.seedAttr.setUsage(THREE.DynamicDrawUsage);
    base.setAttribute('iOrigin', this.originAttr);
    base.setAttribute('iVelocity', this.velocityAttr);
    base.setAttribute('iColor', this.colorAttr);
    base.setAttribute('iParams', this.paramsAttr);
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
        attribute vec3 iOrigin;
        attribute vec3 iVelocity;
        attribute vec3 iColor;
        attribute vec4 iParams; // start, duration, size, style
        attribute float iSeed;

        varying vec3 vColor;
        varying float vProgress;
        varying float vAlive;
        varying float vStyle;
        varying vec2 vUv;

        void main() {
          float start = iParams.x;
          float duration = iParams.y;
          float size = iParams.z;
          float style = iParams.w;
          float age = uTime - start;
          vProgress = clamp(age / max(duration, 1e-4), 0.0, 1.0);
          vAlive = (age < 0.0 || age > duration) ? 0.0 : 1.0;
          vStyle = style;

          // Closed-form drag-decayed displacement, same technique as the particle system.
          float k = 1.4;
          float decay = (1.0 - exp(-k * age)) / k;
          vec3 worldPos = iOrigin + iVelocity * decay;

          // Tumble: rotate the quad's local frame around its own normal so shards spin as they
          // fly. Rotated in view space so it reads correctly regardless of camera angle.
          float ang = age * (3.0 + 6.0 * fract(iSeed * 13.0));
          float ca = cos(ang), sa = sin(ang);
          vec2 rotated = mat2(ca, sa, -sa, ca) * position.xy;

          vec4 mvPosition = modelViewMatrix * vec4(worldPos, 1.0);
          mvPosition.xy += rotated * size * vAlive;
          gl_Position = projectionMatrix * mvPosition;

          vUv = rotated * 2.0;
          vColor = iColor;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vProgress;
        varying float vAlive;
        varying float vStyle;
        varying vec2 vUv;

        // IQ's regular-hexagon SDF: negative inside, used as a hard mask (no texture).
        float hexagonSDF(vec2 p, float r) {
          vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
          p = abs(p);
          p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
          p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
          return length(p) * sign(p.y);
        }

        void main() {
          if (vAlive < 0.5) discard;
          float alpha;
          vec3 col = vColor;

          if (vStyle < 0.5) {
            // Shard: crisp hexagonal chip, fading only near the very end of its flight.
            float d = hexagonSDF(vUv, 0.62);
            float mask = step(d, 0.0);
            float fade = 1.0 - smoothstep(0.6, 1.0, vProgress);
            alpha = mask * fade;
            col += vec3(1.0) * (1.0 - vProgress) * 0.4;
          } else {
            // Flash: soft bright core, gone fast — this is the "unmissable" pop at break.
            float d = length(vUv);
            float glow = 1.0 - smoothstep(0.0, 1.0, d);
            alpha = glow * glow * (1.0 - vProgress);
            col = mix(col, vec3(1.0), 0.6);
          }

          if (alpha <= 0.003) discard;
          gl_FragColor = vec4(col, alpha);
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

  spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    size: number, duration: number, colorHex: number, style: number, spawnTime: number,
  ): void {
    const i = this.cursor;
    const i3 = i * 3;
    const i4 = i * 4;
    this.origin[i3] = x; this.origin[i3 + 1] = y; this.origin[i3 + 2] = z;
    this.velocity[i3] = vx; this.velocity[i3 + 1] = vy; this.velocity[i3 + 2] = vz;
    this.color[i3] = ((colorHex >> 16) & 0xff) / 255;
    this.color[i3 + 1] = ((colorHex >> 8) & 0xff) / 255;
    this.color[i3 + 2] = (colorHex & 0xff) / 255;
    this.params[i4] = spawnTime; this.params[i4 + 1] = Math.max(duration, 0.02); this.params[i4 + 2] = size; this.params[i4 + 3] = style;
    this.seed[i] = Math.random();

    this.originAttr.addUpdateRange(i3, 3);
    this.velocityAttr.addUpdateRange(i3, 3);
    this.colorAttr.addUpdateRange(i3, 3);
    this.paramsAttr.addUpdateRange(i4, 4);
    this.seedAttr.addUpdateRange(i, 1);
    this.originAttr.needsUpdate = true;
    this.velocityAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.paramsAttr.needsUpdate = true;
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
/* Shield shell shader                                                                          */
/* ------------------------------------------------------------------------------------------ */

const SHELL_VERTEX = /* glsl */ `
varying vec3 vObjDir;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

void main() {
  // Base geometry is a unit sphere, so the object-space position IS the surface direction —
  // no per-vertex normalization-by-radius needed regardless of how the mesh is scaled.
  vObjDir = normalize(position);
  vWorldNormal = normalize(mat3(modelMatrix) * normal);
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const SHELL_FRAGMENT = /* glsl */ `
uniform float uFraction;
uniform vec3 uColor;
uniform float uTime;
uniform vec3 uRippleDir[${RIPPLE_SLOTS}];
uniform float uRippleStart[${RIPPLE_SLOTS}];
uniform float uRippleStrength[${RIPPLE_SLOTS}];

varying vec3 vObjDir;
varying vec3 vWorldNormal;
varying vec3 vWorldPos;

// Cube-face projection of a unit direction onto a 2D plane, so a flat hex grid can be laid over
// a sphere without a texture. Produces seams at the cube edges, which reads as panel joins on a
// stylised energy shell rather than a flaw.
vec2 cubeUV(vec3 dir) {
  vec3 a = abs(dir);
  if (a.x >= a.y && a.x >= a.z) return dir.yz / a.x;
  if (a.y >= a.x && a.y >= a.z) return dir.xz / a.y;
  return dir.xy / a.z;
}

// Analytic hex-grid distance field (two offset triangular grids, nearest wins), then the
// standard hex metric from the nearest cell centre. No texture lookups anywhere.
const vec2 HEX_S = vec2(1.0, 1.7320508);
vec2 hexCell(vec2 uv) {
  vec2 p1 = mod(uv, HEX_S) - HEX_S * 0.5;
  vec2 p2 = mod(uv - HEX_S * 0.5, HEX_S) - HEX_S * 0.5;
  return dot(p1, p1) < dot(p2, p2) ? p1 : p2;
}
float hexEdgeDist(vec2 p) {
  vec2 a = abs(p);
  float c = dot(a, normalize(HEX_S));
  return max(c, a.x);
}

float rippleContribution(vec3 dir, int i) {
  float strength = uRippleStrength[i];
  if (strength <= 0.0) return 0.0;
  float age = uTime - uRippleStart[i];
  if (age < 0.0 || age > 2.2) return 0.0;
  float angle = acos(clamp(dot(dir, uRippleDir[i]), -1.0, 1.0));
  // A decaying sine ring expanding out from the impact point across the sphere's surface.
  float wave = sin(angle * 11.0 - age * 15.0) * 0.5 + 0.5;
  float decay = exp(-age * 3.2);
  float front = 1.0 - smoothstep(0.0, 0.5, abs(angle - age * 3.6));
  return wave * decay * strength * (0.35 + 0.65 * front);
}

void main() {
  if (uFraction <= 0.0) discard;

  vec2 uv = cubeUV(vObjDir) * 6.0;
  float hd = hexEdgeDist(hexCell(uv));
  float hexLine = 1.0 - smoothstep(0.4, 0.5, hd);
  float hexFill = smoothstep(0.0, 0.5, hd) * 0.12;

  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float ndotv = clamp(dot(viewDir, normalize(vWorldNormal)), 0.0, 1.0);
  float fresnel = pow(1.0 - ndotv, 2.5);

  float ripple = 0.0;
  for (int i = 0; i < ${RIPPLE_SLOTS}; i++) ripple += rippleContribution(vObjDir, i);
  ripple = clamp(ripple, 0.0, 1.5);

  // Nearly transparent face-on (fresnel ~ 0 dominates the base term), brightening hard at
  // grazing angles — the shell must never obscure the fight when the player looks straight at
  // an enemy, only read as a presence at its silhouette.
  float base = hexFill + hexLine * 0.7;
  float alpha = clamp((base * 0.3 + fresnel * 0.65) * uFraction + ripple * 0.55, 0.0, 1.0);
  if (alpha <= 0.003) discard;

  vec3 col = uColor * (0.5 + fresnel * 1.3 + hexLine * 0.7) + vec3(1.0) * ripple * 0.5;
  gl_FragColor = vec4(col, alpha);
}
`;

/* ------------------------------------------------------------------------------------------ */
/* ShieldFX                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export class ShieldFX {
  private readonly slots: ShieldSlot[];
  private readonly sharedGeometry: THREE.SphereGeometry;
  private readonly breaks: BreakPool;
  private elapsed = 0;

  constructor(scene: THREE.Scene, maxShields: number) {
    // One unit-radius sphere shared by every shield; per-shield size comes from mesh.scale, so
    // acquiring a shield never builds geometry.
    this.sharedGeometry = new THREE.SphereGeometry(1, 32, 24);
    this.slots = new Array(maxShields);

    for (let i = 0; i < maxShields; i++) {
      const material = new THREE.ShaderMaterial({
        uniforms: {
          uFraction: { value: 0 },
          uColor: { value: new THREE.Color(0xffffff) },
          uTime: { value: 0 },
          uRippleDir: { value: this.makeRippleDirArray() },
          uRippleStart: { value: new Float32Array(RIPPLE_SLOTS).fill(-1000) },
          uRippleStrength: { value: new Float32Array(RIPPLE_SLOTS) },
        },
        vertexShader: SHELL_VERTEX,
        fragmentShader: SHELL_FRAGMENT,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.FrontSide,
      });
      const mesh = new THREE.Mesh(this.sharedGeometry, material);
      mesh.visible = false;
      mesh.matrixAutoUpdate = true;
      scene.add(mesh);

      this.slots[i] = { active: false, mesh, material, radius: 1, colorHex: 0xffffff, rippleCursor: 0 };
    }

    this.breaks = new BreakPool(BREAK_POOL_CAPACITY);
    scene.add(this.breaks.mesh);
  }

  private makeRippleDirArray(): THREE.Vector3[] {
    const arr = new Array<THREE.Vector3>(RIPPLE_SLOTS);
    for (let i = 0; i < RIPPLE_SLOTS; i++) arr[i] = new THREE.Vector3(0, 1, 0);
    return arr;
  }

  acquire(radius: number, colorHex: number): number {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      if (!slot.active) {
        slot.active = true;
        slot.radius = radius;
        slot.colorHex = colorHex;
        slot.rippleCursor = 0;
        slot.mesh.scale.setScalar(radius);
        (slot.material.uniforms['uColor'] as { value: THREE.Color }).value.setHex(colorHex);
        (slot.material.uniforms['uFraction'] as { value: number }).value = 0;
        const starts = (slot.material.uniforms['uRippleStart'] as { value: Float32Array }).value;
        const strengths = (slot.material.uniforms['uRippleStrength'] as { value: Float32Array }).value;
        starts.fill(-1000);
        strengths.fill(0);
        slot.mesh.visible = false;
        return i;
      }
    }
    return -1;
  }

  /** 0..1 shield fraction drives visibility; 0 hides the shell entirely. */
  setState(handle: number, x: number, y: number, z: number, fraction: number): void {
    const slot = this.slots[handle];
    if (!slot || !slot.active) return;
    slot.mesh.position.set(x, y, z);
    const f = clamp01(fraction);
    (slot.material.uniforms['uFraction'] as { value: number }).value = f;
    slot.mesh.visible = f > 0;
  }

  /** Ripple emanating from a world-space impact point. */
  ripple(handle: number, x: number, y: number, z: number, strength: number): void {
    const slot = this.slots[handle];
    if (!slot || !slot.active) return;

    scratchDir.set(x - slot.mesh.position.x, y - slot.mesh.position.y, z - slot.mesh.position.z);
    if (scratchDir.lengthSq() < 1e-8) scratchDir.set(0, 1, 0);
    else scratchDir.normalize();

    const i = slot.rippleCursor;
    slot.rippleCursor = (slot.rippleCursor + 1) % RIPPLE_SLOTS;

    const dirs = (slot.material.uniforms['uRippleDir'] as { value: THREE.Vector3[] }).value;
    const starts = (slot.material.uniforms['uRippleStart'] as { value: Float32Array }).value;
    const strengths = (slot.material.uniforms['uRippleStrength'] as { value: Float32Array }).value;
    dirs[i]!.copy(scratchDir);
    starts[i] = this.elapsed;
    strengths[i] = strength;
  }

  /** Hexagonal shell shatters outward — must be unmissable (DESIGN §12). */
  breakShield(handle: number, x: number, y: number, z: number): void {
    const slot = this.slots[handle];
    if (!slot || !slot.active) return;

    slot.mesh.visible = false;
    (slot.material.uniforms['uFraction'] as { value: number }).value = 0;

    this.breaks.spawn(x, y, z, 0, 0, 0, slot.radius * 2.2, BREAK_FLASH_LIFE, slot.colorHex, STYLE_FLASH, this.elapsed);

    for (let i = 0; i < SHARDS_PER_BREAK; i++) {
      // Uniform random point on the unit sphere via rejection-free trig, cosmetic randomness
      // only — this never needs to be seed-reproducible.
      const u = Math.random() * 2 - 1;
      const theta = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const dx = r * Math.cos(theta);
      const dy = u;
      const dz = r * Math.sin(theta);
      const speed = BREAK_SHARD_SPEED * (0.6 + Math.random() * 0.8);
      const size = slot.radius * (0.12 + Math.random() * 0.1);
      this.breaks.spawn(
        x, y, z,
        dx * speed, dy * speed, dz * speed,
        size, BREAK_SHARD_LIFE * (0.7 + Math.random() * 0.5), slot.colorHex, STYLE_SHARD, this.elapsed,
      );
    }
  }

  release(handle: number): void {
    const slot = this.slots[handle];
    if (!slot) return;
    slot.active = false;
    slot.mesh.visible = false;
    (slot.material.uniforms['uFraction'] as { value: number }).value = 0;
  }

  update(elapsed: number, _dt: number): void {
    this.elapsed = elapsed;
    for (const slot of this.slots) {
      (slot.material.uniforms['uTime'] as { value: number }).value = elapsed;
    }
    this.breaks.flush(elapsed);
  }

  reset(): void {
    for (const slot of this.slots) {
      slot.active = false;
      slot.mesh.visible = false;
      (slot.material.uniforms['uFraction'] as { value: number }).value = 0;
      const starts = (slot.material.uniforms['uRippleStart'] as { value: Float32Array }).value;
      const strengths = (slot.material.uniforms['uRippleStrength'] as { value: Float32Array }).value;
      starts.fill(-1000);
      strengths.fill(0);
    }
    this.breaks.reset();
  }

  dispose(): void {
    for (const slot of this.slots) {
      slot.mesh.parent?.remove(slot.mesh);
      slot.material.dispose();
    }
    this.sharedGeometry.dispose();
    this.breaks.mesh.parent?.remove(this.breaks.mesh);
    this.breaks.dispose();
  }
}
