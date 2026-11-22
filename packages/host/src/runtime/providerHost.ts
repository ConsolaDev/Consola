// @effect-diagnostics nodeBuiltinImport:off - Paths under the state folder are joined once, here.
import { join } from 'node:path';
import { DEFAULT_SERVER_SETTINGS } from '@t3tools/contracts';
import { ProviderCredentialError } from '@t3tools/provider-core/server/errors';
import * as ProviderHost from '@t3tools/provider-core/server/ProviderHost';
import * as HostProcess from '@t3tools/shared/HostProcess';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Stream from 'effect/Stream';
import { resolveAttachmentPath } from 't3/attachmentStore.ts';
import * as ModelManifest from 't3/provider/ModelManifest.ts';

/**
 * t3's `ProviderHost` for one Consola session, shaped like t3's own `ProviderHostLive`: every path
 * under `stateDir`, t3's default settings (nothing edits them here), and the bundled model
 * manifest's compatibility policy.
 *
 * The layer also sets `HostProcess.Environment` to `env`, the environment every CLI is started
 * with, so a CLI finds its own login there (its config folder, its keychain entry).
 *
 * Credentials are never stored: a CLI signs itself in from its own config, and the host keeps
 * nothing of it. Reading finds none, and writing or removing fails.
 */
export const makeProviderHost = (options: {
  readonly stateDir: string;
  readonly env: Record<string, string | undefined>;
}): Layer.Layer<ProviderHost.ProviderHost> => {
  const attachmentsDir = join(options.stateDir, 'attachments');
  const host = ProviderHost.ProviderHost.of({
    paths: {
      cwd: options.stateDir,
      baseDir: options.stateDir,
      stateDir: options.stateDir,
      providerStatusCacheDir: join(options.stateDir, 'caches'),
      attachmentsDir,
    },
    settings: {
      get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
      changes: Stream.empty,
      subscribe: Effect.succeed(Stream.empty),
    },
    shouldRunBackgroundWork: Effect.fn('ProviderHost.shouldRunBackgroundWork')(() =>
      Effect.succeed(true),
    ),
    resolveAttachmentPath: (attachment) => resolveAttachmentPath({ attachmentsDir, attachment }),
    credentials: Effect.fn('ProviderHost.credentials')((namespace, bindingId) =>
      Effect.succeed({
        binding: { owner: 't3' as const, key: `${namespace}:${bindingId}` },
        get: Effect.succeedNone,
        set: () =>
          Effect.fail(new ProviderCredentialError({ operation: 'set', cause: NEVER_STORED })),
        remove: Effect.fail(
          new ProviderCredentialError({ operation: 'remove', cause: NEVER_STORED }),
        ),
      }),
    ),
    compatibility: Effect.fn('ProviderHost.compatibility')((driver, version) =>
      Effect.succeed(
        ModelManifest.providerCompatibility(ModelManifest.BUNDLED_MODEL_MANIFEST, driver, version),
      ),
    ),
  });
  return Layer.mergeAll(
    Layer.succeed(ProviderHost.ProviderHost, host),
    Layer.succeed(HostProcess.Environment, options.env),
  );
};

const NEVER_STORED = 'The Consola host never stores credentials; a CLI keeps its own login.';
