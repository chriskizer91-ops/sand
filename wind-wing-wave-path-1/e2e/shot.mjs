// Screenshot tool for builders (lead-owned).
//   node e2e/shot.mjs [--html dist/index.html] [--phone] [--out e2e/output/shot.png]
//        [--cam x,z,dist,yaw,pitch] [--wait 1500] [--eval "js run in the page before the shot"] [--hash "#debug"]
// Prints page errors and render stats (triangles, draw calls).
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { LAPTOP, PHONE, launch, openGame, root, setCamera, sleep } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};
const phone = args.includes('--phone');
const out = opt('out', join(root, 'e2e/output/shot.png'));
mkdirSync(join(out, '..'), { recursive: true });
const browser = await launch();
const { page, errors } = await openGame(browser, phone ? PHONE : LAPTOP, opt('html'), opt('hash', ''));
await sleep(800);
const cam = opt('cam');
if (cam) {
  const [x, z, d, yaw, pitch] = cam.split(',').map(Number);
  await setCamera(page, x, z, d, yaw, pitch);
}
const ev = opt('eval');
if (ev) await page.evaluate(ev);
await sleep(Number(opt('wait', '1500')));
await page.screenshot({ path: out });
const stats = await page.evaluate(() => window.__game.stats());
console.log(`saved ${out}`);
console.log(`render: ${stats.triangles} triangles, ${stats.calls} draw calls, ${stats.programs} shader programs`);
if (errors.length) console.log('PAGE ERRORS:\n' + errors.join('\n'));
await browser.close();
