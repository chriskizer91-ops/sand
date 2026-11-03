// Builds the garden preview page (e2e/garden-preview.ts) and screenshots it: the three crops at five
// growth steps in pots and in beds, ripe and not, thirsty and watered; the bed, the rain barrel (low and
// high) and the sign; the watering can in your hands, idle and pouring; and pots on the sloop's cabin-top
// trays. Uses the game's own sky, sea and frame pipeline. Saves to e2e/output/<prefix>-<view>.png; add
// "phone" to also take the can in a Pixel-sized portrait window.
//   node e2e/garden-look.mjs [prefix] [view ...] [phone]
import * as esbuild from 'esbuild';
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'e2e/output');
mkdirSync(out, { recursive: true });
const args = process.argv.slice(2);
const phone = args.includes('phone');
const rest = args.filter((a) => a !== 'phone');
const prefix = rest[0] ?? 'garden';
const only = rest.slice(1);

const built = await esbuild.build({
  entryPoints: [join(root, 'e2e/garden-preview.ts')],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  write: false,
  logLevel: 'warning',
});
const code = built.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Garden preview</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#000}canvas{display:block}</style></head><body><script>${code}</script></body></html>`;
const pagePath = join(out, 'garden-preview.html');
writeFileSync(pagePath, html);

const exe = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome',
  '/opt/pw-browsers/chromium',
].find(existsSync);
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

async function shoot(viewport, tag, names) {
  const page = await (await browser.newContext({ viewport })).newPage();
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log('console:', m.text());
  });
  await page.goto('file://' + pagePath);
  await page.waitForFunction(() => window.__garden && window.__garden.ready, null, { timeout: 180000 });
  if (!tag) console.log('info', JSON.stringify(await page.evaluate(() => window.__garden.info)));
  const views = names ?? (await page.evaluate(() => window.__garden.views));
  for (const name of views) {
    const r = await page.evaluate((n) => window.__garden.view(n), name);
    if (r !== 'ok') {
      console.log('view', name, r);
      continue;
    }
    const file = `${prefix}-${tag ? tag + '-' : ''}${name}.png`;
    await page.screenshot({ path: join(out, file) });
    console.log('saved', `e2e/output/${file}`);
  }
  await page.close();
}

await shoot({ width: 1280, height: 760 }, '', only.length ? only : null);
// Pixel 7a-sized portrait window: the can as it sits on a tall phone screen.
if (phone) await shoot({ width: 412, height: 860 }, 'phone', ['held-can', 'held-can-pour', 'boat-trays']);
await browser.close();
