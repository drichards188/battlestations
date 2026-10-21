import { defineConfig } from 'vite';

export default defineConfig({
  // relative paths, so the built game runs from any folder (itch.io, GitHub Pages, a zip)
  base: './',
  build: {
    // three.js and the procedural game ship as one ~1 MB chunk
    chunkSizeWarningLimit: 1600,
    // the minifier drops the libraries' MIT notices, so the build carries them in a file
    license: { fileName: 'licenses.md' },
  },
  server: { port: 5199 },
});
