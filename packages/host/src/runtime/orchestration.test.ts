// @effect-diagnostics nodeBuiltinImport:off - The test gives the composition its own folders.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ProviderHost from '@t3tools/provider-core/server/ProviderHost';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as ServerConfig from 't3/config.ts';
import * as ServerSettings from 't3/serverSettings.ts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { HOST_DRIVERS } from './drivers.ts';
import { layerOrchestration } from './orchestration.ts';

const fetched: string[] = [];
beforeAll(() => {
  vi.stubGlobal('fetch', (input: string | URL | Request) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    return Promise.reject(new Error('This test makes no network request.'));
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  expect(fetched.splice(0)).toEqual([]);
});

const SETTINGS = {
  enableProviderUpdateChecks: false,
  threadTitleInstructions: 'Name it for Acme.',
};

describe('layerOrchestration', () => {
  it('gives the drivers t3’s own provider host, over the same paths and settings', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'consola-host-state-'));
    const home = mkdtempSync(join(tmpdir(), 'consola-host-home-'));
    mkdirSync(join(stateDir, 'userdata'), { recursive: true });
    writeFileSync(join(stateDir, 'userdata', 'settings.json'), JSON.stringify(SETTINGS));
    try {
      await Effect.gen(function* () {
        const context = yield* Layer.build(
          layerOrchestration({
            stateDir,
            env: { PATH: home, HOME: home },
            drivers: HOST_DRIVERS.slice(0, 0),
          }),
        );
        const host = Context.get(context, ProviderHost.ProviderHost);
        const config = Context.get(context, ServerConfig.ServerConfig);
        const settings = Context.get(context, ServerSettings.ServerSettingsService);

        expect(host.paths).toEqual({
          cwd: config.cwd,
          baseDir: config.baseDir,
          stateDir: config.stateDir,
          providerStatusCacheDir: config.providerStatusCacheDir,
          attachmentsDir: config.attachmentsDir,
        });
        expect(config.stateDir).toBe(join(stateDir, 'userdata'));
        expect(config.attachmentsDir).toBe(join(stateDir, 'userdata', 'attachments'));

        // One settings service: what the drivers read is the settings file.
        const read = yield* host.settings.get;
        expect(read).toEqual(yield* settings.getSettings);
        expect(read.threadTitleInstructions).toBe(SETTINGS.threadTitleInstructions);

        // No credential is stored: t3's credential store sits on the host's secret store.
        const credentials = yield* host.credentials('claudeAgent', 'sprocket');
        expect(Option.isNone(yield* credentials.get)).toBe(true);
        const written = yield* credentials.set(new TextEncoder().encode('acme')).pipe(Effect.flip);
        expect(written).toMatchObject({ _tag: 'ProviderCredentialError', operation: 'set' });
      }).pipe(Effect.scoped, Effect.runPromise);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
