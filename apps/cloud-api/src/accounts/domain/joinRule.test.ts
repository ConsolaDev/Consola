import { describe, expect, it } from 'vitest';
import { mayJoin } from './joinRule.js';

describe('mayJoin', () => {
  it('lets a verified email join', () => {
    expect(mayJoin({ emailVerified: true })).toBe(true);
  });

  it('turns an unverified email away', () => {
    expect(mayJoin({ emailVerified: false })).toBe(false);
  });
});
