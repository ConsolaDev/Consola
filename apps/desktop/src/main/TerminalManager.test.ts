import { describe, expect, it, vi } from 'vitest';

const { created } = vi.hoisted(() => ({
    created: [] as Array<{
        options: unknown;
        queued: string[];
        relaunched: unknown[];
        fresh: Array<[string, string | undefined]>;
        emit: (event: string, ...args: unknown[]) => boolean;
    }>,
}));

vi.mock('./TerminalService', async () => {
    const { EventEmitter } = await import('events');
    class FakeTerminalService extends EventEmitter {
        public readonly queued: string[] = [];
        public readonly relaunched: unknown[] = [];
        public readonly fresh: Array<[string, string | undefined]> = [];
        constructor(public readonly options: { claudeSessionId: string }) {
            super();
            created.push(this);
        }
        start() {}
        relaunch(launch: unknown) {
            this.relaunched.push(launch);
        }
        queuePrompt(prompt: string) {
            this.queued.push(prompt);
        }
        conversationId() {
            return this.options.claudeSessionId;
        }
        startFreshConversation(claudeSessionId: string, prompt?: string) {
            this.fresh.push([claudeSessionId, prompt]);
        }
        getReplay() {
            return { replay: '', cols: 80, rows: 24 };
        }
        hasClaudeExited() {
            return false;
        }
        destroy() {}
    }
    return { TerminalService: FakeTerminalService };
});

import { TerminalManager } from './TerminalManager';

const options = { cwd: '/tmp', claudeSessionId: 'abc', resume: true };
const owner = { send: () => {}, isDestroyed: () => false } as never;

describe('TerminalManager.startHeadless', () => {
    it('never hands an unattended turn to a terminal that already exists', () => {
        const manager = new TerminalManager(() => []);
        // The person opened the session first: its pane started an interactive terminal.
        manager.ensure('instance-1', options, owner);
        expect(() =>
            manager.startHeadless('instance-1', { ...options, unattended: true, initialPrompt: 'Go on.' })
        ).toThrow('This session already has a terminal, so its turn cannot run unattended.');
        // Nothing was typed into the person's composer.
        expect(created).toHaveLength(1);
        expect(created[0].queued).toEqual([]);
    });

    it('still queues an ordinary prompt for a terminal that already exists', () => {
        created.length = 0;
        const manager = new TerminalManager(() => []);
        manager.ensure('instance-1', options, owner);
        manager.startHeadless('instance-1', { ...options, initialPrompt: 'Review it.' });
        expect(created[0].queued).toEqual(['Review it.']);
    });

    it('moves a terminal running another conversation onto the one a fresh start asks for', () => {
        created.length = 0;
        const manager = new TerminalManager(() => []);
        // A pane mounted while the fresh start was being prepared, and
        // resumed the conversation the record named a moment earlier.
        manager.ensure('instance-1', options, owner);
        manager.startHeadless('instance-1', { ...options, claudeSessionId: 'new', resume: false, initialPrompt: 'Review again.' });
        expect(created).toHaveLength(1);
        expect(created[0].fresh).toEqual([['new', 'Review again.']]);
        // Never typed into the old conversation.
        expect(created[0].queued).toEqual([]);
    });
});

describe('TerminalManager listeners', () => {
    it('tells every status and exit listener, and one that throws does not silence the rest', () => {
        created.length = 0;
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        const manager = new TerminalManager(() => []);
        manager.ensure('inst-1', options, owner);
        const seen: string[] = [];
        manager.addStatusListener(() => { throw new Error('boom'); });
        manager.addStatusListener((id, status) => seen.push(`${id}:${status}`));
        manager.addExitListener(() => { throw new Error('boom'); });
        manager.addExitListener((id, info) => seen.push(`${id}:exit:${info.exitCode}`));
        created[0].emit('status', 'working');
        created[0].emit('exit', { exitCode: 2 });
        expect(seen).toEqual(['inst-1:working', 'inst-1:exit:2']);
        expect(log).toHaveBeenCalledTimes(2);
        log.mockRestore();
    });

    it('stops calling a listener once it unsubscribes', () => {
        created.length = 0;
        const manager = new TerminalManager(() => []);
        manager.ensure('inst-1', options, owner);
        const status = vi.fn();
        const exit = vi.fn();
        const offStatus = manager.addStatusListener(status);
        const offExit = manager.addExitListener(exit);
        offStatus();
        offExit();
        created[0].emit('status', 'working');
        created[0].emit('exit', { exitCode: 0 });
        expect(status).not.toHaveBeenCalled();
        expect(exit).not.toHaveBeenCalled();
    });
});

describe('TerminalManager.relaunch', () => {
    it('relaunches the terminal it already has, and refuses an unknown one', () => {
        created.length = 0;
        const manager = new TerminalManager(() => []);
        manager.ensure('inst-1', options, owner);
        const launch = { cwd: '/tmp', prompt: 'go', unattended: false };
        manager.relaunch('inst-1', launch);
        expect(created).toHaveLength(1);
        expect(created[0].relaunched).toEqual([launch]);
        expect(() => manager.relaunch('nope', launch)).toThrow('No terminal for nope.');
    });
});
