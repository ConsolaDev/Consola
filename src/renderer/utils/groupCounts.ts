import type { Session } from '../../shared/workspace';
import type { TerminalState } from '../stores/terminalStore';

/**
 * A group's derived progress.
 *
 * Computed fresh from the terminal status store on every render and never
 * stored anywhere — the design's rule is "no stored progress state", so a
 * group's numbers can never go stale or disagree with the dots.
 */
export interface GroupCounts {
    total: number;
    needsAttention: number;
    working: number;
    exited: number;
}

export function groupCountsFor(
    sessions: Session[],
    terminals: Record<string, TerminalState>
): GroupCounts {
    const counts: GroupCounts = { total: sessions.length, needsAttention: 0, working: 0, exited: 0 };
    for (const session of sessions) {
        switch (terminals[session.instanceId]?.status) {
            case 'needs-attention':
                counts.needsAttention += 1;
                break;
            case 'working':
                counts.working += 1;
                break;
            case 'exited':
                counts.exited += 1;
                break;
            default:
                // 'ready', or no terminal yet: counted only in the total.
                break;
        }
    }
    return counts;
}

/** The sidebar badge: "◐2 · 7" when someone needs you, a plain "7" otherwise. */
export function formatGroupBadge(counts: GroupCounts): string {
    return counts.needsAttention > 0
        ? `◐${counts.needsAttention} · ${counts.total}`
        : `${counts.total}`;
}
