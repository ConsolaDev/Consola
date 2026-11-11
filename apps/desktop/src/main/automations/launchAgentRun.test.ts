import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Session, Workspace } from '../../shared/workspace';
import type { GitProviderDriver } from '../providers/GitProviderDriver';
import { launchAgentRun, prepareItemWorktree, refreshIdleWorktree, StartedByHandError, withoutGitHooks, type AgentLaunchDeps } from './launchAgentRun';

let root: string;
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-agent-launch-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const workItem = { provider: 'github' as const, repo: 'acme/api', type: 'pr' as const, number: 123 };

function workspace(): Workspace {
    return {
        id: 'ws-1',
        name: 'Acme',
        defaultHarnessId: 'work',
        provider: { id: 'github', accountLogin: 'me' },
        scopes: [
            { id: 'scope-code', name: 'code', path: '/code', isGitRepo: false, createdAt: 0 },
            { id: 'scope-api', name: 'api', path: '/code/api', isGitRepo: true, createdAt: 0 },
        ],
        groups: [{ id: 'g-reviews', name: 'Reviews', createdAt: 0, archivedAt: 5 }],
        actions: [],
        sectionDefaults: {},
        sessions: [],
        createdAt: 0,
        updatedAt: 0,
    } as Workspace;
}

function deps(overrides: Partial<AgentLaunchDeps> = {}) {
    const launchSession = vi.fn(async (_id: string, fields: { name: string }) => ({ id: 's-1', name: fields.name }) as Session);
    const worktree = path.join(root, 'api-pr-123');
    return {
        getWorkspace: () => workspace(),
        resolveDriver: () => ({}) as GitProviderDriver,
        resolveRepo: () => '/code/api',
        worktreePathFor: () => worktree,
        ensureWorktree: vi.fn(async () => {
            fs.mkdirSync(path.join(worktree, '.git'), { recursive: true });
            return worktree;
        }),
        refreshWorktree: vi.fn(async () => true),
        worktreeInUse: vi.fn(() => false),
        composeEnv: async () => ({ GH_TOKEN: 'token' }),
        restoreGroup: vi.fn(),
        ...overrides,
        // Last, and never overridden: the tests read its calls.
        launchSession,
    };
}

const itemRun = {
    workspaceId: 'ws-1',
    run: { id: 'run-1', automation: 'review-requests' },
    prompt: 'Review it.',
    item: { workItem, title: 'Add retries', label: 'Review', groupId: 'g-reviews' },
};

