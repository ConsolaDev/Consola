import {
  PASS_AUDIENCE,
  PASS_MAX_LIFETIME_SECONDS,
  PASS_TYPE,
  passClaims,
} from '@consola/runner-protocol';
import { describe, expect, it } from 'vite-plus/test';
import { checkPassClaims, DEV_PASS_SECONDS, readPass } from './pass.ts';
import type { PassClaims } from './pass.ts';

const NOW = 1_800_000_000;
const claims = (over: Partial<PassClaims> = {}): PassClaims => ({
  aud: PASS_AUDIENCE,
  sub: 'user-1',
  ws: 'sprocket',
  sid: 's-1',
  iat: NOW - 10,
  exp: NOW + 290,
  ...over,
});

describe('readPass', () => {
  /** What the cell signs (`passSigner`): the protocol's claims, under `typ` `PASS_TYPE`. */
  const cells = passClaims({
    personId: 'person-acme-1',
    workspaceId: 'workspace-sprocket',
    sessionId: 's-1',
    issuedAt: NOW,
    lifetimeSeconds: PASS_MAX_LIFETIME_SECONDS,
  });

  it("takes a cell's pass: the protocol's claims under the protocol's type", () => {
    expect(readPass(PASS_TYPE, cells, 'cell')).toEqual(cells);
    expect(readPass(PASS_TYPE, claims(), 'cell')).toEqual(claims());
  });

  it.each<[string, unknown, unknown]>([
    ['another audience', PASS_TYPE, { ...cells, aud: 'consola-cell' }],
    ['no audience', PASS_TYPE, (({ aud: _aud, ...rest }) => rest)(cells)],
    ['no type', undefined, cells],
    ['a plain JWT type', 'JWT', cells],
    [
      'a lifetime over the cap',
      PASS_TYPE,
      { ...cells, exp: cells.iat + PASS_MAX_LIFETIME_SECONDS + 1 },
    ],
    ['a field the contract does not name', PASS_TYPE, { ...cells, email: 'person@acme.test' }],
    ['claims that are not an object', PASS_TYPE, 'a pass'],
  ])('refuses %s', (_name, typ, payload) => {
    expect(readPass(typ, payload, 'cell')).toBeNull();
  });

  it("takes a dev host's own pass, which outlives the cap, only as a dev host's", () => {
    const dev = claims({ iat: NOW, exp: NOW + DEV_PASS_SECONDS });
    expect(DEV_PASS_SECONDS).toBeGreaterThan(PASS_MAX_LIFETIME_SECONDS);
    expect(readPass(PASS_TYPE, dev, 'dev')).toEqual(dev);
    expect(readPass(PASS_TYPE, dev, 'cell')).toBeNull();
  });

  it.each<[string, unknown, unknown]>([
    [
      'a lifetime over the dev pass',
      PASS_TYPE,
      claims({ iat: NOW, exp: NOW + DEV_PASS_SECONDS + 1 }),
    ],
    ['another audience', PASS_TYPE, { ...claims(), aud: 'consola-cell' }],
    ['no type', undefined, claims()],
    ['an exp before its iat', PASS_TYPE, claims({ iat: NOW, exp: NOW - 1 })],
    ['an exp that is no whole second', PASS_TYPE, claims({ iat: NOW, exp: NOW + 400.5 })],
    ['claims that are not an object', PASS_TYPE, null],
  ])('refuses for a dev host %s', (_name, typ, payload) => {
    expect(readPass(typ, payload, 'dev')).toBeNull();
  });
});

describe('checkPassClaims', () => {
  it('accepts a pass for this session within its lifetime', () => {
    expect(checkPassClaims(claims(), 's-1', NOW)).toEqual({ ok: true });
  });

  it('refuses a pass for another session', () => {
    expect(checkPassClaims(claims({ sid: 's-1' }), 's-2', NOW)).toEqual({
      ok: false,
      reason: 'wrong-session',
    });
  });

  it('treats exp equal to now as expired', () => {
    expect(checkPassClaims(claims({ exp: NOW }), 's-1', NOW)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses an iat 120 s in the future', () => {
    expect(checkPassClaims(claims({ iat: NOW + 120 }), 's-1', NOW)).toEqual({
      ok: false,
      reason: 'not-yet-valid',
    });
  });

  it('allows 60 s of clock skew on iat', () => {
    expect(checkPassClaims(claims({ iat: NOW + 59 }), 's-1', NOW)).toEqual({ ok: true });
  });

  it('accepts an iat exactly 60 s ahead, and refuses one 61 s ahead', () => {
    expect(checkPassClaims(claims({ iat: NOW + 60 }), 's-1', NOW)).toEqual({ ok: true });
    expect(checkPassClaims(claims({ iat: NOW + 61 }), 's-1', NOW)).toEqual({
      ok: false,
      reason: 'not-yet-valid',
    });
  });

  it('accepts a pass with one second left (exp = now + 1)', () => {
    expect(checkPassClaims(claims({ exp: NOW + 1 }), 's-1', NOW)).toEqual({ ok: true });
  });
});
