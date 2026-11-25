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
import { withoutGitHooks, withoutRepositoryOverrides } from '../gitEnv';
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

/**
 * The environment a command runs with, in the spec's order: base (login env
 * + token), rendered env:, the step's own secrets, Consola's variables, then
 * git hooks off; never a variable that aims git at another repository than
 * the folder it runs in (the 3-B code review's F5: a login shell's `GIT_DIR`
 * would make the command after a write step push another repository; `env:`
 * refuses `GIT_` names).
 */
export function layerCommandEnv(
  base: NodeJS.ProcessEnv,
  rendered: Record<string, string>,
  consola: Record<string, string>,
  secrets: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return withoutGitHooks(
    withoutRepositoryOverrides({ ...base, ...rendered, ...secrets, ...consola }),
  );
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

/** The most of the last line of stderr a result keeps: it becomes the step's error. */
export const STDERR_LINE_MAX_CHARS = 300;

/** CSI and OSC sequences, then any other escape. */
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?/g;
/** Every control character but tab (newlines are already split on). */
const LINE_CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * The last non-blank line of the end of a log, as plain text, masked and
 * clipped: what `describeFailure` says after a command's exit. `cutsLine`
 * says the text begins partway through a line, whose head is then dropped
 * through its first space or tab. The Node executor reads it from the tail
 * of stderr it keeps; a runner whose commands run elsewhere, from the tail it
 * was handed.
 */
export function lastLineOf(
  text: string,
  secrets: readonly string[],
  cutsLine: boolean,
): string | undefined {
  const lines = text.split('\n');
  if (cutsLine) {
    // The cut line's head may be the end of a secret split by bytes the
    // stripping below removes, too short to mask. Drop it through the
    // first space or tab (stripping keeps both), before stripping.
    const space = lines[0].search(/[ \t]/);
    lines[0] = space === -1 ? '' : lines[0].slice(space + 1);
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    // Masked again after stripping: a secret split by an escape, a NUL or
    // UTF-16's zero bytes never matched in the stream, and is whole only now.
    const line = maskSecrets(
      lines[i].replace(ESCAPES, '').replace(LINE_CONTROLS, ''),
      secrets,
    ).trim();
    if (line) return clipText(i === 0 && cutsLine ? `…${line}` : line, STDERR_LINE_MAX_CHARS);
  }
  return undefined;
}

/** A duration as a `timeout:` writes it: `10m`, `30s`, `1h`, or `300ms` below a second. */
/** A duration as a step's words say it: `30s`, `10m`, `2h`, else milliseconds. */
export function formatDuration(ms: number): string {
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
