import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandSpec, RunningCommand } from '../ports';
import { describeFailure, layerCommandEnv } from '../steps/commandIO';
import { startCommand } from './runCommand';

const BASE: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
const TOKEN = 'gho_abc123';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The timers `runCommand.ts` has pending, found by wrapping the timer globals
 * and reading each new timer's stack. Counting every timer in the process
 * would also count vitest's own, which come and go under load.
 */
function trackTimers() {
  const real = { setTimeout, setInterval, clearTimeout, clearInterval };
  const pending = new Set<NodeJS.Timeout>();
  const ours = () => /[\\/]runCommand\.ts:/.test(new Error().stack ?? '');
  const fake = {
    setTimeout: (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const timer: NodeJS.Timeout = real.setTimeout(
        (...given: unknown[]) => {
          pending.delete(timer);
          callback(...given);
        },
        ms,
        ...args,
      );
      if (ours()) pending.add(timer);
      return timer;
    },
    setInterval: (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      const timer = real.setInterval(callback, ms, ...args);
      if (ours()) pending.add(timer);
      return timer;
    },
    clearTimeout: (timer?: NodeJS.Timeout) => {
      if (timer) pending.delete(timer);
      real.clearTimeout(timer);
    },
    clearInterval: (timer?: NodeJS.Timeout) => {
      if (timer) pending.delete(timer);
      real.clearInterval(timer);
    },
  };
  Object.assign(globalThis, fake);
  return {
    pending: () => pending.size,
    /** Pending timers that keep the process alive (an `unref`'d one does not). */
    holding: () => [...pending].filter((timer) => timer.hasRef()).length,
    restore: () => Object.assign(globalThis, real),
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits (briefly) for a killed process to be reaped; the caller asserts it is gone. */
async function reaped(pid: number): Promise<void> {
  const until = Date.now() + 2000;
  while (alive(pid) && Date.now() < until) await pause(20);
}

describe.skipIf(process.platform === 'win32')('startCommand', () => {
  let dir: string;
  let unsettled: Set<RunningCommand>;
  let grandchildren: number[];

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-run-command-')));
    unsettled = new Set();
    grandchildren = [];
  });

  afterEach(() => {
    // Whatever a failing test left running goes with it.
    for (const command of unsettled) {
      if (command.pid === undefined) continue;
      try {
        process.kill(-command.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    // A test that failed before reading `./pid` still leaves it.
    const written = Number(
      fs.existsSync(path.join(dir, 'pid'))
        ? fs.readFileSync(path.join(dir, 'pid'), 'utf8').trim()
        : '',
    );
    if (written > 0) grandchildren.push(written);
    for (const pid of grandchildren) if (alive(pid)) process.kill(pid, 'SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const stdoutLog = () => path.join(dir, 'logs', 'stdout.log');
  const stderrLog = () => path.join(dir, 'logs', 'stderr.log');
  const stdout = () => fs.readFileSync(stdoutLog(), 'utf8');
  const stderr = () => fs.readFileSync(stderrLog(), 'utf8');

  function start(command: string, fields: Partial<CommandSpec> = {}): RunningCommand {
    const running = startCommand({
      command,
      cwd: dir,
      env: layerCommandEnv(BASE, {}, {}),
      timeoutMs: 10_000,
      stdoutPath: stdoutLog(),
      stderrPath: stderrLog(),
      secrets: [],
      killGraceMs: 200,
      ...fields,
    });
    unsettled.add(running);
    running.result.then(
      () => unsettled.delete(running),
      () => unsettled.delete(running),
    );
    return running;
  }

  /** The pid a command wrote to `./pid`, once it has. */
  async function pidFile(): Promise<number> {
    const file = path.join(dir, 'pid');
    const until = Date.now() + 2000;
    for (;;) {
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
      if (text) {
        const pid = Number(text);
        grandchildren.push(pid);
        return pid;
      }
      if (Date.now() > until) throw new Error('the command never wrote its pid');
      await pause(10);
    }
  }

  it('runs in its folder with the layered environment, git hooks off', async () => {
    const env = layerCommandEnv({ ...BASE, A: 'base' }, { A: 'x' }, {});
    const result = await start('pwd; echo "$A"; echo "$GIT_CONFIG_KEY_0=$GIT_CONFIG_VALUE_0"', {
      env,
    }).result;
    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stopped: false,
      truncated: false,
    });
    expect(stdout()).toBe(`${dir}\nx\ncore.hooksPath=/dev/null\n`);
    expect(result.stdoutBytes).toBe(Buffer.byteLength(stdout()));
  });

  it('an env value is data, never code', async () => {
    const value = '$(touch pwned)\nsecond line';
    const result = await start(`printf '%s' "$A" > out`, {
      env: layerCommandEnv(BASE, { A: value }, {}),
    }).result;
    expect(result.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'out'), 'utf8')).toBe(value);
    expect(fs.existsSync(path.join(dir, 'pwned'))).toBe(false);
  });

  it('stdin is /dev/null', async () => {
    const result = await start('read line').result;
    expect(result.exitCode).toBe(1);
  });

  it('-e -o pipefail', async () => {
    const result = await start('false | true; echo after').result;
    expect(result.exitCode).toBe(1);
    expect(stdout()).not.toContain('after');
  });

  it('reports the exit code and the last line of stderr', async () => {
    const result = await start('echo one >&2; echo two >&2; exit 3').result;
    expect(result).toMatchObject({ exitCode: 3, lastStderrLine: 'two', stderrBytes: 8 });
    expect(describeFailure(result, 600_000)).toBe('exit 3: two');
  });

  it('takes the last line of stderr as plain text', async () => {
    const result = await start(
      String.raw`printf 'one\n\033[31merror: bad\033[0m\r\n\n' >&2; exit 1`,
    ).result;
    expect(result.lastStderrLine).toBe('error: bad');
  });

  describe('keeps the token out of the last line of stderr', () => {
    // Each splits the token in the raw stream with bytes the last line strips.
    it.each([
      ['an escape sequence inside it', String.raw`printf 'gho_\033[0mabc123\n' >&2; exit 1`],
      ['grep colouring it', 'echo "token is $GH_TOKEN" | grep --color=always gho >&2; exit 1'],
      ['a NUL inside it', String.raw`printf 'gho_\0abc123\n' >&2; exit 1`],
      ['UTF-16', `printf '%s\\n' "$GH_TOKEN" | iconv -f UTF-8 -t UTF-16LE >&2; exit 1`],
    ])('%s', async (_name, command) => {
      const env = layerCommandEnv({ ...BASE, GH_TOKEN: TOKEN }, {}, {});
      const result = await start(command, { env, secrets: [TOKEN] }).result;
      expect(result.exitCode).toBe(1);
      expect(result.lastStderrLine).toContain('***');
      expect(result.lastStderrLine).not.toContain(TOKEN);
      expect(describeFailure(result, 600_000)).not.toContain(TOKEN);
    });
  });

  describe('when the 4 KB stderr tail starts inside a line', () => {
    /** Every suffix of the token of 3 or more characters: what a cut could leave at a line's head. */
    const suffixes = Array.from({ length: TOKEN.length - 2 }, (_, start) => TOKEN.slice(start));

    // `ERR gho_ESC[0mabc123`, then zeros: the cut lands at `_`, at `b` and at `1`.
    it.each([4084, 4090, 4092])(
      'never starts the line with the end of a split token (%i zeros)',
      async (zeros) => {
        const env = layerCommandEnv({ ...BASE, GH_TOKEN: TOKEN }, {}, {});
        const command = String.raw`printf 'ERR gho_\033[0mabc123' >&2; printf '%0${zeros}d\n' 0 >&2; exit 1`;
        const result = await start(command, { env, secrets: [TOKEN] }).result;
        const shown = `${result.lastStderrLine ?? ''} | ${describeFailure(result, 600_000)}`;
        for (const suffix of suffixes) expect(shown).not.toContain(suffix);
      },
    );

    it('keeps what follows the first space, marked as cut', async () => {
      const command = String.raw`printf 'ERR gho_\033[0mabc123 then the rest ' >&2; printf '%04070d\n' 0 >&2; exit 1`;
      // The cut lands on the escape inside the token.
      const result = await start(command, { secrets: [TOKEN] }).result;
      expect(result.lastStderrLine).toMatch(/^…then the rest 0+…$/);
    });

    it('leaves a line that starts at the tail unchanged', async () => {
      // A 4095-byte last line and its newline are exactly the tail, which begins after the previous newline.
      const result = await start(
        `head -c 5000 /dev/zero >&2; echo >&2; printf 'word %04090d\\n' 0 >&2; exit 1`,
      ).result;
      expect(result.lastStderrLine).toMatch(/^word 0+…$/);
    });
  });

  it('clips the last line of stderr', async () => {
    const result = await start(`printf '%01000d\\n' 0 >&2; exit 1`).result;
    expect(result.lastStderrLine).toBe(`${'0'.repeat(300)}…`);
  });

  it('ends what the command left running once it exits', async () => {
    const result = await start('sleep 300 >/dev/null 2>&1 & echo $! > pid; echo done').result;
    expect(result.exitCode).toBe(0);
    const pid = await pidFile();
    await reaped(pid);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('kills a leftover that ignores SIGTERM after the grace, without holding the host alive', async () => {
    const timers = trackTimers();
    let settledAt = 0;
    try {
      const result = await start(
        "(trap '' TERM; echo > ready; exec sleep 300) >/dev/null 2>&1 & echo $! > pid; until [ -f ready ]; do sleep 0.01; done",
        { killGraceMs: 300 },
      ).result;
      settledAt = Date.now();
      expect(result.exitCode).toBe(0);
      // The grace's two timers (SIGKILL and the group check) are pending, and neither holds a headless host open.
      expect(timers.pending()).toBe(2);
      expect(timers.holding()).toBe(0);
    } finally {
      timers.restore();
    }
    const pid = await pidFile();
    expect(alive(pid)).toBe(true);
    await reaped(pid);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(Date.now() - settledAt).toBeGreaterThanOrEqual(250);
  });

  /** Whether any process of the group led by `pgid` is left. */
  function groupAlive(pgid: number): boolean {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it('leaves no member of its process group running once it has ended (slice 3-B: a run checkout is checked after this)', async () => {
    const running = start('sleep 30 >/dev/null 2>&1 & echo $! > pid; echo done');
    expect((await running.result).exitCode).toBe(0);
    await running.ended;
    expect(groupAlive(running.pid!)).toBe(false);
  });

  it('ends only after a leftover that ignores SIGTERM is killed at the grace', async () => {
    const running = start(
      "(trap '' TERM; echo > ready; exec sleep 300) >/dev/null 2>&1 & echo $! > pid; until [ -f ready ]; do sleep 0.01; done",
      { killGraceMs: 300 },
    );
    const began = Date.now();
    await running.result;
    const pid = await pidFile();
    expect(alive(pid)).toBe(true);
    await running.ended;
    expect(groupAlive(running.pid!)).toBe(false);
    expect(Date.now() - began).toBeGreaterThanOrEqual(250);
  });

  it('has ended at once when it never started', async () => {
    const running = start('true', { cwd: path.join(dir, 'missing') });
    await expect(running.result).rejects.toThrow();
    await expect(running.ended).resolves.toBeUndefined();
  });

  it('sends no SIGKILL once the group is gone', async () => {
    const kill = vi.spyOn(process, 'kill');
    try {
      // It holds the pipe, and leaves ~200 ms after SIGTERM: alive when the result settles, gone before the grace ends.
      const holder =
        "(trap 'sleep 0.2; exit 0' TERM; echo > ready; while :; do sleep 0.05; done) >&1 & echo $! > pid";
      const result = await start(`${holder}; until [ -f ready ]; do sleep 0.01; done; echo done`, {
        pipeGraceMs: 100,
        killGraceMs: 1500,
      }).result;
      const settledAt = Date.now();
      expect(result.exitCode).toBe(0);
      const pid = await pidFile();
      await reaped(pid);
      await pause(Math.max(0, settledAt + 1700 - Date.now())); // past the grace
      const group = kill.mock.calls.filter(([target]) => target < 0);
      expect(group.map(([, name]) => name)).toContain('SIGTERM');
      expect(group.map(([, name]) => name)).not.toContain('SIGKILL');
    } finally {
      kill.mockRestore();
    }
  });

  it('a timeout kills the whole group, grandchildren included', async () => {
    const result = await start('sleep 300 & echo $! > pid; wait', {
      timeoutMs: 300,
      killGraceMs: 200,
    }).result;
    expect(result).toMatchObject({ timedOut: true, stopped: false });
    const pid = await pidFile();
    await reaped(pid);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(describeFailure(result, 300)).toBe('timed out after 300ms');
  });

  it('resolves even when a background child keeps stdout open', async () => {
    const began = Date.now();
    const result = await start('sleep 300 >&1 & echo $! > pid; echo done').result;
    expect(Date.now() - began).toBeLessThan(3000);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, stopped: false });
    expect(stdout()).toBe('done\n');
    // Once the pipes' grace ran out, the child went with its group.
    const pid = await pidFile();
    await reaped(pid);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('stop() sends SIGTERM to the group, then SIGKILL after the grace', async () => {
    const running = start("trap '' TERM; sleep 300 & echo $! > pid; wait", { killGraceMs: 300 });
    const pid = await pidFile(); // written after the trap is set
    const stoppedAt = Date.now();
    running.stop();
    const result = await running.result;
    expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(250);
    expect(result).toMatchObject({
      stopped: true,
      timedOut: false,
      exitCode: null,
      signal: 'SIGKILL',
    });
    await reaped(pid);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(describeFailure(result, 600_000)).toBe(
      'Stopped while running: it may have done its work',
    );
  });

  it('stop() ends a command that honours SIGTERM without waiting for the grace', async () => {
    const running = start('sleep 300 & echo $! > pid; wait', { killGraceMs: 5000 });
    const pid = await pidFile();
    const stoppedAt = Date.now();
    running.stop();
    const result = await running.result;
    expect(Date.now() - stoppedAt).toBeLessThan(2000);
    expect(result).toMatchObject({ stopped: true, signal: 'SIGTERM' });
    await reaped(pid);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('caps each log at 1 MB and keeps draining', async () => {
    const result = await start('head -c 2000000 /dev/zero; head -c 1500000 /dev/zero >&2').result;
    expect(result).toMatchObject({
      exitCode: 0,
      stdoutBytes: 2_000_000,
      stderrBytes: 1_500_000,
      truncated: true,
    });
    expect(fs.statSync(stdoutLog()).size).toBe(1_048_576);
    expect(fs.statSync(stderrLog()).size).toBe(1_048_576);
  });

  it('masks the token', async () => {
    const env = layerCommandEnv({ ...BASE, GH_TOKEN: 'gho_abc' }, {}, {});
    const result = await start('echo "tok=$GH_TOKEN"; echo "$GH_TOKEN" >&2; exit 1', {
      env,
      secrets: ['gho_abc'],
    }).result;
    expect(stdout()).toBe('tok=***\n');
    expect(stderr()).toBe('***\n');
    expect(result.lastStderrLine).toBe('***');
    // What the command produced, not what was written.
    expect(result.stdoutBytes).toBe('tok=gho_abc\n'.length);
  });

  it('masks a token split across two writes', async () => {
    await start('printf gho_; sleep 0.1; printf abc; printf " gho_ab"', {
      secrets: ['', 'gho_abc'],
    }).result;
    expect(stdout()).toBe('*** gho_ab');
  });

  it('rejects, having run nothing, when its folder is missing', async () => {
    const running = start('touch ran', { cwd: path.join(dir, 'missing') });
    await expect(running.result).rejects.toThrow(/missing/);
    expect(running.pid).toBeUndefined();
  });

  it.skipIf(process.getuid?.() === 0)(
    'rejects, having run nothing, when the shell cannot start there',
    async () => {
      const locked = path.join(dir, 'locked');
      fs.mkdirSync(locked, { mode: 0o000 });
      try {
        const running = start('touch ran', { cwd: locked });
        await expect(running.result).rejects.toThrow(/EACCES/);
        expect(running.pid).toBeUndefined();
      } finally {
        fs.chmodSync(locked, 0o755);
      }
      expect(fs.readdirSync(locked)).toEqual([]);
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'keeps a rejection for a consumer that awaits it late',
    async () => {
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      const locked = path.join(dir, 'locked');
      fs.mkdirSync(locked, { mode: 0o000 });
      try {
        const spec = {
          command: 'true',
          env: BASE,
          timeoutMs: 1000,
          stdoutPath: stdoutLog(),
          stderrPath: stderrLog(),
          secrets: [],
        };
        // Not through `start`, whose bookkeeping would consume the rejection itself.
        const beforeSpawning = startCommand({ ...spec, cwd: path.join(dir, 'missing') });
        const onSpawning = startCommand({ ...spec, cwd: locked });
        await pause(50); // e.g. a durable write between start() and awaiting the result
        await expect(beforeSpawning.result).rejects.toThrow(/missing/);
        await expect(onSpawning.result).rejects.toThrow(/EACCES/);
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
        fs.chmodSync(locked, 0o755);
      }
    },
  );
});
