import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';

const { spawnMock, buildArgsMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), buildArgsMock: vi.fn() }));

vi.mock('node-pty', () => ({ spawn: spawnMock }));
vi.mock('./LoginEnvironment', () => ({ getLoginEnv: () => ({ PATH: '/usr/bin' }) }));
vi.mock('./drivers', () => ({
    getDriver: (id = 'claude') => ({
        id,
        initialPromptViaArgs: id === 'codex',
        retryResumeAsFresh: id !== 'codex',
        resolveBinary: () => 'claude-stub',
        buildSessionArgs: buildArgsMock,
        composeEnv: (_harness: unknown, env: Record<string, string | undefined>) => env,
    }),
    toHarnessConfig: (options: unknown) => options,
}));

import { TerminalService } from './TerminalService';

/** What deliverPendingPrompt writes: a bracketed paste, then Enter. */
function pasted(prompt: string): string[] {
    return [`\x1b[200~${prompt}\x1b[201~`, '\r'];
}

interface PtyHarness {
    writes: string[];
    feed: (data: string) => void;
    exit: (exitCode: number) => void;
}

/** Install a fake PTY behind the mocked spawn and hand back its controls. */
function installFakePty(): PtyHarness {
    const writes: string[] = [];
    let onData: ((data: string) => void) | undefined;
    let onExit: ((event: { exitCode: number }) => void) | undefined;
    spawnMock.mockReturnValue({
        onData: (callback: (data: string) => void) => { onData = callback; },
        onExit: (callback: (event: { exitCode: number }) => void) => { onExit = callback; },
        write: (data: string) => { writes.push(data); },
        resize: () => {},
        kill: () => {},
    });
    return {
        writes,
        feed: (data) => onData?.(data),
        exit: (exitCode) => onExit?.({ exitCode }),
    };
}

// NOTE: if Phase 0 made `workspaceId` a required member of
// TerminalServiceOptions (for GH_TOKEN resolution), add `workspaceId: 'ws-1'`
// to these options — do not loosen the type.
async function buildService(initialPrompt?: string): Promise<TerminalService> {
    const service = new TerminalService({
        cwd: os.tmpdir(),
        claudeSessionId: '00000000-0000-4000-8000-000000000000',
        resume: false,
        initialPrompt,
    });
    await service.start();
    return service;
}

/** Idle debounce (500 ms) plus one, so a settle is unambiguous. */
const SETTLE_MS = 501;

beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
    buildArgsMock.mockReset().mockReturnValue([]);
    return () => vi.useRealTimers();
});

describe('TerminalService Codex launch', () => {
    it('shows asynchronous preparation failures in the terminal', async () => {
        installFakePty();
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        buildArgsMock.mockRejectedValue(new Error('Codex preparation failed'));
        const service = new TerminalService({
            cwd: os.tmpdir(), claudeSessionId: 'consola-id', resume: false, driverId: 'codex',
        });
        const output: string[] = [];
        service.on('data', data => output.push(data));
        service.start();
        await vi.advanceTimersByTimeAsync(1);
        expect(output.join('')).toContain('Codex preparation failed');
        expect(service.hasClaudeExited()).toBe(true);
        expect(spawnMock).not.toHaveBeenCalled();
        service.destroy();
        log.mockRestore();
    });

    it('awaits launch preparation and passes the opening prompt exactly once via argv', async () => {
        const pty = installFakePty();
        buildArgsMock.mockResolvedValue(['resume', 'native-id', '--', 'opening prompt']);
        const service = new TerminalService({
            cwd: os.tmpdir(), claudeSessionId: 'consola-id', resume: false,
            driverId: 'codex', initialPrompt: 'opening prompt',
        });
        service.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(spawnMock.mock.calls[0][1]).toEqual(['resume', 'native-id', '--', 'opening prompt']);
        expect(buildArgsMock.mock.calls[0][1]).toMatchObject({ cwd: os.tmpdir(), initialPrompt: 'opening prompt' });
        pty.feed('› ');
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        expect(pty.writes).toEqual([]);
        pty.exit(0);
        service.restartClaude();
        await vi.advanceTimersByTimeAsync(0);
        expect(buildArgsMock.mock.calls[1][1].initialPrompt).toBeUndefined();
        service.destroy();
    });

    it('does not replace a failed Codex resume with a fresh conversation', async () => {
        const pty = installFakePty();
        const service = new TerminalService({
            cwd: os.tmpdir(), claudeSessionId: 'consola-id', resume: true, driverId: 'codex',
        });
        service.start();
        await vi.advanceTimersByTimeAsync(0);
        pty.feed('No conversation found');
        pty.exit(1);
        await vi.advanceTimersByTimeAsync(0);
        expect(spawnMock).toHaveBeenCalledTimes(1);
        service.destroy();
    });

    it('does not spawn after a tab is destroyed during async launch preparation', async () => {
        installFakePty();
        let ready!: (args: string[]) => void;
        buildArgsMock.mockReturnValue(new Promise<string[]>(resolve => { ready = resolve; }));
        const service = new TerminalService({
            cwd: os.tmpdir(), claudeSessionId: 'consola-id', resume: false, driverId: 'codex',
        });
        service.start();
        await vi.advanceTimersByTimeAsync(0);
        service.destroy();
        ready(['resume', 'native-id']);
        await vi.advanceTimersByTimeAsync(0);
        expect(spawnMock).not.toHaveBeenCalled();
    });

    it('delivers queued prompts to a Codex composer after a trust menu clears', async () => {
        const pty = installFakePty();
        const service = await buildService();
        service.queuePrompt('follow up');
        pty.feed('Do you trust the contents of this directory?\r\n› ');
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        expect(pty.writes).toEqual([]);
        pty.feed('\x1b[2J\x1b[3J\x1b[H› ');
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        expect(pty.writes).toEqual(pasted('follow up'));
        service.destroy();
    });
});

