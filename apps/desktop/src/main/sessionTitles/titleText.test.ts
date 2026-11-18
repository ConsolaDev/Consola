import { describe, expect, it } from 'vitest';
import { isAwaitingName, sanitizeTitle, standInName } from './titleText';

describe('standInName', () => {
  it('collapses whitespace and cuts at 50 code points with one ellipsis', () => {
    expect(standInName('  Fix\n\tthe   login  ')).toBe('Fix the login');
    expect(standInName('a'.repeat(60))).toBe('a'.repeat(50) + '…');
    expect(standInName('🙂'.repeat(51))).toBe('🙂'.repeat(50) + '…'); // code points, not UTF-16 units
    expect(standInName('a'.repeat(50))).toBe('a'.repeat(50));
  });
});

describe('sanitizeTitle', () => {
  it('takes the first line, strips wrapping quotes and backticks, and caps at 120', () => {
    expect(sanitizeTitle('"Login Redirect Loop"\nbecause…')).toBe('Login Redirect Loop');
    expect(sanitizeTitle('`“Session Startup Failure”`')).toBe('Session Startup Failure');
    expect(sanitizeTitle('x'.repeat(130))).toBe('x'.repeat(119) + '…');
  });

  it('treats empty, non-string and the placeholder as no title', () => {
    expect(sanitizeTitle('   ')).toBeNull();
    expect(sanitizeTitle(42)).toBeNull();
    expect(sanitizeTitle('New Session')).toBeNull();
  });
});

describe('isAwaitingName', () => {
  it('awaits a name only for a non-Assistant session still called New Session and not user-named', () => {
    expect(isAwaitingName({ name: 'New Session', kind: 'interactive' })).toBe(true);
    expect(isAwaitingName({ name: 'New Session', nameIsUserSet: true, kind: 'interactive' })).toBe(
      false,
    );
    expect(isAwaitingName({ name: 'PR #12 · Review', kind: 'interactive' })).toBe(false);
    expect(isAwaitingName({ name: 'New Session', kind: 'assistant' })).toBe(false);
  });
});
