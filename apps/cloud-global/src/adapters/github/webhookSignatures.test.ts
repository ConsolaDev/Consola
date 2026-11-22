import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createWebhookSignatures } from './webhookSignatures.js';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('createWebhookSignatures', () => {
  // GitHub's own example ("Validating webhook deliveries"): this secret, this body, this header.
  it("takes GitHub's own example", () => {
    const signatures = createWebhookSignatures("It's a Secret to Everybody");
    expect(
      signatures.verify(
        bytes('Hello, World!'),
        'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
      ),
    ).toBe(true);
  });

  const secret = 'sprocket-test-webhook-secret-0123456789';
  const body = bytes('{"action":"opened","installation":{"id":41}}');
  const signed = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const signatures = createWebhookSignatures(secret);

  it('takes a body signed with the secret, in either case of hex', () => {
    expect(signatures.verify(body, signed)).toBe(true);
    expect(signatures.verify(body, `sha256=${signed.slice(7).toUpperCase()}`)).toBe(true);
  });

  it.each([
    ['no signature', undefined],
    ['an empty one', ''],
    ['the hex alone', signed.slice(7)],
    ['the old SHA-1 header', `sha1=${createHmac('sha1', secret).update(body).digest('hex')}`],
    ['one cut short', signed.slice(0, -2)],
    ['one too long', `${signed}00`],
    ['one that is not hex', `sha256=${'z'.repeat(64)}`],
    ['one with spaces', ` ${signed} `],
    [
      'one signed with another secret',
      `sha256=${createHmac('sha256', 'acme').update(body).digest('hex')}`,
    ],
  ])('refuses %s', (_what, signature) => {
    expect(signatures.verify(body, signature)).toBe(false);
  });

  it('refuses a body changed after signing, by a byte', () => {
    const changed = bytes('{"action":"opened","installation":{"id":42}}');
    expect(signatures.verify(changed, signed)).toBe(false);
  });
});
