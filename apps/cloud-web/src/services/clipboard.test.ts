import { describe, expect, it } from 'vitest';
import { copyText } from './clipboard';

describe('copyText', () => {
  it('writes the text and says it did', async () => {
    const written: string[] = [];
    const clipboard = { writeText: async (text: string) => void written.push(text) };
    expect(await copyText('acme', clipboard)).toBe(true);
    expect(written).toEqual(['acme']);
  });

  it('says it did not when the browser refuses the write', async () => {
    const clipboard = {
      writeText: async () => {
        throw new DOMException('Document is not focused.', 'NotAllowedError');
      },
    };
    expect(await copyText('acme', clipboard)).toBe(false);
  });

  it('says it did not when there is no clipboard to write to', async () => {
    expect(await copyText('acme', null)).toBe(false);
  });
});
