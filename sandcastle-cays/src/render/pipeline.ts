/**
 * How each frame is drawn (from the raft game):
 *  1. the scene without the water, into a small colour + depth picture, which
 *     the water samples to show what is beneath it;
 *  2. the full scene, then what you hold (the basket) in its own depth layer;
 *  3. a soft glow on the brightest highlights (bloom);
 *  4. filmic tone mapping to the screen.
 * Quality levels trade sharpness, shadows and glow for speed.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { Ocean } from './ocean';

export type QualityName = 'high' | 'medium' | 'phone' | 'low';
export interface Quality {
  label: string;
  pixelRatio: number;
  shadows: number;
  bloom: boolean;
  /** Resolution of the under-the-water picture, relative to the screen. */
  refract: number;
  msaa: number;
}

export const QUALITY: Record<QualityName, Quality> = {
  high: { label: 'Pretty', pixelRatio: 1.75, shadows: 2048, bloom: true, refract: 0.75, msaa: 4 },
  medium: { label: 'Balanced', pixelRatio: 1.3, shadows: 1536, bloom: true, refract: 0.6, msaa: 2 },
  phone: { label: 'Phone', pixelRatio: 1.5, shadows: 1024, bloom: false, refract: 0.5, msaa: 0 },
  low: { label: 'Fast', pixelRatio: 1.0, shadows: 0, bloom: false, refract: 0.45, msaa: 0 },
};

export interface PipelineParts {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  vmScene: THREE.Scene;
  vmCamera: THREE.PerspectiveCamera;
  ocean: Ocean;
  sun: THREE.DirectionalLight;
  sunDir: THREE.Vector3;
  sky: THREE.CubeTexture;
  /** Things the under-water picture must skip (the sky, things drawn over the water). */
  aboveWaterOnly: THREE.Object3D[];
}

export class Pipeline {
  private q: Quality = QUALITY.medium;
  private qName: QualityName = 'medium';
  private composer: EffectComposer | null = null;
  private vmPass: RenderPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private refractRT: THREE.WebGLRenderTarget;
  private size = { w: 1, h: 1 };
  private focus = new THREE.Vector3();
  private wasVisible: boolean[] = [];
  /** Half-width of the sun's shadow box (metres), set by the caller each frame. */
  shadowSpan = 14;
  /** Extra resolution scale from automatic quality (1 = as the level says). */
  scale = 1;

  constructor(private p: PipelineParts) {
    const { renderer, sun, ocean, camera } = p;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    p.scene.add(sun.target);

    const depthTex = new THREE.DepthTexture(1, 1);
    depthTex.type = THREE.UnsignedIntType;
    this.refractRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthTexture: depthTex });
    ocean.setSources(this.refractRT.texture, depthTex, p.sky);
    ocean.setCamera(camera);
  }

  get quality(): QualityName {
    return this.qName;
  }

  get pixelRatio(): number {
    return this.p.renderer.getPixelRatio();
  }

  private build(): void {
    const { renderer, scene, camera, vmScene, vmCamera } = this.p;
    if (this.composer) {
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
    }
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: this.q.msaa });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(scene, camera));
    this.vmPass = new RenderPass(vmScene, vmCamera);
    this.vmPass.clear = false;
    this.vmPass.clearDepth = true;
    this.composer.addPass(this.vmPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.2, 0.45, 1.0);
    this.bloom.enabled = this.q.bloom;
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  setQuality(name: QualityName): void {
    const next = QUALITY[name] ?? QUALITY.medium;
    const rebuild = !this.composer || this.q.msaa !== next.msaa;
    this.q = next;
    this.qName = name in QUALITY ? name : 'medium';
    const { sun, renderer } = this.p;
    sun.castShadow = this.q.shadows > 0;
    renderer.shadowMap.enabled = this.q.shadows > 0;
    if (this.q.shadows && sun.shadow.mapSize.x !== this.q.shadows) {
      sun.shadow.mapSize.set(this.q.shadows, this.q.shadows);
      sun.shadow.map?.dispose();
      sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }
    if (rebuild) this.build();
    if (this.bloom) this.bloom.enabled = this.q.bloom;
    this.scale = 1;
    this.resize(this.size.w, this.size.h);
  }

  /** Automatic quality: step down a little when the frame rate stays low. Returns false when nothing is left to trim. */
  stepDown(): boolean {
    if (this.bloom?.enabled) {
      this.bloom.enabled = false;
      return true;
    }
    if (this.scale > 0.71) {
      this.scale -= 0.15;
      this.resize(this.size.w, this.size.h);
      return true;
    }
    if (this.p.sun.castShadow) {
      this.p.sun.castShadow = false;
      this.p.renderer.shadowMap.enabled = false;
      return true;
    }
    return false;
  }

  resize(w: number, h: number): void {
    this.size = { w, h };
    const { renderer, camera, ocean } = this.p;
    const pr = Math.max(0.6, Math.min(window.devicePixelRatio || 1, this.q.pixelRatio) * this.scale);
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    this.composer?.setPixelRatio(pr);
    this.composer?.setSize(w, h);
    this.refractRT.setSize(Math.max(1, Math.floor(w * pr * this.q.refract)), Math.max(1, Math.floor(h * pr * this.q.refract)));
    ocean.setScreen(Math.floor(w * pr), Math.floor(h * pr));
    ocean.setRefract(this.q.refract / 0.75);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    this.p.vmCamera.aspect = w / h;
    this.p.vmCamera.updateProjectionMatrix();
  }

  render(showHeld: boolean, around: THREE.Vector3): void {
    const { renderer, scene, camera, ocean, sun, sunDir, aboveWaterOnly } = this.p;
    // The shadow box follows the viewer, snapped to whole shadow-map pixels so shadows don't crawl.
    const span = this.shadowSpan;
    const sc = sun.shadow.camera;
    if (sc.right !== span) {
      sc.left = -span;
      sc.right = span;
      sc.top = span;
      sc.bottom = -span;
      sc.near = 1;
      sc.far = 160;
      sc.updateProjectionMatrix();
    }
    const texel = (span * 2) / Math.max(1, sun.shadow.mapSize.x);
    this.focus.set(Math.round(around.x / texel) * texel, 0, Math.round(around.z / texel) * texel);
    sun.target.position.copy(this.focus);
    sun.position.copy(this.focus).addScaledVector(sunDir, 70);
    renderer.shadowMap.needsUpdate = true;

    // The water only needs what is under it.
    ocean.mesh.visible = false;
    const was = this.wasVisible;
    was.length = 0;
    for (const o of aboveWaterOnly) {
      was.push(o.visible);
      o.visible = false;
    }
    renderer.setRenderTarget(this.refractRT);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    ocean.mesh.visible = true;
    for (let i = 0; i < aboveWaterOnly.length; i++) aboveWaterOnly[i].visible = was[i];

    if (this.vmPass) this.vmPass.enabled = showHeld;
    this.composer?.render();
  }
}
