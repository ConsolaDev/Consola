/**
 * What a `run:` step's command is given and what its result means. Pure: the
 * Node executor (`node/runCommand`) spawns, and the engine reads the files
 * through `RunFolderPort`.
 */
import {
  coerceOutput,
  describeOutputType,
  type OutputType,
  type OutputValue,
} from '@consola/factory-spec';
import { withoutGitHooks } from '../gitEnv';
import type { CommandResult } from '../ports';

/** The most each of a command's logs holds; past it, writing stops and the pipes keep draining. */
export const LOG_CAP_BYTES = 1024 * 1024;
/** The most `$CONSOLA_OUTPUT` may hold. Long text belongs in an artifact. */
export const OUTPUT_FILE_CAP_BYTES = 64 * 1024;
/** The most of a key or value a problem repeats. */
const ECHO_MAX_CHARS = 64;

const STOPPED = 'Stopped while running: it may have done its work';

/** `text` with every secret replaced by ***, the longest first. Empty secrets are ignored. */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  return [...new Set(secrets.filter((secret) => secret.length > 0))]
    .sort((a, b) => b.length - a.length)
    .reduce((masked, secret) => masked.split(secret).join('***'), text);
}

/** The environment a command runs with, in the spec's order: base (login env + token), rendered env:, Consola's variables, then git hooks off. */
export function layerCommandEnv(
  base: NodeJS.ProcessEnv,
  rendered: Record<string, string>,
  consola: Record<string, string>,
): NodeJS.ProcessEnv {
  return withoutGitHooks({ ...base, ...rendered, ...consola });
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** "a", "a and b", "a, b and c". */
function listed(names: string[]): string {
  return names.length < 2
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** At most `max` characters of `text` (by code point), marked with … when cut. */
export function clipText(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length > max ? `${characters.slice(0, max).join('')}…` : text;
}

/**
 * `$CONSOLA_OUTPUT` as typed outputs. Blank lines are ignored; every other
 * line is `key=value`, split at the first `=`, with a trailing CR stripped.
 * Keys must be declared, values must coerce to their type, and the last write
 * of a key wins. The first bad line fails it, by its number; so does a
 * declared output left unset. A problem repeats what the command wrote only
 * masked (`secrets`), then clipped, since it is kept as the step's error.
 */
export function parseOutputFile(
  text: string,
  declared: Record<string, OutputType>,
  secrets: readonly string[],
): { ok: true; outputs: Record<string, OutputValue> } | { ok: false; problem: string } {
  const fail = (problem: string) => ({
    ok: false as const,
    problem: maskSecrets(problem, secrets),
  });
  // Masked before clipping, so a cut never leaves part of a secret.
  const echo = (written: string) => clipText(maskSecrets(written, secrets), ECHO_MAX_CHARS);
  if (utf8Bytes(text) > OUTPUT_FILE_CAP_BYTES) {
    return fail('$CONSOLA_OUTPUT is over 64 KB; long text belongs in an artifact.');
  }
  const names = Object.keys(declared);
  const outputs: Record<string, OutputValue> = {};
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index];
    if (line.trim() === '') continue;
    const at = `$CONSOLA_OUTPUT line ${index + 1}`;
    const equals = line.indexOf('=');
    if (equals <= 0) {
      const heredoc = /^[^=]*<</.test(line)
        ? '; there is no key<<EOF form, long text belongs in an artifact'
        : '';
      return fail(`${at}: expected key=value${heredoc}`);
    }
    const key = line.slice(0, equals);
    if (!Object.prototype.hasOwnProperty.call(declared, key)) {
      const has = names.length ? `it has: ${names.join(', ')}` : 'it declares none';
      return fail(`${at}: ${echo(key)} is not an output of this step (${has})`);
    }
    const type = declared[key];
    const value = line.slice(equals + 1);
    const coerced = coerceOutput(type, value);
    if (!coerced.ok) {
      // `coerceOutput`'s own wording, with the value it would quote whole echoed safely.
      const got = type.type === 'string' ? String(value.length) : `'${echo(value)}'`;
      return fail(`${at}: ${key}: expected ${describeOutputType(type)} (got ${got})`);
    }
    outputs[key] = coerced.value;
  }
  const missing = names.filter((name) => !Object.prototype.hasOwnProperty.call(outputs, name));
  if (missing.length) return fail(`ended without setting ${listed(missing)} in $CONSOLA_OUTPUT`);
  return { ok: true, outputs };
}

/** A duration as a `timeout:` writes it: `10m`, `30s`, `1h`, or `300ms` below a second. */
function formatDuration(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

/** Why a command that did not succeed failed: "exit 1: <last stderr line>", "timed out after 10m", or the stop message. */
export function describeFailure(result: CommandResult, timeoutMs: number): string {
  if (result.stopped) return STOPPED;
  if (result.timedOut) return `timed out after ${formatDuration(timeoutMs)}`;
  const ended =
    result.exitCode !== null
      ? `exit ${result.exitCode}`
      : `killed by ${result.signal ?? 'a signal'}`;
  return result.lastStderrLine ? `${ended}: ${result.lastStderrLine}` : ended;
}
