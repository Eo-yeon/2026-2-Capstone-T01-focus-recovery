import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({
  publicDir: false,
  build: {
    emptyOutDir: false,
    sourcemap: false,
    lib: { entry: resolve(import.meta.dirname, 'src/content/index.ts'), formats: ['iife'], name: 'FocusRecovery', fileName: () => 'content.js' },
  },
});
