// Builds a preview page of the weather effects (e2e/weather-preview.ts) and screenshots it: squalls on
// the horizon at midday, standing inside a heavy squall, at the edge of one, sunset, night, and spray over
// the bow. Saves to e2e/output/weather-*.png.
//   node e2e/weather-look.mjs [--phone] [view ...]
import * as esbuild from 'esbuild';
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'e2e/output');
mkdirSync(out, { recursive: true });
const args = process.argv.slice(2);
const phone = args.includes('--phone');
const only = args.filter((a) => !a.startsWith('--'));

const built = await esbuild.build({
  entryPoints: [join(root, 'e2e/weather-preview.ts')],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  write: false,
  logLevel: 'warning',
});
const code = built.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Weather preview</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#000}</style></head><body><script>${code}</script></body></html>`;
const pagePath = join(out, 'weather-preview.html');
writeFileSync(pagePath, html);

const exe = [
  '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium',
].find(existsSync);
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
// Laptop-shaped by default; --phone is a Pixel-shaped portrait view with the phone quality level.
const viewport = phone ? { width: 412, height: 860 } : { width: 960, height: 540 };
const page = await (await browser.newContext({ viewport })).newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log('console:', m.text());
});
await page.goto('file://' + pagePath + (phone ? '#phone' : ''));
await page.waitForFunction(() => window.__weather && window.__weather.ready, null, { timeout: 180000 });
console.log('info', JSON.stringify(await page.evaluate(() => window.__weather.info)));
const views = only.length ? only : await page.evaluate(() => window.__weather.views);
for (const name of views) {
  const t = Date.now();
  const r = await page.evaluate((n) => window.__weather.view(n), name);
  if (r !== 'ok') {
    console.log('view', name, r);
    continue;
  }
  const file = `weather-${phone ? 'phone-' : ''}${name}.png`;
  await page.screenshot({ path: join(out, file) });
  const stats = await page.evaluate(() => window.__weather.stats());
  console.log('saved', file, JSON.stringify(stats), `${Date.now() - t} ms`);
}
await browser.close();
