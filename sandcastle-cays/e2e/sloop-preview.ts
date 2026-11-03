// Preview page for the sloop model alone (built and driven by e2e/sloop-look.mjs; not part of the game).
// The boat floats on a flat turquoise sea under a sunny sky, lit the way the game will light it:
// ACES filmic tone mapping, a sun with shadows, a hemisphere light and a sky environment map.
import * as THREE from 'three';
import { createSloop } from '../src/render/sloop';

interface RigPose {
  sail: number;
  boom: number;
  jib: number;
  fill: number;
  time: number;
  rudder: number;
  anchored: boolean;
  /** Outboard throttle (the preview lets it finish tilting before the picture). */
  motor: number;
  lights: 'anchor' | 'underway';
  /** 0 = day, 1 = night (also darkens the preview's sky and light). */
  night: number;
  hatch: number;
  galley: boolean;
  pump: number;
  bilge: number;
  awning: number;
  awningBig: boolean;
  trap: boolean;
  rod: boolean;
}

interface View {
  pos: [number, number, number];
  target: [number, number, number];
  fov: number;
  dots?: boolean;
  /** Rig pose for this view; default is at anchor with the sails furled. */
  rig?: Partial<RigPose>;
}

declare global {
  interface Window {
    __sloop: { ready: boolean; info: Record<string, unknown>; view: (name: string) => string; views: string[] };
  }
}

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const sunDir = new THREE.Vector3(-0.45, 0.62, 0.64).normalize();

