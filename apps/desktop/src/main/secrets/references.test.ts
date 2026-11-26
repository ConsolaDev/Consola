import { describe, expect, it } from 'vitest';
import {
  ENV_REFERENCE_WORDS,
  formatReference,
  KEYCHAIN_ACCOUNT_WORDS,
  KEYCHAIN_REFERENCE_WORDS,
  ONE_PASSWORD_REFERENCE_WORDS,
  parseReference,
  REFERENCE_WORDS,
  referenceFromInput,
  referenceLabel,
} from './references';
import type { BindingRef } from './references';

describe('the words', () => {
  it('are the plan’s, verbatim', () => {
    expect(KEYCHAIN_REFERENCE_WORDS).toBe(
      'A keychain reference is `keychain:<service>/<account>`, e.g. `keychain:consola/<workspace>/personal/PAGERDUTY_TOKEN`.',
    );
    expect(KEYCHAIN_ACCOUNT_WORDS).toBe(
      "A keychain account can't contain `/`: a reference's account is what follows its last `/`.",
    );
    expect(ONE_PASSWORD_REFERENCE_WORDS).toBe(
      'A 1Password reference is `op://<vault>/<item>/[<section>/]<field>`.',
    );
    expect(ENV_REFERENCE_WORDS).toBe(
      'An environment reference is `env:<NAME>`, with NAME in capital letters, digits and `_`.',
    );
    expect(REFERENCE_WORDS).toBe('A secret is bound to `keychain:…`, `op://…` or `env:…`.');
  });
});

describe('parseReference', () => {
  it.each<[string, BindingRef]>([
    [
      'keychain:consola/ws-1/personal/PAGER_TOKEN',
      { kind: 'keychain', service: 'consola/ws-1/personal', account: 'PAGER_TOKEN' },
    ],
    ['keychain:pager/PAGER_TOKEN', { kind: 'keychain', service: 'pager', account: 'PAGER_TOKEN' }],
    [
      'keychain:consola/ws-1/personal/a token with spaces',
      { kind: 'keychain', service: 'consola/ws-1/personal', account: 'a token with spaces' },
    ],
    [
      'op://Ops/PagerDuty/credential',
      { kind: '1password', reference: 'op://Ops/PagerDuty/credential' },
    ],
    [
      'op://Ops/PagerDuty/section/credential',
      { kind: '1password', reference: 'op://Ops/PagerDuty/section/credential' },
    ],
    ['env:PAGER_TOKEN', { kind: 'env', name: 'PAGER_TOKEN' }],
    ['env:_X1', { kind: 'env', name: '_X1' }],
  ])('reads %s, and writes it back as it was', (text, ref) => {
    expect(parseReference(text)).toEqual({ ok: true, ref });
    expect(formatReference(ref)).toBe(text);
  });

  it.each([
    ['keychain:onlyservice', KEYCHAIN_REFERENCE_WORDS],
    ['keychain:/x', KEYCHAIN_REFERENCE_WORDS],
    ['keychain:x/', KEYCHAIN_REFERENCE_WORDS],
    ['keychain:', KEYCHAIN_REFERENCE_WORDS],
    [`keychain:${'s'.repeat(256)}/account`, KEYCHAIN_REFERENCE_WORDS],
    [`keychain:service/${'a'.repeat(256)}`, KEYCHAIN_REFERENCE_WORDS],
    ['op://Ops/PagerDuty', ONE_PASSWORD_REFERENCE_WORDS],
    ['op://Ops//x', ONE_PASSWORD_REFERENCE_WORDS],
    ['op://Ops/PagerDuty/section/field/extra', ONE_PASSWORD_REFERENCE_WORDS],
    ['op://Ops/PagerDuty/credential/', ONE_PASSWORD_REFERENCE_WORDS],
    ['op://', ONE_PASSWORD_REFERENCE_WORDS],
    ['env:pager', ENV_REFERENCE_WORDS],
    ['env:', ENV_REFERENCE_WORDS],
    ['env:1PAGER', ENV_REFERENCE_WORDS],
    ['vault:x', REFERENCE_WORDS],
    ['', REFERENCE_WORDS],
    ['Keychain:a/b', REFERENCE_WORDS],
  ])('refuses %j in its kind’s words', (text, problem) => {
    expect(parseReference(text)).toEqual({ ok: false, problem });
  });

  it.each(['\n', '\r', '\0', '\u001f'])(
    'refuses a control character %j anywhere in a reference, in its kind’s words',
    (control) => {
      for (const [text, problem] of [
        [`keychain:consola/ws${control}-1/PAGER_TOKEN`, KEYCHAIN_REFERENCE_WORDS],
        [`keychain:consola/ws-1/PAGER${control}_TOKEN`, KEYCHAIN_REFERENCE_WORDS],
        [`keychain:consola/ws-1/PAGER_TOKEN${control}`, KEYCHAIN_REFERENCE_WORDS],
        [`op://Ops/Pager${control}Duty/credential`, ONE_PASSWORD_REFERENCE_WORDS],
        [`op://Ops/PagerDuty/credential${control}`, ONE_PASSWORD_REFERENCE_WORDS],
        [`env:PAGER${control}_TOKEN`, ENV_REFERENCE_WORDS],
        [`env:PAGER_TOKEN${control}`, ENV_REFERENCE_WORDS],
      ]) {
        expect(parseReference(text)).toEqual({ ok: false, problem });
      }
    },
  );
});

