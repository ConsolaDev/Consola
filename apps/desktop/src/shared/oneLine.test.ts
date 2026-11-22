import { describe, expect, it } from 'vitest';
import { oneLine, stripEscapes } from './oneLine';

describe('oneLine', () => {
  it.each<[string, number | undefined, string]>([
    ['', undefined, ''],
    ['\n\n  hi  \nthere', undefined, 'hi'],
    ['a\tb', undefined, 'a b'],
    ['\x1b]0;title\x07ok', undefined, 'ok'],
    ['a\x85b', undefined, 'ab'],
    ['y'.repeat(301), undefined, `${'y'.repeat(300)}…`],
    ['y'.repeat(300), undefined, 'y'.repeat(300)],
    ['z'.repeat(250), 200, `${'z'.repeat(200)}…`],
    ['Looked at \x1b[31mcatalog.ts\x1b[0m\x07\nsecond line', undefined, 'Looked at catalog.ts'],
    ['\r\n \x1b[2K\x07 \r\nreal', undefined, 'real'],
    ['first\rsecond', undefined, 'first'],
    ['one\u2028two', undefined, 'one'],
    ['del\x7f here', undefined, 'del here'],
  ])('oneLine(%j, %s) is %j', (text, max, expected) => {
    expect(oneLine(text, max)).toBe(expected);
  });

  it('never cuts a character in half', () => {
    const shaped = oneLine(`${'a'.repeat(299)}😀tail`);
    expect(shaped).toBe(`${'a'.repeat(299)}…`);
  });
});

describe('stripEscapes', () => {
  it.each<[string, string]>([
    ['\x1b[?25hok', 'ok'],
    ['\x1b[38;5;208mwarm\x1b[0m', 'warm'],
    ['\x1b]8;;https://sprocket.example\x1b\\link\x1b]8;;\x1b\\', 'link'],
    ['\x1b]0;title\x07ok', 'ok'],
    ['\x1b(Bplain\x1b=', 'plain'],
    ['tab\tand\x07bell stay', 'tab\tand\x07bell stay'],
  ])('stripEscapes(%j) is %j', (text, expected) => {
    expect(stripEscapes(text)).toBe(expected);
  });
});
