import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

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

/**
 * Where each region's cell listens, read from the same variables cloud-global's outbox reads
 * (`CELL_URL_EU`, `CELL_URL_US`), with the cells' dev addresses as defaults. The page reaches a
 * region's cell at `/cell/<region>/…` on its own origin, so the cell needs no CORS and the page
 * holds no address of its own.
 */
const CELLS: Record<string, string> = {
  eu: process.env.CELL_URL_EU ?? 'http://127.0.0.1:3101',
  us: process.env.CELL_URL_US ?? 'http://127.0.0.1:3102',
};

const cellProxies = Object.fromEntries(
  Object.entries(CELLS).map(([region, target]) => {
    const prefix = `/cell/${region}`;
    return [prefix, { target, rewrite: (path: string) => path.slice(prefix.length) || '/' }];
  }),
);

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

export default defineConfig({
  plugins: [react(), agentUiNotices()],
  server: {
    port: 5175,
    strictPort: true,
    host: 'localhost',
    proxy: { '/api': { target: 'http://127.0.0.1:3100', xfwd: true }, ...cellProxies },
  },
  define: {
    __CONSOLA_COMMIT__: JSON.stringify(commit()),
    __CONSOLA_VERSION__: JSON.stringify(pkg.version),
  },
});
