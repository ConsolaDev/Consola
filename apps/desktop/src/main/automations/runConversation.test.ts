import { describe, expect, it, vi } from 'vitest';
import type { RunRecord } from '@consola/factory-spec';
import type { Harness } from '../../shared/harness';
import type { Session } from '../../shared/workspace';
import type { HarnessDriver } from '../drivers';
import { readRunConversation } from './runConversation';

const record = { entries: [{ kind: 'text' as const, text: 'hi' }], truncated: false };

function run(overrides: Partial<RunRecord> = {}): RunRecord {
    return {
        id: 'run-1',
        automationId: 'review',
        actionName: 'prompt',
        actionVersion: 'v1',
        mode: 'auto',
        trigger: { kind: 'manual' },
        status: 'completed',
        attribution: { automationId: 'review', actionName: 'prompt', triggerKind: 'manual', workspaceId: 'ws-1' },
        createdAt: '2026-11-12T09:00:00Z',
        updatedAt: '2026-11-12T10:05:00Z',
        startedAt: '2026-11-12T10:00:00Z',
        finishedAt: '2026-11-12T10:05:00Z',
        ...overrides,
    } as RunRecord;
}

function harness(overrides: Partial<Harness> = {}): Harness {
    return {
        id: 'work',
        driverId: 'claude',
        name: 'Work',
        accentColor: '#000',
        enabled: false,
        archived: true,
        isBuiltIn: false,
        configDir: '/profiles/work',
        extraArgs: [],
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    };
}

function driverWith(read?: HarnessDriver['readConversation']) {
    return { readConversation: read } as unknown as HarnessDriver;
}

describe('readRunConversation', () => {
    it("reads the run's own window under the harness recorded at launch, archived or not", async () => {
        const read = vi.fn().mockResolvedValue(record);

        const result = await readRunConversation(run({ conversation: { harnessId: 'work', id: 'conv-1' } }), {
            harnesses: () => [harness()],
            sessions: () => [],
            driverFor: () => driverWith(read),
        });

        expect(result).toEqual({ readable: true, conversation: record });
        expect(read).toHaveBeenCalledWith(expect.objectContaining({ configDir: '/profiles/work' }), 'conv-1', {
            since: '2026-11-12T10:00:00Z',
            until: '2026-11-12T10:05:00Z',
        });
    });

    it('starts the window at creation when the run never recorded a start, and leaves it open while running', async () => {
        const read = vi.fn().mockResolvedValue(null);

        const result = await readRunConversation(
            run({ conversation: { harnessId: 'work', id: 'conv-1' }, startedAt: undefined, finishedAt: undefined }),
            { harnesses: () => [harness()], sessions: () => [], driverFor: () => driverWith(read) }
        );

        expect(result).toEqual({ readable: true, conversation: null });
        expect(read).toHaveBeenCalledWith(expect.anything(), 'conv-1', {
            since: '2026-11-12T09:00:00Z',
            until: undefined,
        });
    });

    it('falls back to the run’s session when the run predates conversation pointers', async () => {
        const read = vi.fn().mockResolvedValue(record);
        const session = { id: 'sess-1', harnessId: 'work', claudeSessionId: 'conv-9' } as Session;
        const sessions = vi.fn().mockReturnValue([{ id: 'other' } as Session, session]);

        const result = await readRunConversation(run({ sessionId: 'sess-1' }), {
            harnesses: () => [harness()],
            sessions,
            driverFor: () => driverWith(read),
        });

        expect(result).toEqual({ readable: true, conversation: record });
        expect(sessions).toHaveBeenCalledWith('ws-1');
        expect(read).toHaveBeenCalledWith(expect.anything(), 'conv-9', expect.anything());
    });

    it('is unreadable when the driver cannot read transcripts, or the run has no conversation', async () => {
        const deps = { harnesses: () => [harness()], sessions: () => [], driverFor: () => driverWith(undefined) };

        expect(await readRunConversation(run({ conversation: { harnessId: 'work', id: 'c' } }), deps)).toEqual({
            readable: false,
        });
        expect(await readRunConversation(run(), deps)).toEqual({ readable: false });
        expect(await readRunConversation(run({ sessionId: 'gone' }), deps)).toEqual({ readable: false });
    });
});
