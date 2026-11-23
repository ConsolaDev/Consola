/**
 * A factory's secrets as Settings › Secrets and the cards show them: every
 * name its entries use or this runner has bound, where each is bound, every
 * place it goes, and the names bound to the same reference. Names, labels and
 * times only: no field here can hold a value.
 */
import type { SecretUse } from '@consola/factory-spec';
import type { SecretBinding } from './secretsPort';

export interface SecretBindingView {
  name: string;
  binding?: SecretBinding;
  /**
   * Every use in the factory's resolved entries, a problem or not (an unbound
   * entry's uses are the ones the tab most needs), in entry order;
   * `accepted`: that entry's current version is.
   */
  uses: Array<{
    automation: string;
    step?: string;
    check?: true;
    /** A call's server: the value goes to it, not to a command. */
    server?: { name: string; transport: 'stdio' | 'http' };
    accepted: boolean;
  }>;
  /** Other names bound to the same reference (equal fingerprints), sorted. */
  sameAs?: string[];
}

/** Every used or bound name, sorted by name. */
export function buildSecretsView(input: {
  uses: readonly SecretUse[];
  accepted(automation: string): boolean;
  bound: ReadonlySet<string>;
  describe(name: string): SecretBinding | null;
  fingerprint(name: string): string | null;
}): SecretBindingView[] {
  const names = [...new Set([...input.uses.map((use) => use.name), ...input.bound])].sort();
  const fingerprints = new Map(names.map((name) => [name, input.fingerprint(name)]));
  return names.map((name) => {
    const binding = input.describe(name);
    const fingerprint = binding ? fingerprints.get(name) : null;
    const sameAs =
      fingerprint == null
        ? []
        : names.filter(
            (other) =>
              other !== name && input.describe(other) && fingerprints.get(other) === fingerprint,
          );
    return {
      name,
      // Field by field: whatever else a port's binding carries stays with the port.
      ...(binding
        ? {
            binding: {
              kind: binding.kind,
              label: binding.label,
              changedAt: binding.changedAt,
              ...(binding.program !== undefined ? { program: binding.program } : {}),
            },
          }
        : {}),
      uses: input.uses
        .filter((use) => use.name === name)
        .map((use) => ({
          automation: use.automation,
          ...(use.step !== undefined ? { step: use.step } : {}),
          ...(use.check ? { check: true as const } : {}),
          ...(use.server !== undefined
            ? { server: { name: use.server.name, transport: use.server.transport } }
            : {}),
          accepted: input.accepted(use.automation),
        })),
      ...(sameAs.length > 0 ? { sameAs } : {}),
    };
  });
}
