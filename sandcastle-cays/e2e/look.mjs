// Takes screenshots of a sample castle from a few angles (for checking the look).
//   node e2e/look.mjs [prefix]
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'e2e/output');
mkdirSync(out, { recursive: true });
const prefix = process.argv[2] ?? 'look';
const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome'].find(existsSync);
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 760 } })).newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await page.goto('file://' + join(root, 'dist/index.html'));
await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 180000 });
await page.evaluate(() => window.__game.start());
await page.evaluate(() => window.__game.demo());
await new Promise((r) => setTimeout(r, 6000));
const views = [
  ['wide', [0.35, 0.42, 4.2, 0.4, 0.2, 0.9]],
  ['castle', [0.6, 0.38, 1.7, -0.3, 0.3, 1.2]],
  ['heaps', [-0.5, 0.35, 1.6, 1.7, 0.3, 1.0]],
  ['hole', [0.2, 0.75, 1.3, 0.4, 0.05, -0.6]],
];
for (const [name, st] of views) {
  await page.evaluate((s) => window.__game.camera.setState(s), st);
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: join(out, `${prefix}-${name}.png`) });
  console.log('saved', `${prefix}-${name}.png`);
}
await browser.close();
