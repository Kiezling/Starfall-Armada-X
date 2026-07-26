/**
 * The bounded play space and its sector dressing.
 *
 * Answers the genre's biggest usability failure (DESIGN §2): "where am I, where is the
 * fight." The boundary shell is always present and always visible (DESIGN §13) — nearly
 * invisible at the centre, brightening as the player nears the edge — so the arena reads as
 * a soft warning rather than a wall the player discovers by colliding with it.
 *
 * Sector dressing (Debris Belt asteroids, Ion Storm EMP fronts, The Maw's gravity well) is
 * additive on top of the boundary: only the active sector's dressing is ever in the scene,
 * so idle sectors cost nothing.
 */

import * as THREE from 'three';
import { ARENA } from '../core/constants';
import { Rng } from '../core/rng';
import { palette, color, depthFogColor, DEPTH_FOG_DENSITY } from './palette';
import { SUN_COLOR, SUN_DIRECTION } from './starfield';
import {
  clamp01,
  easeInOutCubic,
  randomOnSphere,
  sweptSphereHit,
  scratchMat4A,
  scratchQuatA,
  scratchVec3A,
} from '../core/math';

/* Tunables local to arena dressing — not gameplay-critical enough to belong in constants.ts. */

const ASTEROID_COUNT = 90;
/** Debris shell keeps clear of the centre so the player always has open space to fight in. */
const ASTEROID_SHELL_MIN = 0.3;
const ASTEROID_SHELL_MAX = 0.82;
const ASTEROID_RADIUS_MIN = 9;
const ASTEROID_RADIUS_MAX = 24;
const ASTEROID_HP_MIN = 40;
const ASTEROID_HP_MAX = 95;

const EMP_FRONT_COUNT = 3;
const EMP_THICKNESS = 26;
const EMP_SPEED = 55;

const MAW_RING_INNER = 14;
const MAW_RING_OUTER = 95;

/* GLSL ----------------------------------------------------------------------------------------
 * Shared hash/noise for the asteroid deformation. Kept local to this file — arena.ts and
 * starfield.ts each own a tiny copy rather than sharing a GLSL module, since neither is in
 * the allowed-imports list for the other and the snippet is a handful of lines.
 */
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
    for (int i = 0; i < 3; i++) {
      sum += amp * valueNoise3(p * freq);
      freq *= 2.1;
      amp *= 0.5;
    }
    return sum;
  }
