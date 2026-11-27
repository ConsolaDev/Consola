import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isLinkTokenShape } from '../../domain/slack.js';
import { linkTokens } from './linkTokens.js';

describe('link tokens', () => {
  it('are 32 random bytes in base64url, a new one each time', () => {
    const one = linkTokens.newToken();
    const two = linkTokens.newToken();
    expect(Buffer.from(one, 'base64url')).toHaveLength(32);
    expect(one).not.toBe(two);
    expect(isLinkTokenShape(one)).toBe(true);
  });

  it('are kept as their SHA-256 in hex', () => {
    const token = linkTokens.newToken();
    expect(linkTokens.hashOf(token)).toBe(createHash('sha256').update(token).digest('hex'));
    expect(linkTokens.hashOf(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('are told from anything else by their shape', () => {
    for (const value of ['', 'short', `${'a'.repeat(43)}=`, 'a'.repeat(44), `${'a'.repeat(42)}/`]) {
      expect([value, isLinkTokenShape(value)]).toEqual([value, false]);
    }
  });
});
