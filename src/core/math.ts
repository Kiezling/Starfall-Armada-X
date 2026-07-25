/**
 * Math helpers tuned for a zero-allocation game loop.
 *
 * The `scratch` vectors and quaternions at the bottom of this file exist so hot code never
 * calls `new THREE.Vector3()`. Borrow one, use it within a single synchronous block, and
 * never retain it — any function you call may reuse the same scratch.
 */

import * as THREE from 'three';

export const TAU = Math.PI * 2;
export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const EPSILON = 1e-6;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function inverseLerp(a: number, b: number, v: number): number {
  return Math.abs(b - a) < EPSILON ? 0 : (v - a) / (b - a);
}

export function remap(v: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  return lerp(outMin, outMax, inverseLerp(inMin, inMax, v));
}

/**
 * Frame-rate independent exponential approach. `smoothing` is the fraction of the remaining
 * distance still left after one second — 0.01 is snappy, 0.5 is loose.
 *
 * Prefer this over `lerp(a, b, 0.1)` in update loops: naive lerp changes behaviour with
 * frame rate, this does not.
 */
export function damp(current: number, target: number, smoothing: number, dt: number): number {
  return lerp(target, current, Math.pow(smoothing, dt));
}

export function dampVec3(
  current: THREE.Vector3,
  target: THREE.Vector3,
  smoothing: number,
  dt: number,
): THREE.Vector3 {
  const t = Math.pow(smoothing, dt);
  current.x = target.x + (current.x - target.x) * t;
  current.y = target.y + (current.y - target.y) * t;
  current.z = target.z + (current.z - target.z) * t;
  return current;
}

/**
 * Critically damped spring toward a target. Produces the settle-without-overshoot motion the
 * chase camera and reticle rely on. `velocity` is mutated in place and must be owned by the
 * caller across frames.
 */
export function springDamp(
  current: number,
  target: number,
  velocity: { value: number },
  smoothTime: number,
  dt: number,
  maxSpeed = Infinity,
): number {
  const omega = 2 / Math.max(smoothTime, 0.0001);
  const x = omega * dt;
  // Padé approximation of exp(-x); cheaper and stable for the range we use.
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  let change = current - target;
  const maxChange = maxSpeed * smoothTime;
  change = clamp(change, -maxChange, maxChange);
  const temp = (velocity.value + omega * change) * dt;
  velocity.value = (velocity.value - omega * temp) * exp;
  return target + (change + temp) * exp;
}

/** Moves `current` toward `target` by at most `maxDelta`. */
export function moveTowards(current: number, target: number, maxDelta: number): number {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

/** Shortest signed angular difference, in radians, wrapped to [-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/* Easing ------------------------------------------------------------------------------------ */

export function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

export function easeInQuad(t: number): number {
  return t * t;
}

export function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

export function easeOutElastic(t: number): number {
  if (t === 0 || t === 1) return t;
  const c4 = TAU / 3;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
}

export function pulse(t: number, frequency: number): number {
  return 0.5 + 0.5 * Math.sin(t * TAU * frequency);
}

/* Geometry ---------------------------------------------------------------------------------- */

/**
 * First-order intercept solution: where to aim to hit a target moving at constant velocity.
 * Writes the aim point into `out`. Returns false when no positive-time solution exists, in
 * which case `out` is set to the target's current position.
 */
export function leadTarget(
  out: THREE.Vector3,
  shooterPos: THREE.Vector3,
  targetPos: THREE.Vector3,
  targetVel: THREE.Vector3,
  projectileSpeed: number,
): boolean {
  const rx = targetPos.x - shooterPos.x;
  const ry = targetPos.y - shooterPos.y;
  const rz = targetPos.z - shooterPos.z;

  const a = targetVel.lengthSq() - projectileSpeed * projectileSpeed;
  const b = 2 * (rx * targetVel.x + ry * targetVel.y + rz * targetVel.z);
  const c = rx * rx + ry * ry + rz * rz;

  let t = -1;
  if (Math.abs(a) < EPSILON) {
    if (Math.abs(b) > EPSILON) t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t1 = (-b + sq) / (2 * a);
      const t2 = (-b - sq) / (2 * a);
      // Smallest strictly positive root.
      if (t1 > 0 && t2 > 0) t = Math.min(t1, t2);
      else t = Math.max(t1, t2);
    }
  }

  if (t <= 0 || !Number.isFinite(t)) {
    out.copy(targetPos);
    return false;
  }
  out.set(targetPos.x + targetVel.x * t, targetPos.y + targetVel.y * t, targetPos.z + targetVel.z * t);
  return true;
}

