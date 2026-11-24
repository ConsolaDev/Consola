/**
 * A secret's value: the checks every runner applies to it, and the printed
 * forms Consola masks wherever it writes. Pure, and with no Node global: the
 * cloud runner runs this file as it is, so bytes come from `TextEncoder` and
 * base64 from the small encoder below.
 */

/** The most a value may hold, in UTF-8 bytes. */
export const MAX_SECRET_VALUE_BYTES = 64 * 1024;
/** The fewest code points a value may hold: a shorter one would mask ordinary text. */
export const MIN_SECRET_VALUE_CHARS = 8;

/** One trailing "\n" dropped, then the checks, in this order: size (UTF-8 bytes), NUL, length (code points). */
export function normalizeSecretValue(
  raw: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  const value = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (new TextEncoder().encode(value).length > MAX_SECRET_VALUE_BYTES)
    return { ok: false, reason: 'its value is over 64 KB' };
  if (value.includes('\0')) return { ok: false, reason: 'its value holds a NUL character' };
  if ([...value].length < MIN_SECRET_VALUE_CHARS)
    return {
      ok: false,
      reason: `its value is too short to mask safely (under ${MIN_SECRET_VALUE_CHARS} characters)`,
    };
  return { ok: true, value };
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64, with `=` padding. */
function base64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const left = bytes.length - i;
    const triple =
      (bytes[i] << 16) | ((left > 1 ? bytes[i + 1] : 0) << 8) | (left > 2 ? bytes[i + 2] : 0);
    out += ALPHABET[(triple >> 18) & 63] + ALPHABET[(triple >> 12) & 63];
    out += left > 1 ? ALPHABET[(triple >> 6) & 63] : '=';
    out += left > 2 ? ALPHABET[triple & 63] : '=';
  }
  return out;
}

/**
 * What a base64 run holding `bytes` shows of them whatever came before, when
 * `offset` bytes (mod 3) did: the characters of the 3-byte groups lying wholly
 * inside them, with `offset` zero bytes standing in for what came before.
 */
function innerBase64(bytes: Uint8Array, offset: number): string {
  const shifted = new Uint8Array(offset + bytes.length);
  shifted.set(bytes, offset);
  const first = offset === 0 ? 0 : 1;
  const end = Math.floor(shifted.length / 3);
  return end > first ? base64(shifted).slice(first * 4, end * 4) : '';
}

/**
 * Every form of `value` Consola masks, longest first, once each: the value;
 * each of its lines, and each without a closing CR (a CRLF value's line as a
 * program printing that one line shows it, review M3); its JSON-escaped form;
 * its percent-encoded form; its base64; and, for each of the three byte
 * alignments, what a longer base64 run holding it shows. Each at least 8
 * characters, but the value itself.
 */
export function maskFormsOf(value: string): string[] {
  const bytes = new TextEncoder().encode(value);
  const lines = value.split('\n');
  const candidates = [
    ...lines,
    ...lines.map((line) => line.replace(/\r$/, '')),
    JSON.stringify(value).slice(1, -1),
    encodeURIComponent(value),
    base64(bytes),
    innerBase64(bytes, 0),
    innerBase64(bytes, 1),
    innerBase64(bytes, 2),
  ].filter((form) => [...form].length >= MIN_SECRET_VALUE_CHARS);
  const forms = [...new Set([value, ...candidates])];
  // Stable: among equal lengths, the value first.
  return forms.sort((a, b) => b.length - a.length);
}
