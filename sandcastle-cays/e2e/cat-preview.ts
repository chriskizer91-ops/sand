// Preview page for the catamaran alone (built and driven by e2e/cat-look.mjs; not part of the game).
// The boat floats on a flat turquoise sea under a sunny sky, lit the way the game lights it:
// ACES filmic tone mapping, a sun with shadows, a hemisphere light and a sky environment map.
import * as THREE from 'three';
import { createCatamaran } from '../src/render/catamaran';

interface Pose {
  sail: number;
  boom: number;
  jib: number;
  fill: number;
  time: number;
  rudder: number;
  anchored: boolean;
  motor: number;
  lights: 'anchor' | 'underway';
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
  rig?: Partial<Pose>;
}

declare global {
  interface Window {
    __cat: { ready: boolean; info: Record<string, unknown>; view: (name: string) => string; views: string[] };
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
sun.position.copy(sunDir).multiplyScalar(40);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = -14;
sc.right = 14;
sc.top = 16;
sc.bottom = -14;
sc.near = 1;
sc.far = 90;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun);
scene.add(sun.target);
const hemi = new THREE.HemisphereLight(0xcfe9ff, 0xe8d4a8, 0.7);
scene.add(hemi);

const water = new THREE.Mesh(
  new THREE.PlaneGeometry(800, 800),
  new THREE.MeshStandardMaterial({ color: 0x2fc2cf, roughness: 0.06, metalness: 0, transparent: true, opacity: 0.7 }),
);
water.rotation.x = -Math.PI / 2;
water.receiveShadow = true;
water.renderOrder = 1;
scene.add(water);
const bed = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), new THREE.MeshStandardMaterial({ color: 0xf3e6c8, roughness: 1 }));
bed.rotation.x = -Math.PI / 2;
bed.position.y = -4;
bed.receiveShadow = true;
scene.add(bed);

const t0 = performance.now();
const boat = createCatamaran();
const buildMs = performance.now() - t0;
scene.add(boat.group);
boat.group.traverse((o) => {
  if ((o as THREE.Mesh).isMesh) {
    o.castShadow = true; // as the game does: every mesh
    o.receiveShadow = true;
  }
});

// Debug overlay: dots on every walkable surface, level by level.
//   green = walkable and inside the rails, orange = blocked for a person of radius 0.22, red = outside the rails.
const dots = (() => {
  const pos: number[] = [];
  const col: number[] = [];
  const step = 0.08;
  const levels = [-0.5, 0.35, 0.6, 0.9, 1.2, 1.5, 1.93, 2.5, 3.0, 3.4, 3.66];
  for (let x = -7.2; x <= 7.2; x += step) {
    for (let z = -4; z <= 4; z += step) {
      const seen = new Set<number>();
      for (const y of levels) {
        const h = boat.deck.heightAt(x, z, y);
        if (h === null || Math.abs(h - y) > 0.36) continue;
        const key = Math.round(h * 50);
        if (seen.has(key)) continue;
        seen.add(key);
        pos.push(x, h + 0.015, z);
        const c = !boat.deck.insideLifelines(x, z, h) ? [1, 0.1, 0.1] : boat.deck.blocked(x, z, 0.22, h) ? [1, 0.55, 0] : [0.1, 0.9, 0.2];
        col.push(...c);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const group = new THREE.Group();
  group.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 3, sizeAttenuation: false, vertexColors: true, depthTest: false })));
  const p = boat.points;
  for (const m of [p.ladderTop, p.ladderBottom, p.locker, p.helm, p.bow, p.mastBase, p.spawn, p.galley, p.workbench, p.pump, p.chart, p.bunk, ...p.potShelf]) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff00ff, depthTest: false }));
    s.position.copy(m);
    group.add(s);
  }
  group.visible = false;
  group.renderOrder = 10;
  scene.add(group);
  return group;
})();

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

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 1500);
const EYE = 1.62;
const STARBOARD_TACK: Partial<Pose> = { sail: 1, boom: -0.6, jib: -0.45, fill: 1, rudder: 0.06, anchored: false };
const REST: Pose = { sail: 0, boom: 0, jib: 0, fill: 1, time: 0, rudder: 0, anchored: true, motor: 0, lights: 'anchor', night: 0, hatch: 1, galley: false, pump: 0, bilge: 0, awning: 0, awningBig: false, trap: false, rod: true };
const p = boat.points;
const eye = (q: THREE.Vector3, dx = 0, dz = 0): [number, number, number] => [q.x + dx, q.y + EYE, q.z + dz];

