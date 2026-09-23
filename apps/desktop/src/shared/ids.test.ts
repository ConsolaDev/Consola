import { describe, expect, it } from 'vitest';
import { generateId } from './ids';

describe('generateId', () => {
  it('mints a different id on every call, even within one millisecond', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateId()));
    expect(ids.size).toBe(50);
  });

  it('is plain base36 text — safe as a JSON key and a DOM id', () => {
    expect(generateId()).toMatch(/^[0-9a-z]+$/);
  });
});
