/**
 * A tiny preview scene for judging the beachcombing finds (built by
 * e2e/finds-look.mjs; not part of the game). All finds lie on flat warm sand
 * under a low-ish sun, plus the basket with a few finds in it, and a copy of
 * the basket held low-left in a first-person view.
 */
import * as THREE from 'three';
import { FIND_KINDS, type FindKind } from '../src/content/finds';
import { basketModel, basketSlots, findModel } from '../src/render/finds';

const W = window.innerWidth;
const H = window.innerHeight;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, W / H, 0.02, 400);

// ---------- sky (background and environment map) ----------
const sunDir = new THREE.Vector3(-0.7, 0.52, -0.3).normalize();
function skyDome(radius: number): THREE.Mesh {
  const g = new THREE.SphereGeometry(radius, 48, 24);
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const zen = new THREE.Color(0x3d9be9);
  const hor = new THREE.Color(0xd9f1ff);
  const ground = new THREE.Color(0xe2cfa4);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / radius;
    if (y >= 0) c.copy(hor).lerp(zen, Math.pow(y, 0.6));
    else c.copy(hor).lerp(ground, Math.min(1, -y * 6));
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, depthWrite: false, fog: false }));
}
scene.add(skyDome(300));

const envScene = new THREE.Scene();
envScene.add(skyDome(50));
const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(2.5, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(40, 36, 30) }));
sunDisc.position.copy(sunDir).multiplyScalar(45);
envScene.add(sunDisc);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(envScene, 0.02).texture;
scene.environmentIntensity = 0.7;

// ---------- lights ----------
const sun = new THREE.DirectionalLight(0xfff2d6, 2.9);
sun.position.copy(sunDir).multiplyScalar(6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = -1.8;
sc.right = 1.8;
sc.top = 1.8;
sc.bottom = -1.8;
sc.near = 0.5;
sc.far = 14;
sun.shadow.bias = -0.0002;
sun.shadow.normalBias = 0.004;
scene.add(sun, sun.target);
scene.add(new THREE.HemisphereLight(0xcfe9ff, 0xe8d4a8, 1.1));

// ---------- warm sand ----------
function sandTexture(): THREE.DataTexture {
  const n = 128;
  const data = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    const h = Math.sin(i * 12.9898) * 43758.5453;
    const r = h - Math.floor(h);
    const k = 0.93 + 0.07 * r;
    data.set([Math.round(255 * k), Math.round(250 * k), Math.round(240 * k), 255], i * 4);
  }
  const t = new THREE.DataTexture(data, n, n);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(60, 60);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
const sand = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshStandardMaterial({ color: 0xead6ab, map: sandTexture(), roughness: 1, metalness: 0 }),
);
sand.rotation.x = -Math.PI / 2;
sand.receiveShadow = true;
scene.add(sand);

// ---------- the finds ----------
const layout: [FindKind, number, number, number][] = [
  // kind, x, z, yaw
  ['cowrie', -0.6, 0.72, 0.3],
  ['calico-scallop', -0.36, 0.72, 0.1],
  ['sand-dollar', -0.1, 0.72, 0.0],
  ['nerite', 0.12, 0.72, 0.4],
  ['sunrise-tellin', 0.32, 0.72, -0.2],
  ['top-shell', 0.56, 0.72, 0.6],
  ['glass-white', -0.5, 0.36, 0.2],
  ['glass-green', -0.32, 0.36, 1.0],
  ['glass-brown', -0.15, 0.36, -0.6],
  ['glass-blue', 0.02, 0.36, 0.4],
  ['sea-bean', 0.2, 0.36, 0.8],
  ['feather', 0.5, 0.36, -0.3],
  ['driftwood', -0.75, -0.1, 0.25],
  ['plank', -0.05, -0.12, -0.12],
  ['rope', 0.62, -0.1, 0.0],
  ['coconut', -0.45, -0.55, 0.5],
  ['float', 0.3, -0.5, -0.8],
  // Pink Sand Cay finds, on a patch of pink sand
  ['netted-olive', -0.22, 1.08, 0.3],
  ['flamingo-tongue', 0.0, 1.08, -0.4],
  ['pumice', 0.24, 1.08, 0.2],
  // beach debris for repairs, along the back
  ['sailcloth', -0.6, -1.0, 0.35],
  ['net', 0.05, -1.02, -0.2],
  ['bottle', 0.62, -0.98, 0.9],
];
const PINK_Y = 0.001;
const pinkSand = new THREE.Mesh(
  new THREE.CircleGeometry(0.42, 48),
  new THREE.MeshStandardMaterial({ color: 0xf7c4b8, map: sand.material.map, roughness: 1, metalness: 0 }),
);
pinkSand.rotation.x = -Math.PI / 2;
pinkSand.scale.set(1, 0.45, 1);
pinkSand.position.set(0, PINK_Y, 1.08);
pinkSand.receiveShadow = true;
scene.add(pinkSand);
for (const [kind, x, z, yaw] of layout) {
  const m = findModel(kind);
  m.position.set(x, z > 0.95 ? PINK_Y : 0, z);
  m.rotation.y = yaw;
  scene.add(m);
}
if (layout.length !== FIND_KINDS.length) console.warn('preview layout is missing some finds');

