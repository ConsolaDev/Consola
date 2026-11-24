import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
} from '@t3tools/contracts';
import type { ModelSelection } from '@t3tools/contracts';
import { AcpRegistryDriver } from '@t3tools/provider-acp-registry/server';
import type { AcpRegistryDriverEnv } from '@t3tools/provider-acp-registry/server';
import { ClaudeDriver } from '@t3tools/provider-claude/server';
import type { ClaudeDriverEnv } from '@t3tools/provider-claude/server';
import { CodexDriver } from '@t3tools/provider-codex/server';
import type { CodexDriverEnv } from '@t3tools/provider-codex/server';
import type { AnyProviderDriver } from '@t3tools/provider-core/server/driver';
import { OpenCodeDriver } from '@t3tools/provider-opencode/server';
import type { OpenCodeDriverEnv } from '@t3tools/provider-opencode/server';
import { PiDriver } from '@t3tools/provider-pi/server';
import type { PiDriverEnv } from '@t3tools/provider-pi/server';
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
 * of them. Not exported: the host only ever hydrates them guarded, as `HOST_DRIVERS`.
 */
const T3_HOST_DRIVERS: ReadonlyArray<AnyProviderDriver<HostDriversEnv>> = [
  CodexDriver,
  ClaudeDriver,
  OpenCodeDriver,
  PiDriver,
  AcpRegistryDriver,
];

/**
 * The drivers a host can run: `T3_HOST_DRIVERS`, each creating its instance without a CLI's login
 * (`withoutCliCredentialsDriver`). A session hydrates only the one its harness names
 * (`hostDriverFor`, `orchestration.ts`).
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

/**
 * The one driver a session hydrates: its harness's, guarded. No other provider instance exists in
 * the session's composition, so no other CLI is probed, nothing (a thread title, the model
 * picker's provider switch) can reach another provider, and t3's provider list names only this one.
 */
export function hostDriverFor(harness: SessionSpec['harness']): AnyProviderDriver<HostDriversEnv> {
  const kind = DRIVER_KIND_BY_HARNESS[harness];
  const driver = HOST_DRIVERS.find((candidate) => candidate.driverKind === kind);
  if (driver === undefined) throw new Error(`HOST_DRIVERS has no driver for ${harness}.`);
  return driver;
}

/**
 * Where a session's thread titles are generated: the session's own provider instance, on the model
 * t3 picks for that driver's text generation (`defaultTextGenerationModel` in
 * `@t3tools/shared/serverSettings`, not exported: its per-driver text model, else its default
 * model). t3 defaults `textGenerationModelSelection` to Codex whatever the thread runs on.
 */
export function titleModelSelection(spec: SessionSpec): ModelSelection {
  const driver = DRIVER_KIND_BY_HARNESS[spec.harness];
  return {
    instanceId: spec.modelSelection?.instanceId ?? defaultInstanceIdForDriver(driver),
    model:
      DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[driver] ??
      DEFAULT_MODEL_BY_PROVIDER[driver] ??
      'default',
  };
}
