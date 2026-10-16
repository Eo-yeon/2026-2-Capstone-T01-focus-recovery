import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
export default defineConfig(({ mode }) => {
  const baseUrl = loadEnv(mode, import.meta.dirname, 'VITE_').VITE_API_BASE_URL || 'http://localhost:8080';
  const api = new URL(baseUrl);
  if (!['http:', 'https:'].includes(api.protocol) || api.username || api.password || api.pathname !== '/' || /[?#]/.test(baseUrl)) throw new Error('VITE_API_BASE_URL must be an HTTP(S) origin');
  const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, 'public/manifest.json'), 'utf8'));
  manifest.host_permissions = [`${api.protocol}//${api.hostname}/*`];
  return {
    base: './',
    publicDir: false,
    plugins: [{ name: 'api-host-permission', generateBundle() { this.emitFile({ type: 'asset', fileName: 'manifest.json', source: JSON.stringify(manifest, null, 2) }); } }],
    build: {
      emptyOutDir: mode !== 'development',
      sourcemap: false,
      rollupOptions: {
        input: { popup: resolve(import.meta.dirname, 'popup.html'), background: resolve(import.meta.dirname, 'src/background/index.ts') },
        output: { entryFileNames: '[name].js' },
      },
    },
  };
});
