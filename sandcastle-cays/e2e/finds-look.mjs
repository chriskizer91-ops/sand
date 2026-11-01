// Builds a tiny preview page of all the beachcombing finds and the basket,
// then screenshots it from a few angles (for judging the look).
//   node e2e/finds-look.mjs [prefix]    -> e2e/output/<prefix>-<view>.png
import * as esbuild from 'esbuild';
import { chromium } from 'playwright-core';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'e2e/output');
mkdirSync(out, { recursive: true });
const prefix = process.argv[2] ?? 'finds';

const built = await esbuild.build({
  entryPoints: [join(root, 'e2e/finds-preview.ts')],
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  write: false,
  logLevel: 'warning',
});
const code = built.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Finds preview</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#cfe6f5}canvas{display:block}</style></head>
<body><script>${code}</script></body></html>`;
const page = join(out, 'finds-preview.html');
writeFileSync(page, html);

const exe = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome',
  '/opt/pw-browsers/chromium',
].find(existsSync);
const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const tab = await (await browser.newContext({ viewport: { width: 1280, height: 760 } })).newPage();
tab.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
tab.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log('console:', m.text());
});
await tab.goto('file://' + page);
await tab.waitForFunction(() => window.__preview && window.__preview.ready, null, { timeout: 120000 });
const views = process.argv[3] ? process.argv[3].split(',') : await tab.evaluate(() => window.__preview.views);
for (const name of views) {
  await tab.evaluate((n) => window.__preview.view(n), name);
  await new Promise((r) => setTimeout(r, 300));
  await tab.screenshot({ path: join(out, `${prefix}-${name}.png`) });
  console.log('saved', `e2e/output/${prefix}-${name}.png`);
}
await browser.close();
