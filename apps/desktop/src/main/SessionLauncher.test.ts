import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionLauncher } from './SessionLauncher';
import type { Session, Workspace } from '../shared/workspace';
import type { Harness } from '../shared/harness';

// Real folders on disk. The launcher refuses to spawn into a working folder
// that is not there, so a made-up fixture path would send every case down the
// rollback branch and none of them would prove anything.
const scopeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-launcher-'));
const targetDir = path.join(scopeDir, 'forum-admin');
fs.mkdirSync(targetDir, { recursive: true });
const missingDir = path.join(scopeDir, 'moved-away');

afterAll(() => {
    fs.rmSync(scopeDir, { recursive: true, force: true });
});

function workspaceFixture(): Workspace {
    return {
        id: 'ws-1',
        name: 'fleet',
        defaultHarnessId: 'default',
        scopes: [
            { id: 'scope-1', name: 'sprocket', path: scopeDir, isGitRepo: false, createdAt: 1 },
        ],
        groups: [],
        provider: { id: 'github', accountLogin: 'octocat' },
        actions: [],
        sectionDefaults: {},
        sessions: [],
        createdAt: 1,
        updatedAt: 1,
    } as unknown as Workspace;
}

function sessionFixture(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        name: 'forum-admin',
        workspaceId: 'ws-1',
        instanceId: 'instance-1',
        claudeSessionId: '11111111-1111-4111-8111-111111111111',
        hasStarted: false,
        harnessId: 'work',
        scopeId: 'scope-1',
        kind: 'interactive',
        createdAt: 1,
        lastActiveAt: 1,
        ...overrides,
    } as Session;
}

const harnessFixture = {
    id: 'work',
    driverId: 'claude',
    name: 'Work',
    isBuiltIn: false,
    binaryPath: '/opt/claude/bin/claude',
    configDir: '/Users/me/.claude-work',
    extraArgs: ['--verbose'],
} as unknown as Harness;

// If Phase 0's NewSessionFields requires more members than these, extend the
// literal — never cast it away.
const launchFields = {
    name: 'forum-admin',
    workspaceId: 'ws-1',
    instanceId: 'instance-1',
    harnessId: 'work',
    scopeId: 'scope-1',
    kind: 'interactive' as const,
    model: undefined,
};

type TerminalHandle = {
    hasClaudeExited: () => boolean;
    runningUnattended: () => boolean;
    queuePrompt: (prompt: string) => void;
};

function buildLauncher(session: Session) {
    const workspaces = {
        getAll: vi.fn(() => [workspaceFixture()]),
        createSession: vi.fn(() => session),
        updateSession: vi.fn(),
        deleteSession: vi.fn(),
    };
    const harnesses = { getAll: vi.fn(() => [harnessFixture]) };
    const terminals = {
        startHeadless: vi.fn(),
        has: vi.fn(() => false),
        get: vi.fn((): TerminalHandle | undefined => undefined),
        relaunch: vi.fn(),
    };
    const launcher = new SessionLauncher(workspaces, harnesses, terminals);
    return { launcher, workspaces, harnesses, terminals };
}

