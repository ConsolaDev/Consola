/**
 * The runner's secrets, as the engine sees them: names, the words that say
 * where each is bound, opaque fingerprints of those bindings, and values only
 * when a run or a check reads them. The engine holds no store and spawns no
 * reader; each runner implements this port (the desktop over
 * `secret-bindings.json` and the keychain, 1Password and the login
 * environment). Contract 18 (proposed): the core sees names, labels and
 * fingerprints, and values only in a run's or a check's memory.
 */

/** The one factory a workspace has until factories arrive; every port call passes it. */
export const PERSONAL_FACTORY = 'personal';

/** Where one name is bound, in words. Never a value. */
export interface SecretBinding {
  kind: 'keychain' | '1password' | 'env' | 'managed';
  /** In words for a card: "the keychain (consola/ws_7f3a/personal · X)". Never a value. */
  label: string;
  /** ISO time the binding last changed. */
  changedAt: string;
  /** The program that reads it, when the runner keeps one with it (1Password's `op`). */
  program?: string;
}

export interface SecretsPort {
  /** Where a person binds a name on this runner, in words: "on this Mac (Settings › Secrets)". */
  readonly bindHint: string;
  boundNames(workspaceId: string, factory: string): ReadonlySet<string>;
  describe(workspaceId: string, factory: string, name: string): SecretBinding | null;
  /** An opaque hash of the binding's reference: equal for equal references, null when unbound. */
  fingerprint(workspaceId: string, factory: string, name: string): string | null;
  /** Every value, raw, or a rejection: a `SecretReadError` naming the first that failed. */
  resolve(
    workspaceId: string,
    factory: string,
    names: readonly string[],
  ): Promise<Record<string, string>>;
}

/** A read that failed for one name, with the reason in words (never the value). */
export class SecretReadError extends Error {
  constructor(
    readonly secret: string,
    readonly reason: string,
  ) {
    super(`Couldn't read ${secret}: ${reason}`);
    this.name = 'SecretReadError';
  }
}
