import { describe, expect, it, vi } from 'vitest';
import { fanOut, type FanOutDeps } from './fanOut';
import type { Group, Session, Workspace } from '../shared/workspace';

const workspace = {
    id: 'ws-1',
    name: 'fleet',
    defaultHarnessId: 'work',
    scopes: [],
    groups: [],
    sessions: [],
} as unknown as Workspace;

const group = { id: 'group-1', name: 'bump lodash', createdAt: 1 } as Group;

const intent = {
    workspaceId: 'ws-1',
    scopeId: 'scope-1',
    targetPaths: ['/repos/forum-admin', '/repos/catalog-portal', '/repos/flextools'],
    prompt: 'Bump lodash to v5.',
    groupName: 'bump lodash',
};

function buildDeps(launchSession: FanOutDeps['launcher']['launchSession']) {
    return {
        workspaces: {
            getAll: vi.fn(() => [workspace]),
            createGroup: vi.fn(() => group),
            createLabel: vi.fn(() => ({ id: 'group-1', name: 'bump lodash' })),
        },
        launcher: { launchSession },
    };
}

describe('fanOut labels', () => {
    it('labels every sibling with one shared label and parents none', async () => {
        const launchSession = vi.fn((_w: string, fields: { name: string; labelIds?: string[] }) =>
            Promise.resolve({ id: `s-${fields.name}` } as Session)
        );
        const deps = buildDeps(launchSession);

        await fanOut(deps, intent);

        expect(deps.workspaces.createLabel).toHaveBeenCalledWith('ws-1', {
            id: 'group-1', // the group's id, as the migration would have made it
            name: 'bump lodash',
        });
        expect(launchSession).toHaveBeenCalledTimes(3);
        for (const [, fields] of launchSession.mock.calls) {
            expect(fields.labelIds).toEqual(['group-1']);
            expect(fields).not.toHaveProperty('parentSessionId');
        }
    });

    it('a target that fails to launch leaves the earlier sessions labelled', async () => {
        const launchSession = vi
            .fn()
            .mockImplementationOnce((_w: string, f: { name: string }) =>
                Promise.resolve({ id: `s-${f.name}`, labelIds: ['group-1'] } as Session)
            )
            .mockRejectedValueOnce(new Error('no such folder'))
            .mockImplementationOnce((_w: string, f: { name: string }) =>
                Promise.resolve({ id: `s-${f.name}`, labelIds: ['group-1'] } as Session)
            );

        const result = await fanOut(buildDeps(launchSession), intent);

        expect(result.failed).toHaveLength(1);
        expect(result.created.map((s) => s.labelIds)).toEqual([['group-1'], ['group-1']]);
        expect(launchSession.mock.calls[0][1].labelIds).toEqual(['group-1']);
    });
});

describe('fanOut', () => {
    it('creates the group first, then one session per target inside it', async () => {
        const launchSession = vi.fn((_workspaceId: string, fields: { name: string }) =>
            Promise.resolve({ id: `session-${fields.name}` } as Session)
        );
        const deps = buildDeps(launchSession);

        const result = await fanOut(deps, intent);

        // Group before sessions: a launch that lands has a group to land in.
        expect(deps.workspaces.createGroup.mock.invocationCallOrder[0]).toBeLessThan(
            launchSession.mock.invocationCallOrder[0]
        );
        expect(deps.workspaces.createGroup).toHaveBeenCalledWith('ws-1', { name: 'bump lodash' });
        expect(launchSession).toHaveBeenCalledTimes(3);
        expect(launchSession).toHaveBeenNthCalledWith(
            1,
            'ws-1',
            expect.objectContaining({
                name: 'forum-admin', // the target's basename
                workspaceId: 'ws-1',
                harnessId: 'work', // the workspace default
                scopeId: 'scope-1',
                cwd: '/repos/forum-admin',
                groupId: 'group-1',
                kind: 'interactive',
                initialPrompt: 'Bump lodash to v5.',
            })
        );
        expect(result.group).toBe(group);
        expect(result.created).toHaveLength(3);
        expect(result.failed).toEqual([]);
    });

    it('keeps earlier sessions and reports the target that failed', async () => {
        const launchSession = vi
            .fn()
            .mockResolvedValueOnce({ id: 's1' })
            .mockRejectedValueOnce(new Error('spawn failed'))
            .mockResolvedValueOnce({ id: 's3' });
        const deps = buildDeps(launchSession);

        const result = await fanOut(deps, intent);

        expect(result.created.map((session: Session) => session.id)).toEqual(['s1', 's3']);
        expect(result.failed).toEqual([{ path: '/repos/catalog-portal', error: 'spawn failed' }]);
    });

    it('mints a distinct instance id per session', async () => {
        const launchSession = vi.fn((_workspaceId: string, _fields: { instanceId: string }) =>
            Promise.resolve({ id: 's' } as Session)
        );
        const deps = buildDeps(launchSession);

        await fanOut(deps, intent);

        const ids = launchSession.mock.calls.map(
            (call) => (call[1] as { instanceId: string }).instanceId
        );
        expect(new Set(ids).size).toBe(3);
        for (const id of ids) {
            expect(id).toMatch(/^workspace-ws-1-session-/);
        }
    });
});