describe('launchAgentRun', () => {
    it('starts a read-only session in the item’s worktree, named and grouped like an Inbox launch', async () => {
        const d = deps();
        await launchAgentRun(d, itemRun);
        expect(d.launchSession).toHaveBeenCalledWith('ws-1', {
            name: 'Add retries',
            workspaceId: 'ws-1',
            instanceId: expect.stringMatching(/^workspace-ws-1-session-/),
            harnessId: 'work',
            kind: 'interactive',
            scopeId: 'scope-api',
            cwd: path.join(root, 'api-pr-123'),
            workItem,
            workItemAction: 'Review',
            groupId: 'g-reviews',
            toolPolicy: 'read-only',
            automation: { name: 'review-requests', runId: 'run-1' },
            initialPrompt: 'Review it.',
            // Its first turn runs with nobody watching, so it has no composer to type into.
            unattended: true,
        });
        // An archived target group is restored so its arrival is visible.
        expect(d.restoreGroup).toHaveBeenCalledWith('ws-1', 'g-reviews');
        // Just made: nothing to bring up to date.
        expect(d.refreshWorktree).not.toHaveBeenCalled();
    });

    it('brings an existing worktree up to the PR’s head, unless someone is working in it', async () => {
        fs.mkdirSync(path.join(root, 'api-pr-123', '.git'), { recursive: true });
        const free = deps();
        await launchAgentRun(free, itemRun);
        expect(free.refreshWorktree).toHaveBeenCalledWith(
            path.join(root, 'api-pr-123'),
            workItem,
            expect.objectContaining({ GH_TOKEN: 'token' })
        );

        const busy = deps({ worktreeInUse: () => true });
        await launchAgentRun(busy, itemRun);
        expect(busy.refreshWorktree).not.toHaveBeenCalled();
    });

    it('checks the item out with git hooks turned off', async () => {
        const d = deps({ composeEnv: async () => ({ GH_TOKEN: 'token', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' }) });
        fs.mkdirSync(path.join(root, 'api-pr-123', '.git'), { recursive: true });
        await launchAgentRun(d, itemRun);
        const hooksOff = expect.objectContaining({
            GH_TOKEN: 'token',
            GIT_CONFIG_COUNT: '2',
            GIT_CONFIG_KEY_0: 'a.b',
            GIT_CONFIG_KEY_1: 'core.hooksPath',
            GIT_CONFIG_VALUE_1: '/dev/null',
        });
        expect(d.ensureWorktree).toHaveBeenCalledWith('/code/api', workItem, hooksOff);
        expect(d.refreshWorktree).toHaveBeenCalledWith(path.join(root, 'api-pr-123'), workItem, hooksOff);
    });

    it('says to clone a repo it cannot find, and creates nothing', async () => {
        const d = deps({ resolveRepo: () => null });
        await expect(launchAgentRun(d, itemRun)).rejects.toThrow(
            'Clone acme/api into one of this workspace’s scopes to review its pull requests automatically.'
        );
        expect(d.ensureWorktree).not.toHaveBeenCalled();
        expect(d.launchSession).not.toHaveBeenCalled();
    });

    it('refuses with StartedByHandError when a person\'s session appeared since', async () => {
        const ws = workspace();
        ws.sessions = [
            // The automation's own earlier session is not one started by hand.
            { id: 'auto', name: 'Add retries', automation: { name: 'review-requests', runId: 'run-0' }, workItem, workItemAction: 'Review', createdAt: 2_000 },
            { id: 'old', name: 'Mine, before', workItem, workItemAction: 'Review', createdAt: 500 },
        ] as unknown as Session[];
        const d = deps({ getWorkspace: () => ws });
        const since = new Date(1_000).toISOString();
        const request = { ...itemRun, item: { ...itemRun.item, startedByHandSince: since } };
        await launchAgentRun(d, request);
        expect(d.launchSession).toHaveBeenCalledTimes(1);

        ws.sessions.push({ id: 'mine', name: 'My review', workItem, workItemAction: 'Review', createdAt: 3_000 } as unknown as Session);
        const refused = launchAgentRun(d, request);
        await expect(refused).rejects.toBeInstanceOf(StartedByHandError);
        await expect(refused).rejects.toMatchObject({ sessionName: 'My review' });
        expect(d.launchSession).toHaveBeenCalledTimes(1);
    });

    it('starts a scheduled run in its scope, with no item', async () => {
        const d = deps();
        await launchAgentRun(d, { workspaceId: 'ws-1', run: { id: 'run-2', automation: 'morning' }, prompt: 'Sum up.', scopeId: 'scope-api' });
        expect(d.launchSession).toHaveBeenCalledWith('ws-1', expect.objectContaining({ name: 'morning', scopeId: 'scope-api', toolPolicy: 'read-only', unattended: true }));
        expect(d.launchSession.mock.calls[0][1]).not.toHaveProperty('cwd');
        expect(d.ensureWorktree).not.toHaveBeenCalled();
    });
});

describe('prepareItemWorktree', () => {
    it('prepares an item worktree with hooks off and names the scope that holds the clone', async () => {
        const d = deps();
        const { cwd, scopeId } = await prepareItemWorktree(d, workspace(), workItem, { refreshExisting: true });
        expect(cwd).toBe(path.join(root, 'api-pr-123'));
        expect(d.ensureWorktree).toHaveBeenCalledWith('/code/api', workItem, expect.objectContaining({ GIT_CONFIG_VALUE_0: '/dev/null' }));
        expect(scopeId).toBe('scope-api');
    });

    it('says to clone a repo it cannot find, and needs a bound account', async () => {
        await expect(prepareItemWorktree(deps({ resolveRepo: () => null }), workspace(), workItem, { refreshExisting: true })).rejects.toThrow(
            'Clone acme/api into one of this workspace’s scopes first.'
        );
        const unbound = { ...workspace(), provider: undefined } as Workspace;
        await expect(prepareItemWorktree(deps(), unbound, workItem, { refreshExisting: true })).rejects.toThrow('This workspace has no provider account bound.');
    });
});

describe('refreshIdleWorktree', () => {
    const dir = () => path.join(root, 'api-pr-123');
    const session = (overrides: Partial<Session> = {}) =>
        ({ id: 'review', name: 'Review', workItem, cwd: dir(), toolPolicy: 'read-only', ...overrides }) as unknown as Session;

    it('refreshes an idle PR worktree before a re-run, and leaves a busy one alone', async () => {
        fs.mkdirSync(path.join(dir(), '.git'), { recursive: true });
        const d = deps();
        await refreshIdleWorktree(d, workspace(), session());
        expect(d.refreshWorktree).toHaveBeenCalledWith(dir(), workItem, expect.objectContaining({ GIT_CONFIG_KEY_0: 'core.hooksPath' }));
        vi.mocked(d.worktreeInUse).mockReturnValue(true);
        vi.mocked(d.refreshWorktree).mockClear();
        await refreshIdleWorktree(d, workspace(), session());
        expect(d.refreshWorktree).not.toHaveBeenCalled();
    });

    it('ignores a session that is not on its item’s Consola worktree, or not on a PR', async () => {
        fs.mkdirSync(path.join(dir(), '.git'), { recursive: true });
        const d = deps();
        await refreshIdleWorktree(d, workspace(), session({ cwd: '/code/api' }));
        await refreshIdleWorktree(d, workspace(), session({ workItem: { ...workItem, type: 'issue' } as Session['workItem'] }));
        await refreshIdleWorktree(d, workspace(), session({ workItem: undefined }));
        expect(d.refreshWorktree).not.toHaveBeenCalled();
    });

    it('does nothing when the worktree is gone', async () => {
        const d = deps();
        await refreshIdleWorktree(d, workspace(), session());
        expect(d.refreshWorktree).not.toHaveBeenCalled();
    });
});

describe('withoutGitHooks', () => {
    it('stops a hook that lives in the checked-out tree, as husky’s do', () => {
        const repo = path.join(root, 'repo');
        const run = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
            execFileSync('git', ['-C', repo, ...args], { env: { ...env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
        execFileSync('git', ['init', '-q', '-b', 'main', repo]);
        const marker = path.join(root, 'hook-ran');
        fs.mkdirSync(path.join(repo, '.husky'));
        fs.writeFileSync(path.join(repo, '.husky', 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
        run(['config', 'core.hooksPath', '.husky']);
        run(['add', '.']);
        run(['commit', '-q', '-m', 'init']);

        run(['checkout', '-q', '-b', 'quiet'], withoutGitHooks(process.env));
        expect(fs.existsSync(marker)).toBe(false);
        // The same checkout without it runs the tree's hook.
        run(['checkout', '-q', '-b', 'loud']);
        expect(fs.existsSync(marker)).toBe(true);
    });
});
