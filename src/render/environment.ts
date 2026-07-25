/**
 * Procedural image-based lighting.
 *
 * Why this exists: the ship hulls are `MeshStandardMaterial` with metalness ~0.85, and a
 * metal's diffuse response is essentially zero — nearly all of its visible colour comes from
 * *reflected environment*. With `scene.environment` unset, three.js has nothing for them to
 * reflect and physically-correct metal renders almost black. Adding direct lights barely
 * helps; it only produces small specular hotspots.
 *
 * So we build an environment here: a small scene of coloured emissive shapes, prefiltered
 * through PMREMGenerator into a mip-chained cube map. The ships then pick up a cool key from
 * "above", a warm bounce from "below", and nebula tint at the horizon — which is what makes
 * the panelling read as machined metal instead of flat plastic.
 *
 * Cost is one prefilter pass at load. Nothing here runs per frame.
 */

import * as THREE from 'three';
import { palette } from './palette';

let cachedTexture: THREE.Texture | null = null;

/**
 * Builds (and caches) the environment map. Assign the result to `scene.environment`.
 *
 * @param renderer needed by PMREMGenerator to run the prefilter passes.
 */
export function getEnvironmentMap(renderer: THREE.WebGLRenderer): THREE.Texture {
  if (cachedTexture) return cachedTexture;

  const p = palette();
  const source = new THREE.Scene();

  // A large inverted sphere provides the ambient gradient: deep blue overhead falling to a
  // warmer, darker floor. Vertex colours keep it to one cheap material.
  const shellGeo = new THREE.SphereGeometry(50, 24, 16);
  const colors = new Float32Array(shellGeo.attributes.position!.count * 3);
  const pos = shellGeo.attributes.position!;
  const top = new THREE.Color(p.nebulaA).multiplyScalar(1.4);
  const bottom = new THREE.Color(p.nebulaB).multiplyScalar(0.55);
  const horizon = new THREE.Color(p.arenaBoundary).multiplyScalar(0.9);
  const mixed = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 50; // -1..1
    if (y >= 0) mixed.copy(horizon).lerp(top, y);
    else mixed.copy(horizon).lerp(bottom, -y);
    colors[i * 3] = mixed.r;
    colors[i * 3 + 1] = mixed.g;
    colors[i * 3 + 2] = mixed.b;
  }
  shellGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const shell = new THREE.Mesh(
    shellGeo,
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide }),
  );
  source.add(shell);

  // A bright key panel. This is what produces the long specular sweep along the fuselage as
  // the ship rolls — the single biggest contributor to the hull reading as metal.
  const key = new THREE.Mesh(
    new THREE.PlaneGeometry(34, 34),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  key.position.set(10, 26, 12);
  key.lookAt(0, 0, 0);
  source.add(key);

  // A cooler, softer rim from behind-left, so silhouettes stay separated against the backdrop.
  const rim = new THREE.Mesh(
    new THREE.PlaneGeometry(26, 14),
    new THREE.MeshBasicMaterial({ color: p.playerAccent }),
  );
  rim.position.set(-22, 6, -18);
  rim.lookAt(0, 0, 0);
  source.add(rim);

  // A second, dimmer rim from behind-right in a neutral cool white. One-sided rim lighting reads
  // fine while a ship banks toward the accent-coloured side, but leaves the opposite flank with
  // no separating edge at all once it rolls away; this closes that gap without competing with
  // the primary (coloured, brighter) rim for attention.
  const rimOpposite = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 13),
    new THREE.MeshBasicMaterial({ color: 0xbfd4e6 }),
  );
  rimOpposite.position.set(20, 4, -20);
  rimOpposite.lookAt(0, 0, 0);
  source.add(rimOpposite);

  // A dim warm bounce from below keeps undersides from going pure black.
  const bounce = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshBasicMaterial({ color: 0x4a3520 }),
  );
  bounce.position.set(0, -24, 0);
  bounce.lookAt(0, 0, 0);
  source.add(bounce);

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const target = pmrem.fromScene(source, 0.04);
  cachedTexture = target.texture;

  // The source scene has done its job; release it so nothing lingers on the GPU.
  pmrem.dispose();
  shellGeo.dispose();
  (shell.material as THREE.Material).dispose();
  for (const mesh of [key, rim, rimOpposite, bounce]) {
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }

  return cachedTexture;
}

/** Applies the environment to a scene at a sensible intensity for the game's look. */
export function applyEnvironment(scene: THREE.Scene, renderer: THREE.WebGLRenderer): void {
  scene.environment = getEnvironmentMap(renderer);
  // Below ~0.6 the hulls go muddy; above ~1.2 they wash out and stop reading as dark military
  // hardware. This sits where panel lines still catch light but the ship stays a silhouette.
  // Nudged up slightly from 0.85 alongside the second rim light so the extra edge definition
  // actually registers instead of getting lost in the same overall exposure.
  scene.environmentIntensity = 0.92;
}

export function disposeEnvironment(): void {
  cachedTexture?.dispose();
  cachedTexture = null;
}
