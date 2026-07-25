/**
 * End-to-end verification harness.
 *
 * Typechecking proves the modules fit together; it proves nothing about whether the game
 * actually runs. This boots a real build in headless Chromium with a software GL backend,
 * watches for console errors and unhandled rejections, samples the frame rate, optionally
 * drives some input, and writes a screenshot.
 *
 * Usage:
 *   node scripts/verify.mjs                 # build, boot, 8s soak, screenshot
 *   node scripts/verify.mjs --seconds 20    # longer soak
 *   node scripts/verify.mjs --no-build      # reuse the existing dist/
 *   node scripts/verify.mjs --play          # also send synthetic input
 *   node scripts/verify.mjs --shot name.png # screenshot filename
 */

import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const SECONDS = Number(opt('--seconds', '8'));
const SHOT = opt('--shot', 'verify.png');
const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');
const SHOT_DIR = join(ROOT, '.verify');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/* Build ------------------------------------------------------------------------------------- */

if (!flag('--no-build')) {
  console.log('[verify] building...');
  const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8' });
  if (build.status !== 0) {
    console.error('[verify] BUILD FAILED');
    console.error(build.stdout || '');
    console.error(build.stderr || '');
    process.exit(1);
  }
  console.log('[verify] build ok');
}

if (!existsSync(DIST)) {
  console.error('[verify] no dist/ — run without --no-build first');
  process.exit(1);
}

