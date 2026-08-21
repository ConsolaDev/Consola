import type { TerminalStatus } from '../shared/terminalStatus';
import type { Session, Workspace } from '../shared/workspace';

/**
 * When a needs-attention transition earns an OS notification.
 *
 * Pure on purpose — no Electron imports — so the debounce is testable as a
 * table. The rule: ring once per needs-attention episode, only while no
 * Consola window is focused. Any other status ends the episode, so the next
 * needs-attention rings again. Status events are edge-triggered upstream, so
 * a session parked on one prompt can never ring twice.
 */
export class NotificationPolicy {
    private readonly notified = new Set<string>();

    public shouldNotify(
        instanceId: string,
        status: TerminalStatus,
        anyWindowFocused: boolean
    ): boolean {
        if (status !== 'needs-attention') {
            this.notified.delete(instanceId);
            return false;
        }
        if (anyWindowFocused) return false;
        if (this.notified.has(instanceId)) return false;
        this.notified.add(instanceId);
        return true;
    }

    /** A destroyed terminal must not suppress a future session's episode. */
    public forget(instanceId: string): void {
        this.notified.delete(instanceId);
    }
}

/** The workspace and session a terminal instance belongs to, if any. */
export function findSessionByInstanceId(
    workspaces: Workspace[],
    instanceId: string
): { workspace: Workspace; session: Session } | null {
    for (const workspace of workspaces) {
        const session = workspace.sessions.find(
            (candidate) => candidate.instanceId === instanceId
        );
        if (session) return { workspace, session };
    }
    return null;
}
