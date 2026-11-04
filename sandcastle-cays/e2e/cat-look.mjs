// Builds a preview page of the catamaran alone (e2e/cat-preview.ts) and screenshots it from
// outside (at anchor, under sail, at night) and from inside (cockpit, saloon, galley, chart table,
// both hull cabins, the flybridge helm, the trampoline, the swim steps), plus debug views with the
// walkable surfaces shown as dots, level by level. Saves to e2e/output/cat-*.png.
//   node e2e/cat-look.mjs [prefix] [view ...]
import * as esbuild from 'esbuild';
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'e2e/output');
mkdirSync(out, { recursive: true });
const prefix = process.argv[2] ?? 'cat';
const only = process.argv.slice(3);

const built = await esbuild.build({
  entryPoints: [join(root, 'e2e/cat-preview.ts')],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  write: false,
  logLevel: 'warning',
});
const code = built.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Catamaran preview</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#000}</style></head><body><script>${code}</script></body></html>`;
const page_path = join(out, 'cat-preview.html');
writeFileSync(page_path, html);

const exe = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome',
  '/opt/pw-browsers/chromium',
].find(existsSync);
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 760 } })).newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log('console:', m.text());
});
await page.goto('file://' + page_path);
await page.waitForFunction(() => window.__cat && window.__cat.ready, null, { timeout: 180000 });
console.log('info', JSON.stringify(await page.evaluate(() => window.__cat.info)));
const views = only.length ? only : await page.evaluate(() => window.__cat.views);
for (const name of views) {
  const r = await page.evaluate((n) => window.__cat.view(n), name);
  if (r !== 'ok') {
    console.log('view', name, r);
    continue;
  }
  await page.screenshot({ path: join(out, `${prefix}-${name}.png`) });
  console.log('saved', `${prefix}-${name}.png`);
}
await browser.close();
