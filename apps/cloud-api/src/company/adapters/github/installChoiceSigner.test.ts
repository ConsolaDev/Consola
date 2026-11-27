import { createHmac, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { InstallChoice, InstallState } from '../../domain/connections.js';
import { createInstallChoiceSigner } from './installChoiceSigner.js';
import { createInstallStateSigner } from './installStateSigner.js';

const SECRET = 'sprocket-test-secret-that-is-long-enough-to-sign-with';
const choice: InstallChoice = {
  workspaceId: 'sprocket',
  personId: 'dana',
  sessionId: 'session-1',
  expiresAt: 1_800_000_300,
  candidates: [
    {
      id: 41,
      account: { id: 9001, login: 'sprocket', type: 'Organization' },
      heldElsewhere: false,
    },
    { id: 63, account: { id: 7, login: 'dana', type: 'User' }, heldElsewhere: false },
    { id: 52, account: { id: 9002, login: 'acme', type: 'Organization' }, heldElsewhere: true },
  ],
};

describe("a choice of installation's signer", () => {
  const signer = createInstallChoiceSigner(SECRET);

  it('reads back exactly what it signed', () => {
    expect(signer.read(signer.sign(choice))).toEqual(choice);
  });

  it('signs nothing but the choice: no GitHub token, code or secret', () => {
    const body = signer.sign(choice).split('.')[0] ?? '';
    expect(JSON.parse(Buffer.from(body, 'base64url').toString())).toEqual(choice);
  });

  it('refuses a choice another secret signed', () => {
    const other = createInstallChoiceSigner(`${SECRET}-other`);
    expect(signer.read(other.sign(choice))).toBeNull();
  });

  it('refuses a choice whose candidates were changed', () => {
    const [, mac] = signer.sign(choice).split('.');
    const changed = Buffer.from(
      JSON.stringify({
        ...choice,
        candidates: choice.candidates.map((each) => ({ ...each, heldElsewhere: false })),
      }),
    ).toString('base64url');
    expect(signer.read(`${changed}.${mac}`)).toBeNull();
  });

  it("uses a key of its own: a Connect's state is never read as a choice, nor a choice as a state", () => {
    const states = createInstallStateSigner(SECRET);
    const state: InstallState = {
      workspaceId: 'sprocket',
      personId: 'dana',
      sessionId: 'session-1',
      expiresAt: 1_800_000_600,
    };
    // A choice's shape signed with the state's key, and a state's with the choice's.
    const asState = (states as unknown as { sign(value: unknown): string }).sign(choice);
    expect(signer.read(asState)).toBeNull();
    const asChoice = (signer as unknown as { sign(value: unknown): string }).sign(state);
    expect(states.read(asChoice)).toBeNull();
  });

  it('does not sign with the secret itself', () => {
    const body = signer.sign(choice).split('.')[0] ?? '';
    const plain = createHmac('sha256', SECRET).update(body).digest('base64url');
    expect(signer.read(`${body}.${plain}`)).toBeNull();
  });

  it('refuses what is not a choice, however it is shaped', () => {
    for (const token of ['', '.', 'abc', 'a.b.c', `${signer.sign(choice)}.x`, 'x'.repeat(9000)]) {
      expect(signer.read(token)).toBeNull();
    }
  });

  it('refuses a properly signed body that is not exactly a choice', () => {
    // The signer's own key, derived the way it derives it, so these reach the shape check.
    const key = Buffer.from(
      hkdfSync(
        'sha256',
        SECRET,
        '',
        'consola cloud: the choice of a GitHub installation to connect',
        32,
      ),
    );
    const signed = (body: string) =>
      `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
    const json = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const [first] = choice.candidates;

    // The derivation above is the signer's: a real choice signed this way reads back.
    expect(signer.read(signed(json(choice)))).toEqual(choice);

    for (const body of [
      json({}),
      json([choice]),
      json({ ...choice, token: 'ghu_person' }),
      json({ ...choice, candidates: [] }),
      json({ ...choice, candidates: Array.from({ length: 21 }, () => first) }),
      json({ ...choice, candidates: [{ ...first, id: 0 }] }),
      json({ ...choice, candidates: [{ ...first, id: '41' }] }),
      json({ ...choice, candidates: [{ ...first, repositorySelection: 'all' }] }),
      json({ ...choice, candidates: [{ ...first, account: { ...first?.account, type: 'Bot' } }] }),
      json({ ...choice, candidates: [{ ...first, account: { ...first?.account, login: '' } }] }),
      // Whether another workspace holds it is said, as a boolean, and never as a workspace.
      json({ ...choice, candidates: [{ id: 41, account: first?.account }] }),
      json({ ...choice, candidates: [{ ...first, heldElsewhere: 'yes' }] }),
      json({ ...choice, candidates: [{ ...first, heldBy: 'acme-workspace' }] }),
      json({ ...choice, sessionId: '' }),
      json({ ...choice, expiresAt: 1.5 }),
      // A Connect's state, which names no candidates.
      json({ workspaceId: 'sprocket', personId: 'dana', sessionId: 's-1', expiresAt: 1 }),
      Buffer.from('{not json').toString('base64url'),
    ]) {
      expect(signer.read(signed(body))).toBeNull();
    }
  });
});
