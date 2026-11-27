import { createHmac, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { InstallState } from '../../domain/connections.js';
import { createInstallStateSigner } from './installStateSigner.js';

const SECRET = 'sprocket-test-secret-that-is-long-enough-to-sign-with';
const state: InstallState = {
  workspaceId: 'sprocket',
  personId: 'dana',
  sessionId: 'session-1',
  expiresAt: 1_800_000_600,
};

describe("a Connect's state signer", () => {
  const signer = createInstallStateSigner(SECRET);

  it('reads back exactly what it signed', () => {
    expect(signer.read(signer.sign(state))).toEqual(state);
  });

  it('refuses a state another secret signed', () => {
    const other = createInstallStateSigner(`${SECRET}-other`);
    expect(signer.read(other.sign(state))).toBeNull();
  });

  it('refuses a state whose body was changed', () => {
    const [, mac] = signer.sign(state).split('.');
    const changed = Buffer.from(JSON.stringify({ ...state, workspaceId: 'catalog' })).toString(
      'base64url',
    );
    expect(signer.read(`${changed}.${mac}`)).toBeNull();
  });

  it('does not sign with the secret itself', () => {
    const body = signer.sign(state).split('.')[0] ?? '';
    const plain = createHmac('sha256', SECRET).update(body).digest('base64url');
    expect(signer.read(`${body}.${plain}`)).toBeNull();
  });

  it('refuses what is not a state, however it is shaped', () => {
    for (const token of ['', '.', 'abc', 'a.b.c', `${signer.sign(state)}.x`, 'x'.repeat(2000)]) {
      expect(signer.read(token)).toBeNull();
    }
  });

  it('refuses a properly signed body that is not exactly a state', () => {
    // The signer's own key, derived the way it derives it, so these reach the shape check.
    const key = Buffer.from(
      hkdfSync('sha256', SECRET, '', 'consola cloud: the state of a GitHub Connect', 32),
    );
    const signed = (body: string) =>
      `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
    const json = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

    // The derivation above is the signer's: a real state signed this way reads back.
    expect(signer.read(signed(json(state)))).toEqual(state);

    for (const body of [
      json({}),
      json([state]),
      json({ ...state, role: 'owner' }),
      json({ ...state, expiresAt: '1800000600' }),
      json({ ...state, expiresAt: 1.5 }),
      json({ ...state, workspaceId: '' }),
      json({ ...state, sessionId: '' }),
      // A state that names the person but no session, or the person as a user.
      json({ workspaceId: 'sprocket', personId: 'dana', expiresAt: 1 }),
      json({ workspaceId: 'sprocket', userId: 'dana', sessionId: 's-1', expiresAt: 1 }),
      Buffer.from('{not json').toString('base64url'),
    ]) {
      expect(signer.read(signed(body))).toBeNull();
    }
  });
});
