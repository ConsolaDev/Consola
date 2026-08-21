import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node-pty', () => ({ spawn: spawnMock }));
vi.mock('./LoginEnvironment', () => ({ getLoginEnv: () => ({ PATH: '/usr/bin' }) }));
vi.mock('./drivers', () => ({
    getDriver: () => ({
        id: 'claude',
        resolveBinary: () => 'claude-stub',
        buildSessionArgs: () => [],
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
    return () => vi.useRealTimers();
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
});