describe('TerminalService prompt FIFO', () => {
    it('delivers two queued prompts in order, one per ready-composer transition', async () => {
        const pty = installFakePty();
        const service = await buildService();

        service.queuePrompt('first prompt');
        service.queuePrompt('second prompt');
        // No screen yet, so the composer cannot be ready: nothing delivered.
        expect(pty.writes).toEqual([]);

        // The CLI paints an empty composer and goes quiet.
        pty.feed('❯ ');
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        expect(pty.writes).toEqual(pasted('first prompt'));

        // Claude works: output flows, the composer is gone. Still one prompt out.
        pty.feed('\x1b[2J\x1b[3J\x1b[Hworking on it...');
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        expect(pty.writes).toEqual(pasted('first prompt'));

        // A fresh empty composer: the second ready transition drains one more.
        pty.feed('\x1b[2J\x1b[3J\x1b[H❯ ');
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        expect(pty.writes).toEqual([...pasted('first prompt'), ...pasted('second prompt')]);

        service.destroy();
    });

    it('never types into a confirmation menu', async () => {
        const pty = installFakePty();
        const service = await buildService();
        service.queuePrompt('would answer the menu');

        pty.feed('Do you want to proceed?\r\n❯ ');
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        // A composer line is on screen, but so is a confirmation marker: hold.
        expect(pty.writes).toEqual([]);

        // The user answers; the menu clears and an empty composer returns.
        pty.feed('\x1b[2J\x1b[3J\x1b[H❯ ');
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        expect(pty.writes).toEqual(pasted('would answer the menu'));

        service.destroy();
    });

    it('seeds the queue from initialPrompt', async () => {
        const pty = installFakePty();
        const service = await buildService('seeded');

        pty.feed('❯ ');
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        expect(pty.writes).toEqual(pasted('seeded'));

        service.destroy();
    });
});

describe('TerminalService status event', () => {
    it('emits one status per derived change across a session lifecycle', async () => {
        const pty = installFakePty();
        const service = await buildService();
        const statuses: string[] = [];
        service.on('status', (status: string) => statuses.push(status));

        pty.feed('booting up');                        // output starts flowing
        await vi.advanceTimersByTimeAsync(SETTLE_MS);  // settles, no menu
        pty.feed('\x1b[2J\x1b[3J\x1b[HDo you want to proceed?');
        await vi.advanceTimersByTimeAsync(SETTLE_MS);  // settles on a menu
        pty.feed('\x1b[2J\x1b[3J\x1b[H❯ ');
        await vi.advanceTimersByTimeAsync(SETTLE_MS);  // menu answered
        pty.exit(0);

        // The spawn's initial 'ready' fired inside buildService(), before this
        // listener attached — real listeners do see it, because wireEvents()
        // runs before start() in TerminalManager. From here: data -> working,
        // settle -> ready, menu -> needs-attention, cleared -> ready, exit.
        expect(statuses).toEqual([
            'working',
            'ready',
            'working',
            'needs-attention',
            'ready',
            'exited',
        ]);
        service.destroy();
    });

    it('does not ring needs-attention when a restart follows a menu on screen', async () => {
        const pty = installFakePty();
        const service = await buildService();

        // The CLI dies with a confirmation menu still painted, so the last
        // thing it said was 'needs-attention'.
        pty.feed('Do you want to proceed?');
        await vi.advanceTimersByTimeAsync(SETTLE_MS);
        pty.exit(1);
        await vi.advanceTimersByTimeAsync(0);

        const statuses: string[] = [];
        service.on('status', (status: string) => statuses.push(status));

        // Restarting throws the screen away, so the menu is gone; a fresh PTY
        // takes the next spawn.
        installFakePty();
        service.restartClaude();
        await vi.advanceTimersByTimeAsync(0);

        // Nothing has been painted yet, so nothing can be waiting on the user.
        // A stale flag surviving the restart would fire an OS notification for
        // a menu that is no longer on screen.
        expect(statuses).toEqual(['ready']);

        service.destroy();
    });
});
