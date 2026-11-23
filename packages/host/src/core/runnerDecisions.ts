/**
 * The runner's decisions (`consola-host runner`), apart from what it touches: what it offers,
 * what each line a session's sandbox prints and each way a sandbox ends tell the cell, what a
 * sandbox is given, what is kept out of what the cell hears, and when to dial the cell again.
 * Nothing here reaches the machine; `adapters/sandboxSessions.ts` and `adapters/cellSocket.ts`
 * act on it.
 */
import {
  type EndedSession,
  HARNESSES,
  type Harness,
  isRepository,
  type Repository,
  readStartScriptLine,
  type SessionStart,
  type SessionUpdate,
} from '@consola/runner-protocol';
import { type HostLine, readHostLine } from './hostLine.ts';

/** The template a session's sandbox starts from (the sandbox template, Task 7). */
export const SESSION_TEMPLATE = 'consola-session';

/** The command a session's sandbox runs: the template's start script, which runs the host. */
export const SESSION_START_ARGV: ReadonlyArray<string> = ['consola-session-start'];

/** The variable holding the API key each harness signs in with, and only that one. */
export const HARNESS_API_KEYS: Readonly<Record<Harness, string>> = {
  claude: 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
};

/** The harnesses a runner offers: each one whose API key its environment holds. */
export function harnessesFromEnv(env: Readonly<Record<string, string | undefined>>): Harness[] {
  return HARNESSES.filter((harness) => (env[HARNESS_API_KEYS[harness]] ?? '') !== '');
}

export type ReadRepositories =
  | { readonly ok: true; readonly repositories: Repository[] }
  | { readonly ok: false; readonly problem: string };

/**
 * The repositories a runner offers, from `CONSOLA_RUNNER_REPOSITORIES`: `owner/name`, separated by
 * commas. A repository is no secret, so a refusal names the one it refuses.
 */
