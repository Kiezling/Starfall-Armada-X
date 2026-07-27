/**
 * Builds a single self-contained HTML file that runs straight from the filesystem.
 *
 * The normal dist/ build cannot be opened via file:// — Chrome refuses to fetch a
 * `<script type="module">` across the opaque file origin, and the CSS is a separate request
 * for the same reason. So this build emits an IIFE bundle instead of an ES module and inlines
 * the JS and CSS into the HTML, leaving zero subresource requests. Since the game already
 * ships assetless (all geometry, textures, and audio are procedural), the result is genuinely
 * one portable file.
 *
 * Output: dist-single/starfall-armada-x.html
 */

import { build } from 'vite';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();
const TMP = join(ROOT, '.single-tmp');
const OUT_DIR = join(ROOT, 'dist-single');
const OUT_FILE = join(OUT_DIR, 'starfall-armada-x.html');

await rm(TMP, { recursive: true, force: true });

await build({
  root: ROOT,
  base: './',
  logLevel: 'error',
  build: {
    target: 'es2022',
    outDir: TMP,
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      // IIFE keeps the bundle a classic script, which file:// will execute.
      output: { format: 'iife', inlineDynamicImports: true, entryFileNames: 'bundle.js' },
    },
  },
});

let html = await readFile(join(TMP, 'index.html'), 'utf8');
const js = await readFile(join(TMP, 'bundle.js'), 'utf8');

// Vite names the CSS from the entry; find whatever stylesheet it linked.
const cssMatch = html.match(/<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/);
let css = '';
if (cssMatch) {
  css = await readFile(join(TMP, cssMatch[1].replace(/^\.?\//, '')), 'utf8');
  html = html.replace(cssMatch[0], `<style>\n${css}\n</style>`);
}

// Drop the emitted script tag (module or not) and inline the bundle as a classic script.
html = html.replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '');
html = html.replace('</body>', `<script>\n${js}\n</script>\n</body>`);

await mkdir(OUT_DIR, { recursive: true });
await writeFile(OUT_FILE, html, 'utf8');
await rm(TMP, { recursive: true, force: true });

const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0);
console.log(`[single] wrote ${OUT_FILE} (${kb} kB, 0 subresources)`);