const views: Record<string, View> = {
  far: { pos: [17, 1.6, 15.5], target: [0, 6.2, 0], fov: 50 },
  near: { pos: [11, 1.7, 9], target: [0, 1.8, 0], fov: 50 },
  side: { pos: [0, 2, 30], target: [0, 9, 0], fov: 46 },
  aft: { pos: [-16, 2.2, 6], target: [-2, 2.5, 0], fov: 45 },
  bowview: { pos: [15, 1.6, -3.5], target: [0, 3.5, 0], fov: 50 },
  sail: { pos: [-6, 1.6, -26], target: [0, 9.5, 0], fov: 50, rig: STARBOARD_TACK },
  'sail-far': { pos: [17, 1.6, 15.5], target: [0, 9, 0], fov: 50, rig: STARBOARD_TACK },
  'sail-half': { pos: [-6, 1.6, -26], target: [0, 9.5, 0], fov: 50, rig: { ...STARBOARD_TACK, sail: 0.5 } },
  'sail-helm': { pos: eye(p.helm), target: [6, 5.8, -0.5], fov: 70, rig: STARBOARD_TACK },
  cockpit: { pos: eye(p.spawn, -1.2, 0.4), target: [2.5, 2.4, -0.3], fov: 70 },
  'cockpit-aft': { pos: eye(p.spawn, 0.3, -0.3), target: [-5.5, 1.8, 0.4], fov: 70, rig: { awning: 1, awningBig: true } },
  saloon: { pos: eye(V3(-1.0, 1.5, 0.6)), target: [3.2, 2.4, -0.4], fov: 72, rig: { galley: true } },
  galley: { pos: eye(p.galley, -0.15, 0.25), target: [2.5, 2.3, -2.9], fov: 70, rig: { galley: true } },
  chart: { pos: eye(p.chart, -0.1, -0.15), target: [3.1, 2.2, 2.3], fov: 70 },
  stairs: { pos: eye(V3(-1.15, 1.5, 2.55)), target: [1.2, 0.0, 2.6], fov: 70 },
  bunk: { pos: eye(p.bunk, -0.45, 0.05), target: [4.6, 0.3, -2.75], fov: 72, rig: { galley: true } },
  workshop: { pos: eye(p.workbench, -0.35, -0.2), target: [2.2, 0.55, 3.4], fov: 72, rig: { galley: true } },
  'hull-aft': { pos: eye(V3(3.1, -0.5, 2.7)), target: [-0.5, 0.3, 2.6], fov: 72 },
  helm: { pos: eye(p.helm), target: [8, 4.6, 0.6], fov: 70 },
  'helm-down': { pos: eye(p.helm, -0.1, 0), target: [0.8, 4.6, 1.1], fov: 70 },
  flybridge: { pos: [-4.5, 6.8, 4.5], target: [0, 3.8, 0], fov: 55 },
  trampoline: { pos: [4.45, 1.5 + EYE, -0.9], target: [9, 0.9, 0.2], fov: 70 },
  foredeck: { pos: [6.0, 1.7 + EYE, 0.9], target: [1.0, 3.0, 0], fov: 70 },
  pots: { pos: [5.4, 3.0, 1.6], target: [3.8, 1.9, 0], fov: 60 },
  steps: { pos: [-11, 1.0, 4.6], target: [-6, 0.7, 2.6], fov: 55 },
  ladder: { pos: [-5.0, 2.0 + EYE, 2.75], target: [-7.0, -0.3, 2.75], fov: 70 },
  under: { pos: [3, -1.6, 9], target: [-1, -0.7, 0], fov: 60 },
  night: { pos: [26, 2.4, 22], target: [0, 8, 0], fov: 50, rig: { lights: 'anchor', night: 1, galley: true } },
  'night-underway': { pos: [30, 2.4, 10], target: [0, 6, 0], fov: 50, rig: { ...STARBOARD_TACK, lights: 'underway', night: 1, galley: true, motor: 0.5 } },
  'night-saloon': { pos: eye(V3(-1.0, 1.5, 0.6)), target: [3.2, 2.4, -0.4], fov: 72, rig: { lights: 'anchor', night: 1, galley: true } },
  living: { pos: [-11, 5, -8], target: [-3, 2, 0], fov: 50, rig: { awning: 1, awningBig: true, trap: true, bilge: 0.9, motor: 0.6 } },
  rudders: { pos: [-9, -1.4, 6], target: [-4.5, -0.7, 0], fov: 55, rig: { rudder: 0.45, motor: 0.8 } },
  debug: { pos: [12, 14, 12], target: [0, 1, 0], fov: 50, dots: true },
  debugtop: { pos: [0, 26, 0.001], target: [0, 0, 0], fov: 38, dots: true },
  debughull: { pos: [2, 4.5, 6.5], target: [1.5, -0.3, 1.5], fov: 55, dots: true },
};

function V3(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, y, z);
}

let hiddenForDots: THREE.Object3D[] = [];
function view(name: string): string {
  const v = views[name];
  if (!v) return 'no such view';
  camera.position.set(...v.pos);
  camera.fov = v.fov;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  camera.lookAt(new THREE.Vector3(...v.target));
  dots.visible = !!v.dots;
  for (const o of hiddenForDots) o.visible = true;
  hiddenForDots = [];
  if (name === 'debughull') {
    // see into the hull: hide the decks above it
    for (const n of ['cat-teak', 'cat-gelcoat', 'cat-varnish']) {
      const o = boat.group.getObjectByName(n);
      if (o) {
        o.visible = false;
        hiddenForDots.push(o);
      }
    }
  }
  const pose: Pose = { ...REST, ...v.rig };
  const r = boat.rig;
  r.setSail(pose.sail);
  r.setBoom(pose.boom);
  r.setJib(pose.jib);
  r.setFill(pose.fill, pose.time);
  r.setRudder(pose.rudder);
  r.setAnchored(pose.anchored);
  for (let k = 0; k < 6; k++) r.setMotor(pose.motor, (clock += 0.05));
  r.setLights(pose.lights, pose.night);
  r.setHatch(pose.hatch);
  r.setGalleyLight(pose.galley);
  r.setPump(pose.pump);
  r.setBilge(pose.bilge, 1.3);
  r.setAwning(pose.awning, pose.awningBig);
  r.setTrap(pose.trap);
  r.setRodStowed(pose.rod);
  setNight(pose.night > 0.5);
  renderer.render(scene, camera);
  return 'ok';
}

let meshes = 0;
boat.group.traverse((o) => {
  if ((o as THREE.Mesh).isMesh) meshes++;
});
window.__cat = {
  ready: true,
  views: Object.keys(views),
  view,
  info: { triangles: boat.triangles, meshes, buildMs: Math.round(buildMs), length: boat.length, beam: boat.beam, draft: boat.draft },
};
