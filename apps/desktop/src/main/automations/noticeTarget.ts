import { assistantSession, type Workspace } from '../../shared/workspace';
import type { AutomationNotice } from './AutomationService';

export type NoticeTarget = { kind: 'session'; sessionId: string } | { kind: 'automations' };

/**
 * Where a click on an automation notification lands: the session a run
 * started; the Assistant, for an approval it asked for, since its tray holds
 * it; otherwise the workspace's Automations panel.
 */
export function noticeTarget(notice: AutomationNotice, workspaces: Workspace[]): NoticeTarget {
    if (notice.sessionId) return { kind: 'session', sessionId: notice.sessionId };
    const workspace = workspaces.find((candidate) => candidate.id === notice.workspaceId);
    const assistant = workspace && assistantSession(workspace);
    if (notice.needsApproval && assistant && notice.actorId === assistant.id) {
        return { kind: 'session', sessionId: assistant.id };
    }
    return { kind: 'automations' };
}
