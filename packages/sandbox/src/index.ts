/**
 * The sandbox interface: code holds `Sandboxes` from `sandboxesFrom(provider)`; a provider
 * implements `SandboxProvider`. Everything here is free of I/O. A real provider, which reaches
 * the network, is exported from an entry point of its own, never from this one (`AGENTS.md`).
 */
export {
  CAPABILITY_ABILITIES,
  SANDBOX_CAPABILITIES,
  type SandboxCapability,
} from './domain/capabilities';
export { isSandboxError, SandboxError, type SandboxErrorCode } from './domain/errors';
export type { Command, CommandResult, CreateSandboxOptions, ExposedPort } from './domain/sandbox';
export type {
  ProviderCommand,
  ProviderKeepAlive,
  ProviderPausing,
  ProviderSandbox,
  ProviderSnapshots,
  SandboxProvider,
} from './application/ports';
export {
  type KeepAlive,
  type Pausing,
  type RunningCommand,
  requireCapability,
  type Sandbox,
  type Sandboxes,
  type Snapshots,
  sandboxesFrom,
} from './application/sandboxes';
export {
  CONTRACT_PROGRAMS,
  type ContractCheck,
  type ContractSubject,
  sandboxContract,
} from './contract/sandboxContract';
export { ContractFailure } from './contract/expect';
export {
  FAKE_DEFAULT_CWD,
  type FakeCommandRecord,
  type FakeFiles,
  type FakeProcess,
  type FakeProgram,
  FakeProvider,
  type FakeProviderOptions,
  type FakeSandboxRecord,
  type FakeTemplate,
} from './providers/fake/FakeProvider';
export { POSIX_PROGRAMS } from './providers/fake/posixPrograms';
