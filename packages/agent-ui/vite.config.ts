import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/postcss';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite-plus';
import { playwright } from 'vite-plus/test/browser-playwright';
import { scopeCss } from './build/scopeCss.ts';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** t3's web app version (`apps/web/package.json` at d51d8c47), as its build stamps it. */
const T3_APP_VERSION = '0.1.11';

/**
 * The `import.meta.env` values t3's `vite.config.ts` defines, for a hosted build with no backend
 * of its own: no Clerk, no relay, no tracing, and `VITE_HOSTED_APP_CHANNEL` set, which is t3's
 * hosted static app (`hostedPairing.ts`): it discovers no environment at the page's origin, so the
 * only environment is the one `AgentChat` registers.
 */
const T3_ENV: Record<string, string> = {
  VITE_WS_URL: '',
  VITE_HTTP_URL: '',
  VITE_T3CODE_RELAY_URL: '',
  VITE_CLERK_PUBLISHABLE_KEY: '',
  VITE_CLERK_JWT_TEMPLATE: '',
  VITE_CLERK_CLI_OAUTH_CLIENT_ID: '',
  VITE_RELAY_OTLP_TRACES_URL: '',
  VITE_RELAY_OTLP_TRACES_DATASET: '',
  VITE_RELAY_OTLP_TRACES_TOKEN: '',
  VITE_HOSTED_APP_URL: '',
  VITE_HOSTED_APP_CHANNEL: 'latest',
  T3CODE_DESKTOP_UPDATE_REPOSITORY: '',
  T3CODE_FEATURE_SECRETS: '',
  VITE_RELEASE_CHANNEL: '',
  APP_VERSION: T3_APP_VERSION,
};

/**
 * Apple's device models are not redistributed (vendor/t3code/UPSTREAM.md): the five imports of
 * them in the copied `components/device/deviceModels.ts` resolve to an empty URL.
 */
const WITHHELD_ASSET = /\/components\/device\/models\/[\w-]+\.glb\?url$/;
const WITHHELD_MODULE = '\0consola-agent-ui:withheld-device-model';
const withheldDeviceModels = (): Plugin => ({
  name: 'consola-agent-ui:withheld-device-models',
  enforce: 'pre',
  resolveId(source, importer) {
    if (importer === undefined || !source.endsWith('.glb?url')) return null;
    const resolved = resolve(dirname(importer), source);
    return WITHHELD_ASSET.test(resolved) ? WITHHELD_MODULE : null;
  },
  load(id) {
    return id === WITHHELD_MODULE ? 'export default "";' : null;
  },
});

export default defineConfig({
  plugins: [withheldDeviceModels(), react({ compiler: true })],
  define: Object.fromEntries(
    Object.entries(T3_ENV).map(([name, value]) => [
      `import.meta.env.${name}`,
      JSON.stringify(value),
    ]),
  ),
  resolve: {
    tsconfigPaths: true,
    dedupe: ['react', 'react-dom'],
    alias: [
      {
        // t3's repository root, from `components/T3AppIcon.tsx` (vendor/t3code/UPSTREAM.md).
        find: '../../../../assets/prod/t3-black-web-apple-touch-180.png',
        replacement: here('./src/t3-root/assets/prod/t3-black-web-apple-touch-180.png'),
      },
    ],
  },
  assetsInclude: ['**/*.wasm'],
  css: {
    postcss: { plugins: [tailwindcss({ base: here('./src') }), scopeCss()] },
  },
  build: {
    lib: {
      entry: here('./src/index.ts'),
      formats: ['es'],
      fileName: 'agent-ui',
      cssFileName: 'agent-ui',
    },
    rolldownOptions: {
      external: [/^react($|\/)/, /^react-dom($|\/)/],
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        // Pre-bundled up front so a lazy import mid-run does not reload the page.
        optimizeDeps: { include: ['vite-plus/test/browser', 'react-dom/client'] },
        test: {
          name: 'browser',
          include: ['src/**/*.browser.test.tsx'],
          // A host replaying t3's `simple` fixture, on an isolated machine (see the file).
          globalSetup: ['./src/testing/hostSession.ts'],
          hookTimeout: 60_000,
          testTimeout: 60_000,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
            screenshotFailures: false,
          },
        },
      },
    ],
  },
});
