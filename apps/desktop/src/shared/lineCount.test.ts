import { describe, expect, it } from 'vitest';
import { countLines } from './lineCount';

describe('countLines', () => {
  it('does not count the end of a final newline as another line', () => {
    expect(countLines('one\ntwo\n')).toBe(2);
  });

  it('counts a last line that has no newline', () => {
    expect(countLines('one\ntwo')).toBe(2);
  });

  it('counts blank lines', () => {
    expect(countLines('\n\n')).toBe(2);
  });

  it('counts an empty file as no lines', () => {
    expect(countLines('')).toBe(0);
  });
});
