import { describe, expect, it } from 'vitest';
import type { SecretBindingView } from '../../../shared/automations';
import {
  ENV_NOTE,
  KEYCHAIN_COMMAND_WORDS,
  KEYCHAIN_NOTE,
  MASKING_NOTE,
  SECRETS_INTRO,
  defaultKeychainService,
  keychainCommand,
  referencePreview,
  secretRows,
} from './secretsWords';

const UTC = { timeZone: 'UTC' };
const AT = '2026-11-20T12:00:00.000Z';

const keychain = (account: string) => ({
  kind: 'keychain' as const,
  label: `the keychain (consola/ws-1/personal · ${account})`,
  changedAt: AT,
});
const env = (name: string) => ({
  kind: 'env' as const,
  label: `your login environment (${name})`,
  changedAt: AT,
});
const onePassword = {
  kind: '1password' as const,
  label: '1Password (op://Work/PagerDuty/token)',
  changedAt: AT,
  program: '/opt/homebrew/bin/op',
};
const page = { automation: 'page-on-call', step: 'page', accepted: true };

const rows = (...secrets: SecretBindingView[]) => secretRows({ secrets }, UTC);

describe('secretRows', () => {
  it('reads an unbound name a step uses as not bound, with Bind… and no time', () => {
    const [row] = rows({ name: 'PAGER_TOKEN', uses: [page] });
    expect(row).toEqual({
      name: 'PAGER_TOKEN',
      binding: 'not bound',
      uses: ['`page-on-call` · step `page`'],
      action: 'Bind…',
    });
    expect(row.changed).toBeUndefined();
  });

  it('reads a keychain binding by its label, when it last changed, and what the keychain does not protect', () => {
    const [row] = rows({ name: 'PAGER_TOKEN', binding: keychain('PAGER_TOKEN'), uses: [page] });
    expect(row.binding).toBe('the keychain (consola/ws-1/personal · PAGER_TOKEN)');
    expect(row.changed).toBe('last changed 20 Nov 12:00');
    expect(row.note).toBe(KEYCHAIN_NOTE);
    expect(row.action).toBe('Change…');
    expect(row.program).toBeUndefined();
  });

  it('says beside an env: binding that it hides nothing (review M11)', () => {
    const [row] = rows({ name: 'PAGER_TOKEN', binding: env('STUB_PAGER_TOKEN'), uses: [page] });
    expect(row.binding).toBe('your login environment (STUB_PAGER_TOKEN)');
    expect(row.note).toBe(ENV_NOTE);
    expect(ENV_NOTE).toBe(
      'An env: binding hides nothing from agents or from commands that do not name it: every session on host, and every command, starts with your whole login environment.',
    );
  });

  it('names the op a 1Password binding reads with, and gives it no note', () => {
    const [row] = rows({ name: 'PAGER_TOKEN', binding: onePassword, uses: [page] });
    expect(row.program).toBe('reads with /opt/homebrew/bin/op');
    expect(row.note).toBeUndefined();
    expect(row.action).toBe('Change…');
  });

  it('says a bound name nothing uses is not used by any automation', () => {
    const [row] = rows({ name: 'SLACK_BOT_TOKEN', binding: env('SLACK_BOT_TOKEN'), uses: [] });
    expect(row.uses).toEqual(['not used by any automation']);
  });

  it('reads a check’s use as its check, and lists every use in order', () => {
    const [row] = rows({
      name: 'TRACKER_TOKEN',
      uses: [
        { automation: 'watch-tickets', check: true, accepted: false },
        { automation: 'page-on-call', step: 'post', accepted: true },
      ],
    });
    expect(row.uses).toEqual(['`watch-tickets` · its check', '`page-on-call` · step `post`']);
  });

  it('flags two names on one reference on each row, in name order, with the kind’s word', () => {
    const list = rows(
      {
        name: 'PAGER_TOKEN',
        binding: keychain('PAGER_TOKEN'),
        uses: [page],
        sameAs: ['TRACKER_TOKEN'],
      },
      {
        name: 'TRACKER_TOKEN',
        binding: keychain('PAGER_TOKEN'),
        uses: [],
        sameAs: ['PAGER_TOKEN'],
      },
    );
    expect(list.map((row) => row.sameAs)).toEqual([
      '`PAGER_TOKEN` and `TRACKER_TOKEN` are the same keychain item',
      '`PAGER_TOKEN` and `TRACKER_TOKEN` are the same keychain item',
    ]);
    const [op] = rows({
      name: 'TRACKER_TOKEN',
      binding: onePassword,
      uses: [],
      sameAs: ['PAGER_TOKEN', 'SLACK_BOT_TOKEN'],
    });
    expect(op.sameAs).toBe(
      '`PAGER_TOKEN`, `SLACK_BOT_TOKEN` and `TRACKER_TOKEN` are the same 1Password item',
    );
    const [variable] = rows({
      name: 'PAGER_TOKEN',
      binding: env('STUB_PAGER_TOKEN'),
      uses: [],
      sameAs: ['TRACKER_TOKEN'],
    });
    expect(variable.sameAs).toBe('`PAGER_TOKEN` and `TRACKER_TOKEN` are the same variable');
    expect(rows({ name: 'PAGER_TOKEN', binding: env('X1'), uses: [] })[0].sameAs).toBeUndefined();
  });

  it('keeps the rows in the order main lists them', () => {
    expect(
      rows(
        { name: 'A_TOKEN', uses: [page] },
        { name: 'B_TOKEN', binding: env('B_TOKEN'), uses: [] },
      ).map((row) => row.name),
    ).toEqual(['A_TOKEN', 'B_TOKEN']);
  });

  it('writes the time in the zone it is given', () => {
    const [row] = secretRows(
      { secrets: [{ name: 'PAGER_TOKEN', binding: keychain('PAGER_TOKEN'), uses: [] }] },
      { timeZone: 'Asia/Tokyo' },
    );
    expect(row.changed).toBe('last changed 20 Nov 21:00');
  });
});

