/**
 * The deep-space backdrop: a nebula skybox plus three parallax star layers.
 *
 * Nothing here is gameplay-relevant — its only job is to sell scale and motion without
 * dragging the eye away from the fight (DESIGN §3, §13). That drives every choice below:
 * low-frequency low-contrast nebula noise, dim/desaturated relative to projectile and
 * telegraph colours, and a hard cap on draw calls so it never eats into the render budget
 * (DESIGN §16.1 — render budget is 7ms for *everything* on screen).
 *
 * Both the nebula sphere and the star field are recentred on the camera every frame so the
 * player can never fly "out" of the sky; parallax is faked per-layer by only partially
 * following the camera, which is what actually sells depth despite everything being an
 * infinite backdrop.
 */

import * as THREE from 'three';
import { Rng } from '../core/rng';
import { palette, color } from './palette';
import { clamp01, damp, randomOnSphere, scratchColorA, scratchColorB } from '../core/math';

/** Seconds for a sector recolour to fully cross-fade. DESIGN §6 sector identity, not a snap. */
const FADE_DURATION = 1.5;

/** World-space radius of the nebula backdrop sphere. Comfortably inside CAMERA.far. */
const NEBULA_RADIUS = 4000;

/**
 * Three parallax layers, far to near. `parallax` is how much of the camera's motion the
 * layer tracks: near 1 means the layer follows the camera almost exactly (so it barely
 * shifts on screen — reads as infinitely far away); lower values let the layer lag behind,
 * which is what produces the illusion that it is closer to the player.
 */
const STAR_LAYERS = [
  { count: 2600, radius: 3200, parallax: 0.995, size: [0.6, 1.6] as const, brightness: [0.2, 0.5] as const },
  { count: 1500, radius: 2200, parallax: 0.9, size: [1.2, 2.4] as const, brightness: [0.35, 0.7] as const },
  { count: 700, radius: 1300, parallax: 0.72, size: [2.0, 3.6] as const, brightness: [0.55, 1.0] as const },
] as const;

const TOTAL_STARS = STAR_LAYERS.reduce((sum, l) => sum + l.count, 0);

/* GLSL --------------------------------------------------------------------------------------- */

// Hash-based 3D value noise + fbm. Deliberately cheap (no gradient noise, no permutation
// textures) — the nebula is a dim, low-frequency backdrop, not a shading showpiece.
const NOISE_GLSL = /* glsl */ `
  float hash31(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  float valueNoise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash31(i + vec3(0.0, 0.0, 0.0));
    float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
    float nx00 = mix(n000, n100, f.x);
    float nx10 = mix(n010, n110, f.x);
    float nx01 = mix(n001, n101, f.x);
    float nx11 = mix(n011, n111, f.x);
    float nxy0 = mix(nx00, nx10, f.y);
    float nxy1 = mix(nx01, nx11, f.y);
    return mix(nxy0, nxy1, f.z);
  }

  float fbm(vec3 p) {
    float sum = 0.0;
    float amp = 0.5;
    float freq = 1.0;
    for (int i = 0; i < 4; i++) {
      sum += amp * valueNoise3(p * freq);
      freq *= 2.03;
      amp *= 0.5;
    }
    return sum;
  }
`;

const NEBULA_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    // BackSide sphere centred on the camera: local position doubles as world direction.
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const NEBULA_FRAGMENT = /* glsl */ `
  varying vec3 vDir;
  uniform float uTime;
  uniform vec3 uColorA0;
  uniform vec3 uColorA1;
  uniform vec3 uColorB0;
  uniform vec3 uColorB1;
  uniform float uFade;
  uniform float uDim;

  ${NOISE_GLSL}

  void main() {
    // Low frequency, slow drift — this is dressing, never a feature (DESIGN §3).
    vec3 p = vDir * 1.4 + vec3(uTime * 0.006, uTime * 0.004, -uTime * 0.005);
    float n = fbm(p);
    float n2 = fbm(p * 2.3 + 11.0);
    // GLSL has no clamp01 — that is a TypeScript helper. Use the built-in three-arg clamp.
    float mixT = clamp(n * 0.7 + n2 * 0.3, 0.0, 1.0);

    vec3 colorA = mix(uColorA0, uColorA1, uFade);
    vec3 colorB = mix(uColorB0, uColorB1, uFade);
    vec3 col = mix(colorA, colorB, mixT);

    // Compressed brightness keeps contrast low so the nebula reads as atmosphere, not signal.
    float brightness = (0.28 + 0.22 * mixT) * uDim;
    gl_FragColor = vec4(col * brightness, 1.0);
  }
`;

