/**
 * The land (WP-E): GPU-displaced CDLOD terrain from heightTex plus the ground shader (terrainMaterial.ts).
 * STUB (lead): a plain CPU mesh at 8 m spacing, rebuilt when heights change, coloured by height.
 * WP-E replaces the body; keep the factory signature.
 */
import * as THREE from 'three';
import { CELL, NX, NZ, ORIGIN_X, ORIGIN_Z } from '../config';
import type { FrameCtx, PageSystem, SystemDeps } from './shared';

export function createTerrain(deps: SystemDeps): PageSystem {
  const { scene, fields } = deps;
  const S = 4; // columns per vertex step
  const n = NX / S + 1;
  const g = new THREE.PlaneGeometry(NX * CELL, NZ * CELL, n - 1, n - 1);
  g.rotateX(-Math.PI / 2);
  g.translate(ORIGIN_X + (NX * CELL) / 2, 0, ORIGIN_Z + (NZ * CELL) / 2);
  const colors = new Float32Array(n * n * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(g, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  scene.add(mesh);
  let version = -1;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const col = new THREE.Color();
  return {
    name: 'terrain',
    update(f: FrameCtx) {
      void f;
      if (fields.colsVersion === version) return;
      version = fields.colsVersion;
      for (let vz = 0; vz < n; vz++) {
        for (let vx = 0; vx < n; vx++) {
          const v = vx + vz * n;
          const x = pos.getX(v);
          const z = pos.getZ(v);
          const h = fields.heightAt(x, z);
          pos.setY(v, h);
          const lava = fields.lavaAt(x, z);
          if (lava > 0.05) col.setRGB(1, 0.35, 0.05);
          else if (h < 0) col.setRGB(0.75, 0.68, 0.5);
          else if (h < 3) col.setRGB(0.93, 0.85, 0.65);
          else col.setRGB(0.35 + h * 0.002, 0.45, 0.3);
          colors[v * 3] = col.r;
          colors[v * 3 + 1] = col.g;
          colors[v * 3 + 2] = col.b;
        }
      }
      pos.needsUpdate = true;
      (g.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
      g.computeVertexNormals();
      void ORIGIN_X;
      void ORIGIN_Z;
      void NZ;
    },
  };
}
