import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

// Deployed under a repository subpath on GitHub Pages, served from root locally.
const base = process.env.GITHUB_PAGES === 'true' ? '/Starfall-Armada-X/' : '/';

// Stamped into the page so a player (or anyone debugging a "did my fix actually deploy"
// question) can read off exactly which commit is live without trusting cache or CI logs.
// GITHUB_SHA is set by Actions and is the actual deployed commit; the git command covers local
// `npm run build`. Either can be missing (shallow clone, no .git), hence the 'dev' fallback.
function commitSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  base,
  define: {
    __BUILD_SHA__: JSON.stringify(commitSha()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    host: true,
    port: 5173,
  },
});
