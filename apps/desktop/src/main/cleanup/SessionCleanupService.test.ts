import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalStatus } from '../../shared/terminalStatus';
import type { Session, Workspace } from '../../shared/workspace';
import type { GitProviderDriver } from '../providers/GitProviderDriver';
import type { PullRequestQuery, PullRequestState } from '../providers/pullRequests';
import { SessionRemover } from '../SessionRemover';
import { WorktreeService } from '../WorktreeService';
import type { ToolScope } from '../tools/Tool';
import { SessionCleanupService } from './SessionCleanupService';

/**
 * Real git for everything on disk — the destructive half is the half worth
 * testing for real — with the provider, terminal status and session store
 * faked around it.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const created: string[] = [];
afterAll(() => {
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
};

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV }).trim();
}

function commit(cwd: string, file: string): string {
    fs.writeFileSync(path.join(cwd, file), file);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-q', '-m', file);
    return git(cwd, 'rev-parse', 'HEAD');
}

const ALL: ToolScope = { workspaceIds: 'all', excludeSessionIds: [] };

class Rig {
    readonly base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-cleanup-')));
    readonly origin = path.join(this.base, 'origin.git');
    readonly clone = path.join(this.base, 'app');
    readonly root = path.join(this.base, 'worktrees');
    readonly worktrees = new WorktreeService(this.root);
    readonly statuses = new Map<string, TerminalStatus>();
    /** PRs by query key: `#<n>` or `head:<branch>`. */
    readonly prs = new Map<string, PullRequestState[]>();
    readonly stopped: string[] = [];
    lookupError: Error | null = null;
    workspaces: Workspace[];
    private sequence = 0;

    constructor() {
        created.push(this.base);
        fs.mkdirSync(this.root);
        execFileSync('git', ['init', '-q', '--bare', '-b', 'main', this.origin]);
        execFileSync('git', ['init', '-q', '-b', 'main', this.clone]);
        git(this.clone, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');
        // Pushes go to the local bare repo; the origin URL above is what the
        // provider maps to a repository.
        git(this.clone, 'config', 'remote.origin.pushurl', this.origin);
        git(this.clone, 'config', 'remote.origin.url', this.origin);
        commit(this.clone, 'README');
        git(this.clone, 'push', '-q', 'origin', 'main');
        this.workspaces = [this.workspace('ws-1', 'Acme')];
    }

    workspace(id: string, name: string): Workspace {
        return {
            id,
            name,
            defaultHarnessId: 'claude',
            scopes: [{ id: `${id}-scope`, name: 'app', path: this.clone, isGitRepo: true, createdAt: 0 }],
            groups: [],
            provider: { id: 'github', accountLogin: 'me' },
            actions: [],
            sectionDefaults: {},
            sessions: [],
            createdAt: 0,
            updatedAt: 0,
        };
    }

    /** A Consola worktree on `branch`, pushed, with one commit. */
    worktree(branch: string, { push = true } = {}): { dir: string; head: string } {
        const dir = path.join(this.root, `app-session-${++this.sequence}`);
        git(this.clone, 'worktree', 'add', '-q', '-b', branch, dir);
        const head = commit(dir, `${branch.replace(/\W/g, '-')}.txt`);
        if (push) git(dir, 'push', '-q', '-u', 'origin', branch);
        return { dir, head };
    }

    session(fields: Partial<Session> & { name: string }, workspaceId = 'ws-1'): Session {
        const id = `s-${++this.sequence}`;
        const session: Session = {
            id,
            workspaceId,
            instanceId: `i-${id}`,
            claudeSessionId: id,
            hasStarted: true,
            harnessId: 'claude',
            scopeId: `${workspaceId}-scope`,
            kind: 'interactive',
            createdAt: 0,
            lastActiveAt: 0,
            ...fields,
        };
        this.workspaces.find((workspace) => workspace.id === workspaceId)!.sessions.push(session);
        return session;
    }

    pr(key: string, number: number, status: PullRequestState['status'], headOid: string): void {
        this.prs.set(key, [
            { number, status, headOid, headBranch: key, url: `https://github.com/acme/app/pull/${number}`, createdAt: '2026-10-01T00:00:00Z' },
        ]);
    }

    sessionIds(): string[] {
        return this.workspaces.flatMap((workspace) => workspace.sessions.map((session) => session.id));
    }

    service(): SessionCleanupService {
        const driver = {
            repoOfRemote: () => 'acme/app',
            lookupPullRequests: async (queries: PullRequestQuery[]) => {
                if (this.lookupError) throw this.lookupError;
                return queries.map((query) => ({
                    query,
                    pullRequests:
                        this.prs.get('number' in query ? `#${query.number}` : `head:${query.headBranch}`) ?? [],
                }));
            },
        } as unknown as GitProviderDriver;
        const remover = new SessionRemover({
            deleteRecord: (workspaceId, sessionId) => {
                const workspace = this.workspaces.find((candidate) => candidate.id === workspaceId)!;
                workspace.sessions = workspace.sessions.filter((session) => session.id !== sessionId);
            },
            destroyTerminal: (instanceId) => this.stopped.push(instanceId),
            destroyShell: () => {},
            releaseMcp: () => {},
        });
        return new SessionCleanupService({
            getWorkspaces: () => this.workspaces,
            status: (instanceId) => this.statuses.get(instanceId) ?? 'exited',
            driverFor: (workspace) => (workspace.provider ? driver : null),
            composeEnv: async () => process.env,
            worktrees: this.worktrees,
            remover,
        });
    }
}

