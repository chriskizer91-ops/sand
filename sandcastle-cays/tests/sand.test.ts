import { describe, expect, it } from 'vitest';
import { CHECK_LIST, runSandCheck } from '../src/checks/sandChecks';
import { compress, decompress } from '../src/engine/save';

describe('sand rules (same checks as the in-game Checks page)', () => {
  for (const check of CHECK_LIST) {
    it(check.name, () => {
      const r = runSandCheck(check.id);
      console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}: ${r.detail} (${r.ms.toFixed(0)} ms)`);
      expect(r.pass, r.detail).toBe(true);
    }, 120000);
  }
});

describe('save files', () => {
  it('compress and decompress round-trip', async () => {
    const raw = new Uint8Array(50000);
    for (let n = 0; n < raw.length; n++) raw[n] = n % 7 === 0 ? 255 : n & 3;
    const z = await compress(raw);
    expect(z.length).toBeLessThan(raw.length / 4);
    const back = await decompress(z);
    expect(Array.from(back)).toEqual(Array.from(raw));
  });
});
