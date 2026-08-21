import { describe, expect, it } from 'vitest';
import { formatGroupBadge, groupCountsFor } from './groupCounts';
import type { Session } from '../../shared/workspace';
import type { TerminalState } from '../stores/terminalStore';

function session(instanceId: string): Session {
    return { instanceId } as Session;
}

function terminal(status: TerminalState['status']): TerminalState {
    return {
        isBusy: false,
        isAwaitingConfirmation: false,
        hasExited: false,
        completedWhileAway: false,
        status,
    };
}

describe('groupCountsFor', () => {
    it('counts member statuses straight from the terminal store', () => {
        const sessions = [session('a'), session('b'), session('c'), session('d'), session('e')];
        const terminals = {
            a: terminal('needs-attention'),
            b: terminal('working'),
            c: terminal('ready'),
            d: terminal('exited'),
            // 'e' has no terminal yet: only the total sees it.
        };

        expect(groupCountsFor(sessions, terminals)).toEqual({
            total: 5,
            needsAttention: 1,
            working: 1,
            exited: 1,
        });
    });
});

describe('formatGroupBadge', () => {
    it('leads with the attention count when someone needs you', () => {
        expect(formatGroupBadge({ total: 7, needsAttention: 2, working: 3, exited: 0 })).toBe(
            '◐2 · 7'
        );
    });

    it('names the exited members, which nothing else would surface', () => {
        expect(formatGroupBadge({ total: 7, needsAttention: 0, working: 3, exited: 1 })).toBe(
            '✕1 · 7'
        );
    });

    it('shows both, attention first', () => {
        expect(formatGroupBadge({ total: 7, needsAttention: 2, working: 3, exited: 1 })).toBe(
            '◐2 · ✕1 · 7'
        );
    });

    it('shows the plain total otherwise', () => {
        expect(formatGroupBadge({ total: 7, needsAttention: 0, working: 3, exited: 0 })).toBe('7');
    });
});
