import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from './sha256';

const nodeHex = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex');

describe('sha256Hex', () => {
  it.each([
    '',
    'abc',
    'name: Reviewer\ntools: edit\n',
    'naïve café 日本語 🙂',
    'x'.repeat(100_000),
  ])('gives node:crypto’s digest of the text as UTF-8 (%#)', (text) => {
    expect(sha256Hex(text)).toBe(nodeHex(text));
  });

  it('gives node:crypto’s digest of bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 128, 64]);
    expect(sha256Hex(bytes)).toBe(nodeHex(bytes));
  });
});

describe('the package outside Node', () => {
  // The web app checks a factory's files in the browser, so nothing the package ships may need
  // Node: a `node:` builtin, or one named without its prefix.
  const BUILTIN = /from ['"](?:node:|(?:crypto|fs|path|os|child_process|util|stream|buffer)['"])/;

  it('imports no Node builtin outside its tests', () => {
    const shipped = readdirSync(__dirname).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
    );
    const importing = shipped.filter((file) =>
      BUILTIN.test(readFileSync(join(__dirname, file), 'utf8')),
    );
    expect(importing).toEqual([]);
  });
});
