/**
 * WebGLRenderer + post-processing chain + adaptive quality controller.
 *
 * Chain: RenderPass -> UnrealBloomPass (half-res) -> custom damage/vignette/grain
 * ShaderPass -> OutputPass. OutputPass is last because it is the only pass that reads
 * `renderer.toneMapping` / `renderer.outputColorSpace` and performs the ACES + sRGB
 * conversion; three.js only bakes tone mapping into a material's fragment shader when
 * the active render target is the screen (see WebGLRenderer's `_currentRenderTarget ===
 * null` check), so the offscreen composer buffers stay linear HDR and nothing here
 * double-applies the curve.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { QualityTier } from '../core/types';
import { CAMERA, RENDER } from '../core/constants';
import { clamp, clamp01 } from '../core/math';
import { RollingAverage } from '../core/pool';

/**
 * Chromatic aberration + vignette + grain, applied once after bloom compositing.
 * Deliberately cheap: one texture sample per colour channel (three total), no
 * additional texture lookups for the grain (a hash function stands in for it).
 */
const PostFXShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uDamagePulse: { value: 0 },
    uLowHull: { value: 0 },
    uReduceFlash: { value: 0 },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uDamagePulse;
    uniform float uLowHull;
    uniform float uReduceFlash;
    uniform float uTime;
    uniform vec2 uResolution;

    varying vec2 vUv;

    // Cheap hash noise in place of a grain texture -- keeps this pass to one sample
    // per channel and a handful of ALU ops, per the post-processing budget.
    float grainHash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453123);
    }

    void main() {
      vec2 center = vUv - 0.5;
      float aspect = uResolution.x / uResolution.y;

      // Chromatic aberration: radial per-channel offset, scaled by the hit pulse and
      // hard-disabled under reduceFlash so it can never read as strobing.
      float caAmount = uDamagePulse * 0.006 * (1.0 - uReduceFlash);
      vec2 dir = center * caAmount;
      float r = texture2D(tDiffuse, vUv - dir).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv + dir).b;
      vec3 color = vec3(r, g, b);

      // Vignette: a constant base darkening (aspect-corrected so it reads as a circle,
      // not an oval) plus a crimson tint that grows with low hull and gets a brief
      // kick from the damage pulse.
      float dist = length(vec2(center.x * aspect, center.y));
      float baseVig = smoothstep(0.35, 0.98, dist);
      float hullVig = smoothstep(0.15, 0.9, dist) * uLowHull;

      color *= 1.0 - baseVig * 0.45;
      float crimsonMix = clamp(hullVig * 0.9 + uDamagePulse * baseVig * 0.35, 0.0, 1.0);
      color = mix(color, vec3(0.55, 0.02, 0.05), crimsonMix);

      // Subtle animated grain, capped further under reduceFlash.
      float grain = (grainHash(vUv * uResolution.xy + uTime) - 0.5) * 0.03 * (1.0 - uReduceFlash * 0.5);
      color += grain;

      gl_FragColor = vec4(color, 1.0);
    }
  `,
};

export class RenderSystem {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly domElement: HTMLCanvasElement;

  private readonly container: HTMLElement;

  private composer!: EffectComposer;
  private renderPass!: RenderPass;
  private bloomPass!: UnrealBloomPass;
  private postPass!: ShaderPass;
  private outputPass!: OutputPass;

  // Adaptive quality controller state. `tier` is the controller's own tracked tier;
  // `tierOverride` (when set) drives everything and freezes adaptation.
  private readonly frameTimeMs = new RollingAverage(60);
  private tier: QualityTier = QualityTier.Ultra;
  private tierOverride: QualityTier | null = null;
  private badTimer = 0;
  private goodTimer = 0;

  private pixelRatioCap: number = RENDER.maxPixelRatio;
  private bloomScale: number = RENDER.bloomResolutionScale;
  private bloomStrengthTier: number = RENDER.bloomStrength;
  private reduceFlash = false;

  private contextLost = false;
  private effWidth = 1;
  private effHeight = 1;
  /** Wrapped so the grain hash's sin() argument never grows large enough to lose precision. */
  private clock = 0;

  private lastDrawCalls = 0;
  private lastTriangles = 0;
  private lastPrograms = 0;
  private lastFrameMs = 0;

  private readonly onContextLost = (e: Event): void => {
    // Without preventDefault the browser treats the context as permanently gone and
    // never fires 'webglcontextrestored'.
    e.preventDefault();
    this.contextLost = true;
  };

  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    this.rebuildComposer();
  };

  constructor(container: HTMLElement) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(CAMERA.fovBase, 1, CAMERA.near, CAMERA.far);

    this.renderer = new THREE.WebGLRenderer({
      // MSAA does not propagate through EffectComposer's offscreen render targets, so
      // paying for it here would buy nothing visible once the composer is in the loop.
      // Bloom softens hard edges enough for a fast-moving space combat game.
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    // We own the per-frame reset (see render()) so stats reflect the whole composer
    // chain rather than just whichever pass rendered last.
    this.renderer.info.autoReset = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    this.domElement = this.renderer.domElement;
    container.appendChild(this.domElement);
    this.domElement.addEventListener('webglcontextlost', this.onContextLost, false);
    this.domElement.addEventListener('webglcontextrestored', this.onContextRestored, false);

    this.buildComposer();
    this.applyTier();
  }

  private buildComposer(): void {
    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      RENDER.bloomStrength,
      RENDER.bloomRadius,
      RENDER.bloomThreshold,
    );
    this.postPass = new ShaderPass(PostFXShader);
    this.outputPass = new OutputPass();

    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(this.postPass);
    this.composer.addPass(this.outputPass);
  }

  private disposeComposer(): void {
    this.renderPass.dispose();
    this.bloomPass.dispose();
    this.postPass.dispose();
    this.outputPass.dispose();
    this.composer.dispose();
  }

  private rebuildComposer(): void {
    this.disposeComposer();
    this.buildComposer();
    this.applyTier();
  }

  /** Applies the shedding ladder for the active tier, then resizes everything to match. */
  private applyTier(): void {
    const t = this.tierOverride ?? this.tier;
    switch (t) {
      case QualityTier.Ultra:
        this.bloomScale = RENDER.bloomResolutionScale;
        this.bloomStrengthTier = RENDER.bloomStrength;
        this.bloomPass.enabled = true;
        this.pixelRatioCap = RENDER.maxPixelRatio;
        break;
      case QualityTier.High:
        // Shed #1: halve the already-half-res bloom buffer.
        this.bloomScale = RENDER.bloomResolutionScale * 0.5;
        this.bloomStrengthTier = RENDER.bloomStrength;
        this.bloomPass.enabled = true;
        this.pixelRatioCap = RENDER.maxPixelRatio;
        break;
      case QualityTier.Medium:
        // Shed #2: cut bloom strength on top of the reduced resolution.
        this.bloomScale = RENDER.bloomResolutionScale * 0.5;
        this.bloomStrengthTier = RENDER.bloomStrength * 0.55;
        this.bloomPass.enabled = true;
        this.pixelRatioCap = RENDER.maxPixelRatio;
        break;
      case QualityTier.Low:
      default:
        // Shed #3 + #4: bloom off entirely, pixel ratio to 1. Gameplay is untouched.
        this.bloomScale = RENDER.bloomResolutionScale * 0.5;
        this.bloomStrengthTier = RENDER.bloomStrength * 0.55;
        this.bloomPass.enabled = false;
        this.pixelRatioCap = 1;
        break;
    }
    this.recomputeBloomStrength();
    this.applySize();
  }

  private recomputeBloomStrength(): void {
    this.bloomPass.strength = this.reduceFlash
      ? Math.min(this.bloomStrengthTier, RENDER.bloomStrength * 0.5)
      : this.bloomStrengthTier;
  }

  /** Resizes the renderer, composer, and every pass that tracks its own resolution. */
  private applySize(): void {
    const width = Math.max(1, this.container.clientWidth || window.innerWidth);
    const height = Math.max(1, this.container.clientHeight || window.innerHeight);
    const pixelRatio = clamp(window.devicePixelRatio || 1, 1, this.pixelRatioCap);

    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, true);

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);

    this.effWidth = width * pixelRatio;
    this.effHeight = height * pixelRatio;
    this.bloomPass.setSize(
      Math.max(1, Math.round(this.effWidth * this.bloomScale)),
      Math.max(1, Math.round(this.effHeight * this.bloomScale)),
    );
    this.postPass.uniforms.uResolution.value.set(this.effWidth, this.effHeight);
  }

  resize(): void {
    this.applySize();
  }

  private updateAdaptiveQuality(rawDt: number): void {
    if (this.tierOverride !== null) return;

    this.frameTimeMs.push(rawDt * 1000);
    const avg = this.frameTimeMs.average;

    if (avg > RENDER.qualityDownMs) {
      this.badTimer += rawDt;
      this.goodTimer = 0;
    } else if (avg < RENDER.qualityUpMs) {
      this.goodTimer += rawDt;
      this.badTimer = 0;
    } else {
      // Dead zone between the two thresholds -- the hysteresis band that stops the
      // tier from flapping when frame time sits right at the edge.
      this.badTimer = 0;
      this.goodTimer = 0;
    }

    if (this.badTimer >= RENDER.qualityDwell && this.tier < QualityTier.Low) {
      this.tier = (this.tier + 1) as QualityTier;
      this.badTimer = 0;
      this.frameTimeMs.reset();
      this.applyTier();
    } else if (this.goodTimer >= RENDER.qualityDwell && this.tier > QualityTier.Ultra) {
      this.tier = (this.tier - 1) as QualityTier;
      this.goodTimer = 0;
      this.frameTimeMs.reset();
      this.applyTier();
    }
  }

  render(rawDt: number): void {
    if (this.contextLost) return;

    this.updateAdaptiveQuality(rawDt);

    this.clock = (this.clock + rawDt) % 1000;
    this.postPass.uniforms.uTime.value = this.clock;

    // autoReset is off (see constructor) so this reset is the only one per frame --
    // otherwise each internal pass's own renderer.render() call would clobber the
    // previous pass's counts and `stats` would only ever show the last pass.
    this.renderer.info.reset();
    this.composer.render(rawDt);

    const info = this.renderer.info;
    this.lastDrawCalls = info.render.calls;
    this.lastTriangles = info.render.triangles;
    this.lastPrograms = info.programs ? info.programs.length : 0;
    this.lastFrameMs = rawDt * 1000;
  }

  get quality(): QualityTier {
    return this.tierOverride ?? this.tier;
  }

  setQualityOverride(tier: QualityTier | null): void {
    this.tierOverride = tier;
    this.badTimer = 0;
    this.goodTimer = 0;
    this.frameTimeMs.reset();
    this.applyTier();
  }

  setReduceFlash(on: boolean): void {
    this.reduceFlash = on;
    this.postPass.uniforms.uReduceFlash.value = on ? 1 : 0;
    this.recomputeBloomStrength();
  }

  setDamagePulse(value: number): void {
    this.postPass.uniforms.uDamagePulse.value = clamp01(value);
  }

  setLowHullVignette(value: number): void {
    this.postPass.uniforms.uLowHull.value = clamp01(value);
  }

  get stats(): { fps: number; frameMs: number; drawCalls: number; triangles: number; programs: number } {
    const avg = this.frameTimeMs.average || this.lastFrameMs;
    return {
      fps: avg > 0 ? 1000 / avg : 0,
      frameMs: avg,
      drawCalls: this.lastDrawCalls,
      triangles: this.lastTriangles,
      programs: this.lastPrograms,
    };
  }

  dispose(): void {
    this.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.disposeComposer();
    this.renderer.dispose();
  }
}
