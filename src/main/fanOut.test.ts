import { describe, expect, it, vi } from 'vitest';
import { fanOut } from './fanOut';
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
    targetPaths: ['/repos/flex-portal', '/repos/controller-app', '/repos/flextools'],
    prompt: 'Bump lodash to v5.',
    groupName: 'bump lodash',
};

function buildDeps(launchSession: ReturnType<typeof vi.fn>) {
    return {
        workspaces: {
            getAll: vi.fn(() => [workspace]),
            createGroup: vi.fn(() => group),
        },
        launcher: { launchSession },
    };
}

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
                name: 'flex-portal', // the target's basename
                workspaceId: 'ws-1',
                harnessId: 'work', // the workspace default
                scopeId: 'scope-1',
                cwd: '/repos/flex-portal',
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
        expect(result.failed).toEqual([{ path: '/repos/controller-app', error: 'spawn failed' }]);
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