describe('referenceFromInput', () => {
  it('builds each kind from the dialog’s fields', () => {
    expect(
      referenceFromInput({ kind: 'keychain', service: 'consola/ws-1/personal', account: 'X_1' }),
    ).toEqual({
      ok: true,
      ref: { kind: 'keychain', service: 'consola/ws-1/personal', account: 'X_1' },
    });
    expect(
      referenceFromInput({ kind: '1password', reference: 'op://Ops/PagerDuty/credential' }),
    ).toEqual({ ok: true, ref: { kind: '1password', reference: 'op://Ops/PagerDuty/credential' } });
    expect(referenceFromInput({ kind: 'env', name: 'PAGER_TOKEN' })).toEqual({
      ok: true,
      ref: { kind: 'env', name: 'PAGER_TOKEN' },
    });
  });

  it('refuses a keychain account with a `/` in its own words (Call 17)', () => {
    expect(
      referenceFromInput({ kind: 'keychain', service: 'consola/ws-1/personal', account: 'a/b' }),
    ).toEqual({ ok: false, problem: KEYCHAIN_ACCOUNT_WORDS });
  });

  it('refuses fields its kind would not read', () => {
    expect(referenceFromInput({ kind: 'keychain', service: '', account: 'X' })).toEqual({
      ok: false,
      problem: KEYCHAIN_REFERENCE_WORDS,
    });
    expect(referenceFromInput({ kind: 'keychain', service: 's', account: 'X\n' })).toEqual({
      ok: false,
      problem: KEYCHAIN_REFERENCE_WORDS,
    });
    // Another kind's text in a field is that field's kind's problem, never the other kind.
    expect(referenceFromInput({ kind: '1password', reference: 'env:PAGER_TOKEN' })).toEqual({
      ok: false,
      problem: ONE_PASSWORD_REFERENCE_WORDS,
    });
    expect(referenceFromInput({ kind: 'env', name: 'pager' })).toEqual({
      ok: false,
      problem: ENV_REFERENCE_WORDS,
    });
  });
});

describe('referenceLabel', () => {
  it('says where each kind lives, in the card’s words', () => {
    expect(
      referenceLabel({
        kind: 'keychain',
        service: 'consola/ws-1/personal',
        account: 'PAGER_TOKEN',
      }),
    ).toBe('the keychain (consola/ws-1/personal · PAGER_TOKEN)');
    expect(referenceLabel({ kind: '1password', reference: 'op://Ops/PagerDuty/credential' })).toBe(
      '1Password (op://Ops/PagerDuty/credential)',
    );
    expect(referenceLabel({ kind: 'env', name: 'PAGER_TOKEN' })).toBe(
      'your login environment (PAGER_TOKEN)',
    );
  });
});
