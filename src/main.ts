/**
 * Entry point.
 *
 * Keeps almost nothing itself: it mounts the game, and it makes a WebGL failure explain itself
 * rather than presenting the player with a blank black page.
 */

import { Game } from './game';

const container = document.getElementById('app');

if (!container) {
  throw new Error('[starfall] #app container is missing from index.html');
}

/**
 * Small always-on build stamp in the corner. Exists so "did my fix actually deploy" has a
 * one-glance answer instead of trusting cache state or CI logs -- Pages/CDN caching and the
 * feature-branch-only deploy gate both make "the site looks unchanged" ambiguous otherwise.
 */
function showBuildStamp(): void {
  const el = document.createElement('div');
  el.textContent = `${__BUILD_SHA__} · ${__BUILD_TIME__.slice(0, 16).replace('T', ' ')}`;
  el.style.cssText =
    'position:fixed;right:6px;bottom:4px;z-index:9999;pointer-events:none;' +
    'font:10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#3d5266;' +
    'letter-spacing:.03em;user-select:text;';
  document.body.append(el);
}

function showFatal(message: string, detail: string): void {
  const el = document.createElement('div');
  el.style.cssText =
    'position:fixed;inset:0;display:grid;place-items:center;padding:32px;text-align:center;' +
    'font:16px/1.6 ui-sans-serif,system-ui,sans-serif;color:#bfe9ff;background:#04060f;';
  const inner = document.createElement('div');
  inner.style.maxWidth = '52ch';
  const h = document.createElement('h1');
  h.textContent = 'Starfall Armada X';
  h.style.cssText = 'font-size:28px;letter-spacing:.18em;text-transform:uppercase;margin:0 0 16px;';
  const p = document.createElement('p');
  p.textContent = message;
  const small = document.createElement('p');
  small.textContent = detail;
  small.style.cssText = 'color:#5f7d94;font-size:13px;margin-top:12px;';
  inner.append(h, p, small);
  el.append(inner);
  document.body.append(el);
}

showBuildStamp();

try {
  const game = new Game(container);
  game.start();

  // Surfaced for debugging and for the verification harness; harmless in production.
  (window as unknown as { __starfall?: Game }).__starfall = game;
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  console.error('[starfall] failed to start:', err);
  showFatal(
    'This game needs WebGL 2, which your browser or graphics driver did not provide.',
    detail,
  );
}
