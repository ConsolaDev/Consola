import { describe, expect, it } from 'vitest';
import { sourceUrl } from './buildInfo';

describe('sourceUrl', () => {
  it('points at the running commit', () => {
    expect(sourceUrl('abc123')).toBe('https://github.com/ConsolaDev/Consola/tree/abc123');
  });

  it('points at the repository when the commit is unknown', () => {
    expect(sourceUrl('')).toBe('https://github.com/ConsolaDev/Consola');
  });
});