export function readRepositories(value: string | undefined): ReadRepositories {
  const names = (value ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (names.length === 0) {
    return {
      ok: false,
      problem:
        'CONSOLA_RUNNER_REPOSITORIES must name the repositories the runner offers, as owner/name, separated by commas.',
    };
  }
  const refused = names.find((name) => !isRepository(name));
  if (refused !== undefined) {
    return {
      ok: false,
      problem: `CONSOLA_RUNNER_REPOSITORIES holds ${refused}, which is not a repository as owner/name.`,
    };
  }
  return { ok: true, repositories: [...new Set(names)] };
}

/** `localhost`, `[::1]` or an address in `127.0.0.0/8`, as a URL's `hostname` spells them. */
const isLoopbackHostname = (hostname: string): boolean =>
  hostname === 'localhost' ||
  hostname === '[::1]' ||
  /^127(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(hostname);

/**
 * Why `--cell-url` cannot be dialled, or null: it is the cell's runner socket over `wss:`, or
 * over `ws:` only to this machine's loopback, since the runner's secret travels in its handshake.
 * User info is refused (the secret goes in a header, and an address may be logged), and never
 * quoted.
 */
export function cellUrlProblem(cellUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(cellUrl);
  } catch {
    return "--cell-url must be the address of the cell's runner socket (wss://…/api/runner).";
  }
  if (url.username !== '' || url.password !== '') {
    return '--cell-url must not carry credentials: the runner sends its secret in a header.';
  }
  if (url.protocol === 'wss:') return null;
  if (url.protocol === 'ws:') {
    return isLoopbackHostname(url.hostname)
      ? null
      : `--cell-url may use ws: only to this machine's loopback (127.0.0.1, ::1 or localhost), not ${url.hostname}; use wss:.`;
  }
  return `--cell-url must use wss: (or ws: to this machine's loopback), not ${url.protocol}`;
}

/** The longest line a sandbox may print that the runner reads; a longer one is dropped whole. */
export const MAX_LINE_LENGTH = 64 * 1024;

/**
 * Turns a command's stdout, which arrives in chunks of any size, into its lines: a line split
 * across chunks is joined, and a chunk holding several is split. A line is handed on once its
 * newline arrives, without it (or a carriage return before it); empty lines are dropped, and so
 * is a line longer than `MAX_LINE_LENGTH`, up to its end, so a sandbox printing without newlines
 * cannot fill the runner's memory.
 */
export class HostLineBuffer {
  private partial = '';
  /** Dropping a line that grew too long, until its newline. */
  private skipping = false;

  push(chunk: string): string[] {
    const lines: string[] = [];
    let rest = chunk;
    let newline = rest.indexOf('\n');
    while (newline !== -1) {
      const piece = rest.slice(0, newline);
      rest = rest.slice(newline + 1);
      newline = rest.indexOf('\n');
      if (this.skipping) {
        this.skipping = false;
        continue;
      }
      const line = `${this.partial}${piece}`.replace(/\r$/, '');
      this.partial = '';
      if (line.length <= MAX_LINE_LENGTH && line.trim() !== '') lines.push(line);
    }
    if (!this.skipping) {
      this.partial += rest;
      if (this.partial.length > MAX_LINE_LENGTH) {
        this.partial = '';
        this.skipping = true;
      }
    }
    return lines;
  }
}

/** One line a session's sandbox printed, as the runner reads it. */
export type SessionLine =
  | { readonly kind: 'host'; readonly line: HostLine }
  /** The start script's `exit` (`StartScriptLine`): the clone failed, and the host never ran. */
  | { readonly kind: 'clone-failed'; readonly message: string }
  /** Anything else: not JSON, or no line the runner reads. */
  | { readonly kind: 'other' };

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Reads one stdout line: the start script's own line, one of the host's, or neither. */
export function readSessionLine(text: string): SessionLine {
  const json = parseJson(text);
  const script = readStartScriptLine(json);
  if (script.ok) return { kind: 'clone-failed', message: script.value.message };
  const line = readHostLine(json);
  return line === null ? { kind: 'other' } : { kind: 'host', line };
}

/**
 * What one stdout line tells the cell: a `title` its title, the start script's `clone-failed` a
 * failure with its message. Nothing for `status` and `dev-pass` (the cell keeps neither), the
 * host's `exit` (the end is told when the sandbox's command ends, `updateForExit`), or a line it
 * cannot read. `ready` is answered by the runner once it has exposed the port the line names.
 */
export function updateForLine(sessionId: string, text: string): SessionUpdate | null {
  const read = readSessionLine(text);
  if (read.kind === 'clone-failed') {
    return { type: 'session.update', sessionId, status: 'failed', error: read.message };
  }
  if (read.kind === 'host' && read.line.type === 'title' && read.line.title !== '') {
    return { type: 'session.update', sessionId, title: read.line.title };
  }
  return null;
}

/** How a session's sandbox command ended, as the runner saw it. */
export type SandboxEnd = {
  /** Its exit code, or null when a signal ended it (the sandbox stopping, from anywhere). */
  readonly exitCode: number | null;
  /** Whether the host printed its `exit` line: it stopped by itself, idle. */
  readonly sawExitLine: boolean;
  /** Whether the runner stopped the sandbox: the cell's stop, a backstop, or shutting down. */
  readonly stoppedByRunner: boolean;
  /** The last line the command wrote on stderr that held text, if any. */
  readonly lastStderrLine: string | null;
  /** Whether the host said `ready`, so the cell was told the session runs. */
  readonly ready: boolean;
  /** Whether the stop was the cell's (`session.stop`), which already holds the session stopped. */
  readonly stopRequested: boolean;
};

/**
 * How a session ended, for the cell. The cell's own stop is `stopped`, ready or not. Otherwise a
 * session that ends before `ready` has `failed`, never `stopped`: the cell keeps a starting
 * session starting on a `stopped`. After `ready`, the host's own exit (its `exit` line) and the
 * runner's stop are `stopped`; a non-zero exit is `failed` with the last line on stderr; a signal
 * from elsewhere is `failed` (the sandbox ended), and so is exit 0 without an `exit` line, since
 * the host exits that way only when something in the sandbox stopped it.
 */
export function updateForExit(sessionId: string, end: SandboxEnd): SessionUpdate {
  const stopped: SessionUpdate = { type: 'session.update', sessionId, status: 'stopped' };
  const failed = (error: string): SessionUpdate => ({
    type: 'session.update',
    sessionId,
    status: 'failed',
    error,
  });
  if (end.stopRequested) return stopped;
  if (!end.ready) {
    if (end.exitCode === null) {
      return failed(
        end.stoppedByRunner
          ? 'The runner stopped the session before it was ready.'
          : "The session's sandbox ended before the session was ready.",
      );
    }
    if (end.exitCode === 0)
      return failed("The session's start command ended before the session was ready.");
    return failed(
      end.lastStderrLine ??
        `The session's start command exited with code ${end.exitCode} before the session was ready.`,
    );
  }
  if (end.sawExitLine || end.stoppedByRunner) return stopped;
  if (end.exitCode === null) return failed("The session's sandbox ended.");
  if (end.exitCode === 0) return failed("The session's host stopped without saying why.");
  return failed(end.lastStderrLine ?? `The session's host exited with code ${end.exitCode}.`);
}

/** How much of a command's stderr the runner keeps, to say why it failed. */
const STDERR_TAIL_LENGTH = 8 * 1024;

/** The end of a command's stderr, bounded, for its last line. */
export class StderrTail {
  private tail = '';

  push(chunk: string): void {
    this.tail = `${this.tail}${chunk}`.slice(-STDERR_TAIL_LENGTH);
  }

  /** The last line that holds text, trimmed and bounded, or null when there is none. */
  lastLine(): string | null {
    const lines = this.tail
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const last = lines.at(-1);
    return last === undefined ? null : last.slice(0, MAX_ERROR_LENGTH);
  }
}

/** What a secret becomes in text the runner sends or logs. */
export const REDACTED = '[redacted]';

/**
 * `text` with every secret taken out, as it is and URL-encoded (a token in an address git prints),
 * the longest first. Empty secrets are ignored.
 */
export function scrubSecrets(text: string, secrets: ReadonlyArray<string>): string {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (secret === '') continue;
    forms.add(secret);
    forms.add(encodeURIComponent(secret));
  }
  let scrubbed = text;
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    scrubbed = scrubbed.split(form).join(REDACTED);
  }
  return scrubbed;
}

