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
const targetDir = path.join(scopeDir, 'flex-portal');
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
            { id: 'scope-1', name: 'sympower', path: scopeDir, isGitRepo: false, createdAt: 1 },
        ],
        groups: [],
        github: { accountLogin: 'octocat' },
        sessions: [],
        createdAt: 1,
        updatedAt: 1,
    } as unknown as Workspace;
}

function sessionFixture(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        name: 'flex-portal',
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
    name: 'flex-portal',
    workspaceId: 'ws-1',
    instanceId: 'instance-1',
    harnessId: 'work',
    scopeId: 'scope-1',
    kind: 'interactive' as const,
    model: undefined,
};

function buildLauncher(session: Session) {
    const workspaces = {
        getAll: vi.fn(() => [workspaceFixture()]),
        createSession: vi.fn(() => session),
        updateSession: vi.fn(),
        deleteSession: vi.fn(),
    };
    const harnesses = { getAll: vi.fn(() => [harnessFixture]) };
    const terminals = { startHeadless: vi.fn() };
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
                githubAccountLogin: 'octocat',
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

    it('registers MCP config for conductor sessions only', async () => {
        const register = vi.fn(async () => '/tmp/cond.json');

        const conductor = buildLauncher(sessionFixture({ kind: 'conductor' }));
        conductor.launcher.conductorControl = { register };
        await conductor.launcher.launchSession('ws-1', { ...launchFields, kind: 'conductor' });

        // The conductor's control tools reach the PTY as an opaque path.
        expect(register).toHaveBeenCalledTimes(1);
        expect(conductor.terminals.startHeadless).toHaveBeenCalledWith(
            'instance-1',
            expect.objectContaining({ mcpConfigPath: '/tmp/cond.json' })
        );

        // Every other kind passes through untouched: no registration, no path.
        const interactive = buildLauncher(sessionFixture());
        interactive.launcher.conductorControl = { register };
        await interactive.launcher.launchSession('ws-1', launchFields);

        expect(register).toHaveBeenCalledTimes(1);
        expect(interactive.terminals.startHeadless.mock.calls[0][1].mcpConfigPath).toBeUndefined();
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
});