// the basket on the sand, with a few finds in it
function filledBasket(kinds: FindKind[]): THREE.Group {
  const b = basketModel();
  const slots = basketSlots();
  kinds.forEach((k, i) => {
    const m = findModel(k);
    m.position.copy(slots[i]);
    m.rotation.y = i * 1.7;
    b.add(m);
  });
  return b;
}
const fill: FindKind[] = ['sand-dollar', 'cowrie', 'calico-scallop', 'glass-green', 'nerite', 'glass-blue', 'sunrise-tellin', 'top-shell', 'sea-bean', 'glass-white'];
const basket = filledBasket(fill);
basket.position.set(1.05, 0, 0.45);
basket.rotation.y = 0.4;
scene.add(basket);

// the basket held low-left, as in first person
const held = filledBasket(fill);
held.visible = false;
camera.add(held);
scene.add(camera);
held.position.set(-0.32, -0.56, -0.9);
held.rotation.set(0.55, 0.35, 0.1);

// ---------- views ----------
const views: Record<string, { pos: [number, number, number]; look: [number, number, number]; fov?: number; held?: boolean }> = {
  overview: { pos: [0.1, 1.8, 2.3], look: [0.1, 0, 0.0] },
  pink: { pos: [0.02, 0.34, 1.44], look: [0.02, 0, 1.08], fov: 45 },
  shellsL: { pos: [-0.36, 0.32, 1.05], look: [-0.36, 0, 0.72], fov: 45 },
  shellsR: { pos: [0.34, 0.32, 1.05], look: [0.34, 0, 0.72], fov: 45 },
  glass: { pos: [-0.12, 0.3, 0.7], look: [-0.12, 0, 0.36], fov: 50 },
  drift: { pos: [0.05, 0.95, 0.9], look: [0.0, 0, -0.25], fov: 55 },
  repair: { pos: [0.02, 0.75, -0.2], look: [0.02, 0, -1.0], fov: 55 },
  basket: { pos: [1.25, 0.62, 0.88], look: [1.05, 0.06, 0.45], fov: 50 },
  held: { pos: [0.1, 1.6, 2.3], look: [0.1, 0.0, 0.0], fov: 65, held: true },
};

function view(name: string): void {
  const v = views[name];
  camera.fov = v.fov ?? 60;
  camera.aspect = W / H;
  camera.updateProjectionMatrix();
  camera.position.set(...v.pos);
  camera.lookAt(new THREE.Vector3(...v.look));
  held.visible = !!v.held;
  renderer.render(scene, camera);
}

/** An ad-hoc camera, for close inspection while tuning. */
function look(pos: [number, number, number], target: [number, number, number], fov = 40): void {
  views.custom = { pos, look: target, fov };
  view('custom');
}

(window as unknown as { __preview: unknown }).__preview = { ready: true, view, look, scene, views: Object.keys(views) };
view('overview');
