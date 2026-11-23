/**
 * One read of the secrets a run or a check needs, all at once. A failure is
 * worded twice, never with a value: for the person, the secret, where it is
 * bound and why; for an agent, the secret and whether it is bound, never
 * where (a label is a reference) nor why (a reason can name one: an `env:`
 * binding's variable).
 */
import { describeReason } from '../steps/commandStep';
import { PERSONAL_FACTORY, SecretReadError, type SecretsPort } from './secretsPort';
import { maskFormsOf, normalizeSecretValue } from './values';

export type SecretsRead =
  | { ok: true; values: Record<string, string>; masks: string[]; labels: Record<string, string> }
  /** `error` is the person's words; `told` what an agent may be told instead (review S1). */
  | { ok: false; error: string; told: string };

/**
 * Why `name` could not be read, with no final punctuation: a step adds
 * `. Nothing ran.`, a check `; nothing ran.`. `label` is where it is bound;
 * null when it is not, and `reason` then says why.
 */
export function readFailure(name: string, label: string | null, reason: string): string {
  return label === null
    ? `Couldn't read \`${name}\`: ${reason}`
    : `Couldn't read \`${name}\` from ${label}: ${reason}`;
}

/**
 * What an agent is told of a failed read of a bound name (`null`: of a read
 * that named none): never where it is bound or why. Same punctuation as
 * `readFailure`.
 */
export function toldFailure(name: string | null, bindHint: string): string {
  return name === null
    ? `Couldn't read its secrets from their bindings ${bindHint}`
    : `Couldn't read \`${name}\` from its binding ${bindHint}`;
}

/** Reads `names` (none → ok and empty, the port never asked). Each must be described before `resolve` is asked. */
export async function readSecrets(
  port: SecretsPort | undefined,
  workspaceId: string,
  names: readonly string[],
): Promise<SecretsRead> {
  if (names.length === 0) return { ok: true, values: {}, masks: [], labels: {} };
  if (!port) {
    // Words of the core's own, naming no binding: the person's and an agent's alike.
    const error = readFailure(names[0], null, "this runner can't bind secrets");
    return { ok: false, error, told: error };
  }
  const labels: Record<string, string> = {};
  for (const name of names) {
    const binding = port.describe(workspaceId, PERSONAL_FACTORY, name);
    if (binding === null) {
      const error = readFailure(name, null, `it is not bound ${port.bindHint}`);
      return { ok: false, error, told: error };
    }
    labels[name] = binding.label;
  }
  const failed = (name: string, reason: string): SecretsRead => ({
    ok: false,
    error: readFailure(name, labels[name] ?? null, reason),
    told: toldFailure(name, port.bindHint),
  });
  let raw: Record<string, string>;
  try {
    raw = await port.resolve(workspaceId, PERSONAL_FACTORY, names);
  } catch (error) {
    if (error instanceof SecretReadError) return failed(error.secret, error.reason);
    return {
      ok: false,
      error: readFailure(names[0], labels[names[0]], describeReason(error)),
      told: toldFailure(null, port.bindHint),
    };
  }
  const values: Record<string, string> = {};
  const masks = new Set<string>();
  for (const name of names) {
    const given = Object.prototype.hasOwnProperty.call(raw, name) ? raw[name] : undefined;
    if (typeof given !== 'string') return failed(name, 'the runner gave no value');
    const checked = normalizeSecretValue(given);
    if (!checked.ok) return failed(name, checked.reason);
    values[name] = checked.value;
    for (const form of maskFormsOf(checked.value)) masks.add(form);
  }
  return {
    ok: true,
    values,
    masks: [...masks].sort((a, b) => b.length - a.length),
    labels,
  };
}
