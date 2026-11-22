import { DEFAULT_SERVER_SETTINGS } from '@t3tools/contracts';
import * as ProviderHost from '@t3tools/provider-core/server/ProviderHost';
import * as HostProcess from '@t3tools/shared/HostProcess';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { describe, expect, it } from 'vite-plus/test';
import { makeProviderHost } from './providerHost.ts';

const STATE_DIR = '/tmp/sprocket/host-state';
const ENV = { PATH: '/opt/sprocket/bin', HOME: '/home/sprocket' };

const withHost = <A, E>(use: (host: ProviderHost.ProviderHost['Service']) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* ProviderHost.ProviderHost);
    }).pipe(Effect.provide(makeProviderHost({ stateDir: STATE_DIR, env: ENV }))),
  );

describe('makeProviderHost', () => {
  it('keeps every path under the state folder', () =>
    withHost((host) =>
      Effect.sync(() => {
        expect(host.paths).toEqual({
          cwd: STATE_DIR,
          baseDir: STATE_DIR,
          stateDir: STATE_DIR,
          providerStatusCacheDir: `${STATE_DIR}/caches`,
          attachmentsDir: `${STATE_DIR}/attachments`,
        });
      }),
    ));

  it('stores no credentials: reading finds none, and writing or removing fails', () =>
    withHost((host) =>
      Effect.gen(function* () {
        const credentials = yield* host.credentials('claudeAgent', 'sprocket');
        expect(Option.isNone(yield* credentials.get)).toBe(true);
        const written = yield* credentials.set(new TextEncoder().encode('acme')).pipe(Effect.flip);
        expect(written).toMatchObject({ _tag: 'ProviderCredentialError', operation: 'set' });
        const removed = yield* credentials.remove.pipe(Effect.flip);
        expect(removed).toMatchObject({ _tag: 'ProviderCredentialError', operation: 'remove' });
      }),
    ));

  it("answers with t3's default settings", () =>
    withHost((host) =>
      Effect.gen(function* () {
        expect(yield* host.settings.get).toEqual(DEFAULT_SERVER_SETTINGS);
      }),
    ));

  it('starts CLIs with the environment it was given', () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* HostProcess.Environment).toEqual(ENV);
      }).pipe(Effect.provide(makeProviderHost({ stateDir: STATE_DIR, env: ENV }))),
    ));
});
