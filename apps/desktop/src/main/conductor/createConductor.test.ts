import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Group } from '../../shared/workspace';
import { createConductor, type CreateConductorDeps } from './createConductor';
import { makeSession, makeWorkspace } from './ConductorControlServer.test';

const request = {
    workspaceId: 'ws-1',
    scopeId: 'scope-1',
    name: 'symbalance-api',
    kickoff: 'Deliver the API.',
};

let calls: string[];
let deps: CreateConductorDeps;
const group = (): Group => ({ id: 'grp-new', name: 'symbalance-api', createdAt: 1 });

beforeEach(() => {
    calls = [];
    deps = {
        getWorkspace: vi.fn(() => makeWorkspace()),
        scaffold: vi.fn(async () => {
            calls.push('scaffold');
            return '/repos/app/conductor/symbalance-api';
        }),
        createGroup: vi.fn(() => {
            calls.push('createGroup');
            return group();
        }),
        updateGroup: vi.fn(() => {
            calls.push('updateGroup');
        }),
        launchSession: vi.fn(async () => {
            calls.push('launchSession');
            return makeSession({ id: 'cond-new', groupId: 'grp-new' });
        }),
    };
});

describe('createConductor', () => {
    it('runs scaffold -> group -> launch -> bind, in that order', async () => {
        const result = await createConductor(deps, request);

        expect(calls).toEqual(['scaffold', 'createGroup', 'launchSession', 'updateGroup']);
        expect(deps.scaffold).toHaveBeenCalledWith(
            '/repos/app',            // the host scope's path
            'symbalance-api',
            'Deliver the API.',
            'Sympower'
        );
        expect(deps.launchSession).toHaveBeenCalledWith(
            'ws-1',
            expect.objectContaining({
                name: 'conductor',
                scopeId: 'scope-1',
                cwd: '/repos/app/conductor/symbalance-api',
                kind: 'conductor',
                groupId: 'grp-new',
                initialPrompt: 'Deliver the API.',
            })
        );
        expect(deps.updateGroup).toHaveBeenCalledWith('ws-1', 'grp-new', {
            conductorSessionId: 'cond-new',
        });
        expect(result.conductorSessionId).toBe('cond-new');
    });

    it('a scaffold collision fails fast: no group, no session', async () => {
        deps.scaffold = vi.fn(async () => {
            throw new Error('Conductor directory already exists: /repos/app/conductor/symbalance-api');
        });

        await expect(createConductor(deps, request)).rejects.toThrow(/already exists/);
        expect(deps.createGroup).not.toHaveBeenCalled();
        expect(deps.launchSession).not.toHaveBeenCalled();
    });

    it('a launch failure archives the group and names the surviving directory', async () => {
        deps.launchSession = vi.fn(async () => {
            throw new Error('spawn failed');
        });

        await expect(createConductor(deps, request)).rejects.toThrow(
            /spawn failed[\s\S]*\/repos\/app\/conductor\/symbalance-api/
        );
        expect(deps.updateGroup).toHaveBeenCalledWith(
            'ws-1',
            'grp-new',
            expect.objectContaining({ archivedAt: expect.any(Number) })
        );
    });

    it('rejects an unknown workspace or scope before touching the disk', async () => {
        deps.getWorkspace = vi.fn(() => undefined);
        await expect(createConductor(deps, request)).rejects.toThrow(/Workspace not found/);

        deps.getWorkspace = vi.fn(() => makeWorkspace());
        await expect(
            createConductor(deps, { ...request, scopeId: 'nope' })
        ).rejects.toThrow(/Scope not found/);
        expect(deps.scaffold).not.toHaveBeenCalled();
    });
});