/** Squared distance between two vectors, without the sqrt. */
export function distSq(a: THREE.Vector3, b: THREE.Vector3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Swept sphere-vs-sphere test for fast projectiles: treats the projectile as a capsule from
 * `prev` to `curr`. Returns true on overlap. This is what stops bullets tunnelling through
 * small enemies at high speed.
 */
export function sweptSphereHit(
  prev: THREE.Vector3,
  curr: THREE.Vector3,
  projRadius: number,
  target: THREE.Vector3,
  targetRadius: number,
): boolean {
  const sum = projRadius + targetRadius;
  const sumSq = sum * sum;

  const dx = curr.x - prev.x;
  const dy = curr.y - prev.y;
  const dz = curr.z - prev.z;
  const segLenSq = dx * dx + dy * dy + dz * dz;

  if (segLenSq < EPSILON) return distSq(curr, target) <= sumSq;

  const px = target.x - prev.x;
  const py = target.y - prev.y;
  const pz = target.z - prev.z;
  let t = (px * dx + py * dy + pz * dz) / segLenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;

  const cx = prev.x + dx * t - target.x;
  const cy = prev.y + dy * t - target.y;
  const cz = prev.z + dz * t - target.z;
  return cx * cx + cy * cy + cz * cz <= sumSq;
}

/**
 * True when `point` lies inside a cone originating at `apex` with the given axis and
 * half-angle. Used for the Bulwark's frontal armour arc and for scatter weapons.
 */
export function inCone(
  apex: THREE.Vector3,
  axis: THREE.Vector3,
  halfAngle: number,
  point: THREE.Vector3,
): boolean {
  const dx = point.x - apex.x;
  const dy = point.y - apex.y;
  const dz = point.z - apex.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < EPSILON) return true;
  const dot = (dx * axis.x + dy * axis.y + dz * axis.z) / len;
  return dot >= Math.cos(halfAngle);
}

/**
 * Writes a uniformly distributed point on the unit sphere into `out`, using the supplied
 * random source so results stay seed-reproducible.
 */
export function randomOnSphere(out: THREE.Vector3, random: () => number): THREE.Vector3 {
  const u = random() * 2 - 1;
  const theta = random() * TAU;
  const r = Math.sqrt(1 - u * u);
  out.set(r * Math.cos(theta), u, r * Math.sin(theta));
  return out;
}

/** Writes a random point inside the unit sphere into `out`. */
export function randomInSphere(out: THREE.Vector3, random: () => number): THREE.Vector3 {
  randomOnSphere(out, random);
  return out.multiplyScalar(Math.cbrt(random()));
}

/**
 * Perturbs `dir` by up to `spreadRadians` on the cone around it, uniformly over the cone's
 * cap. Mutates and returns `dir`.
 *
 * Uses `scratchVec3E`, `scratchQuatA` and `scratchQuatB` — do not pass those as `dir`.
 */
export function applySpread(dir: THREE.Vector3, spreadRadians: number, random: () => number): THREE.Vector3 {
  if (spreadRadians <= 0) return dir;
  dir.normalize();

  // Build any axis perpendicular to dir...
  const perp = scratchVec3E;
  if (Math.abs(dir.y) < 0.9) perp.set(0, 1, 0);
  else perp.set(1, 0, 0);
  perp.cross(dir).normalize();

  // ...then spin it around dir so the deviation direction is uniformly random.
  scratchQuatA.setFromAxisAngle(dir, random() * TAU);
  perp.applyQuaternion(scratchQuatA);

  // sqrt keeps the distribution uniform over the cap rather than clustered at the centre.
  const angle = spreadRadians * Math.sqrt(random());
  scratchQuatB.setFromAxisAngle(perp, angle);
  return dir.applyQuaternion(scratchQuatB).normalize();
}

/* Scratch pool ------------------------------------------------------------------------------ */
/*
 * Borrowed, never retained. Named rather than indexed so a reader can see at a glance whether
 * two nested calls might collide on the same instance.
 */

export const scratchVec3A = /*#__PURE__*/ new THREE.Vector3();
export const scratchVec3B = /*#__PURE__*/ new THREE.Vector3();
export const scratchVec3C = /*#__PURE__*/ new THREE.Vector3();
export const scratchVec3D = /*#__PURE__*/ new THREE.Vector3();
export const scratchVec3E = /*#__PURE__*/ new THREE.Vector3();
export const scratchVec3F = /*#__PURE__*/ new THREE.Vector3();

export const scratchQuatA = /*#__PURE__*/ new THREE.Quaternion();
export const scratchQuatB = /*#__PURE__*/ new THREE.Quaternion();

export const scratchMat4A = /*#__PURE__*/ new THREE.Matrix4();
export const scratchMat4B = /*#__PURE__*/ new THREE.Matrix4();

export const scratchColorA = /*#__PURE__*/ new THREE.Color();
export const scratchColorB = /*#__PURE__*/ new THREE.Color();

/** World up. The arena has a canonical up so auto-levelling has something to level to. */
export const WORLD_UP = /*#__PURE__*/ new THREE.Vector3(0, 1, 0);
/** Three.js convention: an unrotated object faces -Z. */
export const FORWARD = /*#__PURE__*/ new THREE.Vector3(0, 0, -1);
