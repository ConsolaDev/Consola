import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import * as NodeServices from '@effect/platform-node/NodeServices';
import {
  ClaudeSettings,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  type ModelSelection,
  ProviderDriverKind,
} from '@t3tools/contracts';
import {
  AcpRegistryDriver,
  type AcpRegistryDriverEnv,
} from '@t3tools/provider-acp-registry/server';
import {
  ClaudeAdapterV2,
  ClaudeDriver,
  type ClaudeDriverEnv,
} from '@t3tools/provider-claude/server';
import { CodexDriver, type CodexDriverEnv } from '@t3tools/provider-codex/server';
import type { ProviderAdapterDriverCreateError } from '@t3tools/provider-core/server/adapterDriver';
import type { AnyProviderDriver } from '@t3tools/provider-core/server/driver';
import * as IdAllocator from '@t3tools/provider-core/server/IdAllocator';
import type * as McpProviderSessions from '@t3tools/provider-core/server/McpProviderSessions';
import * as ProviderEventLoggers from '@t3tools/provider-core/server/ProviderEventLoggers';
import { OpenCodeDriver, type OpenCodeDriverEnv } from '@t3tools/provider-opencode/server';
import { PiDriver, type PiDriverEnv } from '@t3tools/provider-pi/server';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import type * as PlatformError from 'effect/PlatformError';
import * as Schema from 'effect/Schema';
import * as ServerConfig from 't3/config.ts';
import * as ProviderAdapterRegistry from 't3/orchestration-v2/ProviderAdapterRegistry.ts';
import * as PortScanner from 't3/preview/PortScanner.ts';
import * as ProviderInstallationGate from 't3/provider/ProviderInstallationGate.ts';
import type { SessionSpec } from '../core/sessionSpec.ts';
import { makeProviderHost } from './providerHost.ts';

export type HostDriversEnv =
  | AcpRegistryDriverEnv
  | ClaudeDriverEnv
  | CodexDriverEnv
  | OpenCodeDriverEnv
  | PiDriverEnv;

/**
 * The drivers a host runs, as t3's `BUILT_IN_DRIVERS` (`apps/server/src/provider/builtInDrivers.ts`)
 * lists them and in its order, less the CLIs a Consola session does not offer. Cursor is never
 * one of them.
 */
export const HOST_DRIVERS: ReadonlyArray<AnyProviderDriver<HostDriversEnv>> = [
  CodexDriver,
  ClaudeDriver,
  OpenCodeDriver,
  PiDriver,
  AcpRegistryDriver,
];

/** Which t3 driver runs each harness a `SessionSpec` names. */
export const DRIVER_KIND_BY_HARNESS: Readonly<Record<SessionSpec['harness'], ProviderDriverKind>> =
  {
    claude: ProviderDriverKind.make('claudeAgent'),
    codex: ProviderDriverKind.make('codex'),
    opencode: ProviderDriverKind.make('opencode'),
    pi: ProviderDriverKind.make('pi'),
    acp: ProviderDriverKind.make('acpRegistry'),
  };

/** t3's default model on the harness's default instance, for a session that names none. */
export function defaultModelSelection(harness: SessionSpec['harness']): ModelSelection {
  const driver = DRIVER_KIND_BY_HARNESS[harness];
  return {
    instanceId: defaultInstanceIdForDriver(driver),
    model: DEFAULT_MODEL_BY_PROVIDER[driver] ?? 'default',
  };
}

export class HarnessNotWiredError extends Schema.TaggedError<HarnessNotWiredError>()(
  'HarnessNotWiredError',
  { harness: Schema.String },
) {
  override get message(): string {
    return `This host cannot start a ${this.harness} session yet: only Claude is wired.`;
  }
}

/** Why `hostAdapters` could not build a session's adapter. */
export type HostAdaptersError =
  | HarnessNotWiredError
  | ProviderAdapterDriverCreateError
  | PlatformError.PlatformError
  | Schema.SchemaError;

/**
 * The adapter a session runs on, the way t3's Claude replay harness builds one
 * (`layerClaudeProviderAdapterRegistryReplay` in `ClaudeAdapterV2.testkit.ts`): t3's own
 * `createClaudeAdapterV2` in an adapter registry of one, but with the real Agent SDK runner in
 * place of the replay. No provider snapshot, probe or update check runs.
 *
 * `createClaudeAdapterV2` resolves the CLI with the copied `resolveClaudeSdkExecutablePath` and
 * passes it as `pathToClaudeCodeExecutable`, so the person's own `claude` runs, never the SDK's
 * bundled copy. `claude` sets t3's Claude settings, such as `binaryPath`; by default it is
 * `claude` on `env.PATH`.
 */
export const hostAdapters =
  (options: {
    readonly stateDir: string;
    readonly env: Record<string, string | undefined>;
    readonly claude?: Partial<typeof ClaudeSettings.Encoded>;
  }) =>
  (
    spec: SessionSpec,
  ): Layer.Layer<
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    HostAdaptersError,
    McpProviderSessions.McpProviderSessions
  > => {
    if (spec.harness !== 'claude') {
      return Layer.effect(
        ProviderAdapterRegistry.ProviderAdapterRegistryV2,
        Effect.fail(new HarnessNotWiredError({ harness: spec.harness })),
      );
    }
    const adapter = Schema.decodeEffect(ClaudeSettings)(options.claude ?? {}).pipe(
      Effect.flatMap((settings) =>
        ClaudeAdapterV2.createClaudeAdapterV2(
          {
            instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
            displayName: undefined,
            environment: [],
            enabled: true,
            config: settings,
          },
          {},
        ),
      ),
    );
    return ProviderAdapterRegistry.layerFromAdaptersEffect(
      adapter.pipe(Effect.map((created) => [created])),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          ClaudeAdapterV2.layerQueryRunner.pipe(
            Layer.provide(
              Layer.mergeAll(
                // The host previews no ports, so it tracks no agent's listeners.
                PortScanner.layerTest,
                Layer.succeed(
                  ProviderEventLoggers.ProviderEventLoggers,
                  ProviderEventLoggers.NoOpProviderEventLoggers,
                ),
              ),
            ),
          ),
          IdAllocator.layer,
          ProviderInstallationGate.layer,
          // The adapter reads its attachments folder here: t3's server paths under the state folder.
          ServerConfig.layerTest(options.stateDir, options.stateDir),
          makeProviderHost({ stateDir: options.stateDir, env: options.env }),
        ),
      ),
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );
  };
