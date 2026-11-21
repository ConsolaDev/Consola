import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

function commit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    strictPort: true,
    host: 'localhost',
    proxy: { '/api': { target: 'http://127.0.0.1:3100', xfwd: true } },
  },
  define: {
    __CONSOLA_COMMIT__: JSON.stringify(commit()),
    __CONSOLA_VERSION__: JSON.stringify(pkg.version),
  },
});
