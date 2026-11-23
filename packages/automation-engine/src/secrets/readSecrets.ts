/**
 * One read of the secrets a run or a check needs, all at once. The words of
 * every failure name the secret and where it is bound, never its value.
 */
import { describeReason } from '../steps/commandStep';
import { PERSONAL_FACTORY, SecretReadError, type SecretsPort } from './secretsPort';
import { maskFormsOf, normalizeSecretValue } from './values';

export type SecretsRead =
  | { ok: true; values: Record<string, string>; masks: string[]; labels: Record<string, string> }
  | { ok: false; error: string };

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

/** Reads `names` (none → ok and empty, the port never asked). Each must be described before `resolve` is asked. */
export async function readSecrets(
  port: SecretsPort | undefined,
  workspaceId: string,
  names: readonly string[],
): Promise<SecretsRead> {
  if (names.length === 0) return { ok: true, values: {}, masks: [], labels: {} };
  if (!port)
    return { ok: false, error: readFailure(names[0], null, "this runner can't bind secrets") };
  const labels: Record<string, string> = {};
  for (const name of names) {
    const binding = port.describe(workspaceId, PERSONAL_FACTORY, name);
    if (binding === null)
      return { ok: false, error: readFailure(name, null, `it is not bound ${port.bindHint}`) };
    labels[name] = binding.label;
  }
  let raw: Record<string, string>;
  try {
    raw = await port.resolve(workspaceId, PERSONAL_FACTORY, names);
  } catch (error) {
    if (error instanceof SecretReadError)
      return {
        ok: false,
        error: readFailure(error.secret, labels[error.secret] ?? null, error.reason),
      };
    return { ok: false, error: readFailure(names[0], labels[names[0]], describeReason(error)) };
  }
  const values: Record<string, string> = {};
  const masks = new Set<string>();
  for (const name of names) {
    const given = Object.prototype.hasOwnProperty.call(raw, name) ? raw[name] : undefined;
    if (typeof given !== 'string')
      return { ok: false, error: readFailure(name, labels[name], 'the runner gave no value') };
    const checked = normalizeSecretValue(given);
    if (!checked.ok) return { ok: false, error: readFailure(name, labels[name], checked.reason) };
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
