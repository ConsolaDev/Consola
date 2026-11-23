import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CommandResult, CommandSpec, RunningCommand } from '../ports';
import { LOG_CAP_BYTES, clipText, maskSecrets } from '../steps/commandIO';

/** GitHub Actions' default bash: no profile or rc files, stop at the first failure, a pipeline fails with any part. */
export const COMMAND_SHELL: readonly string[] = [
  '/bin/bash',
  '--noprofile',
  '--norc',
  '-e',
  '-o',
  'pipefail',
  '-c',
];
/** How long a command's group has between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 10_000;
/** How long the pipes may stay open after the shell exited, held by something it left running. */
const PIPE_GRACE_MS = 2000;
/** How often, during the grace, the group is checked for anything left in it. */
const GROUP_POLL_MS = 100;

/** How long, after SIGKILL, `ended` waits for the group to be reaped before it resolves anyway. */
const REAP_WAIT_MS = 2000;
/** How much of stderr's end is kept, to find its last line. */
const STDERR_TAIL_BYTES = 4096;
/** The most of the last line of stderr a result keeps: it becomes the step's error. */
const STDERR_LINE_MAX_CHARS = 300;
/** The longest a Node timer waits; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const MASK = Buffer.from('***');
const EMPTY = Buffer.alloc(0);

/** CSI and OSC sequences, then any other escape. */
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?/g;
/** Every control character but tab (newlines are already split on). */
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * Replaces each secret by ***, across chunk boundaries. It holds back the end
 * of what it has seen, the longest secret's length less one byte, until the
 * next chunk shows whether a secret continues there, or the stream ends.
 */
class Masker {
  private readonly secrets: Buffer[];
  private readonly longest: number;
  private pending = EMPTY;

  constructor(secrets: readonly string[]) {
    // Longest first, so at one position the longest secret wins.
    this.secrets = [...new Set(secrets.filter((secret) => secret.length > 0))]
      .map((secret) => Buffer.from(secret))
      .sort((a, b) => b.length - a.length);
    this.longest = this.secrets[0]?.length ?? 0;
  }

  push(chunk: Buffer): Buffer {
    return this.longest === 0 ? chunk : this.scan(Buffer.concat([this.pending, chunk]), false);
  }

  flush(): Buffer {
    return this.longest === 0 ? EMPTY : this.scan(this.pending, true);
  }

  private scan(buffer: Buffer, final: boolean): Buffer {
    const parts: Buffer[] = [];
    const next = this.secrets.map((secret) => buffer.indexOf(secret));
    let start = 0;
    for (;;) {
      let best = -1;
      for (let i = 0; i < this.secrets.length; i++) {
        if (next[i] !== -1 && next[i] < start) next[i] = buffer.indexOf(this.secrets[i], start);
        if (next[i] !== -1 && (best === -1 || next[i] < next[best])) best = i;
      }
      if (best === -1) break;
      const at = next[best];
      // A longer secret could still start here: decide once more has arrived.
      if (!final && at + this.longest > buffer.length) break;
      parts.push(buffer.subarray(start, at), MASK);
      start = at + this.secrets[best].length;
    }
    const keep = final ? buffer.length : Math.max(start, buffer.length - (this.longest - 1));
    parts.push(buffer.subarray(start, keep));
    this.pending = Buffer.from(buffer.subarray(keep));
    return Buffer.concat(parts);
  }
}

/** One stream's log: masked, then capped. It counts what the command wrote, and keeps reading past the cap. */
class LogSink {
  produced = 0;
  truncated = false;
  private written = 0;
  private failed = false;
  private closed = false;
  private tail = EMPTY;
  /** The tail begins partway through a line: what it kept of that line is not the line's start. */
  private tailCutsLine = false;
  private readonly masker: Masker;

  constructor(
    private readonly fd: number,
    private readonly secrets: readonly string[],
    private readonly keepsTail: boolean,
  ) {
    this.masker = new Masker(secrets);
  }

  write(chunk: Buffer): void {
    this.produced += chunk.length;
    this.emit(this.masker.push(chunk));
  }