/** The longest error, and title, the runner sends the cell, so a frame stays within the cell's limit. */
export const MAX_ERROR_LENGTH = 1_000;

const bounded = (text: string): string =>
  text.length <= MAX_ERROR_LENGTH ? text : `${text.slice(0, MAX_ERROR_LENGTH - 1)}…`;

/**
 * An update as the cell may hear it: its error with every secret taken out first, then bounded
 * (bounding first could leave half a secret), and its title bounded.
 */
export function scrubUpdate(update: SessionUpdate, secrets: ReadonlyArray<string>): SessionUpdate {
  const scrubbed: SessionUpdate = { ...update };
  if (update.error !== undefined) {
    scrubbed.error = bounded(scrubSecrets(update.error, secrets)) || 'The session failed.';
  }
  if (update.title !== undefined) scrubbed.title = bounded(update.title);
  return scrubbed;
}

/** How a session ended, as a `hello` carries it, or null for an update that is no end. */
export function endOf(update: SessionUpdate): EndedSession | null {
  if (update.status !== 'stopped' && update.status !== 'failed') return null;
  return update.error === undefined
    ? { sessionId: update.sessionId, status: update.status }
    : { sessionId: update.sessionId, status: update.status, error: update.error };
}

/** What a runner offers: the repositories and harnesses its `hello` names. */
export type RunnerOffer = {
  readonly repositories: ReadonlyArray<Repository>;
  readonly harnesses: ReadonlyArray<Harness>;
};

/**
 * Why a start asks for something the runner does not offer, or null. The cell checks the same
 * before it sends one; the runner checks again, and starts no sandbox for it.
 */
export function offerRefusal(
  offer: RunnerOffer,
  start: Pick<SessionStart, 'repository' | 'harness'>,
): string | null {
  if (!offer.repositories.includes(start.repository)) {
    return `This runner does not offer ${start.repository}.`;
  }
  if (!offer.harnesses.includes(start.harness)) {
    return `This runner does not offer the ${start.harness} harness.`;
  }
  return null;
}

/** The secrets a runner hands its sandboxes: the git token, and each harness's API key. */
export type SandboxSecrets = {
  readonly gitToken?: string | undefined;
  readonly apiKeys: Readonly<Partial<Record<Harness, string>>>;
};

