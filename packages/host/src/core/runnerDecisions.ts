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

/** The template a session's sandbox starts from (`sandbox-template/`, built on E2B under this name). */
export const SESSION_TEMPLATE = 'consola-session';

/** The command a session's sandbox runs: the template's start script, which runs the host. */
export const SESSION_START_ARGV: ReadonlyArray<string> = ['consola-session-start'];

/** The variable holding the API key each harness signs in with, and only that one. */
export const HARNESS_API_KEYS: Readonly<Record<Harness, string>> = {
  claude: 'ANTHROPIC_API_KEY',
  codex: 'OPENAI_API_KEY',
};

/**
 * Every variable of the runner's environment that holds a secret: its own secret, the git token,
 * each harness's API key, and the key of the E2B account its sandboxes run on. It is the one
 * list: the runner takes their values out of everything it logs or reports (`secretValuesOf`),
 * and never logs any of them. A new secret the runner reads joins it (`bin.test.ts` checks the
 * host's source for one missing).
 */
export const RUNNER_SECRET_VARIABLES: ReadonlyArray<string> = [
  'CONSOLA_RUNNER_SECRET',
  'GIT_TOKEN',
  ...Object.values(HARNESS_API_KEYS),
  'E2B_API_KEY',
];

/** The values `env` gives `RUNNER_SECRET_VARIABLES`, the empty ones left out. */
export function secretValuesOf(env: Readonly<Record<string, string | undefined>>): string[] {
  return RUNNER_SECRET_VARIABLES.flatMap((name) => {
    const value = env[name];
    return value === undefined || value === '' ? [] : [value];
  });
}

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
  if (url.search !== '' || url.hash !== '') {
    return '--cell-url must not carry a query or a fragment: the runner logs it, and sends its secret in a header.';
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

/** What a secret becomes in text the runner sends or logs. */
export const REDACTED = '[redacted]';

/**
 * The shortest start of a secret taken out where text ends part-way through one. Shorter ones are
 * left: any text may end in a few characters a secret starts with, and they give nothing away.
 */
export const SECRET_FRAGMENT_MIN = 4;

/** Every form of the secrets that is looked for: each as it is and URL-encoded, longest first. */
const secretForms = (secrets: ReadonlyArray<string>): string[] => {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (secret === '') continue;
    forms.add(secret);
    forms.add(encodeURIComponent(secret));
  }
  return [...forms].sort((a, b) => b.length - a.length);
};

const replaceForms = (text: string, forms: ReadonlyArray<string>): string => {
  let scrubbed = text;
  for (const form of forms) scrubbed = scrubbed.split(form).join(REDACTED);
  return scrubbed;
};

/**
 * `text` with every secret taken out, as it is and URL-encoded (a token in an address git prints),
 * the longest first. Empty secrets are ignored. Scrub whole text, before it is cut: a cut can
 * leave a piece of a secret that no longer matches it.
 */
export function scrubSecrets(text: string, secrets: ReadonlyArray<string>): string {
  return replaceForms(text, secretForms(secrets));
}

