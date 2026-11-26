import type { SecretBindingView } from '../../../shared/automations';
import { formatChangedAt, sameAsWords, secretUseWords } from '../WorkspaceSettings/secretsWords';

/**
 * The cards' Secrets lines: where each name an entry uses goes, where this
 * Mac binds it, every other automation it goes to, and that rebinding it asks
 * nothing again. From the snapshot's `secrets` alone, never a value.
 */

/** Once, under a card's Secrets lines: the binding is not part of what is approved. */
export const SECRETS_TRUST_LINE =
  "Where a secret is bound is this Mac's setting, not the file's: changing it does not ask again.";

/**
 * The names one place of an entry gives: a step's command, a call's server
 * (`server`: the value goes to it, not to a command), or the check's.
 */
export type SecretPlace =
  | { step: string; names: string[]; server?: { name: string; transport: 'stdio' | 'http' } }
  | { check: true; names: string[] };

function destination(place: SecretPlace): string {
  if ('check' in place) return "this automation's check, as its environment variable";
  if (place.server) {
    return place.server.transport === 'http'
      ? `server \`${place.server.name}\`, in a header`
      : `server \`${place.server.name}\`, as its environment`;
  }
  return `command \`${place.step}\`, as its environment variable`;
}

const viewOf = (secrets: readonly SecretBindingView[] | undefined, name: string) =>
  secrets?.find((view) => view.name === name);

/**
 * One line per name a step's command or the check names, then one per other
 * use of that name, then the trust line once. Empty when nothing names a
 * secret. A name's other uses, and the names bound to its reference, follow
 * its first line only.
 */
export function secretCardLines(input: {
  automation: string;
  places: readonly SecretPlace[];
  secrets: readonly SecretBindingView[] | undefined;
  at: { timeZone?: string };
}): string[] {
  const lines: string[] = [];
  const told = new Set<string>();
  const flagged = new Set<string>();
  for (const place of input.places) {
    for (const name of place.names) {
      const view = viewOf(input.secrets, name);
      const binding = view?.binding;
      const changed = binding
        ? formatChangedAt(binding.changedAt, input.at, { time: false })
        : null;
      const where = binding
        ? `bound on this Mac to ${binding.label}${changed ? `, last changed ${changed}` : ''}`
        : 'not bound on this Mac';
      lines.push(`\`${name}\` → ${destination(place)} · ${where}`);
      if (told.has(name) || !view) continue;
      told.add(name);
      for (const use of view.uses) {
        if (use.automation === input.automation) continue;
        const accepted = use.accepted ? 'accepted' : 'not accepted yet';
        lines.push(`\`${name}\` also goes to ${secretUseWords(use)} (${accepted})`);
      }
      const same = sameAsWords(view);
      if (same && !flagged.has(same)) {
        flagged.add(same);
        lines.push(same);
      }
    }
  }
  if (lines.length > 0) lines.push(SECRETS_TRUST_LINE);
  return lines;
}

/** Whether a name in `places` is unbound or missing from `secrets`: the card offers Bind… instead of Start or Allow. */
export function needsBinding(
  places: readonly SecretPlace[],
  secrets: readonly SecretBindingView[] | undefined,
): boolean {
  return places.some((place) => place.names.some((name) => !viewOf(secrets, name)?.binding));
}

/**
 * Both cards' places (review S1): every use in `secrets` whose `automation` is
 * this entry, grouped by step (in the order `uses` lists them, file order)
 * and then the check. Empty when `secrets` is undefined.
 */
export function secretPlacesOf(
  automation: string,
  secrets: readonly SecretBindingView[] | undefined,
): SecretPlace[] {
  const steps = new Map<string, string[]>();
  const servers = new Map<string, { name: string; transport: 'stdio' | 'http' }>();
  const check: string[] = [];
  for (const view of secrets ?? []) {
    for (const use of view.uses) {
      if (use.automation !== automation) continue;
      if (use.check) {
        if (!check.includes(view.name)) check.push(view.name);
      } else if (use.step !== undefined) {
        const names = steps.get(use.step) ?? [];
        if (!names.includes(view.name)) names.push(view.name);
        steps.set(use.step, names);
        if (use.server) servers.set(use.step, use.server);
      }
    }
  }
  const places: SecretPlace[] = [...steps].map(([step, names]) => {
    const server = servers.get(step);
    return server ? { step, names, server } : { step, names };
  });
  if (check.length > 0) places.push({ check: true, names: check });
  return places;
}