describe('the tab’s fixed words', () => {
  it('says what the tab is, and once what masking cannot catch', () => {
    expect(SECRETS_INTRO).toBe(
      'Automations name the secrets their commands need; this Mac binds each name to where its value lives. Consola reads a value when a run starts and gives it only to the commands that name it.',
    );
    expect(MASKING_NOTE).toBe(
      "Consola masks a value, and its usual printed forms, in what it writes. It can't catch a value printed with part of it cut off, or in another encoding.",
    );
    expect(KEYCHAIN_NOTE).toBe(
      'The keychain keeps a value out of your files; it does not hide it from programs you run.',
    );
  });
});

describe('the Bind dialog’s words', () => {
  it('gives the Terminal command that stores a value under the workspace’s id', () => {
    expect(keychainCommand('ws-1', 'PAGER_TOKEN')).toBe(
      'security add-generic-password -s consola/ws-1/personal -a PAGER_TOKEN -U -w',
    );
    expect(defaultKeychainService('ws-1')).toBe('consola/ws-1/personal');
    expect(KEYCHAIN_COMMAND_WORDS).toBe(
      'Run this in Terminal to store a value you have: security asks for it, so it never passes through Consola. Then bind it here.',
    );
  });

  it('previews what Bind will store, for each kind', () => {
    expect(
      referencePreview({
        kind: 'keychain',
        service: 'consola/ws-1/personal',
        account: 'PAGER_TOKEN',
      }),
    ).toBe('keychain:consola/ws-1/personal/PAGER_TOKEN');
    expect(referencePreview({ kind: '1password', reference: 'op://Work/PagerDuty/token' })).toBe(
      'op://Work/PagerDuty/token',
    );
    expect(referencePreview({ kind: 'env', name: 'STUB_PAGER_TOKEN' })).toBe(
      'env:STUB_PAGER_TOKEN',
    );
  });
});
