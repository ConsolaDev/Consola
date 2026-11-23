import { describe, expect, it } from 'vitest';
import { readSecrets, type SecretsRead } from './readSecrets';
import {
  PERSONAL_FACTORY,
  SecretReadError,
  type SecretBinding,
  type SecretsPort,
} from './secretsPort';
import { maskFormsOf } from './values';

const A_VALUE = 'stub-a-secret-7f3a"\\back%slash';
const B_VALUE = 'stub-b-secret-9c1e+/= x';
const LABELS: Record<string, string> = {
  A_TOKEN: 'the keychain (consola/ws-1/personal · A_TOKEN)',
  B_TOKEN: '1Password (op://Dev/b/credential)',
};

/** A port over `values`; `bound` names what it describes. It records each call. */
function fakePort(
  values: Record<string, string>,
  options: { bound?: readonly string[]; reject?: unknown; omit?: readonly string[] } = {},
) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const bound = new Set(options.bound ?? Object.keys(values));
  const port: SecretsPort = {
    bindHint: 'on this Mac (Settings › Secrets)',
    boundNames: (...args) => {
      calls.push({ method: 'boundNames', args });
      return bound;
    },
    describe: (workspaceId, factory, name): SecretBinding | null => {
      calls.push({ method: 'describe', args: [workspaceId, factory, name] });
      return bound.has(name)
        ? {
            kind: 'keychain',
            label: LABELS[name] ?? `the keychain (${name})`,
            changedAt: '2026-11-22T09:00:00.000Z',
          }
        : null;
    },
    fingerprint: (_workspaceId, _factory, name) => (bound.has(name) ? `fp-${name}` : null),
    resolve: async (workspaceId, factory, names) => {
      calls.push({ method: 'resolve', args: [workspaceId, factory, [...names]] });
      if (options.reject !== undefined) throw options.reject;
      return Object.fromEntries(
        names
          .filter((name) => !(options.omit ?? []).includes(name))
          .map((name) => [name, values[name]]),
      );
    },
  };
  return { port, calls, resolved: () => calls.filter((call) => call.method === 'resolve') };
}

/** Every case's outcome, so no error is ever seen to hold a value. */
const outcomes: SecretsRead[] = [];
const read = async (...args: Parameters<typeof readSecrets>) => {
  const outcome = await readSecrets(...args);
  outcomes.push(outcome);
  return outcome;
};