describe('SessionLauncher', () => {
    it('creates the record and spawns the PTY with no renderer involved', async () => {
        const session = sessionFixture();
        const { launcher, workspaces, terminals } = buildLauncher(session);

        const launched = await launcher.launchSession('ws-1', {
            ...launchFields,
            initialPrompt: 'review the PR',
        });

        // The record was created without the delivery-only field.
        expect(workspaces.createSession).toHaveBeenCalledWith(
            'ws-1',
            expect.not.objectContaining({ initialPrompt: expect.anything() })
        );
        // The PTY spawned headlessly, resolved from the record.
        expect(terminals.startHeadless).toHaveBeenCalledWith(
            'instance-1',
            expect.objectContaining({
                cwd: scopeDir, // the scope's path: the session has no cwd of its own
                claudeSessionId: '11111111-1111-4111-8111-111111111111',
                resume: false,
                initialPrompt: 'review the PR',
                driverId: 'claude',
                binaryOverride: '/opt/claude/bin/claude',
                configDirOverride: '/Users/me/.claude-work',
                extraArgs: ['--verbose'],
                providerId: 'github',
                providerAccountLogin: 'octocat',
            })
        );
        // The conversation exists now; every later attach must --resume it.
        expect(workspaces.updateSession).toHaveBeenCalledWith('ws-1', 'session-1', {
            hasStarted: true,
        });
        expect(launched.hasStarted).toBe(true);
    });

    it('prefers the session cwd over the scope path', async () => {
        const session = sessionFixture({ cwd: targetDir });
        const { launcher, terminals } = buildLauncher(session);

        await launcher.launchSession('ws-1', { ...launchFields, cwd: targetDir });

        expect(terminals.startHeadless).toHaveBeenCalledWith(
            'instance-1',
            expect.objectContaining({ cwd: targetDir })
        );
    });

    it('rolls the record back when the working folder is gone', async () => {
        // A fan-out target that has been moved or deleted since the dialog
        // listed it. The PTY would spawn and die silently; fan-out would
        // report it as launched.
        const session = sessionFixture({ cwd: missingDir });
        const { launcher, workspaces, terminals } = buildLauncher(session);

        await expect(
            launcher.launchSession('ws-1', { ...launchFields, cwd: missingDir })
        ).rejects.toThrow(`has no working folder: ${missingDir} does not exist`);
        expect(workspaces.deleteSession).toHaveBeenCalledWith('ws-1', 'session-1');
        expect(terminals.startHeadless).not.toHaveBeenCalled();
    });

    it('rolls the record back when the session has nowhere to run', async () => {
        const session = sessionFixture({ scopeId: 'gone' });
        const { launcher, workspaces, terminals } = buildLauncher(session);

        await expect(
            launcher.launchSession('ws-1', { ...launchFields, scopeId: 'gone' })
        ).rejects.toThrow(/no working folder/);
        expect(workspaces.deleteSession).toHaveBeenCalledWith('ws-1', 'session-1');
        expect(terminals.startHeadless).not.toHaveBeenCalled();
    });

    it('registers the Consola MCP endpoint for every kind of session', async () => {
        const register = vi.fn(async (session: { id: string }) => `/tmp/${session.id}.json`);

        for (const kind of ['conductor', 'interactive'] as const) {
            const { launcher, terminals } = buildLauncher(sessionFixture({ kind }));
            launcher.mcpHost = { register };
            await launcher.launchSession('ws-1', { ...launchFields, kind });
            // The tools reach the PTY as an opaque path.
            expect(terminals.startHeadless).toHaveBeenCalledWith(
                'instance-1',
                expect.objectContaining({ mcpConfigPath: '/tmp/session-1.json' })
            );
        }
        expect(register).toHaveBeenCalledTimes(2);
    });

    it('still launches an ordinary session when its MCP endpoint cannot be set up', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { launcher, terminals } = buildLauncher(sessionFixture());
        launcher.mcpHost = { register: async () => Promise.reject(new Error('EACCES')) };
        await launcher.launchSession('ws-1', launchFields);
        expect(terminals.startHeadless.mock.calls[0][1].mcpConfigPath).toBeUndefined();
    });

    it('launches with the record’s tool policy', async () => {
        const session = sessionFixture({ toolPolicy: 'read-only' });
        const { launcher, terminals } = buildLauncher(session);
        await launcher.launchSession('ws-1', { ...launchFields, toolPolicy: 'read-only' });
        expect(terminals.startHeadless.mock.calls[0][1].toolPolicy).toBe('read-only');
    });

    it('refuses a policy its harness would loosen before creating anything', async () => {
        const { launcher, workspaces, harnesses, terminals } = buildLauncher(sessionFixture({ toolPolicy: 'read-only' }));
        harnesses.getAll.mockReturnValue([{ ...harnessFixture, extraArgs: ['--dangerously-skip-permissions'] }]);
        await expect(launcher.launchSession('ws-1', { ...launchFields, toolPolicy: 'read-only' })).rejects.toThrow(
            /--dangerously-skip-permissions/
        );
        expect(workspaces.createSession).not.toHaveBeenCalled();
        expect(terminals.startHeadless).not.toHaveBeenCalled();
    });

    it('passes unattended and forkFrom to the terminal and never to the record', async () => {
        const { launcher, workspaces, terminals } = buildLauncher(sessionFixture({ toolPolicy: 'read-only' }));
        await launcher.launchSession('ws-1', {
            ...launchFields,
            toolPolicy: 'read-only',
            initialPrompt: 'Review it.',
            unattended: true,
            forkFrom: 'orig',
        });
        const recorded = (workspaces.createSession.mock.calls[0] as unknown[])[1];
        expect(recorded).not.toHaveProperty('unattended');
        expect(recorded).not.toHaveProperty('forkFrom');
        expect(recorded).not.toHaveProperty('initialPrompt');
        expect(terminals.startHeadless.mock.calls[0][1]).toMatchObject({
            resume: false,
            initialPrompt: 'Review it.',
            unattended: true,
            forkFrom: 'orig',
            toolPolicy: 'read-only',
        });
    });

    it('resumeUnattended starts the recorded session resumed and unattended', async () => {
        const session = sessionFixture({ toolPolicy: 'read-only', hasStarted: true, cwd: targetDir });
        const { launcher, workspaces, terminals } = buildLauncher(session);
        workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);
        await launcher.resumeUnattended('ws-1', 'session-1', 'Go on.');
        expect(terminals.startHeadless).toHaveBeenCalledWith(
            'instance-1',
            expect.objectContaining({
                cwd: targetDir,
                claudeSessionId: '11111111-1111-4111-8111-111111111111',
                resume: true,
                unattended: true,
                initialPrompt: 'Go on.',
                toolPolicy: 'read-only',
                driverId: 'claude',
                configDirOverride: '/Users/me/.claude-work',
            })
        );
        expect(workspaces.createSession).not.toHaveBeenCalled();
    });

    it('resumeUnattended refuses a harness that would loosen the policy', async () => {
        const session = sessionFixture({ toolPolicy: 'read-only', hasStarted: true, cwd: targetDir });
        const { launcher, workspaces, harnesses, terminals } = buildLauncher(session);
        workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);
        harnesses.getAll.mockReturnValue([{ ...harnessFixture, extraArgs: ['--dangerously-skip-permissions'] }]);
        await expect(launcher.resumeUnattended('ws-1', 'session-1', 'Go on.')).rejects.toThrow(/--dangerously-skip-permissions/);
        expect(terminals.startHeadless).not.toHaveBeenCalled();
    });

    it('resumeUnattended refuses when the session was opened while it prepared', async () => {
        const session = sessionFixture({ toolPolicy: 'read-only', hasStarted: true, cwd: targetDir });
        const { launcher, workspaces, terminals } = buildLauncher(session);
        workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);
        // The person clicks the tab while its MCP endpoint is being set up.
        launcher.mcpHost = {
            register: async () => {
                terminals.has.mockReturnValue(true);
                return '/tmp/session.json';
            },
        };
        await expect(launcher.resumeUnattended('ws-1', 'session-1', 'Go on.')).rejects.toThrow(
            'You opened its session before Consola could resume it.'
        );
        expect(terminals.startHeadless).not.toHaveBeenCalled();
    });

    it('resumeUnattended refuses a session that is not read-only, or already has a terminal', async () => {
        const ordinary = sessionFixture({ hasStarted: true });
        const one = buildLauncher(ordinary);
        one.workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [ordinary] }]);
        await expect(one.launcher.resumeUnattended('ws-1', 'session-1', 'Go on.')).rejects.toThrow(/read-only/);

        const restricted = sessionFixture({ toolPolicy: 'read-only', hasStarted: true });
        const two = buildLauncher(restricted);
        two.workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [restricted] }]);
        two.terminals.has.mockReturnValue(true);
        await expect(two.launcher.resumeUnattended('ws-1', 'session-1', 'Go on.')).rejects.toThrow(
            'You opened its session before Consola could resume it.'
        );
        await expect(two.launcher.resumeUnattended('ws-1', 'gone', 'Go on.')).rejects.toThrow('Its session was closed.');
        expect(one.terminals.startHeadless).not.toHaveBeenCalled();
        expect(two.terminals.startHeadless).not.toHaveBeenCalled();
    });

    /** A finished automation review, and the launcher holding it in its workspace. */
    function reviewed(overrides: Partial<Session> = {}) {
        const source = sessionFixture({
            name: 'Add retries',
            hasStarted: true,
            toolPolicy: 'read-only',
            automation: { name: 'review-requests', runId: 'run-1' },
            cwd: targetDir,
            groupId: 'g-reviews',
            model: 'opus',
            workItem: { provider: 'github', repo: 'acme/api', type: 'pr', number: 123 },
            workItemAction: 'Review',
            ...overrides,
        });
        const fork = sessionFixture({ id: 'session-2', instanceId: 'instance-2', claudeSessionId: '22222222-2222-4222-8222-222222222222', cwd: targetDir });
        const built = buildLauncher(fork);
        built.workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [source] }]);
        return { ...built, source };
    }

    it('forkWithFullTools creates an ordinary session on the same harness, folder and item', async () => {
        const { launcher, workspaces } = reviewed();
        await launcher.forkWithFullTools('ws-1', 'session-1');
        const fields = (workspaces.createSession.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
        expect(fields).toEqual({
            name: 'Add retries (full tools)',
            workspaceId: 'ws-1',
            instanceId: expect.stringMatching(/^workspace-ws-1-session-/),
            // The transcript lives in this harness's config directory.
            harnessId: 'work',
            model: 'opus',
            scopeId: 'scope-1',
            cwd: targetDir,
            groupId: 'g-reviews',
            kind: 'interactive',
            workItem: { provider: 'github', repo: 'acme/api', type: 'pr', number: 123 },
            workItemAction: 'Review',
        });
        // A person's own session: no restriction, and nobody else's provenance.
        expect(fields).not.toHaveProperty('toolPolicy');
        expect(fields).not.toHaveProperty('automation');
    });

    it('forkWithFullTools starts the terminal with forkFrom set to the source conversation', async () => {
        const { launcher, terminals } = reviewed();
        const fork = await launcher.forkWithFullTools('ws-1', 'session-1');
        expect(fork).toMatchObject({ id: 'session-2', hasStarted: true });
        const options = terminals.startHeadless.mock.calls[0][1];
        expect(options).toMatchObject({
            claudeSessionId: '22222222-2222-4222-8222-222222222222',
            resume: false,
            forkFrom: '11111111-1111-4111-8111-111111111111',
            configDirOverride: '/Users/me/.claude-work',
        });
        expect(options.toolPolicy).toBeUndefined();
        expect(options.unattended).toBeUndefined();
    });

    it('forkWithFullTools refuses a session that never started', async () => {
        const { launcher, workspaces, terminals } = reviewed({ hasStarted: false });
        await expect(launcher.forkWithFullTools('ws-1', 'session-1')).rejects.toThrow('There is no conversation to continue yet.');
        expect(workspaces.createSession).not.toHaveBeenCalled();
        expect(terminals.startHeadless).not.toHaveBeenCalled();
    });

    it('pins nothing for the built-in or an unknown harness', async () => {
        const session = sessionFixture({ harnessId: 'default' });
        const { launcher, terminals } = buildLauncher(session);

        await launcher.launchSession('ws-1', { ...launchFields, harnessId: 'default' });

        const options = terminals.startHeadless.mock.calls[0][1];
        expect(options.driverId).toBeUndefined();
        expect(options.binaryOverride).toBeUndefined();
        expect(options.configDirOverride).toBeUndefined();
    });

    describe('deliverPrompt', () => {
        function setup(overrides: Partial<Session>, terminal?: Partial<TerminalHandle>) {
            const session = sessionFixture(overrides);
            const built = buildLauncher(session);
            built.workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);
            const queuePrompt = vi.fn();
            if (terminal) {
                built.terminals.get.mockReturnValue({
                    hasClaudeExited: () => false,
                    runningUnattended: () => false,
                    queuePrompt,
                    ...terminal,
                });
            }
            return { ...built, queuePrompt };
        }
        const exited = { hasClaudeExited: () => true };

        it('queues on a live terminal and starts nothing', async () => {
            const { launcher, terminals, queuePrompt } = setup({ hasStarted: true }, {});
            await expect(launcher.deliverPrompt('ws-1', 'session-1', 'hi')).resolves.toBe('queued');
            expect(queuePrompt).toHaveBeenCalledWith('hi');
            expect(terminals.startHeadless).not.toHaveBeenCalled();
            expect(terminals.relaunch).not.toHaveBeenCalled();
        });

        it('relaunches an exited full-tools terminal in place, interactively', async () => {
            const { launcher, terminals } = setup({ hasStarted: true }, exited);
            await expect(launcher.deliverPrompt('ws-1', 'session-1', 'hi')).resolves.toBe('woken');
            expect(terminals.relaunch).toHaveBeenCalledWith('instance-1', { cwd: scopeDir, prompt: 'hi', unattended: false });
            expect(terminals.startHeadless).not.toHaveBeenCalled();
        });

        it('resumes a session with no terminal headlessly, on its own harness, model and policy', async () => {
            const { launcher, terminals } = setup({ hasStarted: true, model: 'opus' });
            await expect(launcher.deliverPrompt('ws-1', 'session-1', 'hi')).resolves.toBe('woken');
            expect(terminals.startHeadless).toHaveBeenCalledWith(
                'instance-1',
                expect.objectContaining({ resume: true, initialPrompt: 'hi', model: 'opus', binaryOverride: '/opt/claude/bin/claude' })
            );
            expect(terminals.startHeadless.mock.calls[0][1].unattended).toBeUndefined();
        });

        it('marks a never-started session started once it is woken fresh', async () => {
            const { launcher, terminals, workspaces } = setup({ hasStarted: false });
            await launcher.deliverPrompt('ws-1', 'session-1', 'hi');
            expect(terminals.startHeadless).toHaveBeenCalledWith('instance-1', expect.objectContaining({ resume: false }));
            expect(workspaces.updateSession).toHaveBeenCalledWith('ws-1', 'session-1', { hasStarted: true });
        });

        it('re-runs an exited read-only terminal unattended, after its worktree hook', async () => {
            const { launcher, terminals } = setup({ toolPolicy: 'read-only', hasStarted: true }, exited);
            const order: string[] = [];
            launcher.beforeRerun = async () => { order.push('refresh'); };
            terminals.relaunch.mockImplementation(() => { order.push('relaunch'); });
            await expect(launcher.deliverPrompt('ws-1', 'session-1', 'look again')).resolves.toBe('rerun');
            expect(terminals.relaunch).toHaveBeenCalledWith('instance-1', { cwd: scopeDir, prompt: 'look again', unattended: true });
            expect(order).toEqual(['refresh', 'relaunch']);
        });

        it('re-runs a read-only session with no terminal as a resumed unattended turn', async () => {
            const { launcher, terminals } = setup({ toolPolicy: 'read-only', hasStarted: true });
            await expect(launcher.deliverPrompt('ws-1', 'session-1', 'look again')).resolves.toBe('rerun');
            expect(terminals.startHeadless).toHaveBeenCalledWith(
                'instance-1',
                expect.objectContaining({ resume: true, unattended: true, initialPrompt: 'look again', toolPolicy: 'read-only' })
            );
        });

        it('still re-runs when the worktree hook fails', async () => {
            const { launcher, terminals } = setup({ toolPolicy: 'read-only', hasStarted: true }, exited);
            launcher.beforeRerun = async () => { throw new Error('gh down'); };
            const error = vi.spyOn(console, 'error').mockImplementation(() => {});
            await expect(launcher.deliverPrompt('ws-1', 'session-1', 'x')).resolves.toBe('rerun');
            expect(terminals.relaunch).toHaveBeenCalled();
            error.mockRestore();
        });

        it('refuses a session in the middle of an unattended run', async () => {
            const { launcher, terminals } = setup({ toolPolicy: 'read-only', hasStarted: true }, { runningUnattended: () => true });
            await expect(launcher.deliverPrompt('ws-1', 'session-1', 'x')).rejects.toThrow(
                '"forum-admin" is in the middle of an unattended run; wait for it to finish.'
            );
            expect(terminals.relaunch).not.toHaveBeenCalled();
        });

        it('refuses a session whose folder is gone, and one it cannot find', async () => {
            const { launcher } = setup({ cwd: missingDir, hasStarted: true }, exited);
            await expect(launcher.deliverPrompt('ws-1', 'session-1', 'x')).rejects.toThrow(`Its working folder is gone: ${missingDir}.`);
            await expect(launcher.deliverPrompt('ws-1', 'nope', 'x')).rejects.toThrow('No session nope in workspace ws-1.');
        });
    });
});
