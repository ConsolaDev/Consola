import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Sealed } from '../../domain/slack.js';
import { createSecretSealer } from './secretSealer.js';

const key = () => randomBytes(32).toString('base64');
const SIGNING_SECRET = '8f742231b10e8888abcd99yyyzzz85a5';

describe('the secret sealer', () => {
  it('opens what it sealed, and nothing of the secret shows in the sealed text', () => {
    const sealer = createSecretSealer(key());
    const sealed = sealer.seal(SIGNING_SECRET);
    expect(sealed).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(sealed).not.toContain(SIGNING_SECRET);
    expect(sealer.open(sealed)).toBe(SIGNING_SECRET);
  });

  it('seals the same secret differently each time', () => {
    const sealer = createSecretSealer(key());
    expect(sealer.seal(SIGNING_SECRET)).not.toBe(sealer.seal(SIGNING_SECRET));
  });

  it('seals an empty text and any text', () => {
    const sealer = createSecretSealer(key());
    for (const secret of ['', 'xoxb-1-2-sprocket', 'ünïcödé ✓']) {
      expect(sealer.open(sealer.seal(secret))).toBe(secret);
    }
  });

  it('opens nothing sealed under another key', () => {
    const sealed = createSecretSealer(key()).seal(SIGNING_SECRET);
    expect(createSecretSealer(key()).open(sealed)).toBeNull();
  });

  it('opens nothing changed, or not sealed at all', () => {
    const sealer = createSecretSealer(key());
    const sealed = sealer.seal(SIGNING_SECRET);
    const [version, iv, body, tag] = sealed.split('.') as [string, string, string, string];
    const flipped = `${body.startsWith('A') ? 'B' : 'A'}${body.slice(1)}`;
    for (const text of [
      `${version}.${iv}.${flipped}.${tag}`,
      `v2.${iv}.${body}.${tag}`,
      `${version}.${iv}.${body}`,
      `${version}.${iv}.${body}.${tag}.x`,
      `${version}.!!.${body}.${tag}`,
      SIGNING_SECRET,
      '',
    ]) {
      expect(sealer.open(text as Sealed)).toBeNull();
    }
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => createSecretSealer(randomBytes(16).toString('base64'))).toThrow('32 bytes');
  });
});
