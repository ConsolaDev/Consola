import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { z } from 'zod';

/** Signs values of one shape, and reads back only what it signed, still of that shape. */
export type SignedTokens<T> = {
  sign(value: T): string;
  /** The value, or null when the token is not one this signed, or not of the shape. */
  read(token: string): T | null;
};

/**
 * Tokens of one purpose, signed with HMAC-SHA256: the value as JSON in base64url, a dot, and its
 * MAC. The key is derived from `secret` (the service's own, `BETTER_AUTH_SECRET`) with HKDF for
 * `purpose` alone, so no two purposes share a key, and a token of one is never read as another's.
 * Reading refuses a token longer than `maxLength` before anything else, checks the MAC in constant
 * time, and only then reads the value and its exact shape.
 */
export function createSignedTokens<T>(options: {
  secret: string;
  purpose: string;
  shape: z.ZodType<T>;
  maxLength: number;
}): SignedTokens<T> {
  const { shape, maxLength } = options;
  const key = Buffer.from(hkdfSync('sha256', options.secret, '', options.purpose, 32));
  const macOf = (body: string) => createHmac('sha256', key).update(body).digest();

  return {
    sign(value) {
      const body = Buffer.from(JSON.stringify(value)).toString('base64url');
      return `${body}.${macOf(body).toString('base64url')}`;
    },

    read(token) {
      if (token.length > maxLength) return null;
      const parts = token.split('.');
      if (parts.length !== 2) return null;
      const [body = '', mac = ''] = parts;
      const given = Buffer.from(mac, 'base64url');
      const expected = macOf(body);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        return null;
      }
      const value = shape.safeParse(parsed);
      return value.success ? value.data : null;
    },
  };
}
