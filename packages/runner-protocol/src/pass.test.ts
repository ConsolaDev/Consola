import { describe, expect, it } from 'vitest';
import {
  PASS_AUDIENCE,
  PASS_MAX_LIFETIME_SECONDS,
  PASS_TYPE,
  passClaims,
  readPassClaims,
} from './pass.js';

const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const grant = {
  personId: 'person-1',
  workspaceId: 'ws-1',
  sessionId: 's-1',
  issuedAt: 1_800_000_000,
  lifetimeSeconds: 60,
};

describe('the pass contract', () => {
  it('names an audience that is no cell token and a type of its own', () => {
    // cloud-contract's CELL_TOKEN_AUDIENCE: a package may not import it, so it is written here.
    expect(PASS_AUDIENCE).not.toBe('consola-cell');
    expect(PASS_TYPE.length).toBeGreaterThan(0);
    expect(PASS_MAX_LIFETIME_SECONDS).toBeGreaterThan(0);
  });
});

describe('passClaims', () => {
  it('round-trips through readPassClaims, and through JSON', () => {
    const claims = passClaims(grant);
    expect(claims).toEqual({
      aud: PASS_AUDIENCE,
      sub: 'person-1',
      ws: 'ws-1',
      sid: 's-1',
      iat: 1_800_000_000,
      exp: 1_800_000_060,
    });
    expect(readPassClaims(wire(claims))).toEqual({ ok: true, value: claims });
  });

  it('allows the longest lifetime and no longer', () => {
    expect(() =>
      passClaims({ ...grant, lifetimeSeconds: PASS_MAX_LIFETIME_SECONDS }),
    ).not.toThrow();
    expect(() => passClaims({ ...grant, lifetimeSeconds: PASS_MAX_LIFETIME_SECONDS + 1 })).toThrow(
      TypeError,
    );
  });

  it.each([
    ['an empty person', { personId: '' }],
    ['an empty workspace', { workspaceId: '' }],
    ['an empty session', { sessionId: '' }],
    ['a fractional time', { issuedAt: 1.5 }],
    ['a negative time', { issuedAt: -1 }],
    ['a zero lifetime', { lifetimeSeconds: 0 }],
    ['a negative lifetime', { lifetimeSeconds: -5 }],
    ['a fractional lifetime', { lifetimeSeconds: 0.5 }],
  ])('throws on %s', (_name, change) => {
    expect(() => passClaims({ ...grant, ...change })).toThrow(TypeError);
  });
});

describe('readPassClaims', () => {
  const claims = passClaims(grant);

  it.each([
    ['another audience', { ...claims, aud: 'consola-cell' }],
    ['a missing claim', { ...claims, sid: undefined }],
    ['a missing sub', { ...claims, sub: undefined }],
    ['an extra claim', { ...claims, role: 'member' }],
    ['an empty sid', { ...claims, sid: '' }],
    ['a fractional iat', { ...claims, iat: 1.5 }],
    ['a string exp', { ...claims, exp: '1800000060' }],
    ['exp equal to iat', { ...claims, exp: claims.iat }],
    ['exp before iat', { ...claims, exp: claims.iat - 1 }],
    ['a lifetime over the cap', { ...claims, exp: claims.iat + PASS_MAX_LIFETIME_SECONDS + 1 }],
    ['not an object', 'pass'],
    ['null', null],
    ['an array', []],
  ])('refuses %s', (_name, value) => {
    expect(readPassClaims(wire(value)).ok).toBe(false);
  });

  it('does not judge the time against now: that is the host', () => {
    expect(readPassClaims(wire({ ...claims, iat: 1, exp: 2 })).ok).toBe(true);
  });

  it('names the claim and never its contents', () => {
    const read = readPassClaims(wire({ ...claims, sub: 7, ws: 'hunter2-secret' }));
    expect(read.ok).toBe(false);
    expect(JSON.stringify(read)).not.toContain('hunter2');
  });
});
