/**
 * The sea (WP-E): camera-centred Gerstner ocean with depth colours from heightTex, foam, storm swell.
 * STUB (lead): a flat translucent plane. WP-E replaces the body; keep the factory signature and API.
 */
import * as THREE from 'three';
import { SEA_LEVEL } from '../config';
import type { FrameCtx, PageSystem, SystemDeps } from './shared';

export interface OceanSystem extends PageSystem {
  /** Water surface height at a world point and time (matches what is drawn), for floating things. */
  waveHeight(x: number, z: number, t: number): number;
}

export function createOcean(deps: SystemDeps): OceanSystem {
  const g = new THREE.PlaneGeometry(20000, 20000);
  g.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0x2fb5c8, transparent: true, opacity: 0.75, depthWrite: false }));
  mesh.position.y = SEA_LEVEL;
  mesh.renderOrder = 1;
  deps.scene.add(mesh);
  return {
    name: 'ocean',
    waveHeight() {
      return SEA_LEVEL;
    },
    update(f: FrameCtx) {
      mesh.position.x = f.cam.target.x;
      mesh.position.z = f.cam.target.z;
    },
  };
}
