import type { SecretBindingView } from '../../../shared/automations';
import type { SecretReferenceInput, SecretsList } from '../../../shared/secrets';

/**
 * Settings › Secrets in words, from main's list alone: what each name is bound
 * to, when that last changed, where the name is used, and what its binding
 * does not protect. Nothing here sees a value; there is none to see.
 */

export const SECRETS_INTRO =
  'Automations name the secrets their commands need; this Mac binds each name to where its value lives. Consola reads a value when a run starts and gives it only to the commands that name it.';

/** Once, at the foot of the tab (spec *Masking › How*). */
export const MASKING_NOTE =
  "Consola masks a value, and its usual printed forms, in what it writes. It can't catch a value printed with part of it cut off, or in another encoding.";

export const KEYCHAIN_NOTE =
  'The keychain keeps a value out of your files; it does not hide it from programs you run.';

/** Beside an `env:` binding (review M11): agents and every command see the whole login environment. */
export const ENV_NOTE =
  'An env: binding hides nothing from agents or from commands that do not name it: every session on host, and every command, starts with your whole login environment.';

export const KEYCHAIN_COMMAND_WORDS =
  'Run this in Terminal to store a value you have: security asks for it, so it never passes through Consola. Then bind it here.';

export const NOT_BOUND = 'not bound';
export const NOT_USED = 'not used by any automation';

export interface SecretRowWords {
  name: string;
  /** "not bound", or the binding's label. */
  binding: string;
  /** "last changed 20 Nov 09:14". */
  changed?: string;
  /** "reads with /opt/homebrew/bin/op". */
  program?: string;
  /** "`page-on-call` · step `page`", "`watch-tickets` · its check", or ["not used by any automation"]. */
  uses: string[];
  /** What the keychain's or the env: binding's place does not protect. */
  note?: string;
  /** "`A` and `B` are the same keychain item". */
  sameAs?: string;
  /** Unbind is offered beside Change… whenever a binding is stored. */
  action: 'Bind…' | 'Change…';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `20 Nov`, or `20 Nov 09:14` with `time`, in the zone given (the person's
 * own when none is). Month names are fixed, not the locale's, so the tab and
 * the cards read the same everywhere. Null for a time that does not parse.
 */
export function formatChangedAt(
  iso: string,
  at: { timeZone?: string },
  { time }: { time: boolean },
): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: at.timeZone,
    day: 'numeric',
    month: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  const day = `${Number(part('day'))} ${MONTHS[Number(part('month')) - 1]}`;
  return time ? `${day} ${part('hour')}:${part('minute')}` : day;
}

/** One use of a name: "`page-on-call` · step `page`" or "`watch-tickets` · its check". */
export function secretUseWords(use: SecretBindingView['uses'][number]): string {
  return `\`${use.automation}\` · ${use.check ? 'its check' : `step \`${use.step}\``}`;
}

/** "`A` and `B`", "`A`, `B` and `C`". */
export function nameList(names: readonly string[]): string {
  const quoted = names.map((name) => `\`${name}\``);
  return quoted.length <= 1
    ? (quoted[0] ?? '')
    : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

const SAME_KIND: Record<NonNullable<SecretBindingView['binding']>['kind'], string> = {
  keychain: 'keychain item',
  '1password': '1Password item',
  env: 'variable',
  managed: 'managed secret',
};

/** "`A` and `B` are the same keychain item": every name on one reference, this one among them, in name order. */
export function sameAsWords(view: SecretBindingView): string | undefined {
  if (!view.binding || !view.sameAs || view.sameAs.length === 0) return undefined;
  const names = [...new Set([view.name, ...view.sameAs])].sort();
  return `${nameList(names)} are the same ${SAME_KIND[view.binding.kind]}`;
}

function noteFor(kind: NonNullable<SecretBindingView['binding']>['kind']): string | undefined {
  if (kind === 'keychain') return KEYCHAIN_NOTE;
  if (kind === 'env') return ENV_NOTE;
  return undefined;
}

/** One row per name, in main's order (by name). */
export function secretRows(list: SecretsList, at: { timeZone?: string }): SecretRowWords[] {
  return list.secrets.map((view) => {
    const { binding } = view;
    const changed = binding ? formatChangedAt(binding.changedAt, at, { time: true }) : null;
    const note = binding ? noteFor(binding.kind) : undefined;
    const sameAs = sameAsWords(view);
    return {
      name: view.name,
      binding: binding ? binding.label : NOT_BOUND,
      ...(changed ? { changed: `last changed ${changed}` } : {}),
      ...(binding?.program ? { program: `reads with ${binding.program}` } : {}),
      uses: view.uses.length > 0 ? view.uses.map(secretUseWords) : [NOT_USED],
      ...(note ? { note } : {}),
      ...(sameAs ? { sameAs } : {}),
      action: binding ? 'Change…' : 'Bind…',
    };
  });
}

/** Where the Bind dialog's keychain item lives by default: the workspace's own, by its id. */
export function defaultKeychainService(workspaceId: string): string {
  return `consola/${workspaceId}/personal`;
}

/** The Terminal command for a value the person has: `security add-generic-password -s consola/<workspaceId>/personal -a <NAME> -U -w`. */
export function keychainCommand(workspaceId: string, name: string): string {
  return `security add-generic-password -s ${defaultKeychainService(workspaceId)} -a ${name} -U -w`;
}

/** What Bind will store, under the fields before the person presses it: `keychain:consola/<ws>/personal/PAGER_TOKEN`, `op://…`, `env:NAME`. */
export function referencePreview(input: SecretReferenceInput): string {
  switch (input.kind) {
    case 'keychain':
      return `keychain:${input.service}/${input.account}`;
    case '1password':
      return input.reference;
    case 'env':
      return `env:${input.name}`;
  }
}
