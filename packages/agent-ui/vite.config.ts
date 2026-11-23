// @effect-diagnostics nodeBuiltinImport:off - Vite loads its config in Node, before any Effect runtime.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/postcss';
import react from '@vitejs/plugin-react';
import { esmExternalRequirePlugin } from 'vite/rolldown/plugins';
import { defineConfig, type Plugin } from 'vite-plus';
import { playwright } from 'vite-plus/test/browser-playwright';
import { serverSdkGuard, thirdPartyNotices, workerPlugins } from './build/bundleGuards.ts';
import { scopeCss } from './build/scopeCss.ts';
import { T3_APP_VERSION } from './build/t3Version.ts';
import { signPass } from './src/testing/passKeys.ts';

/** The notices the build writes (`build/bundleGuards.ts`): the library's, and its workers'. */
const notices = thirdPartyNotices();

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

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

/** The address of every WebSocket the tests' page opened since `watchSockets` first saw each page. */
const openedSockets: string[] = [];
/** The pages already watched: one listener each, whichever page a test file's browser hands over. */
const watchedPages = new WeakSet<object>();

/**
 * Vitest's browser mode, as t3 runs its `*.browser.test.tsx` files: Playwright's Chromium. One
 * object per project, as Vitest names a project's instances in place.
 */
const browser = () => ({
  enabled: true,
  headless: true,
  provider: playwright(),
  instances: [{ browser: 'chromium' as const }],
  screenshotFailures: false,
  commands: {
    /** The system's appearance for the page (`src/testing/render.tsx`); `null` resets it. */
    emulateColorScheme: (
      {
        page,
      }: { page: { emulateMedia(media: { colorScheme: 'light' | 'dark' | null }): Promise<void> } },
      colorScheme: 'light' | 'dark' | null,
    ) => page.emulateMedia({ colorScheme }),
    /** A pass for the tests' host, signed with the key it trusts (`src/testing/passKeys.ts`). */
    signHostPass: (
      _context: unknown,
      privateKeyFile: string,
      sessionId: string,
      lifetimeSeconds: number,
    ) => signPass(privateKeyFile, sessionId, lifetimeSeconds),
    /** Starts recording the address of each WebSocket the page opens (Playwright's event). */
    watchSockets: ({
      page,
    }: {
      page: { on(event: 'websocket', listener: (socket: { url(): string }) => void): void };
    }) => {
      if (watchedPages.has(page)) return;
      watchedPages.add(page);
      page.on('websocket', (socket) => openedSockets.push(socket.url()));
    },
    /** Every address `watchSockets` recorded. */
    openedSockets: () => [...openedSockets],
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
    dedupe: ['react', 'react-dom'],
    alias: [
      // t3's `~/` (`apps/web/tsconfig.json` paths), as an alias so Vite's dependency scan follows it.
      { find: /^~\//, replacement: `${here('./src/t3')}/` },
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
  worker: { plugins: () => workerPlugins(notices) },
  build: {
    lib: {
      entry: here('./src/index.ts'),
      formats: ['es'],
      fileName: 'agent-ui',
      cssFileName: 'agent-ui',
    },
    rolldownOptions: {
      // React is the page's (`react` and `react-dom` are peers), so the library imports it.
      // The plugin marks it external and turns the CommonJS dependencies' `require('react')`
      // (`use-sync-external-store`'s shim, …) into imports too: left as `require`, it throws
      // in a browser, which has none.
      plugins: [
        serverSdkGuard(),
        esmExternalRequirePlugin({ external: [/^react($|\/)/, /^react-dom($|\/)/] }),
        notices.main,
      ],
      // Modules run in source order across the library's chunks. Without it a shared chunk runs
      // before the entry's own modules, t3's theme module among them, ahead of
      // `src/t3Document.ts`, which must run first (it keeps t3 from writing the page at import).
      output: { strictExecutionOrder: true },
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'build/**/*.test.ts'],
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
          // One page at a time: each file's page starts with nothing shown.
          fileParallelism: false,
          // A host replaying t3's `simple` fixture, on an isolated machine (see the file).
          globalSetup: ['./src/testing/hostSession.ts'],
          hookTimeout: 60_000,
          testTimeout: 60_000,
          browser: browser(),
        },
      },
      {
        extends: true,
        // What the built library imports from the page: React (`build.rolldownOptions.external`).
        optimizeDeps: {
          include: [
            'vite-plus/test/browser',
            'react',
            'react/jsx-runtime',
            'react/compiler-runtime',
            'react-dom',
            'react-dom/client',
          ],
        },
        test: {
          // The built library (`pnpm build` first; `pnpm test:dist`, which CI runs after the build).
          name: 'dist',
          include: ['src/**/*.dist.test.tsx'],
          hookTimeout: 60_000,
          testTimeout: 60_000,
          browser: browser(),
        },
      },
    ],
  },
});
