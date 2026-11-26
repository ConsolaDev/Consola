import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

/**
 * SHA-256 of a text, as UTF-8, or of bytes, in lowercase hex: the digest `node:crypto`'s
 * `createHash('sha256')` gives, computed without Node, so the package runs in a browser too (the
 * web app checks a factory's files as they are edited). Every hash the package makes goes
 * through here, and none it stored before changes.
 */
export function sha256Hex(input: string | Uint8Array): string {
  return bytesToHex(sha256(typeof input === 'string' ? utf8ToBytes(input) : input));
}
