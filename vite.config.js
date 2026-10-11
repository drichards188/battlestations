import { defineConfig } from 'vite';

export default defineConfig({
  // relative paths, so the built game runs from any folder (itch.io, GitHub Pages, a zip)
  base: './',
  // three.js and the procedural game ship as one ~1 MB chunk
  build: { chunkSizeWarningLimit: 1600 },
  server: { port: 5199 },
});