describe('readSecrets', () => {
  it('asks nothing for no names, port or none', async () => {
    const { port, calls } = fakePort({ A_TOKEN: A_VALUE });
    expect(await read(port, 'ws-1', [])).toEqual({ ok: true, values: {}, masks: [], labels: {} });
    expect(calls).toEqual([]);
    expect(await read(undefined, 'ws-1', [])).toEqual({
      ok: true,
      values: {},
      masks: [],
      labels: {},
    });
  });

  it('reads every name at once, for the personal factory, with each one’s label and forms', async () => {
    const { port, resolved } = fakePort({ A_TOKEN: `${A_VALUE}\n`, B_TOKEN: B_VALUE });
    const outcome = await read(port, 'ws-1', ['A_TOKEN', 'B_TOKEN']);
    expect(outcome).toEqual({
      ok: true,
      values: { A_TOKEN: A_VALUE, B_TOKEN: B_VALUE },
      labels: { A_TOKEN: LABELS.A_TOKEN, B_TOKEN: LABELS.B_TOKEN },
      masks: expect.any(Array),
    });
    if (!outcome.ok) throw new Error('unreachable');
    expect(new Set(outcome.masks)).toEqual(
      new Set([...maskFormsOf(A_VALUE), ...maskFormsOf(B_VALUE)]),
    );
    expect(outcome.masks).toHaveLength(new Set(outcome.masks).size);
    expect(resolved()).toEqual([
      { method: 'resolve', args: ['ws-1', PERSONAL_FACTORY, ['A_TOKEN', 'B_TOKEN']] },
    ]);
  });

  it('names the secret a store refused, and where it is bound', async () => {
    const { port } = fakePort(
      { A_TOKEN: A_VALUE, B_TOKEN: B_VALUE },
      { reject: new SecretReadError('B_TOKEN', 'the keychain has no such item') },
    );
    expect(await read(port, 'ws-1', ['A_TOKEN', 'B_TOKEN'])).toEqual({
      ok: false,
      error: `Couldn't read \`B_TOKEN\` from ${LABELS.B_TOKEN}: the keychain has no such item`,
      told: "Couldn't read `B_TOKEN` from its binding on this Mac (Settings › Secrets)",
    });
  });

  it('names the first secret for any other failure', async () => {
    const { port } = fakePort(
      { A_TOKEN: A_VALUE, B_TOKEN: B_VALUE },
      { reject: new Error('boom.') },
    );
    expect(await read(port, 'ws-1', ['A_TOKEN', 'B_TOKEN'])).toEqual({
      ok: false,
      error: `Couldn't read \`A_TOKEN\` from ${LABELS.A_TOKEN}: boom`,
      told: "Couldn't read its secrets from their bindings on this Mac (Settings › Secrets)",
    });
  });

  it('asks no store for a name that is not bound', async () => {
    const { port, resolved } = fakePort({ A_TOKEN: A_VALUE }, { bound: ['A_TOKEN'] });
    expect(await read(port, 'ws-1', ['A_TOKEN', 'B_TOKEN'])).toEqual({
      ok: false,
      error: "Couldn't read `B_TOKEN`: it is not bound on this Mac (Settings › Secrets)",
      told: "Couldn't read `B_TOKEN`: it is not bound on this Mac (Settings › Secrets)",
    });
    expect(resolved()).toEqual([]);
  });

  it('refuses a value its checks refuse, naming the secret and not the value', async () => {
    const { port } = fakePort({ A_TOKEN: 'q7x2z', B_TOKEN: B_VALUE });
    expect(await read(port, 'ws-1', ['A_TOKEN', 'B_TOKEN'])).toEqual({
      ok: false,
      error: `Couldn't read \`A_TOKEN\` from ${LABELS.A_TOKEN}: its value is too short to mask safely (under 8 characters)`,
      told: "Couldn't read `A_TOKEN` from its binding on this Mac (Settings › Secrets)",
    });
  });

  it('refuses a name the store left out', async () => {
    const { port } = fakePort({ A_TOKEN: A_VALUE, B_TOKEN: B_VALUE }, { omit: ['B_TOKEN'] });
    expect(await read(port, 'ws-1', ['A_TOKEN', 'B_TOKEN'])).toEqual({
      ok: false,
      error: `Couldn't read \`B_TOKEN\` from ${LABELS.B_TOKEN}: the runner gave no value`,
      told: "Couldn't read `B_TOKEN` from its binding on this Mac (Settings › Secrets)",
    });
  });

  it('says a runner with no port cannot bind', async () => {
    expect(await read(undefined, 'ws-1', ['A_TOKEN'])).toEqual({
      ok: false,
      error: "Couldn't read `A_TOKEN`: this runner can't bind secrets",
      told: "Couldn't read `A_TOKEN`: this runner can't bind secrets",
    });
  });

  it('names a secret a store refused for a reason that names its reference, and tells an agent neither', async () => {
    const { port } = fakePort(
      { A_TOKEN: A_VALUE, B_TOKEN: B_VALUE },
      { reject: new SecretReadError('B_TOKEN', 'your login environment has no `STUB_B_TOKEN`') },
    );
    expect(await read(port, 'ws-1', ['A_TOKEN', 'B_TOKEN'])).toEqual({
      ok: false,
      error: `Couldn't read \`B_TOKEN\` from ${LABELS.B_TOKEN}: your login environment has no \`STUB_B_TOKEN\``,
      told: "Couldn't read `B_TOKEN` from its binding on this Mac (Settings › Secrets)",
    });
  });

  it('tells an agent a name and whether it is bound, never where or why (review S1)', () => {
    const told = outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.told]));
    expect(told.length).toBeGreaterThanOrEqual(7);
    for (const words of told) {
      expect(words).toMatch(/^Couldn't read (`[A-Z_]+`|its secrets)[ :]/);
      for (const where of [
        ...Object.values(LABELS),
        'op://',
        'keychain',
        '1Password',
        'STUB_B_TOKEN',
        'no such item',
        'boom',
        'too short',
        'gave no value',
      ])
        expect(words).not.toContain(where);
    }
  });

  it('never words an error with a value it held', () => {
    const errors = outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.error, outcome.told]));
    expect(errors.length).toBeGreaterThanOrEqual(6);
    for (const error of errors)
      for (const value of [
        A_VALUE,
        B_VALUE,
        'q7x2z',
        ...maskFormsOf(A_VALUE),
        ...maskFormsOf(B_VALUE),
      ])
        expect(error).not.toContain(value);
  });
});
