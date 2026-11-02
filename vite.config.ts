import { defineConfig } from 'vite';

// Relative base so the production build works from any sub-path
// (GitHub Pages, a static file server, or opened from disk via `vite preview`).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