/**
 * The variables a session's sandbox is created with: the session, its harness and repository, the
 * key its host checks passes with, its idle minutes, the git token, and the API key of its own
 * harness and no other.
 */
export function sandboxEnvFor(
  start: SessionStart,
  secrets: SandboxSecrets,
  idleMinutes: number,
): Record<string, string> {
  const env: Record<string, string> = {
    CONSOLA_SESSION_ID: start.sessionId,
    CONSOLA_HARNESS: start.harness,
    CONSOLA_REPOSITORY: start.repository,
    CONSOLA_PASS_PUBLIC_KEY: start.passPublicKeyPem,
    CONSOLA_SESSION_IDLE_MINUTES: String(idleMinutes),
  };
  if (secrets.gitToken !== undefined && secrets.gitToken !== '') env.GIT_TOKEN = secrets.gitToken;
  const apiKey = secrets.apiKeys[start.harness];
  if (apiKey !== undefined && apiKey !== '') env[HARNESS_API_KEYS[start.harness]] = apiKey;
  return env;
}

/** The first wait before dialling the cell again, and the longest. */
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_CAP_MS = 30_000;

/**
 * How long to wait before dialling the cell again after `failures` attempts in a row that did not
 * hold: doubling from `RECONNECT_BASE_MS` up to `RECONNECT_CAP_MS`, then jittered to between half
 * of that and all of it by `random` (in [0, 1)), so runners that lost their cell together do not
 * dial it together.
 */
export function reconnectDelayMs(failures: number, random: number): number {
  const step = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** Math.min(failures, 16));
  return Math.round(step * (0.5 + 0.5 * random));
}

/** How long a connection must stay open after an end went out on it for the end to count as heard. */
export const END_CONFIRM_MS = 5_000;
/** How many ends the runner holds for its next `hello`, at most. */
export const MAX_ENDED_SESSIONS = 32;

type HeldEnd = { end: EndedSession; sentOn: number | null; sentAt: number };

/**
 * The sessions that ended and the cell may not have heard of, for `hello`'s `endedSessions`
 * (Review Focus 5). An end is held from the moment it is known: while the socket is down it rides
 * in the next `hello`; once it went out on a connection, it is taken as heard when that
 * connection closes `END_CONFIRM_MS` or more after, and sent again in the next `hello` when it
 * closes sooner (the cell may never have read it; an end it already has changes nothing). One
 * end per session, the latest, and at most `MAX_ENDED_SESSIONS`: past it the oldest end already
 * sent goes first, else the oldest.
 */
export class EndedSessions {
  private held: HeldEnd[] = [];

  get size(): number {
    return this.held.length;
  }

  /** Holds `end`; answers the end it had to drop for room, if any. */
  add(end: EndedSession): EndedSession | null {
    this.held = this.held.filter((each) => each.end.sessionId !== end.sessionId);
    this.held.push({ end, sentOn: null, sentAt: 0 });
    if (this.held.length <= MAX_ENDED_SESSIONS) return null;
    const sent = this.held.findIndex((each) => each.sentOn !== null);
    const [dropped] = this.held.splice(sent === -1 ? 0 : sent, 1);
    return dropped?.end ?? null;
  }

  /** The ends the next `hello` carries: those not out on a connection now. */
  forHello(): EndedSession[] {
    return this.held.filter((each) => each.sentOn === null).map((each) => each.end);
  }

  /** The ends of `sessionIds` went out on `connection` at `nowMs`. */
  sent(sessionIds: ReadonlyArray<string>, connection: number, nowMs: number): void {
    for (const each of this.held) {
      if (sessionIds.includes(each.end.sessionId)) {
        each.sentOn = connection;
        each.sentAt = nowMs;
      }
    }
  }

  /** `connection` closed at `nowMs`: what it held long enough is heard, the rest goes again. */
  closed(connection: number, nowMs: number): void {
    this.held = this.held.filter(
      (each) => each.sentOn !== connection || nowMs - each.sentAt < END_CONFIRM_MS,
    );
    for (const each of this.held) if (each.sentOn === connection) each.sentOn = null;
  }
}
