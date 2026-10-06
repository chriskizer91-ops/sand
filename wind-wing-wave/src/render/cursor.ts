/**
 * The brush ring on the ground (WP-E), coloured by tool: ember (lava), stone grey (rock),
 * sand gold (sand), soft white (hands), sea blue (scoop), and a small eye ring for look.
 * STUB (lead): a plain ring. WP-E replaces the body; keep the factory signature.
 */
import * as THREE from 'three';
import type { FrameCtx, PageSystem, SystemDeps } from './shared';

export function createCursor(deps: SystemDeps): PageSystem {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.92, 1, 48),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthTest: false }),
  );
  ring.rotateX(-Math.PI / 2);
  ring.renderOrder = 10;
  deps.scene.add(ring);
  return {
    name: 'cursor',
    update(f: FrameCtx) {
      const b = f.brush;
      ring.visible = !!b && !f.watching;
      if (!b) return;
      ring.position.set(b.x, b.y + 0.3, b.z);
      ring.scale.setScalar(b.r);
    },
  };
}
