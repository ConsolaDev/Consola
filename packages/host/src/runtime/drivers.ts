import {
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  type ModelSelection,
  ProviderDriverKind,
} from '@t3tools/contracts';
import {
  AcpRegistryDriver,
  type AcpRegistryDriverEnv,
} from '@t3tools/provider-acp-registry/server';
import { ClaudeDriver, type ClaudeDriverEnv } from '@t3tools/provider-claude/server';
import { CodexDriver, type CodexDriverEnv } from '@t3tools/provider-codex/server';
import type { AnyProviderDriver } from '@t3tools/provider-core/server/driver';
import { OpenCodeDriver, type OpenCodeDriverEnv } from '@t3tools/provider-opencode/server';
import { PiDriver, type PiDriverEnv } from '@t3tools/provider-pi/server';
import type { SessionSpec } from '../core/sessionSpec.ts';
import { withoutCliCredentialsDriver } from './credentials.ts';

export type HostDriversEnv =
  | AcpRegistryDriverEnv
  | ClaudeDriverEnv
  | CodexDriverEnv
  | OpenCodeDriverEnv
  | PiDriverEnv;

/**
 * t3's drivers for the CLIs a Consola session offers, as t3's `BUILT_IN_DRIVERS`
 * (`apps/server/src/provider/builtInDrivers.ts`) lists them and in its order. Cursor is never one
 * of them.
 */
export const T3_HOST_DRIVERS: ReadonlyArray<AnyProviderDriver<HostDriversEnv>> = [
  CodexDriver,
  ClaudeDriver,
  OpenCodeDriver,
  PiDriver,
  AcpRegistryDriver,
];

/**
 * The drivers a host runs: `T3_HOST_DRIVERS`, each creating its instance without a CLI's login
 * (`withoutCliCredentialsDriver`). The host hydrates t3's provider instances from this list
 * (`orchestration.ts`).
 *
 * Claude's driver runs the person's own `claude`: its adapter resolves `binaryPath` with t3's
 * `resolveClaudeSdkExecutablePath` and passes it as `pathToClaudeCodeExecutable`, never the
 * SDK's bundled copy.
 */
export const HOST_DRIVERS: ReadonlyArray<AnyProviderDriver<HostDriversEnv>> = T3_HOST_DRIVERS.map(
  withoutCliCredentialsDriver,
);

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
