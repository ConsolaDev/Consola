import type { SecretReferenceInput, SecretsList } from '../../shared/secrets';

function getAPI() {
  if (typeof window !== 'undefined' && window.secretsAPI) {
    return window.secretsAPI;
  }
  return null;
}

function unavailable(): never {
  throw new Error('Secrets are not available in this window.');
}

/**
 * Bridge to this Mac's secret bindings in the main process (Settings ›
 * Secrets). Names, references and words cross it; a value never does: main
 * reads one only when a run or a check needs it, and gives it to the engine
 * alone. Main checks every reference and says why one is refused.
 */
export const secretsBridge = {
  /** Every name the workspace's automations use or this Mac has bound, with where each is bound and used. */
  list: async (workspaceId: string): Promise<SecretsList> =>
    (await getAPI()?.list(workspaceId)) ?? { secrets: [] },

  /** Binds `name` to a keychain item, a 1Password field or a login-environment variable. */
  bind: async (workspaceId: string, name: string, reference: SecretReferenceInput): Promise<void> =>
    (getAPI() ?? unavailable()).bind(workspaceId, name, reference),

  /** Removes `name`'s binding; nothing in the keychain or 1Password is touched. */
  unbind: async (workspaceId: string, name: string): Promise<void> =>
    (getAPI() ?? unavailable()).unbind(workspaceId, name),
};
