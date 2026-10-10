import { defineConfig } from 'vite';

export default defineConfig({
  // three.js and the procedural game ship as one ~1 MB chunk
  build: { chunkSizeWarningLimit: 1600 },
  server: { port: 5199 },
});
