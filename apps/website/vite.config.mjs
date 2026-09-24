import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const path = (value) => fileURLToPath(new URL(value, import.meta.url));

export default defineConfig({
  root: path('./'),
  publicDir: 'public',
  resolve: { dedupe: ['react', 'react-dom'] },
  esbuild: { jsx: 'automatic' },
  build: {
    outDir: 'dist',
    rollupOptions: { input: { website: path('./index.html'), demo: path('./demo/index.html') } },
  },
  server: { port: 5174, host: '127.0.0.1' },
});
