// Preview page for the sloop model alone (built and driven by e2e/sloop-look.mjs; not part of the game).
// The boat floats on a flat turquoise sea under a sunny sky, lit the way the game will light it:
// ACES filmic tone mapping, a sun with shadows, a hemisphere light and a sky environment map.
import * as THREE from 'three';
import { createSloop } from '../src/render/sloop';

interface View {
  pos: [number, number, number];
  target: [number, number, number];
  fov: number;
  dots?: boolean;
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
    },
    vertexShader: `varying vec3 vDir;
      void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        vec3 c = mix(horizon, top, pow(h, 0.5));
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
scene.add(new THREE.HemisphereLight(0xcfe9ff, 0xe8d4a8, 0.7));

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

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 1500);

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
  renderer.render(scene, camera);
  return 'ok';
}

window.__sloop = {
  ready: true,
  views: Object.keys(views),
  view,
  info: { triangles: boat.triangles, meshes: boat.group.children.length, buildMs: Math.round(buildMs), length: boat.length, beam: boat.beam, draft: boat.draft },
};