  end(): void {
    if (this.closed) return;
    this.emit(this.masker.flush());
    this.closed = true;
    try {
      fs.closeSync(this.fd);
    } catch {
      // Nothing more is written to it either way.
    }
  }

  /** The last non-blank line written, as plain text, masked and clipped. */
  lastLine(): string | undefined {
    const lines = this.tail.toString('utf8').split('\n');
    if (this.tailCutsLine) {
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
        lines[i].replace(ESCAPES, '').replace(CONTROLS, ''),
        this.secrets,
      ).trim();
      if (line)
        return clipText(i === 0 && this.tailCutsLine ? `…${line}` : line, STDERR_LINE_MAX_CHARS);
    }
    return undefined;
  }

  private emit(bytes: Buffer): void {
    if (bytes.length === 0 || this.closed) return;
    if (this.keepsTail) {
      const joined = Buffer.concat([this.tail, bytes]);
      const start = Math.max(0, joined.length - STDERR_TAIL_BYTES);
      if (start > 0) this.tailCutsLine = joined[start - 1] !== 0x0a;
      this.tail = Buffer.from(joined.subarray(start));
    }
    const room = LOG_CAP_BYTES - this.written;
    if (bytes.length > room) this.truncated = true;
    if (room <= 0 || this.failed) return;
    const piece = bytes.length > room ? bytes.subarray(0, room) : bytes;
    try {
      for (let offset = 0; offset < piece.length; )
        offset += fs.writeSync(this.fd, piece, offset, piece.length - offset);
      this.written += piece.length;
    } catch {
      // A log that cannot be written is a log cut short; the pipes keep draining.
      this.failed = true;
      this.truncated = true;
    }
  }
}

function closeQuietly(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // already closed
  }
}

