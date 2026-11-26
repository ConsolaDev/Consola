import { cellTokenClaims } from '@consola/cloud-contract';
import { describe, expect, it } from 'vitest';
import { authenticate } from './authenticate.js';
import type { Clock, SignatureCheck, TokenVerifier } from './ports.js';

const NOW = 1_800_000_000;

const clock: Clock = { nowSeconds: () => NOW };

const goodClaims = (region: 'eu' | 'us' = 'eu') =>
  cellTokenClaims({
    personId: 'person-1',
    workspaceId: 'acme',
    role: 'member',
    region,
    issuedAt: NOW,
  });

/** A verifier that answers `check` for every token, and remembers what it was asked. */
function verifier(check: SignatureCheck): TokenVerifier & { asked: Array<[string, number]> } {
  const asked: Array<[string, number]> = [];
  return {
    asked,
    async verify(token, nowSeconds) {
      asked.push([token, nowSeconds]);
      return check;
    },
  };
}

describe('authenticate', () => {
  it('refuses a request with no token without asking for a signature check', async () => {
    const tokens = verifier({ kind: 'verified', payload: goodClaims() });
    expect(await authenticate({ tokens, clock }, 'eu', null)).toEqual({ kind: 'missing' });
    expect(tokens.asked).toEqual([]);
  });

  it('accepts a verified token whose claims read, checking both at one moment', async () => {
    const tokens = verifier({ kind: 'verified', payload: goodClaims() });
    expect(await authenticate({ tokens, clock }, 'eu', 'the-token')).toEqual({
      kind: 'accepted',
      caller: { personId: 'person-1', workspaceId: 'acme', role: 'member', region: 'eu' },
    });
    expect(tokens.asked).toEqual([['the-token', NOW]]);
  });

  it('refuses what the signature check refuses', async () => {
    for (const kind of ['invalid', 'keys-unavailable'] as const) {
      const tokens = verifier({ kind });
      expect(await authenticate({ tokens, clock }, 'eu', 'the-token')).toEqual({ kind });
    }
  });

  it('refuses a verified token whose claims do not read', async () => {
    const tokens = verifier({ kind: 'verified', payload: { ...goodClaims(), name: 'Acme' } });
    expect(await authenticate({ tokens, clock }, 'eu', 'the-token')).toEqual({ kind: 'invalid' });
  });

  it('refuses a verified token for another region', async () => {
    const tokens = verifier({ kind: 'verified', payload: goodClaims('us') });
    expect(await authenticate({ tokens, clock }, 'eu', 'the-token')).toEqual({
      kind: 'other-region',
    });
  });
});
