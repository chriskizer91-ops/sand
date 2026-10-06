/** The ring that shows where (and how big) your tool will act. */
import * as THREE from 'three';
import type { ToolId } from '../config';

const TOOL_COLOR: Record<ToolId, number> = {
  dig: 0xff9a4d,
  pile: 0xffe08a,
  pat: 0xffffff,
};

export class BrushCursor {
  readonly mesh: THREE.Mesh;
  private mat: THREE.MeshBasicMaterial;
  private target = new THREE.Vector3();
  private smooth = new THREE.Vector3();
  private normal = new THREE.Vector3(0, 1, 0);
  private visible = false;

  constructor() {
    const g = new THREE.RingGeometry(0.86, 1, 40);
    this.mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthTest: false, depthWrite: false });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.renderOrder = 10;
    this.mesh.visible = false;
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.08, 16), this.mat);
    this.mesh.add(dot);
  }

  show(x: number, y: number, z: number, nx: number, ny: number, nz: number, radius: number, tool: ToolId): void {
    this.target.set(x, y, z);
    this.normal.set(nx, ny, nz);
    this.mat.color.setHex(TOOL_COLOR[tool]);
    this.mesh.scale.setScalar(radius);
    if (!this.visible) this.smooth.copy(this.target);
    this.visible = true;
    this.mesh.visible = true;
  }

  hide(): void {
    this.visible = false;
    this.mesh.visible = false;
  }

  update(dt: number, time: number): void {
    if (!this.visible) return;
    this.smooth.lerp(this.target, 1 - Math.exp(-dt * 25));
    this.mesh.position.copy(this.smooth).addScaledVector(this.normal, 0.004);
    this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.normal);
    this.mat.opacity = 0.6 + 0.2 * Math.sin(time * 5);
  }
}
