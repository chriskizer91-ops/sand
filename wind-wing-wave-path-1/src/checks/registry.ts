/**
 * The checks registry. Each work package registers its checks here (in its own
 * checks/<area>Checks.ts file, imported by checks/all.ts). vitest runs every check
 * (tests/checks.test.ts); the in-game checks page runs the `quick` ones on the
 * owner's own device.
 *
 * Checks run in the engine context (worker or page fallback) and must not touch the DOM.
 */

export interface CheckResult {
  group: string;
  id: string;
  /** Plain-language label shown to the owner. */
  label: string;
  pass: boolean;
  /** Plain-language detail (measured numbers, etc.). */
  detail: string;
  ms: number;
}

export interface CheckDef {
  id: string;
  label: string;
  /** Run on the in-game checks page (keep under ~1 s each). */
  quick: boolean;
  /**
   * The result depends on how fast the computer is (a time limit). `npm test` reports a miss of
   * these as a warning, because a shared build machine can be twice as slow as the laptop the
   * limits are set for; set STRICT_SPEED=1 to make a miss fail (on a real laptop). The in-game
   * checks page always shows the plain result for the device it runs on.
   */
  timing?: boolean;
  /** Return pass/fail and a plain detail line. May throw (counts as a fail). */
  run(): { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>;
}

const groups = new Map<string, CheckDef[]>();

export function registerChecks(group: string, checks: CheckDef[]): void {
  const list = groups.get(group) ?? [];
  for (const c of checks) {
    if (list.some((x) => x.id === c.id)) throw new Error(`Duplicate check id ${group}/${c.id}`);
    list.push(c);
  }
  groups.set(group, list);
}

export function allChecks(): { group: string; check: CheckDef }[] {
  const out: { group: string; check: CheckDef }[] = [];
  for (const [group, list] of groups) for (const check of list) out.push({ group, check });
  return out;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export async function runChecks(filter: { quick?: boolean; group?: string } = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const { group, check } of allChecks()) {
    if (filter.quick && !check.quick) continue;
    if (filter.group && filter.group !== group) continue;
    const t0 = now();
    try {
      const r = await check.run();
      results.push({ group, id: check.id, label: check.label, pass: r.pass, detail: r.detail, ms: now() - t0 });
    } catch (err) {
      results.push({ group, id: check.id, label: check.label, pass: false, detail: `Error: ${(err as Error).message}`, ms: now() - t0 });
    }
  }
  return results;
}
