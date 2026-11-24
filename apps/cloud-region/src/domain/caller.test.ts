import {
  CELL_TOKEN_LIFETIME_SECONDS,
  CLOCK_SKEW_SECONDS,
  cellTokenClaims,
} from '@consola/cloud-contract';
import type { CellTokenGrant } from '@consola/cloud-contract';
import { describe, expect, it } from 'vitest';
import { admitClaims } from './caller.js';
import type { Caller } from './caller.js';

const NOW = 1_800_000_000;

/** The claims as they are once a token's JSON has been parsed. */
const claims = (overrides: Partial<CellTokenGrant> = {}): unknown =>
  JSON.parse(
    JSON.stringify(
      cellTokenClaims({
        personId: 'person-1',
        workspaceId: 'acme',
        role: 'admin',
        region: 'eu',
        issuedAt: NOW,
        ...overrides,
      }),
    ),
  );

describe('admitClaims', () => {
  it('accepts claims the contract reads, for this region, as their caller', () => {
    expect(admitClaims(claims(), NOW, 'eu')).toEqual({
      kind: 'accepted',
      caller: { personId: 'person-1', workspaceId: 'acme', role: 'admin', region: 'eu' },
    });
  });

  it('refuses claims the contract does not read', () => {
    const extra = { ...(claims() as object), email: 'someone@sprocket.test' };
    const { ws: _ws, ...missing } = claims() as Record<string, unknown>;
    for (const payload of [extra, missing, 'acme', null]) {
      expect(admitClaims(payload, NOW, 'eu')).toEqual({ kind: 'invalid' });
    }
  });

  it('reads the times at the moment it is given, allowing the skew', () => {
    const expires = NOW + CELL_TOKEN_LIFETIME_SECONDS;
    expect(admitClaims(claims(), expires + CLOCK_SKEW_SECONDS - 1, 'eu').kind).toBe('accepted');
    expect(admitClaims(claims(), expires + CLOCK_SKEW_SECONDS, 'eu')).toEqual({ kind: 'invalid' });
    expect(admitClaims(claims(), NOW - CLOCK_SKEW_SECONDS - 1, 'eu')).toEqual({ kind: 'invalid' });
  });

  it('refuses a token for a workspace in another region', () => {
    expect(admitClaims(claims({ region: 'us' }), NOW, 'eu')).toEqual({ kind: 'other-region' });
    expect(admitClaims(claims({ region: 'us' }), NOW, 'us').kind).toBe('accepted');
  });

  it('judges the region only of claims that read', () => {
    const expired = NOW + CELL_TOKEN_LIFETIME_SECONDS + CLOCK_SKEW_SECONDS;
    expect(admitClaims(claims({ region: 'us' }), expired, 'eu')).toEqual({ kind: 'invalid' });
  });

  it('is the only way to a caller: one written by hand does not type-check', () => {
    // @ts-expect-error A caller comes from a checked token, never from a literal.
    const forged: Caller = {
      personId: 'person-1',
      workspaceId: 'sprocket',
      role: 'owner',
      region: 'eu',
    };
    expect(forged.workspaceId).toBe('sprocket');
  });
});
