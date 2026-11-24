/**
 * An entry needs every secret it names bound before it fires, checks or
 * runs: the problem it shows until then. Decided as entries resolve, never
 * mid-run (spec *Checked at apply, never mid-run*).
 */
import { secretNamesOf, type Automation, type McpServerDefinition } from '@consola/factory-spec';
import { PERSONAL_FACTORY, type SecretsPort } from './secretsPort';

/** An entry's problem on a runner with no secrets port. */
export const NO_SECRETS = "this runner can't bind secrets, so `secrets:` can't run here";

/** "`A`", "`A` and `B`", "`A`, `B` and `C`". */
function listed(names: readonly string[]): string {
  const quoted = names.map((name) => `\`${name}\``);
  return quoted.length < 2
    ? quoted.join('')
    : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/** "needs `A`, `B` and `C` bound <bindHint>": no capital, no final full stop, as every resolve problem. */
export function unboundProblem(names: readonly string[], bindHint: string): string {
  return `needs ${listed(names)} bound ${bindHint}`;
}

/**
 * An entry's unbound names, or null: what it uses (its check's included, and
 * each call's server's among `servers`) less what the port has bound. No
 * port and any name: `NO_SECRETS`, every name unbound.
 */
export function unboundOf(
  automation: Automation,
  port: SecretsPort | undefined,
  workspaceId: string,
  servers?: Readonly<Record<string, McpServerDefinition>>,
): { problem: string; unbound: string[] } | null {
  const names = secretNamesOf(automation, { servers });
  if (names.length === 0) return null;
  if (!port) return { problem: NO_SECRETS, unbound: names };
  const bound = port.boundNames(workspaceId, PERSONAL_FACTORY);
  const unbound = names.filter((name) => !bound.has(name));
  return unbound.length === 0 ? null : { problem: unboundProblem(unbound, port.bindHint), unbound };
}
