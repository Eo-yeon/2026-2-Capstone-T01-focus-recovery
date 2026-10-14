import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig(({ mode }) => ({
  base: './',
  build: {
    emptyOutDir: mode !== 'development',
    sourcemap: false,
    rollupOptions: {
      input: { popup: resolve(import.meta.dirname, 'popup.html'), background: resolve(import.meta.dirname, 'src/background/index.ts') },
      output: { entryFileNames: '[name].js' },
    },
  },
}));
