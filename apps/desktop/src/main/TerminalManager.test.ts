import { describe, expect, it, vi } from 'vitest';

const { created } = vi.hoisted(() => ({
    created: [] as Array<{ options: unknown; queued: string[]; fresh: Array<[string, string | undefined]> }>,
}));

vi.mock('./TerminalService', async () => {
    const { EventEmitter } = await import('events');
    class FakeTerminalService extends EventEmitter {
        public readonly queued: string[] = [];
        public readonly fresh: Array<[string, string | undefined]> = [];
        constructor(public readonly options: { claudeSessionId: string }) {
            super();
            created.push(this);
        }
        start() {}
        queuePrompt(prompt: string) {
            this.queued.push(prompt);
        }
        conversationId() {
            return this.options.claudeSessionId;
        }
        startFreshConversation(claudeSessionId: string, prompt?: string) {
            this.fresh.push([claudeSessionId, prompt]);
        }
        getReplayBuffer() {
            return '';
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