`;

const BOUNDARY_VERTEX = /* glsl */ `
  varying vec3 vDir;
  varying float vViewDist;
  void main() {
    // Unit sphere geometry scaled by radius each frame: local position already is direction.
    vDir = normalize(position);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    // Distance from the camera to this patch of shell, so the far side can be faded out. A
    // containment field the player can see the far wall of through has no depth at all.
    vViewDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const BOUNDARY_FRAGMENT = /* glsl */ `
  varying vec3 vDir;
  varying float vViewDist;
  uniform float uNearFade;
  uniform float uFarFade;
  uniform vec3 uPlayerDir;
  uniform float uPlayerFrac;
  uniform float uTime;
  uniform vec3 uColor;

  // Hex-cell edge distance in a projected angular UV. Visual only — not physically mapped.
  float hexLines(vec2 uv) {
    vec2 r = vec2(1.0, 1.7320508);
    vec2 h = r * 0.5;
    vec2 a = mod(uv, r) - h;
    vec2 b = mod(uv + h, r) - h;
    vec2 gv = dot(a, a) < dot(b, b) ? a : b;
    // The hexagon metric has to match the orientation of the lattice above. Weighting x by
    // 0.866 and y by 0.5 (and clamping against |y|) describes a flat-top hexagon, which is
    // 90 degrees off this pointy-top lattice; the mismatched level set does not tile and the
    // shell drew a field of triangles instead of a hex grid.
    vec2 p = abs(gv);
    float hexDist = max(p.x * 0.5 + p.y * 0.8660254, p.x);
    return 1.0 - smoothstep(0.0, 0.045, abs(0.5 - hexDist));
  }

  void main() {
    // vDir arrives linearly interpolated, which traces the flat chord across each triangle
    // rather than the sphere itself. Feeding that straight into acos()/the scan term made the
    // error reset at every facet edge and flat-shaded the shell into ~150px triangles from the
    // inside. Re-normalizing here projects back onto the sphere and, because adjacent faces
    // agree along their shared edge, the pattern is continuous across the tessellation.
    vec3 dir = normalize(vDir);

    // 72 cells around the equator rather than 2*PI*12 (=75.4): an integer count means the
    // hex grid wraps cleanly across the atan() branch cut instead of leaving a seam meridian.
    // Finer cells than the eye can resolve at range are the point — the shell should read as a
    // fine mesh far away, not as a handful of huge panels right in front of the camera.
    float az = atan(dir.z, dir.x);
    float inc = acos(clamp(dir.y, -1.0, 1.0));
    vec2 uv = vec2(az * (72.0 / 6.28318531), inc * 12.0);
    float hex = hexLines(uv);

    // Overall brightness ramps with how close the player is to the edge (95%/100% per the
    // flight model's warning band), plus a tight localised glow in the player's own direction
    // so the wall reads as reacting to *you* specifically, not just a static shell.
    float edgeGlow = smoothstep(0.72, 1.0, uPlayerFrac);
    float proximity = pow(max(dot(dir, uPlayerDir), 0.0), 10.0);
    float localGlow = proximity * smoothstep(0.25, 1.0, uPlayerFrac);

    // A slow scan-line sweep so the shell reads as active tech, not a painted-on texture.
    float scan = pow(sin(dir.y * 18.0 - uTime * 1.1) * 0.5 + 0.5, 5.0);

    // Distance haze. Without this the far wall renders at the same strength as the near one,
    // which flattens the arena into a lit cage around the camera and reads as the dominant
    // object in every frame. Fading it out with distance restores the sense that the shell is
    // a *boundary* far away, and lets the ships and the sky carry the image instead.
    float depthFade = 1.0 - smoothstep(uNearFade, uFarFade, vViewDist);
    depthFade = 0.1 + depthFade * 0.9;

    // Grazing angles catch the light: the shell is a surface, and the part of it you are
    // looking along should read brighter than the part you are looking straight at.
    float facing = abs(dot(dir, normalize(uPlayerDir)));
    float graze = 0.55 + 0.45 * (1.0 - facing);

    float intensity = hex * (0.02 + edgeGlow * 0.5 + localGlow * 1.6) + scan * (0.02 + edgeGlow * 0.18);
    intensity *= depthFade * graze;
    gl_FragColor = vec4(uColor, clamp(intensity, 0.0, 1.0));
  }
`;

const ASTEROID_VERTEX = /* glsl */ `
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec3 vObjPos;
  varying float vShade;
  varying float vViewDist;

  ${NOISE_GLSL}

  // The displacement field, factored out so the normal can be re-derived from the same data.
  float rockField(vec3 p, vec3 seed) {
    return fbm(p * 1.8 + seed * 0.6) - 0.5;
  }

  void main() {
    // Every instance shares one geometry; per-instance shape variety comes entirely from
    // hashing the instance's own world translation (baked into instanceMatrix) as a noise
    // seed, so no two asteroids deform alike despite there being only one vertex buffer.
    vec3 seed = instanceMatrix[3].xyz;
    float s = hash31(seed);
    vec3 displaced = position + normal * rockField(position, seed) * 0.52;

    // Re-derive the normal from the displaced surface by finite differences along two
    // tangents. Shading with the *undisplaced* normal — as this did — is what made the field
    // read as smooth clay: the silhouette was lumpy but the shading underneath was a plain
    // sphere, so no crease or facet ever caught the light.
    vec3 t1 = normalize(abs(normal.y) < 0.9 ? cross(normal, vec3(0.0, 1.0, 0.0)) : cross(normal, vec3(1.0, 0.0, 0.0)));
    vec3 t2 = cross(normal, t1);
    float e = 0.06;
    vec3 pa = position + t1 * e;
    vec3 pb = position + t2 * e;
    vec3 da = (pa + normal * rockField(pa, seed) * 0.52) - displaced;
    vec3 db = (pb + normal * rockField(pb, seed) * 0.52) - displaced;
    vec3 objNormal = normalize(cross(da, db));
    // The cross product's winding depends on the tangent frame; align it to the sphere normal.
    objNormal *= sign(dot(objNormal, normal));

    vec4 worldPos = instanceMatrix * vec4(displaced, 1.0);
    vNormal = normalize(mat3(instanceMatrix) * objNormal);
    vWorldPos = worldPos.xyz;
    vObjPos = displaced;
    vShade = s;
    vec4 mv = modelViewMatrix * worldPos;
    vViewDist = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const ASTEROID_FRAGMENT = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec3 vObjPos;
  varying float vShade;
  varying float vViewDist;
  uniform vec3 uColor;
  uniform vec3 uLightDir;
  uniform vec3 uSunColor;
  uniform vec3 uFillColor;
  uniform vec3 uFogColor;
  uniform float uFogDensity;

  ${NOISE_GLSL}

  void main() {
    vec3 n = normalize(vNormal);
    vec3 viewDir = normalize(cameraPosition - vWorldPos);

    // Surface detail: two noise bands standing in for regolith grain and crater pitting.
    // Cheap, and it is what stops a low-poly rock reading as a matte blob up close.
    float grain = fbm(vObjPos * 9.0 + vShade * 20.0);
    float pits = smoothstep(0.62, 0.78, fbm(vObjPos * 4.2 + vShade * 7.0));

    // Key from the sun, warm; fill from the opposite side in nebula cyan, standing in for
    // bounce. Two-tone light on a grey rock is most of the difference between "asteroid" and
    // "clay ball" — a single lamp gives one falloff and nothing else.
    float ndotl = max(dot(n, uLightDir), 0.0);
    float fill = max(dot(n, -uLightDir) * 0.5 + 0.5, 0.0);
    // Wrapped diffuse: real regolith scatters well past the terminator.
    float wrapped = max((dot(n, uLightDir) + 0.35) / 1.35, 0.0);

    vec3 albedo = uColor * (0.55 + vShade * 0.3) * (0.72 + grain * 0.5);
    albedo *= 1.0 - pits * 0.45;

    vec3 lit = albedo * uSunColor * wrapped * 1.35;
    lit += albedo * uFillColor * fill * 0.28;
    lit += albedo * 0.05;

    // Rim: a thin bright edge away from the camera, so a rock stays a readable silhouette
    // against the nebula instead of dissolving into it.
    float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
    lit += mix(uFillColor, uSunColor, ndotl) * rim * 0.55;

    // A dull specular sheen on the lit side only — ice and metal in the regolith.
    vec3 h = normalize(uLightDir + viewDir);
    float spec = pow(max(dot(n, h), 0.0), 26.0) * ndotl * (0.25 + grain * 0.4);
    lit += uSunColor * spec * 0.5;

    // Depth cueing: this shader is a custom ShaderMaterial, so it does not pick up three.js's
    // automatic scene.fog application the way the ship hulls (MeshStandardMaterial) do. Blending
    // toward the same shared fog colour/density (palette.ts's depthFogColor/DEPTH_FOG_DENSITY)
    // keeps distant asteroids receding in step with everything else instead of staying crisp
    // while the rest of the arena fades.
    float fogFactor = clamp(exp(-pow(uFogDensity * vViewDist, 2.0)), 0.0, 1.0);
    lit = mix(uFogColor, lit, fogFactor);

    gl_FragColor = vec4(lit, 1.0);
  }
`;

const EMP_VERTEX = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const EMP_FRAGMENT = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uAlpha;
  void main() {
    // Rim-lit shockwave: brightest edge-on, which is exactly where a moving spherical
    // wavefront reads best against the arena, and needs no distance math in the shader.
    float fres = pow(1.0 - max(dot(normalize(vNormal), normalize(vViewDir)), 0.0), 2.4);
    float shimmer = 0.85 + 0.15 * sin(uTime * 6.0);
    vec3 col = uColor * fres * shimmer * 2.0;
    gl_FragColor = vec4(col, fres * uAlpha);
  }
`;

const MAW_VERTEX = /* glsl */ `
  varying vec2 vLocal;
  void main() {
    vLocal = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const MAW_FRAGMENT = /* glsl */ `
  varying vec2 vLocal;
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uInner;
  uniform float uOuter;
  void main() {
    float r = length(vLocal);
    float angle = atan(vLocal.y, vLocal.x);
    float spiral = sin(angle * 6.0 - r * 0.3 + uTime * 1.4) * 0.5 + 0.5;
    float fadeOuter = smoothstep(uOuter, uOuter * 0.6, r);
    float fadeInner = smoothstep(uInner, uInner * 1.8, r);
    float fade = fadeOuter * fadeInner;
    vec3 col = uColor * (0.35 + spiral * 0.75);
    gl_FragColor = vec4(col, fade * (0.3 + spiral * 0.4));
  }
`;

/** One expanding EMP shockwave. `center` is owned and mutated in place, never reassigned. */
interface EmpFront {
  readonly center: THREE.Vector3;
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  radius: number;
  readonly maxRadius: number;
}

export class Arena {
  private readonly scene: THREE.Scene;
  private readonly seed: number;

  private _radius: number = ARENA.radius;
  private shrinkFrom: number = ARENA.radius;
  private shrinkTarget: number = ARENA.radius;
  private shrinkTimer = 0;
  private shrinkDuration = 0;
  private shrinkActive = false;

  private currentSector = 0;

  /* Boundary shell — always in the scene. */
  private readonly boundaryMesh: THREE.Mesh;
  private readonly boundaryMaterial: THREE.ShaderMaterial;

  /* Debris Belt asteroid field. */
  private readonly asteroidGeometry: THREE.IcosahedronGeometry;
  private readonly asteroidMaterial: THREE.ShaderMaterial;
  private readonly asteroidMesh: THREE.InstancedMesh;
  private readonly asteroidPos: THREE.Vector3[] = [];
  private readonly asteroidRadius: Float32Array;
  private readonly asteroidHp: Float32Array;
  private readonly asteroidMaxHp: Float32Array;
  private readonly asteroidAlive: Uint8Array;

  /* Ion Storm EMP fronts. */
  private readonly empGeometry: THREE.SphereGeometry;
  private readonly empFronts: EmpFront[] = [];

  /* The Maw gravity well. */
  private readonly mawGroup: THREE.Group;
  private readonly mawMesh: THREE.Mesh;
  private readonly mawMaterial: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene, seed: number) {
    this.scene = scene;
    this.seed = seed;

    /* Boundary --------------------------------------------------------------------------- */
    const boundaryGeometry = new THREE.SphereGeometry(1, 48, 32);
    this.boundaryMaterial = new THREE.ShaderMaterial({
      vertexShader: BOUNDARY_VERTEX,
      fragmentShader: BOUNDARY_FRAGMENT,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uPlayerDir: { value: new THREE.Vector3(0, 0, 1) },
        uPlayerFrac: { value: 0 },
        uTime: { value: 0 },
        uNearFade: { value: this._radius * 0.5 },
        uFarFade: { value: this._radius * 2.0 },
        uColor: { value: color(palette().arenaBoundary).clone() },
      },
    });
    this.boundaryMesh = new THREE.Mesh(boundaryGeometry, this.boundaryMaterial);
    this.boundaryMesh.frustumCulled = false;
    this.boundaryMesh.scale.setScalar(this._radius);
    scene.add(this.boundaryMesh);

    /* Debris Belt asteroids ---------------------------------------------------------------- */
    // Detail 2 (162 vertices): enough for the displacement to carve real facets, still one
    // shared buffer across all 90 instances.
    this.asteroidGeometry = new THREE.IcosahedronGeometry(1, 2);
    this.asteroidMaterial = new THREE.ShaderMaterial({
      vertexShader: ASTEROID_VERTEX,
      fragmentShader: ASTEROID_FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0x6d6f7d) },
        // The same vector the sky draws its sun along and the scene keys its light from.
        uLightDir: { value: SUN_DIRECTION.clone() },
        uSunColor: { value: new THREE.Color(SUN_COLOR) },
        uFillColor: { value: color(palette().arenaBoundary).clone() },
        uFogColor: { value: depthFogColor().clone() },
        uFogDensity: { value: DEPTH_FOG_DENSITY },
      },
    });
    this.asteroidMesh = new THREE.InstancedMesh(this.asteroidGeometry, this.asteroidMaterial, ASTEROID_COUNT);
    this.asteroidMesh.frustumCulled = false;
    this.asteroidRadius = new Float32Array(ASTEROID_COUNT);
    this.asteroidHp = new Float32Array(ASTEROID_COUNT);
    this.asteroidMaxHp = new Float32Array(ASTEROID_COUNT);
    this.asteroidAlive = new Uint8Array(ASTEROID_COUNT);
    for (let i = 0; i < ASTEROID_COUNT; i++) this.asteroidPos.push(new THREE.Vector3());
    this.buildAsteroidField(new Rng(this.seed));

    /* Ion Storm EMP fronts ------------------------------------------------------------------ */
    this.empGeometry = new THREE.SphereGeometry(1, 32, 16);
    for (let i = 0; i < EMP_FRONT_COUNT; i++) {
      const material = new THREE.ShaderMaterial({
        vertexShader: EMP_VERTEX,
        fragmentShader: EMP_FRAGMENT,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uColor: { value: color(palette().enemyProjectile[0]!).clone() },
          uTime: { value: 0 },
          uAlpha: { value: 0 },
        },
      });
      const mesh = new THREE.Mesh(this.empGeometry, material);
      mesh.frustumCulled = false;
      const maxRadius = this._radius;
      // Stagger initial phase so the fronts don't all pulse in lockstep.
      const startRadius = -EMP_THICKNESS + (i / EMP_FRONT_COUNT) * (maxRadius + EMP_THICKNESS);
      this.empFronts.push({
        center: new THREE.Vector3(0, 0, 0),
        mesh,
        material,
        radius: startRadius,
        maxRadius,
      });
    }

    /* The Maw gravity well ------------------------------------------------------------------- */
    this.mawGroup = new THREE.Group();
    this.mawGroup.rotation.x = -Math.PI / 2;
    const mawGeometry = new THREE.RingGeometry(MAW_RING_INNER, MAW_RING_OUTER, 64, 8);
    this.mawMaterial = new THREE.ShaderMaterial({
      vertexShader: MAW_VERTEX,
      fragmentShader: MAW_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: color(palette().telegraphLethal).clone() },
        uInner: { value: MAW_RING_INNER },
        uOuter: { value: MAW_RING_OUTER },
      },
    });
    this.mawMesh = new THREE.Mesh(mawGeometry, this.mawMaterial);
    this.mawMesh.frustumCulled = false;
    this.mawGroup.add(this.mawMesh);

    this.applySectorVisibility();
  }

  get radius(): number {
    return this._radius;
  }

  setRadius(r: number): void {
    this._radius = r;
    this.shrinkActive = false;
  }

  shrinkTo(target: number, seconds: number): void {
    this.shrinkFrom = this._radius;
    this.shrinkTarget = target;
    this.shrinkTimer = 0;
    this.shrinkDuration = Math.max(seconds, 0.0001);
    this.shrinkActive = true;
  }

  update(playerPos: THREE.Vector3, elapsed: number, dt: number): void {
    if (this.shrinkActive) {
      this.shrinkTimer += dt;
      const t = clamp01(this.shrinkTimer / this.shrinkDuration);
      this._radius = this.shrinkFrom + (this.shrinkTarget - this.shrinkFrom) * easeInOutCubic(t);
      if (t >= 1) this.shrinkActive = false;
    }

    this.boundaryMesh.scale.setScalar(this._radius);
    const bu = this.boundaryMaterial.uniforms;
    bu.uTime.value = elapsed;
    // The fade band scales with the arena so a contracting Maw arena does not simply become a
    // brighter cage as its walls close in.
    bu.uNearFade.value = this._radius * 0.5;
    bu.uFarFade.value = this._radius * 2.0;
    const playerDist = playerPos.length();
    bu.uPlayerFrac.value = clamp01(playerDist / this._radius);
    if (playerDist > 0.001) {
      (bu.uPlayerDir.value as THREE.Vector3).copy(playerPos).divideScalar(playerDist);
    }

    if (this.currentSector === 0) {
      this.asteroidMaterial.uniforms.uTime.value = elapsed;
      (this.asteroidMaterial.uniforms.uFogColor.value as THREE.Color).copy(depthFogColor());
    } else if (this.currentSector === 1) {
      for (const front of this.empFronts) {
        front.radius += EMP_SPEED * dt;
        if (front.radius > front.maxRadius + EMP_THICKNESS) {
          front.radius = -EMP_THICKNESS;
        }
        front.mesh.scale.setScalar(Math.max(front.radius, 0.001));
        // Fade in from the centre and fade out as the wave washes past the boundary.
        const growIn = clamp01(front.radius / (EMP_THICKNESS * 2));
        const shrinkOut = clamp01((front.maxRadius + EMP_THICKNESS - front.radius) / (EMP_THICKNESS * 2));
        // Once the wavefront's radius passes the player, the shell fully encloses the camera:
        // every visible point reads edge-on, and the rim-lit shader washes the whole screen
        // additively instead of reading as a wave. Fading it out as the enclosure deepens keeps
        // the sweep readable (brightest right as it crosses you) instead of blinding — worst
        // near the arena centre, where the shell stays wrapped around the player for most of
        // its sweep rather than passing through quickly.
        const enclosure = clamp01((front.radius - playerDist) / EMP_THICKNESS);
        front.material.uniforms.uAlpha.value = Math.min(growIn, shrinkOut) * (1 - enclosure) * 0.9;
        front.material.uniforms.uTime.value = elapsed;
      }
    } else if (this.currentSector === 2) {
      this.mawMesh.rotation.z += dt * 0.25;
      this.mawMaterial.uniforms.uTime.value = elapsed;
    }
  }

  setSector(sector: number): void {
    const clamped = sector < 0 ? 0 : sector > 2 ? 2 : sector;
    if (clamped === this.currentSector) return;
    this.currentSector = clamped;
    this.applySectorVisibility();
  }

  get asteroidCount(): number {
    return ASTEROID_COUNT;
  }

  /** Writes the asteroid's position into `outPos`. Returns 0 (no collider) if it is dead. */
  getAsteroid(i: number, outPos: THREE.Vector3): number {
    outPos.copy(this.asteroidPos[i]!);
    return this.asteroidAlive[i] ? this.asteroidRadius[i]! : 0;
  }

  raycastAsteroids(from: THREE.Vector3, to: THREE.Vector3, radius: number): number {
    for (let i = 0; i < ASTEROID_COUNT; i++) {
      if (!this.asteroidAlive[i]) continue;
      if (sweptSphereHit(from, to, radius, this.asteroidPos[i]!, this.asteroidRadius[i]!)) return i;
    }
    return -1;
  }

  damageAsteroid(index: number, amount: number): boolean {
    if (index < 0 || index >= ASTEROID_COUNT || !this.asteroidAlive[index]) return false;
    this.asteroidHp[index]! -= amount;
    if (this.asteroidHp[index]! > 0) return false;

    this.asteroidAlive[index] = 0;
    scratchMat4A.makeScale(0, 0, 0);
    this.asteroidMesh.setMatrixAt(index, scratchMat4A);
    this.asteroidMesh.instanceMatrix.needsUpdate = true;
    return true;
  }

  isInEmpField(pos: THREE.Vector3): boolean {
    if (this.currentSector !== 1) return false;
    for (const front of this.empFronts) {
      const halfBand = EMP_THICKNESS * 0.5;
      const d = pos.distanceTo(front.center);
      if (Math.abs(d - front.radius) <= halfBand) return true;
    }
    return false;
  }

  reset(): void {
    this.shrinkActive = false;
    this._radius = ARENA.radius;
    this.shrinkFrom = ARENA.radius;
    this.shrinkTarget = ARENA.radius;

    this.buildAsteroidField(new Rng(this.seed));

    const maxRadius = this._radius;
    for (let i = 0; i < this.empFronts.length; i++) {
      const front = this.empFronts[i]!;
      front.radius = -EMP_THICKNESS + (i / EMP_FRONT_COUNT) * (maxRadius + EMP_THICKNESS);
    }

    this.mawMesh.rotation.z = 0;

    this.currentSector = 0;
    this.applySectorVisibility();
  }

  dispose(): void {
    this.scene.remove(this.boundaryMesh);
    this.boundaryMesh.geometry.dispose();
    this.boundaryMaterial.dispose();

    this.scene.remove(this.asteroidMesh);
    this.asteroidGeometry.dispose();
    this.asteroidMaterial.dispose();

    for (const front of this.empFronts) {
      this.scene.remove(front.mesh);
      front.material.dispose();
    }
    this.empGeometry.dispose();

    this.scene.remove(this.mawGroup);
    this.mawMesh.geometry.dispose();
    this.mawMaterial.dispose();
  }

  /* Internals ---------------------------------------------------------------------------- */

  private buildAsteroidField(rng: Rng): void {
    const rand = () => rng.next();
    for (let i = 0; i < ASTEROID_COUNT; i++) {
      randomOnSphere(scratchVec3A, rand);
      const shellRadius = this._radius * rng.range(ASTEROID_SHELL_MIN, ASTEROID_SHELL_MAX);
      scratchVec3A.multiplyScalar(shellRadius);
      this.asteroidPos[i]!.copy(scratchVec3A);

      const r = rng.range(ASTEROID_RADIUS_MIN, ASTEROID_RADIUS_MAX);
      this.asteroidRadius[i] = r;
      const hp = rng.range(ASTEROID_HP_MIN, ASTEROID_HP_MAX);
      this.asteroidHp[i] = hp;
      this.asteroidMaxHp[i] = hp;
      this.asteroidAlive[i] = 1;

      scratchQuatA.setFromAxisAngle(
        scratchVec3A.set(rng.signed(1), rng.signed(1), rng.signed(1)).normalize(),
        rng.range(0, Math.PI * 2),
      );
      scratchMat4A.compose(this.asteroidPos[i]!, scratchQuatA, scratchVec3A.set(r, r, r));
      this.asteroidMesh.setMatrixAt(i, scratchMat4A);
    }
    this.asteroidMesh.instanceMatrix.needsUpdate = true;
  }

  private applySectorVisibility(): void {
    if (this.currentSector === 0) {
      this.scene.add(this.asteroidMesh);
    } else {
      this.scene.remove(this.asteroidMesh);
    }

    if (this.currentSector === 1) {
      for (const front of this.empFronts) this.scene.add(front.mesh);
    } else {
      for (const front of this.empFronts) this.scene.remove(front.mesh);
    }

    if (this.currentSector === 2) {
      this.scene.add(this.mawGroup);
    } else {
      this.scene.remove(this.mawGroup);
    }
  }
}
