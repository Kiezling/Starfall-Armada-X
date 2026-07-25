import { defineConfig } from 'vite';

// Deployed under a repository subpath on GitHub Pages, served from root locally.
const base = process.env.GITHUB_PAGES === 'true' ? '/Starfall-Armada-X/' : '/';

export default defineConfig({
  base,
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
