/**
 * Temporary visual preview harness.
 *
 * Renders the four hulls against the real starfield so the ship geometry can be inspected
 * headlessly. Not part of the shipped game — `main.ts` points here only during development.
 */

import * as THREE from 'three';
import { RenderSystem } from './render/renderer';
import { Starfield } from './render/starfield';
import { buildShip } from './ship/geometry';
import { HULL_ORDER } from './ship/hulls';
import { palette } from './render/palette';
import { applyEnvironment } from './render/environment';

const app = document.getElementById('app')!;
const render = new RenderSystem(app);
const scene = render.scene;
const camera = render.camera;

const starfield = new Starfield(scene, 1337);
applyEnvironment(scene, render.renderer);

const key = new THREE.DirectionalLight(0xffffff, 2.6);
key.position.set(4, 6, 5);
scene.add(key);
const fill = new THREE.DirectionalLight(palette().playerAccent, 1.0);
fill.position.set(-6, -2, -4);
scene.add(fill);
scene.add(new THREE.AmbientLight(0x334455, 1.2));

const ships = HULL_ORDER.map((id, i) => {
  const visual = buildShip(id);
  visual.root.position.set((i - (HULL_ORDER.length - 1) / 2) * 26, 0, 0);
  scene.add(visual.root);
  visual.setThrottle(0.85);
  return visual;
});

camera.position.set(0, 10, 46);
camera.lookAt(0, 0, 0);

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  const t = now / 1000;

  for (let i = 0; i < ships.length; i++) {
    const s = ships[i]!;
    s.root.rotation.y = t * 0.5 + i * 0.4;
    s.setControlSurfaces(Math.sin(t * 1.3), Math.cos(t * 0.9), Math.sin(t * 0.7));
    s.update(dt);
  }

  starfield.update(camera.position, t, dt);
  render.render(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
