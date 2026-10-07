// Builds the whole game into ONE html file: dist/index.html
//   node build.mjs            -> dist/index.html
//   node build.mjs --release  -> also copies it to builds/wind-wing-wave-v<version>.html
import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const release = process.argv.includes('--release');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version.replace(/\.0$/, '');

const common = {
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020', 'chrome90', 'safari15'],
  write: false,
  legalComments: 'none',
  logLevel: 'warning',
};

// 1. The island engine, which runs on a background thread (Web Worker).
const worker = await esbuild.build({ ...common, entryPoints: [join(root, 'src/engine/worker.ts')] });
const workerCode = worker.outputFiles[0].text;

// 2. The page, with the worker's code embedded as text.
const page = await esbuild.build({
  ...common,
  entryPoints: [join(root, 'src/main.ts')],
  define: { __WORKER_SOURCE__: JSON.stringify(workerCode), __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
});
const pageCode = page.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const template = readFileSync(join(root, 'src/index.html'), 'utf8');
const html = template.replace('<!--SCRIPT-->', () => `<script>${pageCode}</script>`);

const outArg = process.argv.indexOf('--out');
const outFile = outArg > 0 ? process.argv[outArg + 1] : 'dist/index.html';
mkdirSync(dirname(join(root, outFile)), { recursive: true });
writeFileSync(join(root, outFile), html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`Built ${outFile} (${kb} KB)`);

if (release) {
  mkdirSync(join(root, 'builds'), { recursive: true });
  const out = join(root, `builds/wind-wing-wave-v${version}.html`);
  copyFileSync(join(root, outFile), out);
  console.log(`Release copy: builds/wind-wing-wave-v${version}.html`);
}