let rig: Rig;
beforeEach(() => {
    rig = new Rig();
});

describe('cleanupStale', () => {
    it('removes a session whose branch PR merged, with its worktree and branch', async () => {
        const { dir, head } = rig.worktree('consola/session-aaaa');
        const session = rig.session({ name: 'Ship it', cwd: dir });
        rig.pr('head:consola/session-aaaa', 12, 'merged', head);

        const result = await rig.service().cleanupStale(ALL, { prStates: ['merged', 'closed'] });

        expect(result.removed).toEqual([
            expect.objectContaining({ sessionId: session.id, worktree: 'removed', branch: 'deleted' }),
        ]);
        expect(result.summary).toBe('Removed 1 session.');
        expect(rig.sessionIds()).toEqual([]);
        // Stopped before the worktree went, and again (a no-op) with the record.
        expect(new Set(rig.stopped)).toEqual(new Set([session.instanceId]));
        expect(fs.existsSync(dir)).toBe(false);
        expect(git(rig.clone, 'branch', '--list', 'consola/session-aaaa')).toBe('');
    });

    it('removes a PR-linked session whose PR was closed, squash-style head included', async () => {
        const { dir, head } = rig.worktree('feature-x');
        const session = rig.session({
            name: 'Review #51',
            cwd: dir,
            workItem: { provider: 'github', repo: 'acme/app', type: 'pr', number: 51 },
        });
        rig.pr('#51', 51, 'closed', head);

        const result = await rig.service().cleanupStale(ALL, { prStates: ['closed'] });
        expect(result.removed.map((outcome) => outcome.sessionId)).toEqual([session.id]);
        expect(fs.existsSync(dir)).toBe(false);
    });

    it('keeps everything it cannot prove safe, and says why', async () => {
        const dirty = rig.worktree('dirty');
        fs.writeFileSync(path.join(dirty.dir, 'wip.txt'), 'unsaved');
        rig.pr('head:dirty', 1, 'merged', dirty.head);

        const ahead = rig.worktree('ahead');
        commit(ahead.dir, 'after-merge.txt');
        rig.pr('head:ahead', 2, 'merged', ahead.head);

        const open = rig.worktree('open');
        rig.pr('head:open', 3, 'open', open.head);

        const closed = rig.worktree('closed');
        rig.pr('head:closed', 4, 'closed', closed.head);

        const busy = rig.worktree('busy');
        rig.pr('head:busy', 5, 'merged', busy.head);

        const conductor = rig.worktree('conductor');
        rig.pr('head:conductor', 6, 'merged', conductor.head);

        const caller = rig.worktree('caller');
        rig.pr('head:caller', 7, 'merged', caller.head);

        rig.pr('#8', 8, 'merged', 'c'.repeat(40));
        const sessions = {
            dirty: rig.session({ name: 'dirty', cwd: dirty.dir }),
            ahead: rig.session({ name: 'ahead', cwd: ahead.dir }),
            open: rig.session({ name: 'open', cwd: open.dir }),
            closed: rig.session({ name: 'closed', cwd: closed.dir }),
            busy: rig.session({ name: 'busy', cwd: busy.dir }),
            conductor: rig.session({ name: 'conductor', cwd: conductor.dir, kind: 'conductor' }),
            caller: rig.session({ name: 'caller', cwd: caller.dir }),
            // Linked to a merged PR, but runs in the scope folder itself.
            scope: rig.session({ name: 'scope', workItem: { provider: 'github', repo: 'acme/app', type: 'pr', number: 8 } }),
            // Not linked, not in a Consola worktree: not a candidate at all.
            plain: rig.session({ name: 'plain', cwd: rig.clone }),
        };
        rig.statuses.set(sessions.busy.instanceId, 'working');
        const before = rig.sessionIds();

        const result = await rig.service().cleanupStale(
            { workspaceIds: 'all', excludeSessionIds: [sessions.caller.id] },
            { prStates: ['merged'] }
        );

        const reasons = Object.fromEntries(result.skipped.map((verdict) => [verdict.sessionName, verdict.reason]));
        expect(reasons).toEqual({
            dirty: 'dirty',
            ahead: 'local-commits',
            open: 'pr-open',
            closed: 'pr-state-excluded',
            busy: 'busy',
            conductor: 'conductor',
            caller: 'caller',
            scope: 'not-managed-worktree',
        });
        expect(result.removed).toEqual([]);
        expect(rig.sessionIds()).toEqual(before);
        expect(rig.stopped).toEqual([]);
        for (const tree of [dirty, ahead, open, closed, busy, conductor, caller]) {
            expect(fs.existsSync(tree.dir)).toBe(true);
        }
        expect(fs.existsSync(path.join(dirty.dir, 'wip.txt'))).toBe(true);
    });

    it('keeps a worktree another remaining session still uses, removing only the record', async () => {
        const { dir, head } = rig.worktree('shared', { push: true });
        const review = rig.session({
            name: 'Review',
            cwd: dir,
            workItem: { provider: 'github', repo: 'acme/app', type: 'pr', number: 9 },
        });
        const fixer = rig.session({
            name: 'Fix CI',
            cwd: dir,
            workItem: { provider: 'github', repo: 'acme/app', type: 'pr', number: 9 },
        });
        rig.statuses.set(fixer.instanceId, 'needs-attention');
        rig.pr('#9', 9, 'merged', head);

        const result = await rig.service().cleanupStale(ALL, { prStates: ['merged'] });

        expect(result.removed).toEqual([
            expect.objectContaining({ sessionId: review.id, worktree: 'kept', branch: 'none' }),
        ]);
        expect(result.removed[0].notes[0]).toMatch(/"Fix CI" still uses it/);
        expect(rig.sessionIds()).toEqual([fixer.id]);
        expect(fs.existsSync(dir)).toBe(true);
    });

    it('removes one shared worktree once when every session on it goes', async () => {
        const { dir, head } = rig.worktree('pair');
        const ref = { provider: 'github' as const, repo: 'acme/app', type: 'pr' as const, number: 10 };
        rig.session({ name: 'A', cwd: dir, workItem: ref });
        rig.session({ name: 'B', cwd: dir, workItem: ref });
        rig.pr('#10', 10, 'merged', head);

        const result = await rig.service().cleanupStale(ALL, { prStates: ['merged'] });
        expect(result.removed.map((outcome) => outcome.worktree)).toEqual(['removed', 'removed']);
        expect(result.failed).toEqual([]);
        expect(fs.existsSync(dir)).toBe(false);
    });

    it('removes just the record when a linked session’s worktree is already gone', async () => {
        const session = rig.session({
            name: 'Gone',
            cwd: path.join(rig.root, 'app-pr-77'),
            workItem: { provider: 'github', repo: 'acme/app', type: 'pr', number: 77 },
        });
        rig.pr('#77', 77, 'merged', 'd'.repeat(40));
        const result = await rig.service().cleanupStale(ALL, { prStates: ['merged'] });
        expect(result.removed).toEqual([
            expect.objectContaining({ sessionId: session.id, worktree: 'none', notes: ['Its worktree is already gone.'] }),
        ]);
    });

    it('fails closed when the provider cannot answer', async () => {
        const { dir, head } = rig.worktree('feature');
        rig.session({ name: 'S', cwd: dir });
        rig.pr('head:feature', 1, 'merged', head);
        rig.lookupError = new Error('gh: HTTP 502');

        const result = await rig.service().cleanupStale(ALL, { prStates: ['merged'] });
        expect(result.skipped).toEqual([
            expect.objectContaining({ reason: 'lookup-failed', detail: 'gh: HTTP 502' }),
        ]);
        expect(fs.existsSync(dir)).toBe(true);
    });

    it('honours the workspace scope and an explicit session list', async () => {
        rig.workspaces.push(rig.workspace('ws-2', 'Other'));
        const mine = rig.worktree('mine');
        const theirs = rig.worktree('theirs');
        const kept = rig.session({ name: 'mine', cwd: mine.dir });
        const other = rig.session({ name: 'theirs', cwd: theirs.dir }, 'ws-2');
        rig.pr('head:mine', 1, 'merged', mine.head);
        rig.pr('head:theirs', 2, 'merged', theirs.head);

        const preview = await rig.service().previewStale(
            { workspaceIds: ['ws-1'], excludeSessionIds: [] },
            { prStates: ['merged'], sessionIds: [kept.id, other.id, 'nope'] }
        );
        expect(preview.candidates.map((verdict) => verdict.sessionId)).toEqual([kept.id]);
        // Out of scope reads exactly like nonexistent: nothing to learn about other workspaces.
        expect(preview.unknownSessionIds).toEqual([other.id, 'nope']);
    });

    it('never removes a worktree someone added as a workspace folder', async () => {
        const { dir, head } = rig.worktree('feature');
        rig.workspaces[0].scopes.push({ id: 'wt-scope', name: 'feature checkout', path: dir, isGitRepo: true, createdAt: 0 });
        const session = rig.session({ name: 'S', cwd: dir });
        rig.pr('head:feature', 1, 'merged', head);

        const result = await rig.service().cleanupStale(ALL, { prStates: ['merged'] });
        expect(result.skipped).toEqual([
            expect.objectContaining({
                sessionId: session.id,
                reason: 'not-managed-worktree',
                detail: expect.stringMatching(/holds the workspace folder "feature checkout"/),
            }),
        ]);
        expect(fs.existsSync(dir)).toBe(true);
    });

    it('acts only on the sessions named, re-checking each — what approving a preview runs', async () => {
        const first = rig.worktree('first');
        const later = rig.worktree('later');
        const approved = rig.session({ name: 'Previewed', cwd: first.dir });
        rig.session({ name: 'Merged after the preview', cwd: later.dir });
        rig.pr('head:first', 1, 'merged', first.head);
        rig.pr('head:later', 2, 'merged', later.head);

        const result = await rig.service().cleanupStale(ALL, { prStates: ['merged'], sessionIds: [approved.id] });
        expect(result.removed.map((outcome) => outcome.sessionId)).toEqual([approved.id]);
        expect(fs.existsSync(later.dir)).toBe(true);
    });
});