const STAR_VERTEX = /* glsl */ `
  attribute float aSize;
  attribute float aBrightness;
  attribute float aPhase;
  attribute float aTemp;
  attribute float aParallax;

  uniform vec3 uCameraPos;
  uniform float uTime;
  uniform float uDim;
  uniform vec3 uStarTint;

  varying float vAlpha;
  varying vec3 vColor;

  // Rough black-body ramp: cool red -> orange -> white -> blue-white.
  vec3 tempColor(float t) {
    vec3 red = vec3(1.0, 0.4, 0.28);
    vec3 orange = vec3(1.0, 0.78, 0.5);
    vec3 white = vec3(1.0, 1.0, 1.0);
    vec3 blue = vec3(0.68, 0.78, 1.0);
    vec3 c = mix(red, orange, clamp(t / 0.33, 0.0, 1.0));
    c = mix(c, white, clamp((t - 0.33) / 0.33, 0.0, 1.0));
    c = mix(c, blue, clamp((t - 0.66) / 0.34, 0.0, 1.0));
    return c;
  }

  void main() {
    // Parallax lives entirely in the vertex shader: a star's world position is its fixed
    // offset on the layer's shell plus a fraction of the camera's position. Distant stars
    // (aParallax near 1) track the camera almost fully and barely move; near stars lag
    // behind and visibly drift, which is what sells depth. This needs one uniform update
    // per frame and zero attribute re-uploads.
    vec3 worldPos = position + uCameraPos * aParallax;
    vec4 mv = modelViewMatrix * vec4(worldPos, 1.0);

    float twinkle = 0.6 + 0.4 * sin(uTime * (1.2 + aPhase * 1.7) + aPhase * 6.2831853);
    vAlpha = aBrightness * twinkle * uDim;
    vColor = tempColor(aTemp) * uStarTint;

    gl_PointSize = aSize * (320.0 / max(-mv.z, 1.0));
    gl_Position = projectionMatrix * mv;
  }
`;

const STAR_FRAGMENT = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv);
    if (d > 0.5) discard;
    float edge = smoothstep(0.5, 0.1, d);
    gl_FragColor = vec4(vColor, edge * vAlpha);
  }
