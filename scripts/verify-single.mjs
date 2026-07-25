/**
 * Verifies the single-file build actually boots from a file:// URL, which is the only thing
 * that makes it useful. A dist/ build passes every other check and still fails here, because
 * file:// cannot fetch module scripts — so this is checked directly rather than assumed.
 */

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const FILE = join(process.cwd(), 'dist-single', 'starfall-armada-x.html');
if (!existsSync(FILE)) {
  console.error('[single] no build — run scripts/build-single.mjs first');
  process.exit(1);
}

const BUNDLED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  ...(existsSync(BUNDLED) ? { executablePath: BUNDLED } : {}),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const pageErrors = [];
const consoleErrors = [];
const external = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('request', (r) => { if (!r.url().startsWith('file://') && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) external.push(r.url()); });

await page.goto(pathToFileURL(FILE).href, { waitUntil: 'load', timeout: 45000 });
await page.waitForTimeout(2500);
await page.mouse.click(640, 360);
await page.keyboard.press('Enter');
await page.waitForTimeout(3000);

const state = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  const gl = c && (c.getContext('webgl2') || c.getContext('webgl'));
  return {
    hasCanvas: !!c,
    hasGl: !!gl,
    booted: !!window.__starfall,
    state: window.__starfall?.state,
  };
});

await page.screenshot({ path: join(process.cwd(), '.verify', 'single-file.png') });
await browser.close();

console.log(JSON.stringify({ ...state, pageErrors: pageErrors.length, consoleErrors: consoleErrors.length, external: external.length }, null, 2));
for (const e of [...pageErrors, ...consoleErrors].slice(0, 5)) console.log('  ERR', e.slice(0, 300));

const ok = state.hasCanvas && state.hasGl && state.booted && pageErrors.length === 0 && consoleErrors.length === 0 && external.length === 0;
console.log(`RESULT: ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