function makeSky(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(0x3d9be9) },
      horizon: { value: new THREE.Color(0xd9f1ff) },
      sunDir: { value: sunDir },
      sunGain: { value: 1 },
    },
    vertexShader: `varying vec3 vDir;
      void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform float sunGain; varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        vec3 c = mix(horizon, top, pow(h, 0.5));
        if (d.y < 0.0) c = mix(horizon, vec3(0.12, 0.45, 0.55), min(1.0, -d.y * 4.0));
        float s = max(dot(d, sunDir), 0.0);
        c += vec3(1.0, 0.95, 0.85) * (pow(s, 1200.0) * 40.0 + pow(s, 16.0) * 0.3) * sunGain;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(500, 48, 24), mat);
}

const sky = makeSky();
scene.add(sky);
const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene();
envScene.add(makeSky());
scene.environment = pmrem.fromScene(envScene, 0, 0.1, 1000).texture;
scene.environmentIntensity = 0.8;

const sun = new THREE.DirectionalLight(0xfff2d6, 2.7);
sun.position.copy(sunDir).multiplyScalar(30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = -9;
sc.right = 9;
sc.top = 9;
sc.bottom = -9;
sc.near = 1;
sc.far = 70;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.025;
scene.add(sun);
scene.add(sun.target);
const hemi = new THREE.HemisphereLight(0xcfe9ff, 0xe8d4a8, 0.7);
scene.add(hemi);

const water = new THREE.Mesh(
  new THREE.PlaneGeometry(600, 600),
  new THREE.MeshStandardMaterial({ color: 0x2fc2cf, roughness: 0.06, metalness: 0, transparent: true, opacity: 0.7 }),
);
water.rotation.x = -Math.PI / 2;
water.receiveShadow = true;
water.renderOrder = 1;
scene.add(water);
const bed = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: 0xf3e6c8, roughness: 1 }));
bed.rotation.x = -Math.PI / 2;
bed.position.y = -4;
bed.receiveShadow = true;
scene.add(bed);

const t0 = performance.now();
const boat = createSloop();
const buildMs = performance.now() - t0;
scene.add(boat.group);

// Debug overlay: dots wherever deck.heightAt says you can stand.
//   green = walkable and safe, orange = blocked for a person of radius 0.25, red = outside the lifelines.
const dots = (() => {
  const pos: number[] = [];
  const col: number[] = [];
  const step = 0.07;
  for (let x = -4.6; x <= 4.6; x += step) {
    for (let z = -1.6; z <= 1.6; z += step) {
      const h = boat.deck.heightAt(x, z);
      if (h === null) continue;
      pos.push(x, h + 0.012, z);
      const c = !boat.deck.insideLifelines(x, z) ? [1, 0.1, 0.1] : boat.deck.blocked(x, z, 0.25) ? [1, 0.55, 0] : [0.1, 0.9, 0.2];
      col.push(...c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const group = new THREE.Group();
  group.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 3, sizeAttenuation: false, vertexColors: true })));
  const p = boat.points;
  const marks = [p.ladderTop, p.ladderBottom, p.locker, p.helm, p.bow, p.mastBase, p.spawn, ...p.potShelf];
  for (const m of marks) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff00ff }));
    s.position.copy(m);
    group.add(s);
  }
  group.visible = false;
  scene.add(group);
  return group;
})();

function countMeshes(): number {
  let n = 0;
  boat.group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) n++;
  });
  return n;
}

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 1500);

/** Day or night lighting for the preview scene (the game has its own day and night). */
function setNight(on: boolean): void {
  const u = (sky.material as THREE.ShaderMaterial).uniforms;
  (u.top.value as THREE.Color).set(on ? 0x07102a : 0x3d9be9);
  (u.horizon.value as THREE.Color).set(on ? 0x1a2a48 : 0xd9f1ff);
  u.sunGain.value = on ? 0.04 : 1;
  scene.environmentIntensity = on ? 0.05 : 0.8;
  sun.color.set(on ? 0x9fb4d8 : 0xfff2d6);
  sun.intensity = on ? 0.22 : 2.7;
  hemi.color.set(on ? 0x3a4f78 : 0xcfe9ff);
  hemi.groundColor.set(on ? 0x141a26 : 0xe8d4a8);
  hemi.intensity = on ? 0.18 : 0.7;
  (water.material as THREE.MeshStandardMaterial).color.set(on ? 0x0b3442 : 0x2fc2cf);
}
let clock = 0;

const STARBOARD_TACK: Partial<RigPose> = { sail: 1, boom: -0.7, jib: -0.45, fill: 1, time: 0, rudder: 0.08, anchored: false };
const REST: RigPose = {
  sail: 0,
  boom: 0,
  jib: 0,
  fill: 1,
  time: 0,
  rudder: 0,
  anchored: true,
  motor: 0,
  lights: 'anchor',
  night: 0,
  hatch: 0,
  galley: false,
  pump: 0,
  bilge: 0,
  awning: 0,
  awningBig: false,
  trap: false,
  rod: true,
};

const views: Record<string, View> = {
  far: { pos: [11.5, 1.6, 9.6], target: [0, 4.3, 0], fov: 50 },
  near: { pos: [6.2, 1.6, 6.4], target: [0, 1.5, 0], fov: 50 },
  side: { pos: [0.5, 1.2, 18], target: [0.5, 4.6, 0], fov: 48 },
  stern: { pos: [-9.5, 1.6, 6.5], target: [-2, 1.4, 0], fov: 50 },
  cockpit: { pos: [-2.75, 2.0, 0], target: [2.5, 1.45, 0], fov: 70 },
  foredeck: { pos: [2.9, 2.52, 0], target: [-4, 1.25, 0], fov: 70 },
  ladder: { pos: [-3.62, 2.42, 0.45], target: [-4.6, -0.2, 0.6], fov: 70 },
  laddertop: { pos: [-5.2, 2.2, 0.2], target: [-4.35, 0.15, 0.58], fov: 65 },
  swim: { pos: [-6.2, 0.25, 1.6], target: [-4.3, 0.45, 0.45], fov: 65 },
  under: { pos: [2.6, -1.3, 4.6], target: [-0.6, -0.5, 0], fov: 60 },
  aft: { pos: [-11, 1.3, 0.4], target: [-3, 1.1, 0], fov: 45 },
  quarter: { pos: [-2.6, 1.05, 2.3], target: [-2.9, 0.82, 1.2], fov: 55 },
  sidedeck: { pos: [-0.6, 2.38, 1.17], target: [2.0, 1.55, 0.2], fov: 70 },
  bow: { pos: [6.2, 1.5, 2.3], target: [3.9, 1.0, 0], fov: 50 },
  hullclose: { pos: [-1.6, 1.25, 4.2], target: [-2.6, 0.75, 0], fov: 55 },
  debug: { pos: [5.5, 7.5, 7], target: [-0.4, 0.8, 0], fov: 50, dots: true },
  debugtop: { pos: [0, 14, 0.001], target: [0, 0, 0], fov: 42, dots: true },
  debugcockpit: { pos: [-1.0, 3.2, 2.2], target: [-3.0, 0.6, 0], fov: 60, dots: true },
  // Sailing: starboard tack (wind from starboard, boom out to port), anchor up.
  'sail-far': { pos: [11.5, 1.6, 9.6], target: [0, 4.3, 0], fov: 50, rig: STARBOARD_TACK },
  'sail-far-port': { pos: [-4, 1.6, -14.4], target: [0, 4.3, 0], fov: 50, rig: STARBOARD_TACK },
  'sail-half': { pos: [-4, 1.6, -14.4], target: [0, 4.3, 0], fov: 50, rig: { ...STARBOARD_TACK, sail: 0.5 } },
  'sail-half-stbd': { pos: [11.5, 1.6, 9.6], target: [0, 4.3, 0], fov: 50, rig: { ...STARBOARD_TACK, sail: 0.5 } },
  'sail-cockpit': { pos: [-3.2, 2.02, 0.3], target: [2.0, 2.6, -0.4], fov: 70, rig: STARBOARD_TACK },
  'sail-luff': { pos: [-4, 1.6, -14.4], target: [0, 4.3, 0], fov: 50, rig: { ...STARBOARD_TACK, boom: -0.12, jib: -0.1, fill: 0, time: 1.3 } },
  'sail-luff-cockpit': { pos: [-3.2, 2.02, 0.3], target: [2.0, 2.6, -0.4], fov: 70, rig: { ...STARBOARD_TACK, boom: -0.12, jib: -0.1, fill: 0, time: 1.3 } },
  'sail-run': { pos: [-12, 2.5, 6], target: [0, 4.3, 0], fov: 50, rig: { sail: 1, boom: 1.4, jib: 1.0, fill: 1, rudder: -0.3, anchored: false } },
  'anchor-up': { pos: [6.0, 1.7, 1.6], target: [4.2, 0.95, 0], fov: 45, rig: { anchored: false } },
  'sail-bundle': { pos: [-0.6, 3.3, 2.6], target: [-1.0, 2.3, 0], fov: 55, rig: { ...STARBOARD_TACK, sail: 0.3, boom: -0.2, jib: -0.2 } },
  'sail-foredeck': { pos: [2.6, 2.45, 0.6], target: [-1.5, 2.6, -1.5], fov: 70, rig: STARBOARD_TACK },
  'motor-down': { pos: [-7.0, 0.4, -2.6], target: [-4.6, 0.15, -0.45], fov: 55, rig: { motor: 1 } },
  'motor-up': { pos: [-7.0, 0.4, -2.6], target: [-4.6, 0.15, -0.45], fov: 55, rig: { motor: 0 } },
  'motor-deck': { pos: [-3.85, 2.45, -0.25], target: [-4.75, 0.25, -0.6], fov: 65, rig: { motor: 0 } },
  'motor-stern': { pos: [-10.5, 1.3, -1.5], target: [-3, 0.8, 0], fov: 45, rig: { motor: 1, anchored: false } },
  'night-anchor': { pos: [24, 2.2, 18], target: [0, 4.5, 0], fov: 50, rig: { lights: 'anchor', night: 1 } },
  'night-underway': { pos: [26, 2.2, 15], target: [0, 4.0, 0], fov: 50, rig: { ...STARBOARD_TACK, lights: 'underway', night: 1 } },
  'night-ahead': { pos: [30, 2.2, 0], target: [0, 3.0, 0], fov: 50, rig: { ...STARBOARD_TACK, lights: 'underway', night: 1 } },
  'night-astern': { pos: [-30, 2.2, 4], target: [0, 3.0, 0], fov: 50, rig: { ...STARBOARD_TACK, lights: 'underway', night: 1, motor: 0.6 } },
  'night-far': { pos: [52, 2.5, 30], target: [0, 4.0, 0], fov: 50, rig: { lights: 'anchor', night: 1 } },
  'day-lights': { pos: [6.0, 1.9, 1.9], target: [4.0, 1.3, 0], fov: 45, rig: { lights: 'underway', night: 0 } },
  galley: { pos: [-2.9, 2.02, 0.25], target: [-1.45, 1.15, 0], fov: 65, rig: { hatch: 1 } },
  'galley-night': { pos: [-2.9, 2.02, 0.25], target: [-1.45, 1.15, 0], fov: 65, rig: { hatch: 0.6, galley: true, night: 1 } },
  'galley-night-far': { pos: [-12, 2.2, 5], target: [-1.5, 1.4, 0], fov: 50, rig: { hatch: 0.6, galley: true, night: 1 } },
  workbench: { pos: [-3.38, 2.02, -0.28], target: [-3.9, 1.1, -0.66], fov: 65, rig: { trap: true } },
  'workbench-out': { pos: [-2.4, 2.7, 1.5], target: [-3.85, 1.1, -0.6], fov: 55, rig: {} },
  pump: { pos: [-2.55, 2.02, 0.25], target: [-2.55, 1.05, 0.95], fov: 65, rig: { pump: 0.8 } },
  bilge: { pos: [-1.85, 2.3, 0.85], target: [-2.75, 0.4, -0.05], fov: 60, rig: { bilge: 0.95, time: 2.3 } },
  awning: { pos: [4.0, 3.4, 6.2], target: [-1.0, 1.95, 0], fov: 50, rig: { awning: 1 } },
  'awning-big': { pos: [4.0, 3.4, 6.2], target: [-1.0, 1.95, 0], fov: 50, rig: { awning: 1, awningBig: true } },
  'awning-half': { pos: [4.0, 3.4, 6.2], target: [-1.0, 1.95, 0], fov: 50, rig: { awning: 0.5 } },
  'awning-cockpit': { pos: [-2.75, 2.02, 0], target: [0.5, 1.95, 0], fov: 70, rig: { awning: 1, awningBig: true } },
  'awning-far': { pos: [11.5, 1.6, 9.6], target: [0, 4.3, 0], fov: 50, rig: { awning: 1, awningBig: true, trap: true } },
  trap: { pos: [-1.6, -0.35, 4.2], target: [-3.6, -0.7, 1.5], fov: 60, rig: { trap: true } },
  'trap-above': { pos: [-1.6, 1.5, 4.6], target: [-3.6, -0.4, 1.5], fov: 55, rig: { trap: true } },
  rod: { pos: [-5.6, 2.3, 3.6], target: [-3.9, 1.8, 1.2], fov: 55, rig: {} },
  'stern-living': { pos: [-7.5, 2.6, -1.4], target: [-3.4, 1.0, 0], fov: 50, rig: { trap: true, awning: 1 } },
  'sail-helm': { pos: [-2.2, 2.4, 1.9], target: [-3.6, 0.8, 0], fov: 60, rig: { ...STARBOARD_TACK, rudder: 0.45 } },
};

function view(name: string): string {
  const v = views[name];
  if (!v) return 'no such view';
  camera.position.set(...v.pos);
  camera.fov = v.fov;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  camera.lookAt(new THREE.Vector3(...v.target));
  dots.visible = !!v.dots;
  const pose: RigPose = { ...REST, ...v.rig };
  boat.rig.setSail(pose.sail);
  boat.rig.setBoom(pose.boom);
  boat.rig.setJib(pose.jib);
  boat.rig.setFill(pose.fill, pose.time);
  boat.rig.setRudder(pose.rudder);
  boat.rig.setAnchored(pose.anchored);
  for (let k = 0; k < 26; k++) boat.rig.setMotor(pose.motor, (clock += 0.05));
  boat.rig.setLights(pose.lights, pose.night);
  boat.rig.setHatch(pose.hatch);
  boat.rig.setGalleyLight(pose.galley);
  boat.rig.setPump(pose.pump);
  boat.rig.setBilge(pose.bilge, pose.time);
  boat.rig.setAwning(pose.awning, pose.awningBig);
  boat.rig.setTrap(pose.trap);
  boat.rig.setRodStowed(pose.rod);
  setNight(pose.night > 0.5);
  renderer.render(scene, camera);
  return 'ok';
}

window.__sloop = {
  ready: true,
  views: Object.keys(views),
  view,
  info: { triangles: boat.triangles, meshes: countMeshes(), buildMs: Math.round(buildMs), length: boat.length, beam: boat.beam, draft: boat.draft },
};
