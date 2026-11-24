import type { SecretBindingView } from './automations';

/**
 * What crosses between the renderer and main for Settings › Secrets: names,
 * references and words, never a value. Main builds and checks the reference
 * (`main/secrets/references.ts`); the renderer only collects its fields.
 */

/** The Bind dialog's fields: one of the three places a value can live on this Mac. */
export type SecretReferenceInput =
  | { kind: 'keychain'; service: string; account: string }
  | { kind: '1password'; reference: string }
  | { kind: 'env'; name: string };

/** Settings › Secrets' list: every name the workspace's automations use or this Mac has bound. */
export interface SecretsList {
  /** Why `secret-bindings.json` did not read, in the tab's words; absent when it did. */
  problem?: string;
  secrets: SecretBindingView[];
}

/** `window.secretsAPI`: reached only through `renderer/services/secretsBridge.ts`. */
export interface SecretsAPI {
  list(workspaceId: string): Promise<SecretsList>;
  bind(workspaceId: string, name: string, reference: SecretReferenceInput): Promise<void>;
  unbind(workspaceId: string, name: string): Promise<void>;
}
