import { describe, expect, it } from 'vitest';
import { maskSecrets } from '../steps/commandIO';
import {
  MAX_SECRET_VALUE_BYTES,
  MIN_SECRET_VALUE_CHARS,
  maskFormsOf,
  normalizeSecretValue,
} from './values';

const SEEDED = 'stub-pager-secret-7f3a"\\back%slash\nline two!';

describe('normalizeSecretValue', () => {
  it('drops one trailing newline, and only one', () => {
    expect(normalizeSecretValue('stub-pager-secret-1\n')).toEqual({
      ok: true,
      value: 'stub-pager-secret-1',
    });
    expect(normalizeSecretValue('stub-pager-secret-1\n\n')).toEqual({
      ok: true,
      value: 'stub-pager-secret-1\n',
    });
    expect(normalizeSecretValue('stub-pager-secret-1')).toEqual({
      ok: true,
      value: 'stub-pager-secret-1',
    });
  });

  it('wants at least 8 code points, however many bytes they take', () => {
    expect(MIN_SECRET_VALUE_CHARS).toBe(8);
    expect(normalizeSecretValue('1234567')).toEqual({
      ok: false,
      reason: 'its value is too short to mask safely (under 8 characters)',
    });
    // 8 code points, 15 bytes.
    expect(normalizeSecretValue('ééééééé1')).toEqual({ ok: true, value: 'ééééééé1' });
    // 7 code points of 4 bytes each: 28 bytes, still too short.
    expect(normalizeSecretValue('😀😀😀😀😀😀😀').ok).toBe(false);
    // The newline it drops does not count.
    expect(normalizeSecretValue('1234567\n').ok).toBe(false);
  });

  it('holds a value to 64 KB of UTF-8', () => {
    expect(MAX_SECRET_VALUE_BYTES).toBe(65_536);
    expect(normalizeSecretValue('x'.repeat(65_536)).ok).toBe(true);
    expect(normalizeSecretValue('x'.repeat(65_537))).toEqual({
      ok: false,
      reason: 'its value is over 64 KB',
    });
    // Counted in bytes: 32 768 two-byte characters fill it, one more does not fit.
    expect(normalizeSecretValue('é'.repeat(32_768)).ok).toBe(true);
    expect(normalizeSecretValue('é'.repeat(32_769)).ok).toBe(false);
    // The newline it drops is not counted either.
    expect(normalizeSecretValue(`${'x'.repeat(65_536)}\n`).ok).toBe(true);
  });

  it('refuses a NUL', () => {
    expect(normalizeSecretValue('abcdefgh\0')).toEqual({
      ok: false,
      reason: 'its value holds a NUL character',
    });
  });
});

describe('maskFormsOf', () => {
  const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

  it('masks the value, its long lines, and its escaped, encoded and base64 forms', () => {
    const forms = maskFormsOf(SEEDED);
    expect(forms).toContain(SEEDED);
    expect(forms).toContain(String.raw`stub-pager-secret-7f3a"\back%slash`);
    // 9 characters: kept.
    expect(forms).toContain('line two!');
    expect(forms).toContain(String.raw`stub-pager-secret-7f3a\"\\back%slash\nline two!`);
    expect(forms).toContain(JSON.stringify(SEEDED).slice(1, -1));
    expect(forms).toContain(encodeURIComponent(SEEDED));
    expect(forms).toContain(base64(SEEDED));
  });

  it("masks a CRLF value's lines without their CR, as a program printing one line shows it (review M3)", () => {
    const value = 'stub-pem-line-one-7f3a\r\nstub-pem-line-two-9c1e\r\nshort\r';
    const forms = maskFormsOf(value);
    expect(forms).toContain('stub-pem-line-one-7f3a');
    expect(forms).toContain('stub-pem-line-one-7f3a\r');
    expect(forms).toContain('stub-pem-line-two-9c1e');
    // A line under 8 characters without its CR is still too short to mask.
    expect(forms).not.toContain('short');
    expect(forms).not.toContain('short\r');
    expect(maskSecrets('printed: stub-pem-line-one-7f3a\n', forms)).toBe('printed: ***\n');
  });

  it('drops a line under 8 characters', () => {
    const forms = maskFormsOf('stub-pager-secret-7f3a\nshort!');
    expect(forms).not.toContain('short!');
    expect(forms).toContain('stub-pager-secret-7f3a');
  });

  it.each([
    ['', 0],
    ['u', 1],
    ['u:', 2],
  ])('shows in a longer base64 run after %j (alignment %i)', (prefix) => {
    for (const value of [SEEDED, 'stub-tracker-secret-9c1e', 'stub-slack-secret-12', 'ééééééé1']) {
      const run = base64(`${prefix}${value}`);
      expect(
        maskFormsOf(value).some((form) => form !== value && run.includes(form)),
        `${prefix}|${value}`,
      ).toBe(true);
      // And after it, whatever follows.
      expect(
        maskFormsOf(value).some((form) => base64(`${prefix}${value} and more`).includes(form)),
      ).toBe(true);
    }
  });

  it('keeps every form 8 characters or more but the value, once each, longest first', () => {
    for (const value of [SEEDED, 'stub-pager-secret-1', 'abcdefgh', 'ééééééé1']) {
      const forms = maskFormsOf(value);
      expect(forms[0].length).toBeGreaterThanOrEqual(forms[forms.length - 1].length);
      for (const form of forms) {
        if (form !== value) expect([...form].length, form).toBeGreaterThanOrEqual(8);
      }
      expect(new Set(forms).size).toBe(forms.length);
      for (let i = 1; i < forms.length; i++) {
        expect(forms[i - 1].length).toBeGreaterThanOrEqual(forms[i].length);
      }
    }
  });

  it('encodes base64 as Node does, each padding case included', () => {
    // Byte lengths 24, 25 and 26 leave 0, 1 and 2 over a multiple of 3.
    for (const value of [
      SEEDED,
      'stub-pager-secret-7f3a-x',
      'stub-pager-secret-7f3a-xy',
      'stub-pager-secret-7f3a-xyz',
    ]) {
      expect(maskFormsOf(value), value).toContain(base64(value));
    }
    expect(
      ['stub-pager-secret-7f3a-x', 'stub-pager-secret-7f3a-xy', 'stub-pager-secret-7f3a-xyz'].map(
        (v) => Buffer.byteLength(v) % 3,
      ),
    ).toEqual([0, 1, 2]);
  });
});
