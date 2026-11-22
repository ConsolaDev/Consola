import { describe, expect, it } from 'vitest';
import { initialsOf } from './me';

describe('initialsOf', () => {
  it('takes the first letters of the first two words, capitalised', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('ada king lovelace')).toBe('AK');
    expect(initialsOf('Ada')).toBe('A');
  });

  it('ignores extra spaces', () => {
    expect(initialsOf('  Ada   Lovelace ')).toBe('AL');
  });

  it('keeps a letter outside the basic plane whole', () => {
    expect(initialsOf('𝒜da Lovelace')).toBe('𝒜L');
  });

  it('gives ? for a name with nothing in it', () => {
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('   ')).toBe('?');
  });
});