/** `text` with the start of a secret it ends in (`SECRET_FRAGMENT_MIN` or more) redacted. */
const withoutTrailingSecretStart = (text: string, forms: ReadonlyArray<string>): string => {
  let longest = 0;
  for (const form of forms) {
    for (let length = Math.min(form.length - 1, text.length); length > longest; length -= 1) {
      if (length >= SECRET_FRAGMENT_MIN && text.endsWith(form.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }
  return longest === 0 ? text : `${text.slice(0, text.length - longest)}${REDACTED}`;
};

/** How much of a command's stderr the runner keeps, scrubbed, to say why it failed. */
export const STDERR_TAIL_LENGTH = 8 * 1024;

/**
 * The end of a command's stderr, scrubbed of `secrets` as it arrives and only then bounded, for
 * its last line. Output arrives in chunks that may split a secret, so the runner holds back,
 * unscrubbed, the last characters that could be the start of one (fewer than the longest secret's
 * length), and scrubs them with what follows: a secret is always scrubbed whole, before any cut.
 * Output that ends part-way through a secret has that start redacted too.
 */
export class StderrTail {
  private readonly forms: ReadonlyArray<string>;
  /** How many characters at the end may still be the start of a secret. */
  private readonly holdBack: number;
  /** Scrubbed, at most `STDERR_TAIL_LENGTH`. */
  private tail = '';
  /** Unscrubbed: fewer characters than the longest secret, or a whole one at its end. */
  private held = '';

  constructor(secrets: ReadonlyArray<string> = []) {
    this.forms = secretForms(secrets);
    this.holdBack = Math.max(0, ...this.forms.map((form) => form.length - 1));
  }

  push(chunk: string): void {
    const raw = `${this.held}${chunk}`;
    let cut = Math.max(0, raw.length - this.holdBack);
    // A secret that is whole and crosses the cut is scrubbed with what comes before it.
    const found = this.forms.flatMap((form) => {
      const at: Array<{ start: number; end: number }> = [];
      for (let index = raw.indexOf(form); index !== -1; index = raw.indexOf(form, index + 1)) {
        at.push({ start: index, end: index + form.length });
      }
      return at;
    });
    for (let moved = true; moved; ) {
      moved = false;
      for (const { start, end } of found) {
        if (start < cut && end > cut) {
          cut = end;
          moved = true;
        }
      }
    }
    this.tail = `${this.tail}${replaceForms(raw.slice(0, cut), this.forms)}`.slice(
      -STDERR_TAIL_LENGTH,
    );
    this.held = raw.slice(cut);
  }

  /** The last line that holds text, scrubbed, then trimmed and bounded, or null when there is none. */
  lastLine(): string | null {
    const held = withoutTrailingSecretStart(replaceForms(this.held, this.forms), this.forms);
    const lines = `${this.tail}${held}`
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const last = lines.at(-1);
    return last === undefined ? null : last.slice(0, MAX_ERROR_LENGTH);
  }
}

/** The longest error, and title, the runner sends the cell, so a frame stays within the cell's limit. */
export const MAX_ERROR_LENGTH = 1_000;

const bounded = (text: string): string =>
  text.length <= MAX_ERROR_LENGTH ? text : `${text.slice(0, MAX_ERROR_LENGTH - 1)}…`;

/**
 * An update as the cell may hear it. Its two free texts, the error and the title (made from the
 * conversation, which may hold a token someone typed), have every secret taken out first, then
 * are bounded: bounding first could leave a piece of a secret. `hostUrl` is the provider's
 * address for a port, checked as an origin before it is sent, and the status is one of three
 * words, so neither carries the sandbox's text.
 */
export function scrubUpdate(update: SessionUpdate, secrets: ReadonlyArray<string>): SessionUpdate {
  const forms = secretForms(secrets);
  const scrubbed: SessionUpdate = { ...update };
  if (update.error !== undefined) {
    scrubbed.error = bounded(replaceForms(update.error, forms)) || 'The session failed.';
  }
  if (update.title !== undefined) {
    scrubbed.title = bounded(replaceForms(update.title, forms)) || REDACTED;
  }
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

/**
 * How long a session's sandbox may outlive the runner's last word: it is created with this
 * lifetime and renewed (`keepAlive`) every `SANDBOX_LEASE_RENEW_SECONDS` while the runner holds
 * the session, so its provider stops it this long after a runner that died last renewed it.
 */
export const SANDBOX_LEASE_SECONDS = 10 * 60;
/** How often the runner renews a sandbox's lease: three renewals can fail before it runs out. */
export const SANDBOX_LEASE_RENEW_SECONDS = 3 * 60;

/**
 * The lifetime to give a session's sandbox now, as it is made or its lease renewed, in the
 * whole seconds a provider takes: the lease, or what is left of the session's lifetime cap
 * (`remainingMs`) once that is shorter, so its provider stops it by the cap even should the
 * runner's own stop then fail (a stop is asked once). Without a lease (`null`: a provider that
 * cannot renew one) it is all that is left of the cap. A second at least, the provider's grain,
 * when the cap is under one away and its own stop is due.
 */
export function sandboxLifetimeSeconds(remainingMs: number, leaseSeconds: number | null): number {
  const remaining = Math.floor(remainingMs / 1_000);
  return Math.max(1, leaseSeconds === null ? remaining : Math.min(leaseSeconds, remaining));
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

/** How many ends the runner holds for its next `hello`, at most. */
export const MAX_ENDED_SESSIONS = 32;

/** A ping on the cell's socket follows an end, and goes at least this often. */
export const HEARTBEAT_INTERVAL_MS = 25_000;
/** How long a ping may go unanswered before the runner drops the socket and dials again. */
export const PONG_TIMEOUT_MS = 10_000;

/** `sentOn`: the connection it went out on, or null while held for the next `hello`. */
type HeldEnd = { end: EndedSession; sentOn: number | null; ping: number };

/**
 * The sessions that ended and the cell may not have heard of, for `hello`'s `endedSessions`
 * (a runner's restart). An end is held from the moment it is known: while the socket is down it rides
 * in the next `hello`. Once it went out on a connection, a ping follows it, and the end is heard
 * when that ping's pong comes back, since the cell reads a socket's frames in order. Should the
 * connection close first, however long it was open, the end goes again in the next `hello` (an
 * end the cell already has changes nothing): a socket that died without a close stays open for
 * minutes, and everything written into it is lost. One end per session, the latest, and at most
 * `MAX_ENDED_SESSIONS`: past it the oldest end already sent goes first, else the oldest.
 */
export class EndedSessions {
  private held: HeldEnd[] = [];

  get size(): number {
    return this.held.length;
  }

  /** Holds `end`; answers the end it had to drop for room, if any. */
  add(end: EndedSession): EndedSession | null {
    this.held = this.held.filter((each) => each.end.sessionId !== end.sessionId);
    this.held.push({ end, sentOn: null, ping: 0 });
    if (this.held.length <= MAX_ENDED_SESSIONS) return null;
    const sent = this.held.findIndex((each) => each.sentOn !== null);
    const [dropped] = this.held.splice(sent === -1 ? 0 : sent, 1);
    return dropped?.end ?? null;
  }

  /** The ends the next `hello` carries: those not out on a connection now. */
  forHello(): EndedSession[] {
    return this.held.filter((each) => each.sentOn === null).map((each) => each.end);
  }

  /** The ends of `sessionIds` went out on `connection`, and its ping `ping` after them. */
  sent(sessionIds: ReadonlyArray<string>, connection: number, ping: number): void {
    for (const each of this.held) {
      if (sessionIds.includes(each.end.sessionId)) {
        each.sentOn = connection;
        each.ping = ping;
      }
    }
  }

  /** `connection`'s ping `ping` was answered: every end that went out on it before is heard. */
  heard(connection: number, ping: number): void {
    this.held = this.held.filter((each) => each.sentOn !== connection || each.ping > ping);
  }

  /** `connection` closed: the ends it did not confirm go again. */
  closed(connection: number): void {
    for (const each of this.held) if (each.sentOn === connection) each.sentOn = null;
  }
}

/** How often a connection pings, and how long a ping may go unanswered. */
export type HeartbeatTiming = { readonly intervalMs: number; readonly timeoutMs: number };

export const HEARTBEAT: HeartbeatTiming = {
  intervalMs: HEARTBEAT_INTERVAL_MS,
  timeoutMs: PONG_TIMEOUT_MS,
};

/** What a connection's heartbeat does now: ping, drop the socket, or wait `ms` before asking. */
export type HeartbeatStep =
  | { readonly kind: 'ping' }
  | { readonly kind: 'drop' }
  | { readonly kind: 'wait'; readonly ms: number };

/** A ping's payload: its number, in decimal, as `Pings.next` gives it. */
const PING_PAYLOAD = /^[1-9][0-9]{0,14}$/;

/**
 * One connection's pings. Each carries its number (from 1), which its pong echoes, so a pong
 * answers its ping and every ping before it. A ping goes `intervalMs` after the last one, and one
 * unanswered for `timeoutMs` means the socket is dead though still open (a NAT that forgot it, a
 * laptop that slept, a cell gone without a reset), which TCP notices only after many minutes.
 */
export class Pings {
  private readonly timing: HeartbeatTiming;
  private lastNumber = 0;
  private lastAt: number;
  /** The pings not answered yet, oldest first. */
  private waiting: Array<{ readonly number: number; readonly at: number }> = [];

  constructor(openedAtMs: number, timing: HeartbeatTiming) {
    this.timing = timing;
    this.lastAt = openedAtMs;
  }

  /** A ping goes at `nowMs`: answers the number it carries. */
  next(nowMs: number): number {
    this.lastNumber += 1;
    this.lastAt = nowMs;
    this.waiting.push({ number: this.lastNumber, at: nowMs });
    return this.lastNumber;
  }

  /** A pong came with `payload`: the ping it answers, or null for none this connection awaits. */
  answer(payload: string): number | null {
    if (!PING_PAYLOAD.test(payload)) return null;
    const answered = Number(payload);
    if (!this.waiting.some((each) => each.number === answered)) return null;
    this.waiting = this.waiting.filter((each) => each.number > answered);
    return answered;
  }

  step(nowMs: number): HeartbeatStep {
    const oldest = this.waiting[0];
    if (oldest !== undefined && nowMs - oldest.at >= this.timing.timeoutMs) return { kind: 'drop' };
    if (nowMs - this.lastAt >= this.timing.intervalMs) return { kind: 'ping' };
    const pingIn = this.lastAt + this.timing.intervalMs - nowMs;
    const dropIn = oldest === undefined ? pingIn : oldest.at + this.timing.timeoutMs - nowMs;
    return { kind: 'wait', ms: Math.min(pingIn, dropIn) };
  }
}
