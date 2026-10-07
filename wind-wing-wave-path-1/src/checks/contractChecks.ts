/** Checks for the lead-owned contract pieces: the column grid and the patch grid. */
import { NX, PATCH_BLOCK } from '../config';
import { BLOCKS_X, ChangeFlag, Columns } from '../engine/columns';
import { PatchGrid } from '../eco/patches';
import { registerChecks } from './registry';

registerChecks('contract', [
  {
    id: 'columns-pack',
    label: 'Ground data packs correctly for the screen',
    quick: true,
    run() {
      const cols = new Columns();
      const c = cols.index(10, 20);
      cols.rock[c] = 5;
      cols.sed[c] = 1;
      cols.lava[c] = 2;
      cols.temp[c] = 0.5;
      cols.sandKind[c] = 200;
      cols.rockKind[c] = 1;
      const surf = new Float32Array(1);
      const ground = new Uint8Array(4);
      cols.packRect(10, 20, 1, 1, surf, ground);
      const ok = surf[0] === 8 && ground[0] === 40 && ground[1] === 128 && ground[2] === 50 && ground[3] === ((200 >> 2) << 2 | 1);
      return { pass: ok, detail: `surface ${surf[0]} m, bytes ${Array.from(ground).join(',')}` };
    },
  },
  {
    id: 'columns-undo-blocks',
    label: 'Undo copies each ground block once and restores it exactly',
    quick: true,
    run() {
      const cols = new Columns();
      const copies: number[] = [];
      const snaps = new Map<number, ReturnType<Columns['snapshotBlock']>>();
      cols.beforeModify = (b) => {
        copies.push(b);
        snaps.set(b, cols.snapshotBlock(b));
      };
      cols.recordId = 1;
      const c = cols.index(17, 33);
      cols.touch(c);
      cols.rock[c] = 9;
      cols.touch(c);
      cols.sed[c] = 3;
      cols.touchRect(0, 0, 40, 40);
      const b = (17 >> 4) + (33 >> 4) * BLOCKS_X;
      const firstCopies = copies.filter((x) => x === b).length;
      snaps.get(b) && cols.restoreBlock(snaps.get(b)!);
      const ok = firstCopies === 1 && cols.rock[c] === 0 && cols.sed[c] === 0 && copies.length === 9;
      return { pass: ok, detail: `block copied ${firstCopies}x, ${copies.length} blocks copied for a 41x41 rectangle` };
    },
  },
  {
    id: 'columns-listeners',
    label: 'Ground changes are reported to listeners, clamped to the zone',
    quick: true,
    run() {
      const cols = new Columns();
      let got: number[] = [];
      cols.addListener((i0, k0, i1, k1, f) => (got = [i0, k0, i1, k1, f]));
      cols.markChanged(-5, 3, NX + 10, 4, ChangeFlag.Geom | ChangeFlag.Burn);
      const ok = got[0] === 0 && got[2] === NX - 1 && got[4] === (ChangeFlag.Geom | ChangeFlag.Burn);
      return { pass: ok, detail: got.join(',') };
    },
  },
  {
    id: 'patches-blocks',
    label: 'Life-grid blocks snapshot and restore (with merging)',
    quick: true,
    run() {
      const g = new PatchGrid();
      const cover = g.add('cover', (n) => new Float32Array(n));
      const sp = g.add('sp', (n) => new Uint8Array(n), true, 2);
      g.add('derived', (n) => new Float32Array(n), false);
      const p = 5 + 9 * g.np;
      cover[p] = 0.5;
      sp[p * 2 + 1] = 7;
      const blk = PatchGrid.blockOf(p);
      const snap = g.snapshotBlock(blk);
      cover[p] = 0.1;
      sp[p * 2 + 1] = 3;
      g.restoreBlock(snap, (name, s, c) => (name === 'cover' ? Math.max(s, c) : s));
      const ok = Math.abs(cover[p] - 0.5) < 1e-6 && sp[p * 2 + 1] === 7 && snap.data.length === 2 && PATCH_BLOCK === 8;
      return { pass: ok, detail: `cover ${cover[p]}, species ${sp[p * 2 + 1]}, ${snap.data.length} saved fields` };
    },
  },
]);
