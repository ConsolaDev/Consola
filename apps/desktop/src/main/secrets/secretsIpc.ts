import { PERSONAL_FACTORY, type SecretBindingView } from '@consola/automation-engine';
import { IPC_CHANNELS } from '../../shared/constants';
import type { SecretsList } from '../../shared/secrets';
import type { guardedIpc } from '../guardedIpc';
import type { BindingsStore } from './BindingsStore';
import { asSecretReferenceInput, bindSecret, type DesktopSecretsDeps } from './desktopSecrets';

/**
 * Settings › Secrets' three channels, the person's only: no tool an agent can
 * call reaches these (`allowBoundary.test.ts`). Names, references and words;
 * never a value. Registered through `guardedIpc`, so only a Consola window's
 * main frame may call them; with them, a deleted workspace's bindings go
 * (nothing in the keychain or 1Password is touched).
 */

export interface SecretsIpcDeps {
  ipc: Pick<typeof guardedIpc, 'handle'>;
  workspaces: {
    getAll(): ReadonlyArray<{ id: string }>;
    onChange(listener: () => void): unknown;
  };
  bindings: BindingsStore;
  /** The runner's two members Settings › Secrets uses; main hands no module the whole runner (slice 3's gate rule). */
  runner: {
    reload(workspaceId: string): Promise<void>;
    secretsView(workspaceId: string): SecretBindingView[];
  };
  secretDeps: Pick<DesktopSecretsDeps, 'store' | 'programs' | 'loginEnv'>;
}

/** The channels `registerSecretsIpc` handles, which `removeSecretsIpc` removes. */
export const SECRETS_CHANNELS = [
  IPC_CHANNELS.SECRETS_LIST,
  IPC_CHANNELS.SECRETS_BIND,
  IPC_CHANNELS.SECRETS_UNBIND,
] as const;

export function registerSecretsIpc(deps: SecretsIpcDeps): void {
  const { ipc, workspaces, bindings, runner, secretDeps } = deps;
  // A deleted workspace's bindings go with it.
  workspaces.onChange(() =>
    bindings.keepWorkspaces(new Set(workspaces.getAll().map((workspace) => workspace.id))),
  );
  /** A workspace this Mac holds, or a throw before anything else is read. */
  const secretsWorkspace = (workspaceId: unknown): string => {
    if (
      typeof workspaceId !== 'string' ||
      !workspaces.getAll().some((workspace) => workspace.id === workspaceId)
    )
      throw new Error('Unknown workspace.');
    return workspaceId;
  };
  ipc.handle(
    IPC_CHANNELS.SECRETS_LIST,
    async (_event, workspaceId: unknown): Promise<SecretsList> => {
      const id = secretsWorkspace(workspaceId);
      // A file that did not read is read again each time the tab opens; once it
      // does, every workspace re-resolves, so its rows say so too (review S4).
      if (bindings.retry()) {
        for (const workspace of workspaces.getAll()) await runner.reload(workspace.id);
      }
      return {
        ...(bindings.problem ? { problem: bindings.problem } : {}),
        secrets: runner.secretsView(id),
      };
    },
  );
  ipc.handle(
    IPC_CHANNELS.SECRETS_BIND,
    async (_event, workspaceId: unknown, name: unknown, reference: unknown) => {
      const id = secretsWorkspace(workspaceId);
      if (typeof name !== 'string') throw new Error('Secret name required.');
      await bindSecret(secretDeps, id, name, asSecretReferenceInput(reference));
      await runner.reload(id);
    },
  );
  ipc.handle(IPC_CHANNELS.SECRETS_UNBIND, async (_event, workspaceId: unknown, name: unknown) => {
    const id = secretsWorkspace(workspaceId);
    if (typeof name !== 'string') throw new Error('Secret name required.');
    bindings.unbind(id, PERSONAL_FACTORY, name);
    await runner.reload(id);
  });
}

export function removeSecretsIpc(ipc: Pick<typeof guardedIpc, 'removeHandler'>): void {
  for (const channel of SECRETS_CHANNELS) ipc.removeHandler(channel);
}
