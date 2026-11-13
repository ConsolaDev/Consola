import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileSync, execFile } = vi.hoisted(() => ({
    execFileSync: vi.fn(),
    execFile: vi.fn(),
}));
vi.mock('child_process', () => ({ execFileSync, execFile }));

type Probe = { stdout: string } | { error: Error };

/** Each background probe answers with the next outcome, asynchronously, as a real child would. */
function answerBackgroundProbes(...outcomes: Probe[]): void {
    execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
        const outcome = outcomes.shift() ?? { error: new Error('no outcome queued') };
        queueMicrotask(() => ('error' in outcome ? callback(outcome.error, '') : callback(null, outcome.stdout)));
        return { stdin: { end: vi.fn() } };
    });
}

function timeout(): Error {
    return Object.assign(new Error('spawnSync /bin/zsh ETIMEDOUT'), { code: 'ETIMEDOUT' });
}

function killedAfterTimeout(): Error {
    return Object.assign(new Error('Command failed: /bin/zsh -ilc env -0'), { killed: true, signal: 'SIGTERM' });
}

const LOGIN_PATH = '/opt/homebrew/bin:/usr/bin:/bin';

// The module caches its answer, so each test imports a fresh copy.
async function load() {
    return import('./LoginEnvironment');
}

describe('LoginEnvironment', () => {
    const originalPath = process.env.PATH;

    beforeEach(() => {
        vi.resetModules();
        execFileSync.mockReset();
        execFile.mockReset();
        process.env.PATH = '/usr/bin:/bin';
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        process.env.PATH = originalPath;
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("uses the login shell's environment when the first probe answers", async () => {
        execFileSync.mockReturnValue(`PATH=${LOGIN_PATH}\0NVM_DIR=/home/me/.nvm\0`);
        const { getLoginEnv, loginEnvProblem } = await load();

        expect(getLoginEnv().PATH).toBe(LOGIN_PATH);
        expect(getLoginEnv().NVM_DIR).toBe('/home/me/.nvm');
        expect(loginEnvProblem()).toBeNull();
        expect(execFile).not.toHaveBeenCalled();
    });

    it('serves the bare environment after a failed probe, then the login shell once a retry answers', async () => {
        execFileSync.mockImplementation(() => { throw timeout(); });
        answerBackgroundProbes({ stdout: `PATH=${LOGIN_PATH}\0` });
        const { getLoginEnv, loginEnvProblem, loginEnvRetry } = await load();

        expect(getLoginEnv().PATH).toBe('/usr/bin:/bin');
        expect(loginEnvProblem()).toMatch(/-ilc` did not finish within 5s/);

        await loginEnvRetry();

        expect(loginEnvRetry()).toBeNull();
        expect(getLoginEnv().PATH).toBe(LOGIN_PATH);
        expect(loginEnvProblem()).toBeNull();
        expect(execFile).toHaveBeenCalledTimes(1);
    });

    it('lets a launch that triggers the first probe wait for the retry it starts', async () => {
        execFileSync.mockImplementation(() => { throw timeout(); });
        answerBackgroundProbes({ stdout: `PATH=${LOGIN_PATH}\0` });
        const { getLoginEnv, loginEnvRetry } = await load();

        await loginEnvRetry();

        expect(getLoginEnv().PATH).toBe(LOGIN_PATH);
    });

    it('has nothing to wait for when the first probe answers', async () => {
        execFileSync.mockReturnValue(`PATH=${LOGIN_PATH}\0`);
        const { loginEnvRetry } = await load();

        expect(loginEnvRetry()).toBeNull();
        expect(execFileSync).toHaveBeenCalledTimes(1);
    });

    it('backs off between retries and stops after the last one', async () => {
        vi.useFakeTimers();
        execFileSync.mockImplementation(() => { throw timeout(); });
        answerBackgroundProbes(
            { error: killedAfterTimeout() },
            { error: killedAfterTimeout() },
            { error: killedAfterTimeout() }
        );
        const { loginEnvProblem, loginEnvRetry } = await load();

        await loginEnvRetry();
        expect(execFile).toHaveBeenCalledTimes(1);
        expect(loginEnvProblem()).toMatch(/did not finish within 20s/);

        await vi.advanceTimersByTimeAsync(29_999);
        expect(execFile).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(execFile).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(120_000);
        expect(execFile).toHaveBeenCalledTimes(3);

        await vi.advanceTimersByTimeAsync(60 * 60_000);
        expect(execFile).toHaveBeenCalledTimes(3);
        expect(loginEnvProblem()).toMatch(/did not finish within 20s/);
    });

    it('recovers on a later retry', async () => {
        vi.useFakeTimers();
        execFileSync.mockImplementation(() => { throw timeout(); });
        answerBackgroundProbes({ error: killedAfterTimeout() }, { stdout: `PATH=${LOGIN_PATH}\0` });
        const { getLoginEnv, loginEnvProblem, loginEnvRetry } = await load();

        await loginEnvRetry();
        expect(getLoginEnv().PATH).toBe('/usr/bin:/bin');

        await vi.advanceTimersByTimeAsync(30_000);

        expect(getLoginEnv().PATH).toBe(LOGIN_PATH);
        expect(loginEnvProblem()).toBeNull();
    });

    it('names a failure that is not a timeout', async () => {
        execFileSync.mockImplementation(() => {
            throw Object.assign(new Error('Command failed: /bin/zsh -ilc env -0\nzsh: parse error'), { status: 1 });
        });
        answerBackgroundProbes({ error: Object.assign(new Error('Command failed: /bin/zsh -ilc env -0\nzsh: parse error'), { code: 1 }) });
        const { loginEnvProblem, loginEnvRetry } = await load();

        await loginEnvRetry();

        expect(loginEnvProblem()).toMatch(/-ilc` failed: Command failed: \/bin\/zsh -ilc env -0$/);
    });

    it('does not carry an enclosing Claude session into the retried environment', async () => {
        execFileSync.mockImplementation(() => { throw timeout(); });
        answerBackgroundProbes({ stdout: `PATH=${LOGIN_PATH}\0CLAUDECODE=1\0` });
        const { getLoginEnv, loginEnvRetry } = await load();

        await loginEnvRetry();

        expect(getLoginEnv().CLAUDECODE).toBeUndefined();
    });
});
