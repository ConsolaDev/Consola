import { describe, expect, it } from 'vitest';
import { roleForNewMember } from './organization.js';

describe('roleForNewMember', () => {
  it('makes the first person the owner', () => {
    expect(roleForNewMember(0)).toBe('owner');
  });

  it('makes everyone after a member', () => {
    expect(roleForNewMember(1)).toBe('member');
    expect(roleForNewMember(7)).toBe('member');
  });
});
