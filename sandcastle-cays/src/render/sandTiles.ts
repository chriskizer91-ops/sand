/** Holds the sand surface meshes sent by the engine (one mesh per 1.9 m tile). */
import * as THREE from 'three';

export class SandTiles {
  readonly group = new THREE.Group();
  private tiles = new Map<number, THREE.Mesh>();

  constructor(private material: THREE.Material) {
    this.group.name = 'sand';
  }

  update(tile: number, positions: Float32Array, normals: Int8Array, attrs: Uint8Array, indices: Uint32Array): void {
    const old = this.tiles.get(tile);
    if (indices.length === 0) {
      if (old) {
        this.group.remove(old);
        old.geometry.dispose();
        this.tiles.delete(tile);
      }
      return;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(normals, 3, true));
    g.setAttribute('sandAttr', new THREE.BufferAttribute(attrs, 4, true));
    g.setIndex(new THREE.BufferAttribute(indices, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    if (old) {
      old.geometry.dispose();
      old.geometry = g;
    } else {
      const mesh = new THREE.Mesh(g, this.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `tile-${tile}`;
      this.tiles.set(tile, mesh);
      this.group.add(mesh);
    }
  }

  clear(): void {
    for (const m of this.tiles.values()) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    this.tiles.clear();
  }

  get triangleCount(): number {
    let n = 0;
    for (const m of this.tiles.values()) n += (m.geometry.index?.count ?? 0) / 3;
    return n;
  }
}
