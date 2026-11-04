// Preview page for the dinghy (built and driven by e2e/dinghy-look.mjs; not part of the game).
// One dinghy floats on its own; a second hangs in the catamaran's davits. Same sunny sea and light
// as the catamaran's preview: ACES tone mapping, a sun with shadows, a hemisphere light, a sky map.
import * as THREE from 'three';
import { createCatamaran } from '../src/render/catamaran';
import { createDinghy } from '../src/render/dinghy';

interface Pose {
  /** Show the catamaran (with its dinghy in the davits) instead of the free dinghy. */
  cat: boolean;
  falls: number;
  phase: number;
  rowing: boolean;
  motor: number;
  rudder: number;
  damage: number;
}
interface View {
  pos: [number, number, number];
  target: [number, number, number];
  fov: number;
  pose?: Partial<Pose>;
}

declare global {
  interface Window {
    __dinghy: { ready: boolean; info: Record<string, unknown>; view: (name: string) => string; views: string[] };
  }
}

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const sunDir = new THREE.Vector3(-0.45, 0.62, 0.64).normalize();
function makeSky(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { top: { value: new THREE.Color(0x3d9be9) }, horizon: { value: new THREE.Color(0xd9f1ff) }, sunDir: { value: sunDir } },
    vertexShader: `varying vec3 vDir;
      void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 c = mix(horizon, top, pow(max(d.y, 0.0), 0.5));
        if (d.y < 0.0) c = mix(horizon, vec3(0.12, 0.45, 0.55), min(1.0, -d.y * 4.0));
        float s = max(dot(d, sunDir), 0.0);
        c += vec3(1.0, 0.95, 0.85) * (pow(s, 1200.0) * 40.0 + pow(s, 16.0) * 0.3);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(500, 48, 24), mat);
}
scene.add(makeSky());
const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new THREE.Scene();
envScene.add(makeSky());
scene.environment = pmrem.fromScene(envScene, 0, 0.1, 1000).texture;
scene.environmentIntensity = 0.8;
const sun = new THREE.DirectionalLight(0xfff2d6, 2.7);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun);
scene.add(sun.target);
scene.add(new THREE.HemisphereLight(0xcfe9ff, 0xe8d4a8, 0.7));
const water = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), new THREE.MeshStandardMaterial({ color: 0x2fc2cf, roughness: 0.06, transparent: true, opacity: 0.7 }));
water.rotation.x = -Math.PI / 2;
water.receiveShadow = true;
water.renderOrder = 2;
scene.add(water);
const bed = new THREE.Mesh(new THREE.PlaneGeometry(800, 800), new THREE.MeshStandardMaterial({ color: 0xf3e6c8, roughness: 1 }));
bed.rotation.x = -Math.PI / 2;
bed.position.y = -3;
bed.receiveShadow = true;
scene.add(bed);

const t0 = performance.now();
const free = createDinghy();
const buildMs = performance.now() - t0;
scene.add(free.group);
const cat = createCatamaran();
scene.add(cat.group);
const hung = createDinghy();
hung.rig.setStowed(true);
hung.group.rotation.y = cat.points.davitYaw;
cat.group.add(hung.group);
for (const g of [free.group, cat.group])
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });

/** Aim the sun's shadow box at what's in view. */
function shadowAt(c: THREE.Vector3, size: number): void {
  sun.target.position.copy(c);
  sun.position.copy(c).addScaledVector(sunDir, 40);
  const sc = sun.shadow.camera;
  sc.left = -size;
  sc.right = size;
  sc.top = size;
  sc.bottom = -size;
  sc.near = 1;
  sc.far = 90;
  sc.updateProjectionMatrix();
}

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.03, 1500);
const SIT = 0.78; // seated eye height above the seat
const sp = free.points;
const REST: Pose = { cat: false, falls: 0, phase: 0, rowing: false, motor: 0, rudder: 0, damage: 0 };
const views: Record<string, View> = {
  water: { pos: [3.6, 1.5, 3.3], target: [0, 0.15, 0], fov: 50 },
  'water-aft': { pos: [-3.8, 1.3, -2.9], target: [0, 0.15, 0], fov: 50 },
  top: { pos: [0.01, 5.2, 0], target: [0, 0, 0], fov: 50 },
  row: { pos: [2.2, 2.0, 4.6], target: [0, 0.1, 0], fov: 55, pose: { rowing: true, phase: 0.2 } },
  'row-catch': { pos: [1.4, 2.6, -4.2], target: [0, 0.1, 0], fov: 55, pose: { rowing: true, phase: 0.0 } },
  seat: { pos: [sp.seat.x, sp.seat.y + SIT, 0], target: [-1.8, 0.25, 0], fov: 72, pose: { rowing: true, phase: 0.02 } },
  'seat-recovery': { pos: [sp.seat.x, sp.seat.y + SIT, 0], target: [-1.8, 0.25, 0], fov: 72, pose: { rowing: true, phase: 0.7 } },
  helm: { pos: [sp.helm.x, sp.helm.y + SIT, sp.helm.z], target: [3.0, 0.35, 0.1], fov: 72, pose: { motor: 0.6, rudder: 0.15 } },
  motoring: { pos: [-3.8, 1.2, 2.0], target: [-1.2, 0.15, 0], fov: 50, pose: { motor: 0.8, rudder: 0.3 } },
  'motor-up': { pos: [-3.8, 1.2, 2.0], target: [-1.2, 0.15, 0], fov: 50, pose: { motor: 0 } },
  'damage-half': { pos: [2.6, 1.1, 2.6], target: [0, 0.2, 0], fov: 50, pose: { damage: 0.5 } },
  'damage-full': { pos: [2.6, 1.1, 2.6], target: [0, 0.2, 0], fov: 50, pose: { damage: 1 } },
  'damage-port': { pos: [-1.2, 1.0, -3.2], target: [0, 0.2, 0], fov: 50, pose: { damage: 1 } },
  davits: { pos: [-15, 2.6, -3.5], target: [-5.5, 1.8, 0], fov: 50, pose: { cat: true } },
  'davits-close': { pos: [-10, 2.4, -2.6], target: [-6.0, 1.5, 0.1], fov: 50, pose: { cat: true } },
  'davits-side': { pos: [-6.3, 2.2, -8.5], target: [-5.8, 1.6, 0], fov: 50, pose: { cat: true } },
  'davits-low': { pos: [-10, 2.4, -2.6], target: [-6.0, 1.0, 0.1], fov: 50, pose: { cat: true, falls: 0.7 } },
  launched: { pos: [-6.55, 0.35 + 1.62, -2.1], target: [-6.05, 0.0, 0.2], fov: 72, pose: { cat: true, falls: 1 } },
  'steps-clear': { pos: [-5.0, 2.4, -2.7], target: [-6.25, 1.0, -1.6], fov: 65, pose: { cat: true } },
  cockpit: { pos: [-3.2, 3.1, 0.2], target: [-6.0, 1.6, 0.1], fov: 65, pose: { cat: true } },
};

let clock = 0;
function view(name: string): string {
  const v = views[name];
  if (!v) return 'no such view';
  const pose: Pose = { ...REST, ...v.pose };
  free.group.visible = !pose.cat;
  cat.group.visible = pose.cat;
  free.rig.setOars(pose.phase, pose.rowing);
  for (let k = 0; k < 30; k++) free.rig.setMotor(pose.motor, (clock += 0.05));
  free.rig.setRudder(pose.rudder);
  free.rig.setDamage(pose.damage);
  cat.rig.setFalls(pose.falls);
  hung.group.position.copy(cat.rig.status().dinghyOrigin);
  hung.rig.setStowed(pose.falls < 0.99);
  if (pose.cat) shadowAt(new THREE.Vector3(-4, 1, 0), 12);
  else shadowAt(new THREE.Vector3(0, 0, 0), 4);
  camera.position.set(...v.pos);
  camera.fov = v.fov;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  camera.lookAt(new THREE.Vector3(...v.target));
  renderer.render(scene, camera);
  return 'ok';
}

let meshes = 0;
free.group.traverse((o) => {
  if ((o as THREE.Mesh).isMesh) meshes++;
});
window.__dinghy = {
  ready: true,
  views: Object.keys(views),
  view,
  info: { triangles: free.triangles, meshes, buildMs: Math.round(buildMs), length: free.length, beam: free.beam },
};
