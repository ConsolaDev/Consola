import { ENV_NAME_PATTERN } from '@consola/factory-spec';
import type { SecretReferenceInput } from '../../shared/secrets';

/**
 * Where a secret's value lives on this Mac, as a reference: a keychain item,
 * a 1Password field or a login-environment variable. A reference says where,
 * never what: it is all `secret-bindings.json` holds, and what a card's label
 * is made of.
 */
export type BindingRef =
  | { kind: 'keychain'; service: string; account: string }
  | { kind: '1password'; reference: string }
  | { kind: 'env'; name: string };

export const KEYCHAIN_REFERENCE_WORDS =
  'A keychain reference is `keychain:<service>/<account>`, e.g. `keychain:consola/<workspace>/personal/PAGERDUTY_TOKEN`.';
export const KEYCHAIN_ACCOUNT_WORDS =
  "A keychain account can't contain `/`: a reference's account is what follows its last `/`.";
export const ONE_PASSWORD_REFERENCE_WORDS =
  'A 1Password reference is `op://<vault>/<item>/[<section>/]<field>`.';
export const ENV_REFERENCE_WORDS =
  'An environment reference is `env:<NAME>`, with NAME in capital letters, digits and `_`.';
export const REFERENCE_WORDS = 'A secret is bound to `keychain:…`, `op://…` or `env:…`.';

const KEYCHAIN_PREFIX = 'keychain:';
const ONE_PASSWORD_PREFIX = 'op://';
const ENV_PREFIX = 'env:';
/** The longest keychain service or account a reference may name. */
const MAX_KEYCHAIN_PART = 255;

type Parsed = { ok: true; ref: BindingRef } | { ok: false; problem: string };

/** A part a reference may hold: not empty, and no character below U+0020 (CR, LF and NUL among them). */
function isPlainPart(part: string): boolean {
  return part.length > 0 && !/[\u0000-\u001f]/.test(part);
}

/**
 * `keychain:<service>/<account>` (the account is what follows the last `/`),
 * `op://<vault>/<item>/[<section>/]<field>`, `env:<NAME>`.
 */
export function parseReference(text: string): Parsed {
  if (text.startsWith(KEYCHAIN_PREFIX)) {
    const rest = text.slice(KEYCHAIN_PREFIX.length);
    const slash = rest.lastIndexOf('/');
    const service = rest.slice(0, Math.max(slash, 0));
    const account = slash === -1 ? '' : rest.slice(slash + 1);
    const fits = (part: string) => isPlainPart(part) && part.length <= MAX_KEYCHAIN_PART;
    return fits(service) && fits(account)
      ? { ok: true, ref: { kind: 'keychain', service, account } }
      : { ok: false, problem: KEYCHAIN_REFERENCE_WORDS };
  }
  if (text.startsWith(ONE_PASSWORD_PREFIX)) {
    const segments = text.slice(ONE_PASSWORD_PREFIX.length).split('/');
    return (segments.length === 3 || segments.length === 4) && segments.every(isPlainPart)
      ? { ok: true, ref: { kind: '1password', reference: text } }
      : { ok: false, problem: ONE_PASSWORD_REFERENCE_WORDS };
  }
  if (text.startsWith(ENV_PREFIX)) {
    const name = text.slice(ENV_PREFIX.length);
    return ENV_NAME_PATTERN.test(name)
      ? { ok: true, ref: { kind: 'env', name } }
      : { ok: false, problem: ENV_REFERENCE_WORDS };
  }
  return { ok: false, problem: REFERENCE_WORDS };
}

/** `parseReference`'s inverse. */
export function formatReference(ref: BindingRef): string {
  switch (ref.kind) {
    case 'keychain':
      return `${KEYCHAIN_PREFIX}${ref.service}/${ref.account}`;
    case '1password':
      return ref.reference;
    case 'env':
      return `${ENV_PREFIX}${ref.name}`;
  }
}

/** The Bind dialog's fields as a reference, each checked in its own kind's words (Call 17). */
export function referenceFromInput(input: SecretReferenceInput): Parsed {
  const asKind = (text: string, kind: BindingRef['kind'], problem: string): Parsed => {
    const parsed = parseReference(text);
    return parsed.ok && parsed.ref.kind === kind ? parsed : { ok: false, problem };
  };
  switch (input.kind) {
    case 'keychain':
      if (input.account.includes('/')) return { ok: false, problem: KEYCHAIN_ACCOUNT_WORDS };
      return asKind(
        `${KEYCHAIN_PREFIX}${input.service}/${input.account}`,
        'keychain',
        KEYCHAIN_REFERENCE_WORDS,
      );
    case '1password':
      return asKind(input.reference, '1password', ONE_PASSWORD_REFERENCE_WORDS);
    case 'env':
      return asKind(`${ENV_PREFIX}${input.name}`, 'env', ENV_REFERENCE_WORDS);
  }
}

/** Where a binding lives, in a card's words. Never a value. */
export function referenceLabel(ref: BindingRef): string {
  switch (ref.kind) {
    case 'keychain':
      return `the keychain (${ref.service} · ${ref.account})`;
    case '1password':
      return `1Password (${ref.reference})`;
    case 'env':
      return `your login environment (${ref.name})`;
  }
}