/* Static server ------------------------------------------------------------------------------
 * Deliberately a plain static server with no network egress: if the game ever tries to fetch
 * an external asset, it fails here, which is exactly the regression we want to catch.
 */

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let filePath = join(DIST, normalize(urlPath));
    if (!filePath.startsWith(DIST)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (urlPath === '/' || !extname(filePath)) filePath = join(DIST, 'index.html');
    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/`;
console.log(`[verify] serving dist/ at ${url}`);

/* Browser ------------------------------------------------------------------------------------ */

// The environment ships a Chromium build that may not match this playwright version's
// expected revision, and downloading is disabled. Point at the preinstalled binary when it
// exists and let playwright resolve its own otherwise.
const BUNDLED_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({
  ...(existsSync(BUNDLED_CHROME) ? { executablePath: BUNDLED_CHROME } : {}),
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage',
    '--mute-audio',
  ],
});

const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await context.newPage();

const consoleErrors = [];
const consoleWarnings = [];
const pageErrors = [];
const failedRequests = [];
const externalRequests = [];

page.on('console', (msg) => {
  const text = msg.text();
  if (msg.type() === 'error') consoleErrors.push(text);
  else if (msg.type() === 'warning') consoleWarnings.push(text);
});
page.on('pageerror', (err) => pageErrors.push(err.stack || String(err)));
page.on('requestfailed', (req) => failedRequests.push(`${req.url()} :: ${req.failure()?.errorText}`));
page.on('request', (req) => {
  const u = req.url();
  if (!u.startsWith(url) && !u.startsWith('data:') && !u.startsWith('blob:')) {
    externalRequests.push(u);
  }
});

console.log('[verify] loading...');
let loadOk = true;
try {
  await page.goto(url, { waitUntil: 'load', timeout: 45000 });
} catch (err) {
  loadOk = false;
  pageErrors.push(`navigation failed: ${err.message}`);
}

// Give the app a moment to boot before we start measuring.
await page.waitForTimeout(1500);

/* WebGL sanity -------------------------------------------------------------------------------- */

const glInfo = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  if (!canvas) return { hasCanvas: false };
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  return {
    hasCanvas: true,
    width: canvas.width,
    height: canvas.height,
    hasContext: !!gl,
    version: gl ? gl.getParameter(gl.VERSION) : null,
  };
});

/* Optional synthetic input --------------------------------------------------------------------- */

let flying = false;
if (flag('--play')) {
  console.log('[verify] driving input...');
  await page.mouse.move(640, 360);
  await page.mouse.click(640, 360);
  await page.waitForTimeout(400);
  // Dismiss a title screen if one is present.
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  // Fire continuously, but do NOT hold throttle for the whole soak: flying straight for
  // seconds pins the ship against the arena wall, which leaves every screenshot under the
  // boundary-danger vignette and hides whatever the shot was meant to show.
  await page.keyboard.down('Space');
  flying = true;
  void (async () => {
    // Bank around the arena instead of charging out of it: short throttle bursts with
    // alternating turns, which also exercises steering, strafe, and drift.
    const turns = [
      ['KeyW', 900, 900, 300],
      ['KeyA', 500, 400, 420],
      ['KeyW', 700, 1180, 260],
      ['KeyD', 500, 300, 460],
    ];
    while (flying) {
      for (const [key, hold, mx, my] of turns) {
        if (!flying) return;
        await page.keyboard.down(key).catch(() => {});
        await page.mouse.move(mx, my, { steps: 8 }).catch(() => {});
        await page.waitForTimeout(hold).catch(() => {});
        await page.keyboard.up(key).catch(() => {});
      }
      if (!flying) return;
      await page.keyboard.press('ControlLeft').catch(() => {});
    }
  })();
}

/* Frame-rate sampling --------------------------------------------------------------------------
 * Measured inside the page so it reflects the actual rAF cadence. Note this is SwiftShader
 * software rendering, so absolute numbers are far below real hardware — the value here is
 * catching "the loop stopped" and "frame time exploded", not benchmarking.
 */

console.log(`[verify] soaking for ${SECONDS}s...`);
const perf = await page.evaluate(async (seconds) => {
  return await new Promise((resolve) => {
    let frames = 0;
    let worst = 0;
    let last = performance.now();
    const start = last;
    const tick = () => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      if (frames > 5 && dt > worst) worst = dt;
      frames++;
      if (now - start < seconds * 1000) requestAnimationFrame(tick);
      else resolve({ frames, elapsed: now - start, worstFrameMs: worst });
    };
    requestAnimationFrame(tick);
  });
}, SECONDS);

if (flag('--play')) {
  flying = false;
  for (const key of ['KeyW', 'KeyA', 'KeyD', 'Space']) {
    await page.keyboard.up(key).catch(() => {});
  }
}

/* Screenshot ----------------------------------------------------------------------------------- */

await mkdir(SHOT_DIR, { recursive: true });
const shotPath = join(SHOT_DIR, SHOT);
await page.screenshot({ path: shotPath });

await browser.close();
server.close();

/* Report ----------------------------------------------------------------------------------------- */

const fps = perf.frames / (perf.elapsed / 1000);

console.log('\n================ VERIFY REPORT ================');
console.log(`load:             ${loadOk ? 'ok' : 'FAILED'}`);
console.log(`canvas:           ${glInfo.hasCanvas ? `${glInfo.width}x${glInfo.height}` : 'MISSING'}`);
console.log(`webgl context:    ${glInfo.hasContext ? glInfo.version : 'MISSING'}`);
console.log(`frames:           ${perf.frames} in ${(perf.elapsed / 1000).toFixed(1)}s`);
console.log(`fps (swiftshader):${fps.toFixed(1)}`);
console.log(`worst frame:      ${perf.worstFrameMs.toFixed(1)}ms`);
console.log(`page errors:      ${pageErrors.length}`);
console.log(`console errors:   ${consoleErrors.length}`);
console.log(`console warnings: ${consoleWarnings.length}`);
console.log(`failed requests:  ${failedRequests.length}`);
console.log(`EXTERNAL requests:${externalRequests.length}  (must be 0 — the game ships assetless)`);
console.log(`screenshot:       ${shotPath}`);

const show = (label, list, limit = 8) => {
  if (!list.length) return;
  console.log(`\n--- ${label} ---`);
  for (const item of list.slice(0, limit)) console.log(`  ${String(item).slice(0, 500)}`);
  if (list.length > limit) console.log(`  ...and ${list.length - limit} more`);
};

show('PAGE ERRORS', pageErrors);
show('CONSOLE ERRORS', consoleErrors);
show('FAILED REQUESTS', failedRequests);
show('EXTERNAL REQUESTS', externalRequests);
show('CONSOLE WARNINGS', consoleWarnings, 5);

const hardFail =
  !loadOk ||
  !glInfo.hasCanvas ||
  !glInfo.hasContext ||
  pageErrors.length > 0 ||
  consoleErrors.length > 0 ||
  externalRequests.length > 0 ||
  perf.frames < 10;

console.log(`\nRESULT: ${hardFail ? 'FAIL' : 'PASS'}`);
console.log('===============================================\n');
process.exit(hardFail ? 1 : 0);
