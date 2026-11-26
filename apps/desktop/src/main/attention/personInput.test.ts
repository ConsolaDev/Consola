import { describe, expect, it } from 'vitest';
import { isPersonKey, pressesEnter } from './personInput';

describe('pressesEnter', () => {
  it('hears Enter, alone or after typing', () => {
    expect(pressesEnter('\r')).toBe(true);
    expect(pressesEnter('yes\r')).toBe(true);
  });

  it('does not hear Shift+Enter, or a CR inside a paste', () => {
    expect(pressesEnter('\x1b\r')).toBe(false);
    expect(pressesEnter('\x1b[200~line one\rline two\x1b[201~')).toBe(false);
    expect(pressesEnter('\x1b[200~text\r\x1b[201~\r')).toBe(true);
  });
});

describe('isPersonKey', () => {
  it('hears keys: a digit, y, Esc, an arrow', () => {
    for (const key of ['1', 'y', '\x1b', '\x1b[A']) expect(isPersonKey(key)).toBe(true);
  });

  it('ignores what the terminal reports by itself', () => {
    for (const report of [
      '\x1b[I',
      '\x1b[O',
      '\x1b[12;40R',
      '\x1b[?1;2c',
      '\x1b[<0;10;5M',
      '\x1b[<0;10;5m',
      '\x1b[M !!',
      '\x1b]11;rgb:0000/0000/0000\x07',
    ]) {
      expect(isPersonKey(report)).toBe(false);
    }
  });
});
