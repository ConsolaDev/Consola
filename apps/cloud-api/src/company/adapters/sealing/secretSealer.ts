import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SecretSealer } from '../../application/slackPorts.js';
import type { Sealed } from '../../domain/slack.js';

/** What every text this sealer seals starts with: its format, so a later one can be told apart. */
const VERSION = 'v1';
/** AES-256-GCM's nonce, 12 random bytes for each text sealed. */
const IV_BYTES = 12;
/** GCM's tag, which says the text was sealed with this key and not changed since. */
const TAG_BYTES = 16;
/** The key: 32 bytes. */
export const SECRETS_KEY_BYTES = 32;

/** base64url, as it is written in a sealed text: letters, digits, `-` and `_`. */
const PART = /^[A-Za-z0-9_-]+$/;

/**
 * Seals the secrets Consola keeps for its connections (Slack's client and signing secrets and
 * bot tokens) with AES-256-GCM under `CONNECTION_SECRETS_KEY`: `v1.<iv>.<ciphertext>.<tag>`, each
 * part base64url, a new random IV every time. Opening checks the tag, so a text sealed under
 * another key, or changed, opens to nothing (null). This is the only code that seals or opens
 * one (`src/boundary.test.ts`), and it logs nothing.
 *
 * `key` is the variable's value, 32 bytes in base64, which `config.ts` checks the shape of.
 */
export function createSecretSealer(key: string): SecretSealer {
  const secretKey = Buffer.from(key, 'base64');
  if (secretKey.length !== SECRETS_KEY_BYTES) {
    throw new Error(`The connection secrets key must be ${SECRETS_KEY_BYTES} bytes.`);
  }

  return {
    seal(secret) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', secretKey, iv, { authTagLength: TAG_BYTES });
      const sealed = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, iv, sealed, tag]
        .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
        .join('.') as Sealed;
    },

    open(sealed) {
      const parts = sealed.split('.');
      if (parts.length !== 4) return null;
      const [version, ivText = '', bodyText = '', tagText = ''] = parts;
      if (version !== VERSION || ![ivText, tagText].every((part) => PART.test(part))) return null;
      if (bodyText !== '' && !PART.test(bodyText)) return null;
      const iv = Buffer.from(ivText, 'base64url');
      const tag = Buffer.from(tagText, 'base64url');
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
      try {
        const decipher = createDecipheriv('aes-256-gcm', secretKey, iv, {
          authTagLength: TAG_BYTES,
        });
        decipher.setAuthTag(tag);
        const opened = Buffer.concat([
          decipher.update(Buffer.from(bodyText, 'base64url')),
          decipher.final(),
        ]);
        return opened.toString('utf8');
      } catch {
        // Another key's, or changed: GCM's tag does not check.
        return null;
      }
    },
  };
}
