/**
 * What a step's sandbox says, masked: every secret it was given (a command's `secretEnv`, the
 * clone token, the harness's API key) in every printed form, then bounded to what the cell keeps.
 * Pure.
 *
 * `maskFormsOf` is the engine's (`packages/automation-engine/src/secrets/values.ts`), carried over
 * as it is rather than imported: the host imports no engine code (`boundary.test.ts`). Keep the
 * two the same.
 */
import type { OutputTail } from './ports.ts';

/** What a secret becomes, as the engine writes it. */
export const MASK = '***';

/** The fewest code points a form other than the value itself may hold, as in the engine. */
const MIN_FORM_CHARS = 8;

/** The most of each stream the cell keeps, in characters: 16 KiB. */
export const OUTPUT_TAIL_LENGTH = 16 * 1024;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64, with `=` padding. */
function base64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const left = bytes.length - i;
    const triple =
      ((bytes[i] ?? 0) << 16) |
      ((left > 1 ? (bytes[i + 1] ?? 0) : 0) << 8) |
      (left > 2 ? (bytes[i + 2] ?? 0) : 0);
    out += (ALPHABET[(triple >> 18) & 63] ?? '') + (ALPHABET[(triple >> 12) & 63] ?? '');
    out += left > 1 ? (ALPHABET[(triple >> 6) & 63] ?? '') : '=';
    out += left > 2 ? (ALPHABET[triple & 63] ?? '') : '=';
  }
  return out;
}

/**
 * What a base64 run holding `bytes` shows of them whatever came before, when `offset` bytes (mod
 * 3) did: the characters of the 3-byte groups lying wholly inside them.
 */
function innerBase64(bytes: Uint8Array, offset: number): string {
  const shifted = new Uint8Array(offset + bytes.length);
  shifted.set(bytes, offset);
  const first = offset === 0 ? 0 : 1;
  const end = Math.floor(shifted.length / 3);
  return end > first ? base64(shifted).slice(first * 4, end * 4) : '';
}

/**
 * Every form of `value` that is masked, longest first, once each: the value; each of its lines,
 * with and without a closing CR; its JSON-escaped form; its percent-encoded form; its base64; and,
 * for each of the three byte alignments, what a longer base64 run holding it shows. Each at least
 * 8 characters, but the value itself.
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
  ].filter((form) => [...form].length >= MIN_FORM_CHARS);
  const forms = [...new Set([value, ...candidates])];
  return forms.sort((a, b) => b.length - a.length);
}

/** Every form of every secret, longest first; empty secrets are ignored. */
export function maskFormsOfAll(secrets: ReadonlyArray<string>): string[] {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (secret === '') continue;
    for (const form of maskFormsOf(secret)) if (form !== '') forms.add(form);
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

const replaceForms = (text: string, forms: ReadonlyArray<string>): string => {
  let masked = text;
  for (const form of forms) masked = masked.split(form).join(MASK);
  return masked;
};

/** `text` with every form of every secret replaced by `***`, the longest first. */
export function maskText(text: string, secrets: ReadonlyArray<string>): string {
  return replaceForms(text, maskFormsOfAll(secrets));
}

/**
 * The end of a stream, masked as it arrives and only then bounded to `limit` characters, with the
 * whole stream's size in UTF-8 bytes. Output arrives in chunks that may split a secret, so the
 * characters at the end that could start one (fewer than the longest form) are held back,
 * unmasked, and masked with what follows: a secret is always masked whole, before any cut. A
 * stream that ends part-way through a secret has that start masked too.
 */
export class MaskedTail {
  private readonly forms: ReadonlyArray<string>;
  private readonly holdBack: number;
  private readonly limit: number;
  private tail = '';
  private held = '';
  private cut = false;
  private byteCount = 0;
  private readonly encoder = new TextEncoder();

  constructor(secrets: ReadonlyArray<string>, limit: number = OUTPUT_TAIL_LENGTH) {
    this.forms = maskFormsOfAll(secrets);
    this.holdBack = Math.max(0, ...this.forms.map((form) => form.length - 1));
    this.limit = limit;
  }

  push(chunk: string): void {
    this.byteCount += this.encoder.encode(chunk).length;
    const raw = `${this.held}${chunk}`;
    let at = Math.max(0, raw.length - this.holdBack);
    // A form that is whole and crosses the cut is masked with what comes before it.
    for (let moved = true; moved; ) {
      moved = false;
      for (const form of this.forms) {
        for (let index = raw.indexOf(form); index !== -1; index = raw.indexOf(form, index + 1)) {
          if (index < at && index + form.length > at) {
            at = index + form.length;
            moved = true;
          }
        }
      }
    }
    this.append(replaceForms(raw.slice(0, at), this.forms));
    this.held = raw.slice(at);
  }

  private append(masked: string): void {
    const joined = `${this.tail}${masked}`;
    if (joined.length > this.limit) {
      this.cut = true;
      this.tail = joined.slice(-this.limit);
    } else {
      this.tail = joined;
    }
  }

  /** The masked end of the stream, whether it was cut, and its whole size in bytes. */
  end(): { readonly text: string; readonly truncated: boolean; readonly bytes: number } {
    let held = replaceForms(this.held, this.forms);
    // A stream that ends inside a secret: the start it ends with is masked.
    for (const form of this.forms) {
      for (let length = Math.min(form.length - 1, held.length); length >= 4; length -= 1) {
        if (held.endsWith(form.slice(0, length))) {
          held = `${held.slice(0, held.length - length)}${MASK}`;
          break;
        }
      }
    }
    const joined = `${this.tail}${held}`;
    const truncated = this.cut || joined.length > this.limit;
    return {
      text: joined.length > this.limit ? joined.slice(-this.limit) : joined,
      truncated,
      bytes: this.byteCount,
    };
  }
}

/** The tail of two streams, as the run's page shows them. */
export function outputTailOf(stdout: MaskedTail, stderr: MaskedTail): OutputTail {
  const out = stdout.end();
  const err = stderr.end();
  return { stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated };
}
