import { defineConfig } from 'vite';

export default defineConfig({
  // Rapier's lazily loaded chunk embeds its WASM (~4.3 MB, ~1.7 MB gzipped)
  build: { chunkSizeWarningLimit: 4500 },
  server: { port: 5199 },
});
