import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandSpec, RunningCommand } from '../ports';
import { describeFailure, layerCommandEnv } from '../steps/commandIO';
import { startCommand } from './runCommand';

const BASE: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin' };

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
        const result = await start('pwd; echo "$A"; echo "$GIT_CONFIG_KEY_0=$GIT_CONFIG_VALUE_0"', { env }).result;
        expect(result).toMatchObject({ exitCode: 0, signal: null, timedOut: false, stopped: false, truncated: false });
        expect(stdout()).toBe(`${dir}\nx\ncore.hooksPath=/dev/null\n`);
        expect(result.stdoutBytes).toBe(Buffer.byteLength(stdout()));
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
        const result = await start(String.raw`printf 'one\n\033[31merror: bad\033[0m\r\n\n' >&2; exit 1`).result;
        expect(result.lastStderrLine).toBe('error: bad');
    });

    it('a timeout kills the whole group, grandchildren included', async () => {
        const result = await start('sleep 300 & echo $! > pid; wait', { timeoutMs: 300, killGraceMs: 200 }).result;
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
        expect(result).toMatchObject({ stopped: true, timedOut: false, exitCode: null, signal: 'SIGKILL' });
        await reaped(pid);
        expect(() => process.kill(pid, 0)).toThrow();
        expect(describeFailure(result, 600_000)).toBe('Stopped while running: it may have done its work');
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
        expect(result).toMatchObject({ exitCode: 0, stdoutBytes: 2_000_000, stderrBytes: 1_500_000, truncated: true });
        expect(fs.statSync(stdoutLog()).size).toBe(1_048_576);
        expect(fs.statSync(stderrLog()).size).toBe(1_048_576);
    });

    it('masks the token', async () => {
        const env = layerCommandEnv({ ...BASE, GH_TOKEN: 'gho_abc' }, {}, {});
        const result = await start('echo "tok=$GH_TOKEN"; echo "$GH_TOKEN" >&2; exit 1', { env, secrets: ['gho_abc'] }).result;
        expect(stdout()).toBe('tok=***\n');
        expect(stderr()).toBe('***\n');
        expect(result.lastStderrLine).toBe('***');
        // What the command produced, not what was written.
        expect(result.stdoutBytes).toBe('tok=gho_abc\n'.length);
    });

    it('masks a token split across two writes', async () => {
        await start('printf gho_; sleep 0.1; printf abc; printf " gho_ab"', { secrets: ['', 'gho_abc'] }).result;
        expect(stdout()).toBe('*** gho_ab');
    });

    it('rejects, having run nothing, when its folder is missing', async () => {
        const running = start('touch ran', { cwd: path.join(dir, 'missing') });
        await expect(running.result).rejects.toThrow(/missing/);
        expect(running.pid).toBeUndefined();
    });

    it.skipIf(process.getuid?.() === 0)('rejects, having run nothing, when the shell cannot start there', async () => {
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
    });
});
