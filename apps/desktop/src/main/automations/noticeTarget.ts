import { assistantSession, type Workspace } from '../../shared/workspace';
import type { AutomationNotice } from '@consola/automation-engine';

export type NoticeTarget = { kind: 'session'; sessionId: string } | { kind: 'automation'; name: string } | { kind: 'automations' };

/**
 * Where a click on an automation notification lands: the session a run
 * started; the Assistant, for an approval it asked for, since its tray holds
 * it; the automation's page, for a notice about it rather than a run (one
 * that needs Allow); otherwise the workspace's Automations dashboard.
 */
export function noticeTarget(notice: AutomationNotice, workspaces: Workspace[]): NoticeTarget {
    if (notice.sessionId) return { kind: 'session', sessionId: notice.sessionId };
    const workspace = workspaces.find((candidate) => candidate.id === notice.workspaceId);
    const assistant = workspace && assistantSession(workspace);
    if (notice.needsApproval && assistant && notice.actorId === assistant.id) {
        return { kind: 'session', sessionId: assistant.id };
    }
    if (notice.automation) return { kind: 'automation', name: notice.automation };
    return { kind: 'automations' };
}
