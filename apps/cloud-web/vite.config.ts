import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

function commit(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

/**
 * Ships `@consola/agent-ui`'s notices beside the chat the build bundles from its `dist/`, as
 * `agent-ui/THIRD-PARTY-NOTICES` and `agent-ui/LICENSE` (that package's `AGENTS.md`,
 * "Build"): this app's own licence tooling sees one MIT package, never the packages
 * inside it.
 */
function agentUiNotices(): Plugin {
  return {
    name: 'consola:agent-ui-notices',
    apply: 'build',
    generateBundle() {
      const dist = dirname(createRequire(import.meta.url).resolve('@consola/agent-ui'));
      const notices = [
        [join(dist, 'THIRD-PARTY-NOTICES'), 'agent-ui/THIRD-PARTY-NOTICES'],
        [join(dist, '..', 'LICENSE'), 'agent-ui/LICENSE'],
      ];
      for (const [from, fileName] of notices) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(from, 'utf8') });
      }
    },
  };
}

/**
 * `@consola/factory-spec`, which the definition page checks a factory's files with, is linked
 * from the workspace and built as CommonJS (the API and the desktop `require` it). Vite reads a
 * linked package as ES modules unless told: so the dev server pre-bundles it, and the build
 * converts it as it does a package from `node_modules`.
 */
const COMMONJS_LINKED = ['@consola/factory-spec'];

export default defineConfig({
  plugins: [react(), agentUiNotices()],
  optimizeDeps: { include: COMMONJS_LINKED },
  build: {
    commonjsOptions: { include: [/packages\/factory-spec\//, /node_modules/] },
  },
  server: {
    port: 5175,
    strictPort: true,
    host: 'localhost',
    // The page and the API share one origin: `/api` goes to `cloud-api`, so the session cookie
    // is first-party and the API needs no CORS. The forwarded headers tell it the page's host.
    proxy: { '/api': { target: 'http://127.0.0.1:3100', xfwd: true } },
  },
  define: {
    __CONSOLA_COMMIT__: JSON.stringify(commit()),
  },
});
