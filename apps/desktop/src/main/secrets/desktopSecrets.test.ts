import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PERSONAL_FACTORY,
  type SecretBinding,
  SecretReadError,
  SecretReaderFailure,
  readSecrets,
} from '@consola/automation-engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonStateFile } from '../state/JsonStateFile';
import { BindingsStore, type SecretBindingsFile } from './BindingsStore';
import {
  asSecretReferenceInput,
  bindSecret,
  DESKTOP_BIND_HINT,
  type DesktopSecretsDeps,
  desktopSecretsPort,
  NO_OP_KEPT,
  OP_MISSING_WORDS,
} from './desktopSecrets';
import { secretPrograms } from './programs';
import { KEYCHAIN_ACCOUNT_WORDS, REFERENCE_WORDS } from './references';

/*
 * Every reader here is a fake that records its call and returns a long fake
 * value: nothing reads the person's keychain or 1Password (rule 5a-secrets).
 */

const KEYCHAIN_VALUE = 'stub-pager-secret-7f3a"\\back%slash';
const OP_VALUE = 'stub-slack-secret-9c1e+/=';
const ENV_VALUE = 'stub-tracker-secret-2b4d';
const ALL_VALUES = [KEYCHAIN_VALUE, OP_VALUE, ENV_VALUE];
const WS = 'ws-1';
const P = PERSONAL_FACTORY;

