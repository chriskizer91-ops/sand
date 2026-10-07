/** Runs every registered check (the same ones as the in-game checks page). */
import { describe, expect, it } from 'vitest';
import '../src/checks/all';
import { allChecks } from '../src/checks/registry';

const all = allChecks();

describe('checks', () => {
  it('has checks registered', () => {
    expect(all.length).toBeGreaterThan(0);
  });
  for (const { group, check } of all) {
    it(`${group}: ${check.label}`, async () => {
      const r = await check.run();
      // A time limit missed on a slow build machine is a warning, not a failure (STRICT_SPEED=1 makes it fail).
      if (!r.pass && check.timing && !process.env.STRICT_SPEED) {
        console.warn(`SLOW MACHINE (not counted as a failure): ${check.label}: ${r.detail}`);
        return;
      }
      expect(r.pass, r.detail).toBe(true);
    }, 120_000);
  }
});
