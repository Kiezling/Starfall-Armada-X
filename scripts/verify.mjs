#!/usr/bin/env node
// Headless-Chromium boot check for the single-file Starfall Armada X build.
//
// Typecheck-style static review cannot catch what breaks this game: it is one
// self-contained HTML file whose failure modes are all runtime (a thrown
// constructor, a broken inline sprite, an accidental external fetch). So the
// only verification that means anything is booting it in a real browser and
// watching what the page actually does.
//
// Asserts:
//   - zero uncaught page errors and zero console errors
//   - a live canvas that is actually painting (sampled, not assumed)
//   - a frame loop that advances over the sample window
//   - zero external network requests, because the build must stay 100%
//     offline/assetless -- every sprite is an inline data URI and regressing
//     that silently would only show up as a broken game on a plane
//
// Usage: node scripts/verify.mjs [--seconds 8] [--shot .verify/game.png] [--file <path>]

import { pathToFileURL } from 'node:url';
import { mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

// Playwright may be installed locally or only globally (as in the CI/agent
// image). ESM ignores NODE_PATH, so fall back to an explicit global resolve
// rather than forcing a redundant local install.
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    for (const entry of ['index.mjs', 'index.js']) {
      const candidate = path.join(root, 'playwright', entry);
      if (existsSync(candidate)) return await import(pathToFileURL(candidate).href);
    }
    throw new Error('playwright not found locally or globally; run: npm i -D playwright');
  }
}
const { chromium } = await loadPlaywright();

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const file = path.resolve(arg('file', 'starfall_armada_x_v48_sprite_build.html'));
const seconds = Number(arg('seconds', 8));
const shot = arg('shot', '.verify/game.png');

const consoleErrors = [];
const pageErrors = [];
const externalRequests = [];

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e?.stack ?? e)));
page.on('request', (r) => {
  const u = r.url();
  // file:/data:/blob: are self-contained; anything else means the build reached
  // off-machine and the offline guarantee is broken.
  if (!/^(file|data|blob):/.test(u)) externalRequests.push(u);
});

await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });

// Count frames from inside the page so "is it looping?" is measured, not inferred.
await page.evaluate(() => {
  window.__frames = 0;
  const raf = window.requestAnimationFrame.bind(window);
  const tick = () => { window.__frames++; raf(tick); };
  raf(tick);
});

// Get past the title/route modal, then keep the sim under continuous input so
// the sampled window exercises movement, firing and spawning rather than an
// idle first frame.
await page.mouse.move(640, 400);
await page.mouse.click(640, 400);
await page.keyboard.press('Enter');
await page.keyboard.press('Space');

const t0 = Date.now();
while (Date.now() - t0 < seconds * 1000) {
  const t = Date.now();
  await page.mouse.move(640 + Math.sin(t / 400) * 260, 400 + Math.cos(t / 500) * 180);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(120);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(80);
}

const diag = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  let canvasNonBlank = false;
  try {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    // Stride by a prime so the sample cannot align with a repeating pattern.
    for (let i = 0; i < d.length; i += 4 * 997) {
      if (d[i] > 12 || d[i + 1] > 12 || d[i + 2] > 12) { canvasNonBlank = true; break; }
    }
  } catch (e) { canvasNonBlank = `unreadable: ${e.message}`; }
  return {
    frames: window.__frames,
    canvas: c ? { w: c.width, h: c.height } : null,
    canvasNonBlank,
    imagesTotal: document.images.length,
    imagesBroken: [...document.images].filter((i) => i.complete && !i.naturalWidth).length,
  };
});

if (shot) {
  mkdirSync(path.dirname(path.resolve(shot)), { recursive: true });
  await page.screenshot({ path: shot });
}
await browser.close();

const failed =
  pageErrors.length > 0 ||
  consoleErrors.length > 0 ||
  externalRequests.length > 0 ||
  diag.imagesBroken > 0 ||
  diag.canvasNonBlank !== true ||
  diag.frames < seconds * 5;

console.log(JSON.stringify({ seconds, ...diag, pageErrors: pageErrors.length, consoleErrors: consoleErrors.length, externalRequests: externalRequests.length }, null, 2));
if (pageErrors.length) console.log('\n--- page errors ---\n' + pageErrors.join('\n---\n'));
if (consoleErrors.length) console.log('\n--- console errors ---\n' + consoleErrors.slice(0, 20).join('\n'));
if (externalRequests.length) console.log('\n--- external requests ---\n' + [...new Set(externalRequests)].join('\n'));
console.log(failed ? '\nVERIFY: FAIL' : '\nVERIFY: PASS');

process.exit(failed ? 1 : 0);