let dir: string;
let store: BindingsStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-desktop-secrets-'));
  store = new BindingsStore(
    new JsonStateFile<SecretBindingsFile>(path.join(dir, 'secret-bindings.json')),
    () => new Date('2026-11-16T08:00:00.000Z'),
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function deps(overrides: Partial<DesktopSecretsDeps> = {}) {
  const readKeychain = vi.fn(async () => KEYCHAIN_VALUE);
  const readOnePassword = vi.fn(async () => OP_VALUE);
  const loginEnv = vi.fn(
    async (): Promise<NodeJS.ProcessEnv> => ({
      PATH: '/usr/bin:/bin',
      TRACKER_TOKEN: ENV_VALUE,
    }),
  );
  const all: DesktopSecretsDeps = {
    store,
    programs: secretPrograms({
      test: true,
      env: { CONSOLA_E2E_SECURITY: '/stub/security', CONSOLA_E2E_OP: '/stub/op' },
    }),
    loginEnv,
    readKeychain,
    readOnePassword,
    ...overrides,
  };
  return { all, readKeychain, readOnePassword, loginEnv };
}

function bindAll(): void {
  store.bind(WS, P, 'PAGER_TOKEN', {
    kind: 'keychain',
    service: 'consola/ws-1/personal',
    account: 'PAGER_TOKEN',
  });
  store.bind(
    WS,
    P,
    'SLACK_BOT_TOKEN',
    { kind: '1password', reference: 'op://Ops/Slack/bot-token' },
    '/opt/homebrew/bin/op',
  );
  store.bind(WS, P, 'TRACKER_TOKEN', { kind: 'env', name: 'TRACKER_TOKEN' });
}

async function readError(promise: Promise<unknown>): Promise<SecretReadError> {
  const error = await promise.then(
    () => {
      throw new Error('the read resolved');
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SecretReadError);
  return error as SecretReadError;
}

describe('desktopSecretsPort', () => {
  it('says where a person binds a name on this Mac', () => {
    expect(DESKTOP_BIND_HINT).toBe('on this Mac (Settings › Secrets)');
    expect(desktopSecretsPort(deps().all).bindHint).toBe(DESKTOP_BIND_HINT);
  });

  it('describes each kind, and names the bound ones', () => {
    bindAll();
    const port = desktopSecretsPort(deps().all);
    expect([...port.boundNames(WS, P)].sort()).toEqual([
      'PAGER_TOKEN',
      'SLACK_BOT_TOKEN',
      'TRACKER_TOKEN',
    ]);
    expect(port.boundNames('ws-2', P).size).toBe(0);
    expect(port.describe(WS, P, 'PAGER_TOKEN')).toEqual({
      kind: 'keychain',
      label: 'the keychain (consola/ws-1/personal · PAGER_TOKEN)',
      changedAt: '2026-11-16T08:00:00.000Z',
    });
    expect(port.describe(WS, P, 'SLACK_BOT_TOKEN')).toEqual({
      kind: '1password',
      label: '1Password (op://Ops/Slack/bot-token)',
      changedAt: '2026-11-16T08:00:00.000Z',
      program: '/opt/homebrew/bin/op',
    });
    expect(port.describe(WS, P, 'TRACKER_TOKEN')).toEqual({
      kind: 'env',
      label: 'your login environment (TRACKER_TOKEN)',
      changedAt: '2026-11-16T08:00:00.000Z',
    });
    expect(port.describe(WS, P, 'NOT_BOUND')).toBeNull();
  });

  it('fingerprints the reference: equal for one reference, different for another, null when unbound', () => {
    bindAll();
    store.bind(WS, P, 'PAGERDUTY_TOKEN', {
      kind: 'keychain',
      service: 'consola/ws-1/personal',
      account: 'PAGER_TOKEN',
    });
    const port = desktopSecretsPort(deps().all);
    const pager = port.fingerprint(WS, P, 'PAGER_TOKEN');
    expect(pager).toMatch(/^[0-9a-f]{16}$/);
    expect(port.fingerprint(WS, P, 'PAGERDUTY_TOKEN')).toBe(pager);
    expect(port.fingerprint('ws-2', P, 'PAGER_TOKEN')).toBeNull();
    expect(port.fingerprint(WS, P, 'NOT_BOUND')).toBeNull();
    const others = ['SLACK_BOT_TOKEN', 'TRACKER_TOKEN'].map((name) =>
      port.fingerprint(WS, P, name),
    );
    expect(new Set([pager, ...others]).size).toBe(3);
    // A rebinding to another reference moves it; the same reference again does not.
    store.bind(WS, P, 'PAGER_TOKEN', { kind: 'env', name: 'PAGER_TOKEN' });
    const moved = port.fingerprint(WS, P, 'PAGER_TOKEN');
    expect(moved).not.toBe(pager);
    store.bind(WS, P, 'PAGER_TOKEN', { kind: 'env', name: 'PAGER_TOKEN' });
    expect(port.fingerprint(WS, P, 'PAGER_TOKEN')).toBe(moved);
  });

  it('reads a keychain item through the stub and an env: binding from the login environment', async () => {
    bindAll();
    const { all, readKeychain, readOnePassword } = deps();
    const values = await desktopSecretsPort(all).resolve(WS, P, ['PAGER_TOKEN', 'TRACKER_TOKEN']);
    expect(values).toEqual({ PAGER_TOKEN: KEYCHAIN_VALUE, TRACKER_TOKEN: ENV_VALUE });
    expect(readKeychain).toHaveBeenCalledTimes(1);
    expect(readKeychain).toHaveBeenCalledWith({
      program: '/stub/security',
      env: { PATH: '/usr/bin:/bin', TRACKER_TOKEN: ENV_VALUE },
      service: 'consola/ws-1/personal',
      account: 'PAGER_TOKEN',
    });
    expect(readOnePassword).not.toHaveBeenCalled();
  });

  it('waits for the login environment’s retry, then refuses a variable it lacks (Review Focus 5)', async () => {
    store.bind(WS, P, 'PAGER_TOKEN', { kind: 'env', name: 'PAGER_TOKEN' });
    let release!: (env: NodeJS.ProcessEnv) => void;
    const settled = new Promise<NodeJS.ProcessEnv>((resolve) => {
      release = resolve;
    });
    const loginEnv = vi.fn(() => settled);
    const read = desktopSecretsPort(deps({ loginEnv }).all).resolve(WS, P, ['PAGER_TOKEN']);
    let done = false;
    void read.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loginEnv).toHaveBeenCalled();
    expect(done).toBe(false);
    release({ PATH: '/usr/bin:/bin', PAGER_TOKEN_OTHER: 'x' });
    const error = await readError(read);
    expect(error.secret).toBe('PAGER_TOKEN');
    expect(error.reason).toBe('your login environment has no `PAGER_TOKEN`');
  });

  it('reads 1Password with the op kept at bind time, or the stub in a test run', async () => {
    bindAll();
    const outside = deps({ programs: secretPrograms({ test: false, env: {} }) });
    await expect(
      desktopSecretsPort(outside.all).resolve(WS, P, ['SLACK_BOT_TOKEN']),
    ).resolves.toEqual({ SLACK_BOT_TOKEN: OP_VALUE });
    expect(outside.readOnePassword).toHaveBeenCalledWith({
      program: '/opt/homebrew/bin/op',
      env: { PATH: '/usr/bin:/bin', TRACKER_TOKEN: ENV_VALUE },
      reference: 'op://Ops/Slack/bot-token',
    });

    const inside = deps();
    await desktopSecretsPort(inside.all).resolve(WS, P, ['SLACK_BOT_TOKEN']);
    expect(inside.readOnePassword).toHaveBeenCalledWith(
      expect.objectContaining({ program: '/stub/op' }),
    );
  });

  it('reads nothing in a test run with no stubs', async () => {
    bindAll();
    const { all, readKeychain, readOnePassword } = deps({
      programs: secretPrograms({ test: true, env: {} }),
    });
    const port = desktopSecretsPort(all);
    const keychain = await readError(port.resolve(WS, P, ['PAGER_TOKEN']));
    expect(keychain.reason).toBe('a test run reads no keychain');
    const onePassword = await readError(port.resolve(WS, P, ['SLACK_BOT_TOKEN']));
    expect(onePassword.reason).toBe('a test run reads no 1Password');
    expect(readKeychain).not.toHaveBeenCalled();
    expect(readOnePassword).not.toHaveBeenCalled();
  });

  it('says a 1Password binding kept no op, and reads nothing', async () => {
    fs.writeFileSync(
      path.join(dir, 'secret-bindings.json'),
      JSON.stringify({
        version: 1,
        workspaces: {
          [WS]: {
            factories: {
              [P]: {
                SLACK_BOT_TOKEN: {
                  ref: 'op://Ops/Slack/bot-token',
                  boundAt: '2026-11-15T10:00:00.000Z',
                },
              },
            },
          },
        },
      }),
    );
    store = new BindingsStore(
      new JsonStateFile<SecretBindingsFile>(path.join(dir, 'secret-bindings.json')),
      () => new Date(),
    );
    const { all, readOnePassword } = deps({ programs: secretPrograms({ test: false, env: {} }) });
    const error = await readError(desktopSecretsPort(all).resolve(WS, P, ['SLACK_BOT_TOKEN']));
    expect(error.reason).toBe(NO_OP_KEPT);
    expect(NO_OP_KEPT).toBe("it was bound without `op`'s path; bind it again");
    expect(readOnePassword).not.toHaveBeenCalled();
  });

  it('turns a reader’s failure into a read error naming the secret', async () => {
    bindAll();
    const { all } = deps({
      readKeychain: vi.fn(async () => {
        throw new SecretReaderFailure('the keychain has no such item');
      }),
    });
    const error = await readError(desktopSecretsPort(all).resolve(WS, P, ['PAGER_TOKEN']));
    expect(error.secret).toBe('PAGER_TOKEN');
    expect(error.reason).toBe('the keychain has no such item');
    // The engine words it with the binding's label.
    await expect(readSecrets(desktopSecretsPort(all), WS, ['PAGER_TOKEN'])).resolves.toEqual({
      ok: false,
      error:
        "Couldn't read `PAGER_TOKEN` from the keychain (consola/ws-1/personal · PAGER_TOKEN): the keychain has no such item",
    });
  });

  it('refuses a name that is not bound', async () => {
    const error = await readError(desktopSecretsPort(deps().all).resolve(WS, P, ['PAGER_TOKEN']));
    expect(error.reason).toBe('it is not bound on this Mac (Settings › Secrets)');
  });

  it('has no field a value could ride in (review S8)', async () => {
    bindAll();
    const port = desktopSecretsPort(deps().all);
    await port.resolve(WS, P, ['PAGER_TOKEN', 'SLACK_BOT_TOKEN', 'TRACKER_TOKEN']);
    for (const name of ['PAGER_TOKEN', 'SLACK_BOT_TOKEN', 'TRACKER_TOKEN']) {
      const described = port.describe(WS, P, name) as SecretBinding;
      for (const key of Object.keys(described))
        expect(['kind', 'label', 'changedAt', 'program']).toContain(key);
      const answers = JSON.stringify([described, port.fingerprint(WS, P, name)]);
      for (const value of ALL_VALUES) expect(answers).not.toContain(value);
    }
  });
});

describe('bindSecret', () => {
  it('finds op on the login PATH when a 1Password reference is bound, and keeps it', async () => {
    const programs = secretPrograms({
      test: false,
      env: {},
      isExecutable: (file) => file === '/opt/homebrew/bin/op',
    });
    const { all } = deps({
      programs,
      loginEnv: vi.fn(async () => ({ PATH: '/usr/bin:/opt/homebrew/bin' })),
    });
    await bindSecret(all, WS, 'SLACK_BOT_TOKEN', {
      kind: '1password',
      reference: 'op://Ops/Slack/bot-token',
    });
    expect(store.get(WS, P, 'SLACK_BOT_TOKEN')).toEqual({
      ref: { kind: '1password', reference: 'op://Ops/Slack/bot-token' },
      op: '/opt/homebrew/bin/op',
      boundAt: '2026-11-16T08:00:00.000Z',
    });
    expect(desktopSecretsPort(all).describe(WS, P, 'SLACK_BOT_TOKEN')?.program).toBe(
      '/opt/homebrew/bin/op',
    );
  });

  it('refuses a 1Password reference when op is not on the login PATH, storing nothing', async () => {
    const { all } = deps({
      programs: secretPrograms({ test: false, env: {}, isExecutable: () => false }),
      loginEnv: vi.fn(async () => ({ PATH: '/usr/bin:/bin' })),
    });
    await expect(
      bindSecret(all, WS, 'SLACK_BOT_TOKEN', {
        kind: '1password',
        reference: 'op://Ops/Slack/bot-token',
      }),
    ).rejects.toThrow(OP_MISSING_WORDS);
    expect(OP_MISSING_WORDS).toBe(
      "`op` (1Password's CLI) isn't on your login PATH; install it, then bind again.",
    );
    expect(store.names(WS, P)).toEqual([]);
  });

  it('binds a keychain item and an env: variable without looking for any program', async () => {
    const { all, loginEnv } = deps();
    await bindSecret(all, WS, 'PAGER_TOKEN', {
      kind: 'keychain',
      service: 'consola/ws-1/personal',
      account: 'PAGER_TOKEN',
    });
    await bindSecret(all, WS, 'TRACKER_TOKEN', { kind: 'env', name: 'TRACKER_TOKEN' });
    expect(store.names(WS, P)).toEqual(['PAGER_TOKEN', 'TRACKER_TOKEN']);
    expect(store.get(WS, P, 'PAGER_TOKEN')?.op).toBeUndefined();
    expect(loginEnv).not.toHaveBeenCalled();
  });

  it('refuses a keychain account with a `/`, storing nothing', async () => {
    await expect(
      bindSecret(deps().all, WS, 'PAGER_TOKEN', {
        kind: 'keychain',
        service: 'consola/ws-1/personal',
        account: 'a/b',
      }),
    ).rejects.toThrow(KEYCHAIN_ACCOUNT_WORDS);
    expect(store.names(WS, P)).toEqual([]);
  });
});

describe('asSecretReferenceInput', () => {
  it('takes each of the three shapes, and only their fields', () => {
    expect(
      asSecretReferenceInput({ kind: 'keychain', service: 's', account: 'a', extra: 1 }),
    ).toEqual({ kind: 'keychain', service: 's', account: 'a' });
    expect(asSecretReferenceInput({ kind: '1password', reference: 'op://a/b/c' })).toEqual({
      kind: '1password',
      reference: 'op://a/b/c',
    });
    expect(asSecretReferenceInput({ kind: 'env', name: 'X_1' })).toEqual({
      kind: 'env',
      name: 'X_1',
    });
  });

  it.each([
    null,
    'keychain:a/b',
    { kind: 'keychain', service: 's' },
    { kind: 'keychain', service: 's', account: 1 },
    { kind: '1password' },
    { kind: 'env', name: ['X'] },
    { kind: 'vault', name: 'X' },
  ])('refuses %j', (value) => {
    expect(() => asSecretReferenceInput(value)).toThrow(REFERENCE_WORDS);
  });
});
