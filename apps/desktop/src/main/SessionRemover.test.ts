import { describe, expect, it, vi } from 'vitest';
import { SessionRemover } from './SessionRemover';

function harness(deleteRecord: (workspaceId: string, sessionId: string) => void = () => {}) {
    const calls: string[] = [];
    const remover = new SessionRemover({
        deleteRecord: vi.fn((workspaceId, sessionId) => {
            calls.push(`record ${workspaceId}/${sessionId}`);
            deleteRecord(workspaceId, sessionId);
        }),
        destroyTerminal: (id) => calls.push(`terminal ${id}`),
        destroyShell: (id) => calls.push(`shell ${id}`),
        releaseMcp: (id) => calls.push(`mcp ${id}`),
    });
    return { remover, calls };
}

const session = { id: 's-1', instanceId: 'workspace-w-session-1' };

describe('SessionRemover', () => {
    it('deletes the record first, then stops terminal, shell and MCP endpoint', () => {
        const { remover, calls } = harness();
        remover.remove('w', session);
        expect(calls).toEqual([
            'record w/s-1',
            'terminal workspace-w-session-1',
            'shell workspace-w-session-1',
            'mcp s-1',
        ]);
    });

    it('leaves a running session untouched when the record cannot be deleted', () => {
        const { remover, calls } = harness(() => {
            throw new Error('disk full');
        });
        expect(() => remover.remove('w', session)).toThrow('disk full');
        expect(calls).toEqual(['record w/s-1']);
    });

    it('stop() tears down the runtime and keeps the record', () => {
        const { remover, calls } = harness();
        remover.stop(session);
        expect(calls).toEqual(['terminal workspace-w-session-1', 'shell workspace-w-session-1', 'mcp s-1']);
    });
});