`;

/**
 * Derives the two sector nebula colours from the palette's single nebulaA/nebulaB pair.
 * The palette contract deliberately exposes only one pair (it is the single source of
 * truth for colour); sector identity comes from a fixed, deterministic HSL transform of
 * that pair rather than inventing new hex values per sector.
 */
function sectorNebulaColors(sector: number): [THREE.Color, THREE.Color] {
  const p = palette();
  const a = color(p.nebulaA).clone();
  const b = color(p.nebulaB).clone();
  switch (sector) {
    case 1: // Ion Storm — colder and more saturated, an electrical storm overhead.
      a.offsetHSL(0.06, 0.12, 0.02);
      b.offsetHSL(-0.05, 0.15, 0.04);
      break;
    case 2: // The Maw — darker and pushed toward the lethal-telegraph red.
      a.offsetHSL(-0.08, 0.05, -0.06);
      b.offsetHSL(0.03, 0.1, -0.04);
      break;
    default: // Debris Belt — the base palette, unaltered.
      break;
  }
  return [a, b];
}

export class Starfield {
  private readonly scene: THREE.Scene;

  private readonly nebulaMesh: THREE.Mesh;
  private readonly nebulaMaterial: THREE.ShaderMaterial;

  private readonly starPoints: THREE.Points;
  private readonly starGeometry: THREE.BufferGeometry;
  private readonly starMaterial: THREE.ShaderMaterial;

  private currentSector = 0;
  private fadeElapsed = FADE_DURATION;

  private dimCurrent = 1;
  private dimTarget = 1;

  constructor(scene: THREE.Scene, seed: number) {
    this.scene = scene;
    const rng = new Rng(seed);

    const nebulaGeometry = new THREE.SphereGeometry(NEBULA_RADIUS, 24, 16);
    const baseA = color(palette().nebulaA);
    const baseB = color(palette().nebulaB);
    this.nebulaMaterial = new THREE.ShaderMaterial({
      vertexShader: NEBULA_VERTEX,
      fragmentShader: NEBULA_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uColorA0: { value: baseA.clone() },
        uColorA1: { value: baseA.clone() },
        uColorB0: { value: baseB.clone() },
        uColorB1: { value: baseB.clone() },
        uFade: { value: 1 },
        uDim: { value: 1 },
      },
    });
    this.nebulaMesh = new THREE.Mesh(nebulaGeometry, this.nebulaMaterial);
    this.nebulaMesh.frustumCulled = false;
    this.nebulaMesh.renderOrder = -2;
    scene.add(this.nebulaMesh);

    this.starGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(TOTAL_STARS * 3);
    const sizes = new Float32Array(TOTAL_STARS);
    const brightness = new Float32Array(TOTAL_STARS);
    const phases = new Float32Array(TOTAL_STARS);
    const temps = new Float32Array(TOTAL_STARS);
    const parallax = new Float32Array(TOTAL_STARS);

    const p = new THREE.Vector3();
    const rand = () => rng.next();
    let cursor = 0;
    for (const layer of STAR_LAYERS) {
      for (let i = 0; i < layer.count; i++) {
        randomOnSphere(p, rand);
        p.multiplyScalar(layer.radius);
        positions[cursor * 3] = p.x;
        positions[cursor * 3 + 1] = p.y;
        positions[cursor * 3 + 2] = p.z;
        sizes[cursor] = rng.range(layer.size[0], layer.size[1]);
        brightness[cursor] = rng.range(layer.brightness[0], layer.brightness[1]);
        phases[cursor] = rng.next();
        // Skew slightly toward the hot end — a real sky reads mostly white/blue with a
        // scattering of warm giants, not an even split.
        temps[cursor] = Math.pow(rng.next(), 1.3);
        parallax[cursor] = layer.parallax;
        cursor++;
      }
    }

    this.starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.starGeometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    this.starGeometry.setAttribute('aBrightness', new THREE.BufferAttribute(brightness, 1));
    this.starGeometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    this.starGeometry.setAttribute('aTemp', new THREE.BufferAttribute(temps, 1));
    this.starGeometry.setAttribute('aParallax', new THREE.BufferAttribute(parallax, 1));
    // The shader recentres every star on the camera itself; the geometry's own bounds are
    // meaningless (and would otherwise get the whole field frustum-culled away).
    this.starGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    this.starMaterial = new THREE.ShaderMaterial({
      vertexShader: STAR_VERTEX,
      fragmentShader: STAR_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uCameraPos: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uDim: { value: 1 },
        uStarTint: { value: color(palette().starTint).clone() },
      },
    });
    this.starPoints = new THREE.Points(this.starGeometry, this.starMaterial);
    this.starPoints.frustumCulled = false;
    this.starPoints.renderOrder = -1;
    scene.add(this.starPoints);
  }

  update(cameraPos: THREE.Vector3, elapsed: number, rawDt: number): void {
    // The whole backdrop is recentred on the camera so the player can never fly "out" of it.
    this.nebulaMesh.position.copy(cameraPos);

    const nebulaU = this.nebulaMaterial.uniforms;
    nebulaU.uTime.value = elapsed;
    if (this.fadeElapsed < FADE_DURATION) {
      this.fadeElapsed += rawDt;
      nebulaU.uFade.value = clamp01(this.fadeElapsed / FADE_DURATION);
    }

    // Dimming (boss intros) and the sector fade both use rawDt: neither should stall or
    // speed up under hit-stop/slow-mo, they are presentation, not simulation.
    this.dimCurrent = damp(this.dimCurrent, this.dimTarget, 0.0001, rawDt);
    nebulaU.uDim.value = this.dimCurrent;

    const starU = this.starMaterial.uniforms;
    (starU.uCameraPos.value as THREE.Vector3).copy(cameraPos);
    starU.uTime.value = elapsed;
    starU.uDim.value = this.dimCurrent;
  }

  setSector(sector: number): void {
    const clamped = sector < 0 ? 0 : sector > 2 ? 2 : sector;
    if (clamped === this.currentSector && this.fadeElapsed >= FADE_DURATION) return;
    this.currentSector = clamped;

    const u = this.nebulaMaterial.uniforms;
    const t = clamp01(this.fadeElapsed / FADE_DURATION);
    // Capture whatever colour is currently on screen as the new fade origin, so a sector
    // change mid-transition still cross-fades smoothly instead of jumping.
    scratchColorA.copy(u.uColorA0.value as THREE.Color).lerp(u.uColorA1.value as THREE.Color, t);
    scratchColorB.copy(u.uColorB0.value as THREE.Color).lerp(u.uColorB1.value as THREE.Color, t);
    (u.uColorA0.value as THREE.Color).copy(scratchColorA);
    (u.uColorB0.value as THREE.Color).copy(scratchColorB);

    const [a, b] = sectorNebulaColors(clamped);
    (u.uColorA1.value as THREE.Color).copy(a);
    (u.uColorB1.value as THREE.Color).copy(b);
    this.fadeElapsed = 0;
    u.uFade.value = 0;
  }

  setDimming(value: number): void {
    // value=0 -> full brightness; value=1 -> heavily dimmed but never fully black, so the
    // sky still reads as present behind a boss rather than vanishing.
    this.dimTarget = 1 - clamp01(value) * 0.85;
  }

  dispose(): void {
    this.scene.remove(this.nebulaMesh);
    this.nebulaMesh.geometry.dispose();
    this.nebulaMaterial.dispose();

    this.scene.remove(this.starPoints);
    this.starGeometry.dispose();
    this.starMaterial.dispose();
  }
}