describe('previewStale', () => {
    it('reports what would happen and changes nothing', async () => {
        const { dir, head } = rig.worktree('consola/session-bbbb');
        const session = rig.session({ name: 'Preview me', cwd: dir });
        rig.pr('head:consola/session-bbbb', 3, 'merged', head);

        const preview = await rig.service().previewStale(ALL, { prStates: ['merged'] });

        expect(preview.candidates).toEqual([
            expect.objectContaining({
                sessionId: session.id,
                pullRequest: expect.objectContaining({ number: 3, status: 'merged' }),
                worktree: { path: dir, remove: true },
                branch: 'consola/session-bbbb',
            }),
        ]);
        expect(preview.summary).toBe('Would remove 1 session.');
        expect(rig.sessionIds()).toEqual([session.id]);
        expect(fs.existsSync(dir)).toBe(true);
    });
});

describe('deleteSession', () => {
    it('deletes the session with its worktree and branch when its commits are pushed', async () => {
        const { dir } = rig.worktree('feature');
        const session = rig.session({ name: 'Done', cwd: dir });
        const outcome = await rig.service().deleteSession(ALL, session.id);
        expect(outcome).toMatchObject({ worktree: 'removed', branch: 'deleted' });
        expect(rig.sessionIds()).toEqual([]);
        expect(fs.existsSync(dir)).toBe(false);
    });

    it('deletes the record but keeps a worktree holding local-only commits', async () => {
        const { dir } = rig.worktree('unpushed', { push: false });
        const session = rig.session({ name: 'Draft', cwd: dir });
        const outcome = await rig.service().deleteSession(ALL, session.id);
        expect(outcome).toMatchObject({ worktree: 'kept', branch: 'none' });
        expect(outcome.notes[0]).toMatch(/only locally/);
        expect(rig.sessionIds()).toEqual([]);
        expect(fs.existsSync(dir)).toBe(true);
    });

    it('previews the delete — worktree and branch included — changing nothing', async () => {
        const { dir } = rig.worktree('previewed');
        const session = rig.session({ name: 'Done', cwd: dir });
        const preview = await rig.service().previewDelete(ALL, session.id);
        expect(preview).toMatchObject({
            summary: 'Would delete "Done" and its worktree.',
            candidates: [{ sessionId: session.id, worktree: { remove: true }, branch: 'previewed' }],
            skipped: [],
        });
        expect(rig.sessionIds()).toEqual([session.id]);
        expect(fs.existsSync(dir)).toBe(true);
    });

    it('never touches a scope folder', async () => {
        const session = rig.session({ name: 'Here', cwd: rig.clone });
        const outcome = await rig.service().deleteSession(ALL, session.id);
        expect(outcome.worktree).toBe('none');
        expect(fs.existsSync(path.join(rig.clone, 'README'))).toBe(true);
    });

    it('refuses itself, conductors, busy sessions and sessions out of scope', async () => {
        const self = rig.session({ name: 'self' });
        const conductor = rig.session({ name: 'c', kind: 'conductor' });
        const busy = rig.session({ name: 'b' });
        rig.statuses.set(busy.instanceId, 'working');
        const service = rig.service();
        const scope = { workspaceIds: ['ws-1'], excludeSessionIds: [self.id] };

        await expect(service.deleteSession(scope, self.id)).rejects.toThrow(/itself/);
        // A preview refuses what the delete would, so no one is asked to approve it.
        await expect(service.previewDelete(scope, conductor.id)).rejects.toThrow(/Conductors/);
        await expect(service.deleteSession(scope, conductor.id)).rejects.toThrow(/Conductors/);
        await expect(service.deleteSession(scope, busy.id)).rejects.toThrow(/working/);
        await expect(
            service.deleteSession({ workspaceIds: ['ws-9'], excludeSessionIds: [] }, busy.id)
        ).rejects.toThrow(/No session/);
        expect(rig.sessionIds()).toHaveLength(3);
    });
});
