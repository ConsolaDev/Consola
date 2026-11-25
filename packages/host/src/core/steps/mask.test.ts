import { maskFormsOf } from '@consola/automation-engine/core';
import { describe, expect, it } from 'vite-plus/test';
import { MASK, MaskedTail, maskText } from './mask.ts';

/** Not a real token; its `/` and `+` make its encoded forms differ from it. */
const TOKEN = 'ghs_Sprocket/Token+0123456789';

const base64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

describe('masking a step’s output', () => {
  it('masks a secret in every printed form the engine masks', () => {
    const forms = maskFormsOf(TOKEN);
    expect(forms[0]?.length).toBeGreaterThanOrEqual(TOKEN.length);
    for (const printed of [
      TOKEN,
      encodeURIComponent(TOKEN),
      base64(TOKEN),
      JSON.stringify(`a\n${TOKEN}`).slice(1, -1),
      // Inside a longer base64 run, at each of the three alignments.
      base64(`x${TOKEN}y`),
      base64(`xx${TOKEN}`),
      base64(`xxx${TOKEN}zz`),
    ]) {
      expect(maskText(`said: ${printed}.`, [TOKEN])).not.toContain(printed);
    }
    expect(maskText(`token=${TOKEN}`, [TOKEN])).toBe(`token=${MASK}`);
    expect(maskText('nothing here', [''])).toBe('nothing here');
  });

  it('masks a secret split across chunks, and one a stream ends inside', () => {
    const tail = new MaskedTail([TOKEN]);
    tail.push(`before ${TOKEN.slice(0, 9)}`);
    tail.push(`${TOKEN.slice(9)} after\nand then ${TOKEN.slice(0, 12)}`);
    const { text, truncated, bytes } = tail.end();
    expect(text).toBe(`before ${MASK} after\nand then ${MASK}`);
    expect(text).not.toContain(TOKEN.slice(0, 9));
    expect(truncated).toBe(false);
    expect(bytes).toBe(Buffer.byteLength(`before ${TOKEN} after\nand then ${TOKEN.slice(0, 12)}`));
  });

  it('keeps the end of a long stream, masked before it is cut', () => {
    const tail = new MaskedTail([TOKEN], 40);
    tail.push('x'.repeat(100));
    tail.push(` ${TOKEN} end`);
    const { text, truncated, bytes } = tail.end();
    expect(truncated).toBe(true);
    expect(text.length).toBe(40);
    expect(text.endsWith(` ${MASK} end`)).toBe(true);
    expect(text).not.toContain('Token');
    expect(bytes).toBe(100 + TOKEN.length + 5);
  });
});
