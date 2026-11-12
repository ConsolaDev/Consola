import { describe, expect, it } from 'vitest';
import type { Session, Workspace } from '../../shared/workspace';
import type { AutomationNotice } from './AutomationService';
import { noticeTarget } from './noticeTarget';

const WORKSPACES = [
    {
        id: 'ws-1',
        sessions: [
            { id: 'a', kind: 'assistant' },
            { id: 's-2', kind: 'interactive' },
        ] as Session[],
    },
] as unknown as Workspace[];

function notice(fields: Partial<AutomationNotice>): AutomationNotice {
    return { title: 't', body: 'b', runId: 'r1', workspaceId: 'ws-1', needsApproval: true, ...fields };
}

describe('noticeTarget', () => {
    it('opens the Assistant for a request it asked for', () => {
        expect(noticeTarget(notice({ actorId: 'a' }), WORKSPACES)).toEqual({ kind: 'session', sessionId: 'a' });
    });

    it('opens Automations for another session’s request, and for a run nobody asked for', () => {
        expect(noticeTarget(notice({ actorId: 's-2' }), WORKSPACES)).toEqual({ kind: 'automations' });
        expect(noticeTarget(notice({}), WORKSPACES)).toEqual({ kind: 'automations' });
    });

    it('opens the session a run started, first', () => {
        expect(noticeTarget(notice({ needsApproval: false, sessionId: 's-2', actorId: 'a' }), WORKSPACES)).toEqual({
            kind: 'session',
            sessionId: 's-2',
        });
    });

    it('only routes an approval to the Assistant', () => {
        expect(noticeTarget(notice({ needsApproval: false, actorId: 'a' }), WORKSPACES)).toEqual({ kind: 'automations' });
    });
});
