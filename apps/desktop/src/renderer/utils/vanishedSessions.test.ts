import { describe, expect, it } from 'vitest';
import type { Session, Workspace } from '../../shared/workspace';
import { vanishedSessions } from './vanishedSessions';

const session = (id: string) => ({ id, instanceId: `i-${id}` }) as Session;
const workspace = (id: string, ...sessions: Session[]) => ({ id, sessions }) as Workspace;

describe('vanishedSessions', () => {
    it('lists sessions that disappeared, across workspaces', () => {
        const before = [workspace('a', session('1'), session('2')), workspace('b', session('3'))];
        const after = [workspace('a', session('2')), workspace('b')];
        expect(vanishedSessions(before, after).map((s) => s.id)).toEqual(['1', '3']);
    });

    it('counts a deleted workspace’s sessions as vanished', () => {
        expect(vanishedSessions([workspace('a', session('1'))], []).map((s) => s.id)).toEqual(['1']);
    });

    it('ignores additions and sessions that merely moved', () => {
        const before = [workspace('a', session('1'))];
        const after = [workspace('a'), workspace('b', session('1'), session('9'))];
        expect(vanishedSessions(before, after)).toEqual([]);
    });
});
