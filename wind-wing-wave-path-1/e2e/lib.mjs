// Shared helpers for the browser checks and screenshot tools (lead-owned).
import { chromium } from 'playwright-core';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const base = '/opt/pw-browsers';
  const known = [join(base, 'chromium/chrome-linux/chrome')];
  if (existsSync(base)) for (const d of readdirSync(base)) known.push(join(base, d, 'chrome-linux/chrome'), join(base, d, 'chrome-linux64/chrome'));
  return known.find(existsSync);
}

/** Launch headless Chromium with software WebGL (SwiftShader). Frame rates here mean nothing. */
export async function launch() {
  return chromium.launch({
    executablePath: findChrome(),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--allow-file-access-from-files'],
  });
}

export const LAPTOP = { viewport: { width: 1280, height: 760 } };
export const PHONE = { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true };

export function gameUrl(htmlPath) {
  return 'file://' + resolve(htmlPath ?? join(root, 'dist/index.html'));
}

/** Open the game and wait until the engine reports ready. Collects page errors into `errors`. */
export async function openGame(browser, opts = LAPTOP, htmlPath, hash = '') {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  await page.goto(gameUrl(htmlPath) + hash);
  await page.waitForFunction(() => window.__game && window.__game.ready, null, { timeout: 180000 });
  return { ctx, page, errors };
}

/** Set the camera: target x, z, distance, yaw, pitch (radians), then let a few frames render. */
export async function setCamera(page, x, z, dist, yaw = -0.6, pitch = 0.75) {
  await page.evaluate(([x, z, d, yw, p]) => {
    const c = window.__game.camera;
    c.state = [x, 0, z, d, yw, p];
  }, [x, z, dist, yaw, pitch]);
  await sleep(400);
}
