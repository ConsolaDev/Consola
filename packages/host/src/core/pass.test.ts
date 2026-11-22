import { describe, expect, it } from 'vite-plus/test';
import { checkPassClaims, type PassClaims, passCloseCode } from './pass.ts';

const NOW = 1_800_000_000;
const claims = (over: Partial<PassClaims> = {}): PassClaims => ({
  sub: 'user-1',
  ws: 'sprocket',
  sid: 's-1',
  iat: NOW - 10,
  exp: NOW + 600,
  ...over,
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
});

describe('passCloseCode', () => {
  it('closes with 4401 for a pass that is missing, invalid, expired or not yet valid', () => {
    for (const refusal of ['missing', 'invalid', 'expired', 'not-yet-valid'] as const) {
      expect(passCloseCode(refusal)).toBe(4401);
    }
  });

  it('closes with 4403 for a valid pass for another session', () => {
    expect(passCloseCode('wrong-session')).toBe(4403);
  });
});