/** The shell, spawned into its own process group, and its two logs. Throws when nothing could be started. */
function launch(spec: CommandSpec) {
  if (!(spec.timeoutMs > 0 && spec.timeoutMs <= MAX_TIMER_MS)) {
    throw new Error(
      `A command's timeout must be from 1 ms to ${MAX_TIMER_MS} ms, not ${spec.timeoutMs}.`,
    );
  }
  if (!fs.statSync(spec.cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`The command's folder is missing: ${spec.cwd}`);
  }
  const fds: number[] = [];
  try {
    for (const file of [spec.stdoutPath, spec.stderrPath]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fds.push(fs.openSync(file, 'w'));
    }
    const child = spawn(COMMAND_SHELL[0], [...COMMAND_SHELL.slice(1), spec.command], {
      cwd: spec.cwd,
      env: spec.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      child,
      stdout: new LogSink(fds[0], spec.secrets, false),
      stderr: new LogSink(fds[1], spec.secrets, true),
    };
  } catch (error) {
    for (const fd of fds) closeQuietly(fd);
    throw error;
  }
}

/**
 * Runs `spec.command` with `/bin/bash` (`COMMAND_SHELL`), stdin from
 * `/dev/null`, detached into a process group of its own, so a stop or a
 * timeout reaches everything it started: SIGTERM to the group, then SIGKILL
 * after the grace. The result comes from the shell's exit, not from its
 * pipes: if something it left running still holds them `pipeGraceMs` later,
 * the group is ended and the result resolves anyway. Whatever is left in the
 * group when the result settles is ended the same way; `ended` resolves once
 * nothing is (slice 3-B: Consola checks a run's own checkout only then).
 */
export function startCommand(spec: CommandSpec): RunningCommand {
  let launched: ReturnType<typeof launch>;
  try {
    launched = launch(spec);
  } catch (error) {
    const result = Promise.reject(error);
    // Its consumer still sees the rejection; awaiting it later is not an unhandled one.
    result.catch(() => undefined);
    return { pid: undefined, result, ended: Promise.resolve(), stop() {} };
  }
  const { child, stdout, stderr } = launched;
  const pid = child.pid;
  const killGraceMs = spec.killGraceMs ?? KILL_GRACE_MS;
  const pipeGraceMs = spec.pipeGraceMs ?? PIPE_GRACE_MS;

  let exitCode: number | null = null;
  let signal: string | null = null;
  let exited = false;
  let settled = false;
  let timedOut = false;
  let stopped = false;
  let pipeTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let groupGone = false;
  let markEnded!: () => void;
  // Resolves once the group is found empty, or a while after SIGKILL whatever is left (`REAP_WAIT_MS`).
  const ended = new Promise<void>((resolve) => {
    markEnded = resolve;
  });
  if (pid === undefined) markEnded();

  const unwatch = (): void => {
    clearTimeout(killTimer);
    clearInterval(pollTimer);
  };
  /**
   * Signals every process in the group; false when none is left. Once the
   * group is found gone it is never signalled again: its id may be reused.
   */
  const signalGroup = (name: NodeJS.Signals | 0): boolean => {
    if (groupGone || pid === undefined) return false;
    try {
      process.kill(-pid, name);
      return true;
    } catch {
      groupGone = true;
      unwatch();
      markEnded();
      return false;
    }
  };
  /**
   * SIGTERM to the group now, then SIGKILL after the grace, unless a check
   * every `GROUP_POLL_MS` finds it empty first. Only the first call does
   * anything, and neither timer keeps a host process alive.
   */
  const terminate = (): void => {
    if (killTimer || !signalGroup('SIGTERM')) return;
    killTimer = setTimeout(() => {
      signalGroup('SIGKILL');
      unwatch();
      if (groupGone) return;
      // Killed: `ended` waits for the group to be reaped, briefly, then resolves whatever is left.
      const reapTimer = setInterval(() => signalGroup(0), GROUP_POLL_MS / 10);
      const giveUp = setTimeout(markEnded, REAP_WAIT_MS);
      void ended.then(() => {
        clearInterval(reapTimer);
        clearTimeout(giveUp);
      });
      reapTimer.unref();
      giveUp.unref();
    }, killGraceMs);
    pollTimer = setInterval(() => signalGroup(0), GROUP_POLL_MS);
    killTimer.unref();
    pollTimer.unref();
  };

  const timeoutTimer = setTimeout(() => {
    if (exited || stopped) return;
    timedOut = true;
    terminate();
  }, spec.timeoutMs);

  const result = new Promise<CommandResult>((resolve, reject) => {
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(pipeTimer);
      // Stop reading first, so nothing arrives after the logs close.
      for (const stream of [child.stdout, child.stderr]) {
        stream.removeAllListeners('data');
        stream.destroy();
      }
      stdout.end();
      stderr.end();
      // What it left running ends with it: only outputs, artifacts and the checkout cross steps.
      terminate();
      const lastStderrLine = stderr.lastLine();
      resolve({
        exitCode,
        signal,
        timedOut,
        stopped,
        stdoutBytes: stdout.produced,
        stderrBytes: stderr.produced,
        truncated: stdout.truncated || stderr.truncated,
        ...(lastStderrLine !== undefined ? { lastStderrLine } : {}),
      });
    };

    child.stdout.on('data', (chunk: Buffer) => stdout.write(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.write(chunk));
    // A read error ends the stream; the exit still settles the result.
    child.stdout.on('error', () => undefined);
    child.stderr.on('error', () => undefined);
    // Only a failed spawn emits this (nothing here calls `child.kill`): nothing ran.
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      stdout.end();
      stderr.end();
      reject(error);
    });
    child.once('exit', (code, name) => {
      exited = true;
      exitCode = code;
      signal = name;
      clearTimeout(timeoutTimer);
      pipeTimer = setTimeout(() => {
        terminate();
        finish();
      }, pipeGraceMs);
    });
    child.once('close', finish);
  });
  // Its consumer still sees a rejection; awaiting it later is not an unhandled one.
  result.catch(() => undefined);

  return {
    pid,
    result,
    ended,
    stop() {
      if (settled) return;
      // After the shell exited, a stop only ends what it left holding the pipes.
      if (!exited && !timedOut && !stopped) {
        stopped = true;
        clearTimeout(timeoutTimer);
      }
      terminate();
    },
  };
}
