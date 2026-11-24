import { afterAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionOpenedError } from '@consola/automation-engine';
import {
  SessionLauncher,
  automationRecordLaunch,
  recordLaunchFields,
  reportTurnsFor,
} from './SessionLauncher';
import type { ExistingTerminal, StepContinuation } from './SessionLauncher';
import { launchedWithFullTools } from './automations/launchAgentRun';
import { WorktreeService } from './WorktreeService';
import { worktreePathLock } from './worktreeCleanup/PathLock';
import type { NewSessionFields, Session, Workspace } from '../shared/workspace';
import type { Harness } from '../shared/harness';
import type { AgentGrants } from '../shared/agentGrants';

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
    scopes: [{ id: 'scope-1', name: 'sprocket', path: scopeDir, isGitRepo: false, createdAt: 1 }],
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
  };
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

function buildLauncher(session: Session) {
  const workspaces = {
    getAll: vi.fn(() => [workspaceFixture()]),
    createSession: vi.fn((_workspaceId: string, _fields: NewSessionFields): Session => session),
    updateSession: vi.fn(),
    deleteSession: vi.fn(),
    replaceConversation: vi.fn(
      (
        _workspaceId: string,
        _sessionId: string,
        claudeSessionId = '22222222-2222-4222-8222-222222222222',
      ) => ({
        ...session,
        claudeSessionId,
        hasStarted: true,
      }),
    ),
  };
  const harnesses = { getAll: vi.fn(() => [harnessFixture]) };
  const terminals = {
    startHeadless: vi.fn(),
    has: vi.fn(() => false),
    get: vi.fn((): ExistingTerminal | undefined => undefined),
    relaunch: vi.fn(),
  };
  const launcher = new SessionLauncher(workspaces, harnesses, terminals);
  return { launcher, workspaces, harnesses, terminals };
}

/** A terminal the session already has, live unless `exited`. */
function existingTerminal(state: { exited?: boolean; unattended?: boolean } = {}) {
  return {
    queuePrompt: vi.fn(),
    startFreshConversation: vi.fn(),
    runningUnattended: vi.fn(() => state.unattended ?? false),
    hasClaudeExited: vi.fn(() => state.exited ?? false),
    restartClaude: vi.fn(),
  };
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
      expect.not.objectContaining({ initialPrompt: expect.anything() }),
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
      }),
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
      expect.objectContaining({ cwd: targetDir }),
    );
  });

  it('rolls the record back when the working folder is gone', async () => {
    // A fan-out target that has been moved or deleted since the dialog
    // listed it. The PTY would spawn and die silently; fan-out would
    // report it as launched.
    const session = sessionFixture({ cwd: missingDir });
    const { launcher, workspaces, terminals } = buildLauncher(session);

    await expect(
      launcher.launchSession('ws-1', { ...launchFields, cwd: missingDir }),
    ).rejects.toThrow(`has no working folder: ${missingDir} does not exist`);
    expect(workspaces.deleteSession).toHaveBeenCalledWith('ws-1', 'session-1');
    expect(terminals.startHeadless).not.toHaveBeenCalled();
  });

  it('rolls the record back when the session has nowhere to run', async () => {
    const session = sessionFixture({ scopeId: 'gone' });
    const { launcher, workspaces, terminals } = buildLauncher(session);

    await expect(
      launcher.launchSession('ws-1', { ...launchFields, scopeId: 'gone' }),
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
        expect.objectContaining({ mcpConfigPath: '/tmp/session-1.json' }),
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
    const { launcher, workspaces, harnesses, terminals } = buildLauncher(
      sessionFixture({ toolPolicy: 'read-only' }),
    );
    harnesses.getAll.mockReturnValue([
      { ...harnessFixture, extraArgs: ['--dangerously-skip-permissions'] },
    ]);
    await expect(
      launcher.launchSession('ws-1', { ...launchFields, toolPolicy: 'read-only' }),
    ).rejects.toThrow(/--dangerously-skip-permissions/);
    expect(workspaces.createSession).not.toHaveBeenCalled();
    expect(terminals.startHeadless).not.toHaveBeenCalled();
  });

  it('passes unattended and forkFrom to the terminal and never to the record', async () => {
    const { launcher, workspaces, terminals } = buildLauncher(
      sessionFixture({ toolPolicy: 'read-only' }),
    );
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
      }),
    );
    expect(workspaces.createSession).not.toHaveBeenCalled();
  });

  it('resumeUnattended refuses a harness that would loosen the policy', async () => {
    const session = sessionFixture({ toolPolicy: 'read-only', hasStarted: true, cwd: targetDir });
    const { launcher, workspaces, harnesses, terminals } = buildLauncher(session);
    workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);
    harnesses.getAll.mockReturnValue([
      { ...harnessFixture, extraArgs: ['--dangerously-skip-permissions'] },
    ]);
    await expect(launcher.resumeUnattended('ws-1', 'session-1', 'Go on.')).rejects.toThrow(
      /--dangerously-skip-permissions/,
    );
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
    const refused = launcher.resumeUnattended('ws-1', 'session-1', 'Go on.');
    await expect(refused).rejects.toThrow('You opened its session before Consola could resume it.');
    // Typed, so the engine tells it from any other failed resume without reading its words.
    await expect(refused).rejects.toBeInstanceOf(SessionOpenedError);
    expect(terminals.startHeadless).not.toHaveBeenCalled();
  });

  it('resumeUnattended refuses a session that is not read-only, or already has a terminal', async () => {
    const ordinary = sessionFixture({ hasStarted: true });
    const one = buildLauncher(ordinary);
    one.workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [ordinary] }]);
    await expect(one.launcher.resumeUnattended('ws-1', 'session-1', 'Go on.')).rejects.toThrow(
      /read-only/,
    );

    const restricted = sessionFixture({ toolPolicy: 'read-only', hasStarted: true });
    const two = buildLauncher(restricted);
    two.workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [restricted] }]);
    two.terminals.has.mockReturnValue(true);
    const opened = two.launcher.resumeUnattended('ws-1', 'session-1', 'Go on.');
    await expect(opened).rejects.toThrow('You opened its session before Consola could resume it.');
    await expect(opened).rejects.toBeInstanceOf(SessionOpenedError);
    await expect(two.launcher.resumeUnattended('ws-1', 'gone', 'Go on.')).rejects.toThrow(
      'Its session was closed.',
    );
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
    const fork = sessionFixture({
      id: 'session-2',
      instanceId: 'instance-2',
      claudeSessionId: '22222222-2222-4222-8222-222222222222',
      cwd: targetDir,
    });
    const built = buildLauncher(fork);
    built.workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [source] }]);
    return { ...built, source };
  }

  it('forkWithFullTools creates an ordinary session on the same harness, folder and item', async () => {
    const { launcher, workspaces } = reviewed();
    await launcher.forkWithFullTools('ws-1', 'session-1');
    const fields = (workspaces.createSession.mock.calls[0] as unknown[])[1] as Record<
      string,
      unknown
    >;
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
    await expect(launcher.forkWithFullTools('ws-1', 'session-1')).rejects.toThrow(
      'There is no conversation to continue yet.',
    );
    expect(workspaces.createSession).not.toHaveBeenCalled();
    expect(terminals.startHeadless).not.toHaveBeenCalled();
  });

  describe('a session whose worktree a cleanup rule removed', () => {
    it('rebuilds it before looking for the folder, and the pane says so', async () => {
      const removedAt = path.join(scopeDir, 'app-session-9');
      const session = sessionFixture({
        hasStarted: true,
        cwd: removedAt,
        removedWorktree: {
          path: removedAt,
          mainRepo: scopeDir,
          commit: 'a'.repeat(40),
          branch: null,
          keepRef: 'refs/consola/worktrees/app-session-9',
          trigger: 'settled',
          removedAt: 0,
        },
      });
      const { launcher, workspaces, terminals } = buildLauncher(session);
      workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);
      const order: string[] = [];
      launcher.prepareCheckout = vi.fn(async () => {
        order.push('rebuild');
        fs.mkdirSync(removedAt, { recursive: true });
        return { notice: 'Consola rebuilt this session’s worktree.' };
      });
      terminals.startHeadless.mockImplementation(() => {
        order.push('spawn');
      });

      await launcher.runInSession('ws-1', 'session-1', 'Check again.', 'continue');

      expect(order).toEqual(['rebuild', 'spawn']);
      expect(terminals.startHeadless).toHaveBeenCalledWith(
        session.instanceId,
        expect.objectContaining({
          cwd: removedAt,
          launchNotice: 'Consola rebuilt this session’s worktree.',
        }),
      );
    });

    it('never asks for a rebuild for a session that was not removed', async () => {
      const session = sessionFixture({ hasStarted: true, cwd: targetDir });
      const { launcher, workspaces } = buildLauncher(session);
      workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);
      launcher.prepareCheckout = vi.fn(async () => ({}));
      await launcher.runInSession('ws-1', 'session-1', 'Check again.', 'continue');
      expect(launcher.prepareCheckout).not.toHaveBeenCalled();
    });
  });

  describe('runInSession', () => {
    const linked = () => sessionFixture({ hasStarted: true, cwd: targetDir });

    it('continue: queues the prompt into the live terminal and leaves the conversation alone', async () => {
      const session = linked();
      const { launcher, workspaces, terminals } = buildLauncher(session);
      workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);
      const terminal = existingTerminal();
      terminals.get.mockReturnValue(terminal);

      await launcher.runInSession('ws-1', 'session-1', 'Check again.', 'continue');

      expect(terminal.queuePrompt).toHaveBeenCalledWith('Check again.');
      expect(terminal.restartClaude).not.toHaveBeenCalled();
      expect(terminal.startFreshConversation).not.toHaveBeenCalled();
      expect(workspaces.replaceConversation).not.toHaveBeenCalled();
      expect(terminals.startHeadless).not.toHaveBeenCalled();
    });

    it('continue: resumes an exited CLI in its working folder before queueing', async () => {
      const session = linked();
      const { launcher, workspaces, terminals } = buildLauncher(session);
      workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);
      const terminal = existingTerminal({ exited: true });
      terminals.get.mockReturnValue(terminal);

      await launcher.runInSession('ws-1', 'session-1', 'Check again.', 'continue');

      expect(terminal.restartClaude).toHaveBeenCalledWith(targetDir);
      expect(terminal.queuePrompt).toHaveBeenCalledWith('Check again.');
    });

    it('continue: with no terminal, spawns one resuming the recorded conversation', async () => {
      const session = linked();
      const { launcher, workspaces, terminals } = buildLauncher(session);
      workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);

      await launcher.runInSession('ws-1', 'session-1', 'Check again.', 'continue');

      expect(terminals.startHeadless).toHaveBeenCalledWith(
        'instance-1',
        expect.objectContaining({
          cwd: targetDir,
          claudeSessionId: '11111111-1111-4111-8111-111111111111',
          resume: true,
          initialPrompt: 'Check again.',
          configDirOverride: '/Users/me/.claude-work',
        }),
      );
      expect(workspaces.replaceConversation).not.toHaveBeenCalled();
    });

    it('continue: a conversation a harness switch began is resumed knowing how it began', async () => {
      // Should the resume find it missing — a fork nobody has spoken in yet —
      // the terminal opens it the same way again rather than blank.
      const session = sessionFixture({
        cwd: targetDir,
        hasStarted: true,
        priorConversations: [
          {
            harnessId: 'personal',
            claudeSessionId: 'before',
            continuedAs: '11111111-1111-4111-8111-111111111111',
            endedAt: 1,
            carried: 'native',
          },
        ],
      });
      const { launcher, workspaces, terminals } = buildLauncher(session);
      workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);

      await launcher.runInSession('ws-1', 'session-1', 'Check again.', 'continue');

      expect(terminals.startHeadless.mock.calls[0][1]).toMatchObject({
        resume: true,
        opening: { forkFrom: 'before' },
      });
    });

    it('continue: a session that never ran creates its conversation and is marked started', async () => {
      const session = sessionFixture({ hasStarted: false, cwd: targetDir });
      const { launcher, workspaces, terminals } = buildLauncher(session);
      workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);

      await launcher.runInSession('ws-1', 'session-1', 'Check again.', 'continue');

      expect(terminals.startHeadless.mock.calls[0][1]).toMatchObject({ resume: false });
      expect(workspaces.updateSession).toHaveBeenCalledWith('ws-1', 'session-1', {
        hasStarted: true,
      });
    });

    it('fresh: moves the live terminal onto the id it then records', async () => {
      const session = linked();
      const { launcher, workspaces, terminals } = buildLauncher(session);
      workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);
      const terminal = existingTerminal();
      terminals.get.mockReturnValue(terminal);

      await launcher.runInSession('ws-1', 'session-1', 'Header\n\nReview again.', 'fresh');

      const [newId, prompt] = terminal.startFreshConversation.mock.calls[0];
      expect(newId).not.toBe(session.claudeSessionId);
      expect(prompt).toBe('Header\n\nReview again.');
      expect(workspaces.replaceConversation).toHaveBeenCalledWith('ws-1', 'session-1', newId);
      expect(terminal.queuePrompt).not.toHaveBeenCalled();
      expect(terminals.startHeadless).not.toHaveBeenCalled();
    });

    it('fresh: a terminal that refuses leaves the record on the running conversation', async () => {
      const session = linked();
      const { launcher, workspaces, terminals } = buildLauncher(session);
      workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);
      const terminal = existingTerminal();
      terminal.startFreshConversation.mockImplementation(() => {
        throw new Error('This session is still starting. Try again in a moment.');
      });
      terminals.get.mockReturnValue(terminal);

      await expect(
        launcher.runInSession('ws-1', 'session-1', 'Review again.', 'fresh'),
      ).rejects.toThrow(/still starting/);
      expect(workspaces.replaceConversation).not.toHaveBeenCalled();
    });

    it('fresh: with no terminal, records a new conversation and spawns it as a create', async () => {
      const session = linked();
      const { launcher, workspaces, terminals } = buildLauncher(session);
      workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);

      await launcher.runInSession('ws-1', 'session-1', 'Review again.', 'fresh');

      expect(workspaces.replaceConversation).toHaveBeenCalledWith('ws-1', 'session-1');
      expect(terminals.startHeadless).toHaveBeenCalledWith(
        'instance-1',
        expect.objectContaining({
          claudeSessionId: '22222222-2222-4222-8222-222222222222',
          resume: false,
          initialPrompt: 'Review again.',
        }),
      );
    });

    it('keeps the record’s tool policy, and refuses a harness that would loosen it', async () => {
      const session = sessionFixture({ hasStarted: true, cwd: targetDir, toolPolicy: 'read-only' });
      const { launcher, workspaces, harnesses, terminals } = buildLauncher(session);
      workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);

      await launcher.runInSession('ws-1', 'session-1', 'Review again.', 'fresh');
      expect(terminals.startHeadless.mock.calls[0][1]).toMatchObject({ toolPolicy: 'read-only' });

      harnesses.getAll.mockReturnValue([
        { ...harnessFixture, extraArgs: ['--dangerously-skip-permissions'] },
      ]);
      await expect(
        launcher.runInSession('ws-1', 'session-1', 'Go on.', 'continue'),
      ).rejects.toThrow(/--dangerously-skip-permissions/);
    });

    it('never interrupts or types into an unattended turn', async () => {
      const session = linked();
      const { launcher, workspaces, terminals } = buildLauncher(session);
      workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);
      const terminal = existingTerminal({ unattended: true });
      terminals.get.mockReturnValue(terminal);

      for (const conversation of ['continue', 'fresh'] as const) {
        await expect(
          launcher.runInSession('ws-1', 'session-1', 'Go on.', conversation),
        ).rejects.toThrow(/automation is still running/);
      }
      expect(terminal.queuePrompt).not.toHaveBeenCalled();
      expect(terminal.startFreshConversation).not.toHaveBeenCalled();
      expect(workspaces.replaceConversation).not.toHaveBeenCalled();
    });

    it('refuses a session that is gone, or whose folder is', async () => {
      const session = sessionFixture({ hasStarted: true, cwd: missingDir });
      const { launcher, workspaces, terminals } = buildLauncher(session);

      await expect(launcher.runInSession('ws-1', 'session-1', 'Go on.', 'fresh')).rejects.toThrow(
        /no longer exists/,
      );

      workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);
      await expect(launcher.runInSession('ws-1', 'session-1', 'Go on.', 'fresh')).rejects.toThrow(
        /folder is gone/,
      );
      expect(workspaces.replaceConversation).not.toHaveBeenCalled();
      expect(terminals.startHeadless).not.toHaveBeenCalled();
    });
  });

  it('launches on an edited built-in harness with its own settings, as a pane does', async () => {
    const session = sessionFixture({ harnessId: 'default' });
    const { launcher, harnesses, terminals } = buildLauncher(session);
    harnesses.getAll.mockReturnValue([
      {
        ...harnessFixture,
        id: 'default',
        isBuiltIn: true,
        configDir: '/Users/me/.claude-personal',
        extraArgs: [],
      },
    ]);

    await launcher.launchSession('ws-1', { ...launchFields, harnessId: 'default' });

    expect(terminals.startHeadless.mock.calls[0][1]).toMatchObject({
      driverId: 'claude',
      configDirOverride: '/Users/me/.claude-personal',
    });
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

  describe('a step session’s turns', () => {
    const STEP = { name: 'catalog-notes', runId: 'r1', step: { id: 'look', attempt: 1 } };
    const GRANTS: AgentGrants = {
      driverId: 'claude',
      servers: [{ name: 'grafana' }],
      skills: [],
      allowedMcpServers: [{ serverName: 'consola' }, { serverName: 'grafana' }],
      strict: true,
      accountFile: '/Users/me/.claude-work/.claude.json',
      allowedTools: ['mcp__grafana__*'],
    };

    it("a step session's grants reach its record and every launch of it, a reopen included", async () => {
      const { launcher, workspaces, terminals } = buildLauncher(sessionFixture());
      workspaces.createSession.mockImplementation(
        (_workspaceId: string, fields: NewSessionFields) => ({ ...sessionFixture(), ...fields }),
      );
      const session = await launcher.launchSession('ws-1', {
        ...launchFields,
        toolPolicy: 'read-only',
        automation: STEP,
        grants: GRANTS,
        initialPrompt: 'look',
        unattended: true,
      });
      expect((workspaces.createSession.mock.calls[0] as unknown[])[1]).toMatchObject({
        grants: GRANTS,
      });
      expect(terminals.startHeadless.mock.calls[0][1]).toMatchObject({ grants: GRANTS });

      // A reopen after a restart starts the record as it is.
      await launcher.startRecorded('ws-1', { ...session, hasStarted: true }, { resume: true });
      expect(terminals.startHeadless.mock.calls[1][1]).toMatchObject({
        resume: true,
        grants: GRANTS,
      });
    });

    it('a session with no grants launches with no grants key', async () => {
      const { launcher, terminals } = buildLauncher(sessionFixture());
      await launcher.launchSession('ws-1', launchFields);
      expect(
        Object.prototype.hasOwnProperty.call(terminals.startHeadless.mock.calls[0][1], 'grants'),
      ).toBe(false);
    });

    it.each([['edit'], ['write']] as const)(
      'runs the reminder in a %s session, and never resumes one unattended (slice 3-B)',
      async (policy) => {
        const session = sessionFixture({
          toolPolicy: policy,
          hasStarted: true,
          automation: STEP,
          cwd: targetDir,
        });
        const { launcher, workspaces, terminals } = buildLauncher(session);
        workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);
        terminals.get.mockReturnValue({ ...existingTerminal(), hasClaudeExited: () => true });
        await expect(
          launcher.relaunchUnattended('ws-1', 'session-1', 'You ended without: notes'),
        ).resolves.toBeUndefined();
        expect(terminals.relaunch).toHaveBeenCalledWith(
          'instance-1',
          expect.objectContaining({ prompt: 'You ended without: notes', unattended: true }),
        );
        await expect(launcher.resumeUnattended('ws-1', 'session-1', 'go on')).rejects.toThrow(
          'Consola resumes a turn unattended only in a read-only session.',
        );
      },
    );

    it('reminds a step only in a session Consola started for it', async () => {
      const session = sessionFixture({ hasStarted: true, cwd: targetDir });
      const { launcher, workspaces, terminals } = buildLauncher(session);
      workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);
      terminals.get.mockReturnValue({ ...existingTerminal(), hasClaudeExited: () => true });
      await expect(launcher.relaunchUnattended('ws-1', 'session-1', 'remind')).rejects.toThrow(
        'Consola reminds a step only in a session it started for that step.',
      );
      expect(terminals.relaunch).not.toHaveBeenCalled();
    });

    it('a reminder in a live terminal leaves its grants as the terminal has them', async () => {
      const session = sessionFixture({
        toolPolicy: 'read-only',
        hasStarted: true,
        automation: STEP,
        grants: GRANTS,
      });
      const { launcher, workspaces, terminals } = buildLauncher(session);
      workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);
      terminals.get.mockReturnValue({ ...existingTerminal(), hasClaudeExited: () => true });
      await launcher.relaunchUnattended('ws-1', 'session-1', 'remind');
      expect(terminals.relaunch).toHaveBeenCalledWith('instance-1', {
        cwd: scopeDir,
        prompt: 'remind',
        unattended: true,
      });
    });

    it('a full-tools fork of a step session carries none of its grants', async () => {
      const source = sessionFixture({
        toolPolicy: 'read-only',
        hasStarted: true,
        automation: STEP,
        grants: GRANTS,
      });
      const { launcher, workspaces, terminals } = buildLauncher(source);
      workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [source] }]);
      workspaces.createSession.mockImplementation(
        (_workspaceId: string, fields: NewSessionFields) => ({
          ...sessionFixture(),
          ...fields,
          id: 'session-2',
        }),
      );
      await launcher.forkWithFullTools('ws-1', 'session-1');
      expect((workspaces.createSession.mock.calls[0] as unknown[])[1]).not.toHaveProperty('grants');
      expect(terminals.startHeadless.mock.calls[0][1]).not.toHaveProperty('grants');
    });

    it("a step session's terminal reports its unattended turns and carries its cap", async () => {
      const { launcher, workspaces, terminals } = buildLauncher(sessionFixture());
      // The record is what the fields make it: the spawn reads it, not the fields.
      workspaces.createSession.mockImplementation(
        (_workspaceId: string, fields: NewSessionFields) => ({ ...sessionFixture(), ...fields }),
      );
      await launcher.launchSession('ws-1', {
        ...launchFields,
        toolPolicy: 'read-only',
        automation: STEP,
        maxTurns: 6,
        initialPrompt: 'look',
        unattended: true,
      });
      expect((workspaces.createSession.mock.calls[0] as unknown[])[1]).toMatchObject({
        maxTurns: 6,
        automation: STEP,
      });
      expect(terminals.startHeadless).toHaveBeenCalledWith(
        'instance-1',
        expect.objectContaining({ reportTurns: true, maxTurns: 6, unattended: true }),
      );
    });

    it('a legacy automation session’s terminal does not report, nor does a hand-made one’s', async () => {
      const legacy = buildLauncher(
        sessionFixture({ toolPolicy: 'read-only', automation: { name: 'nightly', runId: 'r2' } }),
      );
      await legacy.launcher.launchSession('ws-1', {
        ...launchFields,
        toolPolicy: 'read-only',
        automation: { name: 'nightly', runId: 'r2' },
        initialPrompt: 'look',
        unattended: true,
      });
      expect(legacy.terminals.startHeadless.mock.calls[0][1]).toMatchObject({ reportTurns: false });
      expect(legacy.terminals.startHeadless.mock.calls[0][1]).not.toHaveProperty('maxTurns');

      const handMade = buildLauncher(sessionFixture());
      await handMade.launcher.launchSession('ws-1', launchFields);
      expect(handMade.terminals.startHeadless.mock.calls[0][1]).toMatchObject({
        reportTurns: false,
      });
    });

    it('resumeUnattended replays the record’s cap', async () => {
      const session = sessionFixture({
        toolPolicy: 'read-only',
        hasStarted: true,
        automation: STEP,
        maxTurns: 6,
      });
      const { launcher, workspaces, terminals } = buildLauncher(session);
      workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);
      await launcher.resumeUnattended('ws-1', 'session-1', 'Go on.');
      expect(terminals.startHeadless.mock.calls[0][1]).toMatchObject({
        resume: true,
        unattended: true,
        reportTurns: true,
        maxTurns: 6,
      });
      expect(terminals.startHeadless.mock.calls[0][1]).not.toHaveProperty('turnMaxTurns');
    });

    it('resumeUnattended runs a reminder cut off by a quit under the reminder’s own cap', async () => {
      const session = sessionFixture({
        toolPolicy: 'read-only',
        hasStarted: true,
        automation: STEP,
        maxTurns: 6,
      });
      const { launcher, workspaces, terminals } = buildLauncher(session);
      workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);
      await launcher.resumeUnattended('ws-1', 'session-1', 'Go on.', { maxTurns: 3 });
      expect(terminals.startHeadless.mock.calls[0][1]).toMatchObject({
        resume: true,
        unattended: true,
        reportTurns: true,
        turnMaxTurns: 3,
        maxTurns: 6,
      });
    });

    it('the reminder’s cap reaches an exited terminal', async () => {
      const session = sessionFixture({
        toolPolicy: 'read-only',
        hasStarted: true,
        automation: STEP,
        maxTurns: 6,
      });
      const { launcher, workspaces, terminals } = buildLauncher(session);
      workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);
      terminals.get.mockReturnValue({ ...existingTerminal(), hasClaudeExited: () => true });
      await launcher.relaunchUnattended('ws-1', 'session-1', 'remind', { maxTurns: 3 });
      expect(terminals.relaunch).toHaveBeenCalledWith('instance-1', {
        cwd: scopeDir,
        prompt: 'remind',
        unattended: true,
        maxTurns: 3,
      });
    });

    it('…and a terminal spawned fresh for it', async () => {
      const session = sessionFixture({
        toolPolicy: 'read-only',
        hasStarted: true,
        automation: STEP,
        maxTurns: 6,
      });
      const { launcher, workspaces, terminals } = buildLauncher(session);
      workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);
      await launcher.relaunchUnattended('ws-1', 'session-1', 'remind', { maxTurns: 3 });
      expect(terminals.startHeadless.mock.calls[0][1]).toMatchObject({
        resume: true,
        unattended: true,
        initialPrompt: 'remind',
        reportTurns: true,
        turnMaxTurns: 3,
        maxTurns: 6,
      });
    });

    it('a full-tools fork carries no cap and does not report', async () => {
      const source = sessionFixture({
        name: 'catalog-notes · look',
        toolPolicy: 'read-only',
        hasStarted: true,
        automation: STEP,
        maxTurns: 6,
      });
      const { launcher, workspaces, terminals } = buildLauncher(source);
      workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [source] }]);
      workspaces.createSession.mockImplementation(
        (_workspaceId: string, fields: NewSessionFields) => ({
          ...sessionFixture(),
          ...fields,
          id: 'session-2',
        }),
      );
      await launcher.forkWithFullTools('ws-1', 'session-1');
      const recorded = (workspaces.createSession.mock.calls[0] as unknown[])[1];
      expect(recorded).not.toHaveProperty('maxTurns');
      expect(recorded).not.toHaveProperty('automation');
      expect(terminals.startHeadless.mock.calls[0][1]).toMatchObject({ reportTurns: false });
      expect(terminals.startHeadless.mock.calls[0][1]).not.toHaveProperty('maxTurns');
    });

    it.each<[string, Parameters<typeof recordLaunchFields>[0], object]>([
      [
        'a step session with a cap',
        { automation: STEP, maxTurns: 6 },
        { reportTurns: true, maxTurns: 6 },
      ],
      [
        "a step session with its agent's grants",
        { automation: STEP, maxTurns: 3, grants: GRANTS },
        { reportTurns: true, maxTurns: 3, grants: GRANTS },
      ],
      ['a step session without one', { automation: STEP }, { reportTurns: true }],
      [
        'a legacy automation session',
        { automation: { name: 'nightly', runId: 'r2' } },
        { reportTurns: false },
      ],
      ['a hand-made session', {}, { reportTurns: false }],
      ['no record', undefined, { reportTurns: false }],
    ])(
      'recordLaunchFields is the one rule every launch path reads: %s',
      (_name, record, expected) => {
        expect(recordLaunchFields(record)).toStrictEqual(expected);
      },
    );

    it("automationRecordLaunch: an automation's session reopens on its record's harness and model", () => {
      const harnesses: Harness[] = [
        {
          id: 'claude-work',
          driverId: 'claude',
          name: 'Claude work',
          accentColor: '#888888',
          enabled: true,
          archived: false,
          isBuiltIn: false,
          binaryPath: '/opt/claude/bin/claude',
          configDir: '/home/alice/.claude-work',
          extraArgs: ['--verbose'],
          createdAt: 0,
          updatedAt: 0,
        },
      ];
      expect(
        automationRecordLaunch(
          { automation: STEP, model: 'opus', harnessId: 'claude-work' },
          harnesses,
        ),
      ).toStrictEqual({
        model: 'opus',
        driverId: 'claude',
        binaryOverride: '/opt/claude/bin/claude',
        configDirOverride: '/home/alice/.claude-work',
        extraArgs: ['--verbose'],
      });
      // Every key its own, so a spread replaces whatever a window sent.
      const noModel = automationRecordLaunch(
        { automation: STEP, model: undefined, harnessId: 'claude-work' },
        harnesses,
      );
      expect(Object.prototype.hasOwnProperty.call(noModel, 'model')).toBe(true);
      expect(noModel.model).toBeUndefined();
      // A harness no record names any more: every field empty, so the window's go too.
      expect(
        automationRecordLaunch({ automation: STEP, model: 'opus', harnessId: 'gone' }, harnesses),
      ).toStrictEqual({
        model: 'opus',
        driverId: undefined,
        binaryOverride: undefined,
        configDirOverride: undefined,
        extraArgs: undefined,
      });
      expect(
        automationRecordLaunch({ model: 'opus', harnessId: 'claude-work' }, harnesses),
      ).toStrictEqual({});
      expect(automationRecordLaunch(undefined, harnesses)).toStrictEqual({});
    });

    it('reportTurnsFor: only an automation step’s session reports', () => {
      expect(reportTurnsFor({ automation: STEP })).toBe(true);
      expect(reportTurnsFor({ automation: { name: 'nightly', runId: 'r2' } })).toBe(false);
      expect(reportTurnsFor({})).toBe(false);
    });
  });

  describe('relaunchUnattended', () => {
    function setup(overrides: Partial<Session>, terminal?: Partial<ExistingTerminal>) {
      const session = sessionFixture({ toolPolicy: 'read-only', hasStarted: true, ...overrides });
      const built = buildLauncher(session);
      built.workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [session] }]);
      if (terminal) built.terminals.get.mockReturnValue({ ...existingTerminal(), ...terminal });
      return built;
    }
    const exited = { hasClaudeExited: () => true };

    it('relaunches an exited terminal in place, without refreshing the worktree', async () => {
      const { launcher, terminals } = setup({}, exited);
      await launcher.relaunchUnattended('ws-1', 'session-1', 'Set it now.');
      expect(terminals.relaunch).toHaveBeenCalledWith('instance-1', {
        cwd: scopeDir,
        prompt: 'Set it now.',
        unattended: true,
      });
      expect(terminals.startHeadless).not.toHaveBeenCalled();
    });

    it('refuses while the CLI is running', async () => {
      const { launcher, terminals } = setup({}, {});
      await expect(launcher.relaunchUnattended('ws-1', 'session-1', 'x')).rejects.toThrow(
        'You opened its session before Consola could remind it.',
      );
      expect(terminals.relaunch).not.toHaveBeenCalled();
      expect(terminals.startHeadless).not.toHaveBeenCalled();
    });

    it('spawns a resume when there is no terminal, without refreshing the worktree', async () => {
      const { launcher, terminals } = setup({});
      await launcher.relaunchUnattended('ws-1', 'session-1', 'Set it now.');
      expect(terminals.startHeadless).toHaveBeenCalledWith(
        'instance-1',
        expect.objectContaining({
          resume: true,
          unattended: true,
          initialPrompt: 'Set it now.',
          toolPolicy: 'read-only',
        }),
      );
    });

    it('refuses a terminal that appeared while it prepared', async () => {
      const { launcher, terminals } = setup({});
      launcher.mcpHost = {
        register: async () => {
          terminals.has.mockReturnValue(true);
          return '/tmp/session.json';
        },
      };
      await expect(launcher.relaunchUnattended('ws-1', 'session-1', 'x')).rejects.toThrow(
        'You opened its session before Consola could remind it.',
      );
      expect(terminals.startHeadless).not.toHaveBeenCalled();
    });

    it('refuses a session with no policy, or that is gone', async () => {
      const { launcher, terminals } = setup({ toolPolicy: undefined }, exited);
      // A write step's session is reminded too (slice 3-B): only a session with no policy is refused, in these words.
      await expect(launcher.relaunchUnattended('ws-1', 'session-1', 'x')).rejects.toThrow(
        'Consola reminds a step only in a session it started for that step.',
      );
      await expect(launcher.relaunchUnattended('ws-1', 'gone', 'x')).rejects.toThrow(
        'Its session was closed.',
      );
      expect(terminals.relaunch).not.toHaveBeenCalled();
    });
  });
});

describe("a step's full-tools continuation (slice 3-B Task 20)", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  /** The person's clone, and a review step's automation checkout of PR 51 in a temp worktree root. */
  function rig() {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-continue-')));
    made.push(base);
    const clone = path.join(base, 'catalog-portal');
    const root = path.join(base, 'worktrees');
    fs.mkdirSync(root);
    git(base, 'init', '-q', '-b', 'main', clone);
    fs.writeFileSync(path.join(clone, 'README.md'), 'catalog-portal\n');
    git(clone, 'add', '-A');
    git(
      clone,
      '-c',
      'user.name=alice',
      '-c',
      'user.email=alice@sprocket.example',
      'commit',
      '-q',
      '-m',
      'first',
    );
    const read = git(clone, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(clone, 'LATER.md'), 'later\n');
    git(clone, 'add', '-A');
    git(
      clone,
      '-c',
      'user.name=alice',
      '-c',
      'user.email=alice@sprocket.example',
      'commit',
      '-q',
      '-m',
      'later',
    );
    const automationCheckoutDir = path.join(root, 'catalog-portal-pr-51-automation');
    git(clone, 'worktree', 'add', '-q', '--detach', automationCheckoutDir, read);
    return { base, clone, root, read, automationCheckoutDir, worktrees: new WorktreeService(root) };
  }

  const STEP_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
  function launcherFor(
    source: Session,
    checkout: ReturnType<StepContinuation['checkoutOf']>,
    open = false,
  ) {
    const built = buildLauncher(sessionFixture());
    built.workspaces.getAll.mockReturnValue([{ ...workspaceFixture(), sessions: [source] }]);
    built.workspaces.createSession.mockImplementation(
      (_workspaceId: string, fields: NewSessionFields) => ({
        ...sessionFixture(),
        ...fields,
        id: 'session-2',
        hasStarted: true,
      }),
    );
    const refusal = vi.fn((_runId: string, _stepId: string) =>
      open ? 'Continue with full tools after the run ends' : null,
    );
    const continuationFolder = vi.fn<StepContinuation['continuationFolder']>();
    built.launcher.continuation = { refusal, checkoutOf: () => checkout, continuationFolder };
    return { ...built, refusal, continuationFolder };
  }
  const stepSession = (overrides: Partial<Session> = {}) =>
    sessionFixture({
      id: STEP_ID,
      name: 'ui-bugfixer',
      hasStarted: true,
      toolPolicy: 'write',
      automation: { name: 'ui-bug-to-pr', runId: 'run-41', step: { id: 'fix', attempt: 1 } },
      cwd: targetDir,
      ...overrides,
    });

  it("refuses while the step's run is open, and starts nothing", async () => {
    const source = stepSession();
    const { launcher, workspaces, terminals, refusal } = launcherFor(
      source,
      { kind: 'run-owned', cwd: targetDir, head: 'c'.repeat(40) },
      true,
    );
    await expect(launcher.forkWithFullTools('ws-1', STEP_ID)).rejects.toThrow(
      'Continue with full tools after the run ends',
    );
    expect(refusal).toHaveBeenCalledWith('run-41', 'fix');
    expect(workspaces.createSession).not.toHaveBeenCalled();
    expect(terminals.startHeadless).not.toHaveBeenCalled();
  });

  it("asks the run checkout's git-folder check for the folder it forks in, after any rebuild, and starts nothing when it refuses (3-B code review F11)", async () => {
    // As cleanup left it: removed, so the fork's launch rebuilds it first, then asks.
    const source = stepSession({
      removedWorktree: {
        path: targetDir,
        mainRepo: scopeDir,
        commit: 'a'.repeat(40),
        branch: null,
        keepRef: 'refs/consola/worktrees/x',
        trigger: 'settled',
        removedAt: 0,
      },
    });
    const { launcher, workspaces, terminals } = launcherFor(source, {
      kind: 'run-owned',
      cwd: targetDir,
      head: 'c'.repeat(40),
    });
    const order: string[] = [];
    launcher.prepareCheckout = vi.fn(async () => {
      order.push('rebuild');
      return {};
    });
    const asked: Array<Pick<Session, 'cwd' | 'agentCwd'>> = [];
    let refusal: string | null = "the step changed this checkout's git folder";
    launcher.spawnRefusal = (session) => {
      order.push('check');
      asked.push(session);
      return refusal;
    };
    await expect(launcher.forkWithFullTools('ws-1', STEP_ID)).rejects.toThrow(
      "the step changed this checkout's git folder",
    );
    expect(order).toEqual(['rebuild', 'check']);
    expect(asked).toEqual([{ cwd: targetDir }]);
    expect(workspaces.createSession).not.toHaveBeenCalled();
    expect(terminals.startHeadless).not.toHaveBeenCalled();
    refusal = null;
    await launcher.forkWithFullTools('ws-1', STEP_ID);
    expect(terminals.startHeadless.mock.calls[0][1]).toMatchObject({ cwd: targetDir });
  });

  it('forks a run-owned step in its own folder once the run ended', async () => {
    const source = stepSession({
      workItem: { provider: 'github', repo: 'sprocket/catalog-portal', type: 'issue', number: 42 },
    });
    const { launcher, workspaces, terminals, continuationFolder } = launcherFor(source, {
      kind: 'run-owned',
      cwd: targetDir,
      head: 'c'.repeat(40),
    });
    await launcher.forkWithFullTools('ws-1', STEP_ID);
    const fields = (workspaces.createSession.mock.calls[0] as unknown[])[1] as NewSessionFields;
    expect(fields.cwd).toBe(targetDir);
    expect(fields).not.toHaveProperty('toolPolicy');
    expect(fields).not.toHaveProperty('automation');
    expect(continuationFolder).not.toHaveBeenCalled();
    expect(terminals.startHeadless.mock.calls[0][1]).toMatchObject({
      cwd: targetDir,
      forkFrom: source.claudeSessionId,
    });
  });

  it("moves a review step's continuation out of the automation checkout, at the commit it read, forked from its conversation (canary row 41)", async () => {
    const at = rig();
    const workItem = {
      provider: 'github' as const,
      repo: 'sprocket/catalog-portal',
      type: 'pr' as const,
      number: 51,
    };
    const source = stepSession({
      name: 'pre-pr-reviewer',
      toolPolicy: 'read-only',
      cwd: at.automationCheckoutDir,
      workItem,
    });
    const { launcher, workspaces, terminals, continuationFolder } = launcherFor(source, {
      kind: 'item',
      cwd: at.automationCheckoutDir,
      head: at.read,
    });
    continuationFolder.mockImplementation(async (_workspace, step, commit) => {
      const dir = at.worktrees.continuationWorktreePathFor(step.workItem!, step.id);
      await at.worktrees.addContinuationWorktree(at.clone, dir, commit);
      return dir;
    });
    const session = await launcher.forkWithFullTools('ws-1', STEP_ID);

    expect(continuationFolder).toHaveBeenCalledWith(expect.anything(), source, at.read);
    expect(session.cwd).toBe(
      path.join(at.root, `catalog-portal-pr-51-continue-${STEP_ID.slice(0, 8)}`),
    );
    expect(git(session.cwd!, 'rev-parse', 'HEAD')).toBe(at.read);
    expect(session.toolPolicy).toBeUndefined();
    expect(session.workItem).toEqual(workItem);
    expect(launchedWithFullTools(session, at.automationCheckoutDir)).toBe(false);
    expect(((workspaces.createSession.mock.calls[0] as unknown[])[1] as NewSessionFields).cwd).toBe(
      session.cwd,
    );
    expect(terminals.startHeadless.mock.calls[0][1]).toMatchObject({
      cwd: session.cwd,
      forkFrom: source.claudeSessionId,
    });
    // The automation checkout is where the step left it.
    expect(git(at.automationCheckoutDir, 'rev-parse', 'HEAD')).toBe(at.read);
  });

  it('a second continuation of the same step keeps the worktree the first made', async () => {
    const at = rig();
    const workItem = {
      provider: 'github' as const,
      repo: 'sprocket/catalog-portal',
      type: 'pr' as const,
      number: 51,
    };
    const dir = at.worktrees.continuationWorktreePathFor(workItem, STEP_ID);
    // The clone's own hook never runs for it (a checkout's `post-checkout`).
    const marker = path.join(at.base, 'hook-ran');
    const hook = path.join(at.clone, '.git', 'hooks', 'post-checkout');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    fs.chmodSync(hook, 0o755);
    await at.worktrees.addContinuationWorktree(at.clone, dir, at.read);
    expect(fs.existsSync(marker)).toBe(false);
    // In use until the session naming it is recorded.
    expect(worktreePathLock.recentlyPrepared(dir)).toBe(true);
    fs.writeFileSync(path.join(dir, 'notes.md'), 'mine\n');
    await at.worktrees.addContinuationWorktree(at.clone, dir, at.read);
    expect(fs.readFileSync(path.join(dir, 'notes.md'), 'utf8')).toBe('mine\n');
    // Anything else at that path is left alone: a plain folder, another repository's worktree.
    const other = at.worktrees.continuationWorktreePathFor({ ...workItem, number: 52 }, STEP_ID);
    fs.mkdirSync(other);
    await expect(at.worktrees.addContinuationWorktree(at.clone, other, at.read)).rejects.toThrow(
      'exists but is not a worktree of',
    );
    const stranger = path.join(at.base, 'storefront');
    git(at.base, 'init', '-q', '-b', 'main', stranger);
    git(
      stranger,
      '-c',
      'user.name=bob',
      '-c',
      'user.email=bob@sprocket.example',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'x',
    );
    const theirs = at.worktrees.continuationWorktreePathFor({ ...workItem, number: 53 }, STEP_ID);
    git(stranger, 'worktree', 'add', '-q', '--detach', theirs);
    await expect(at.worktrees.addContinuationWorktree(at.clone, theirs, at.read)).rejects.toThrow(
      'exists but is not a worktree of',
    );
    await expect(
      at.worktrees.addContinuationWorktree(at.clone, path.join(at.base, 'elsewhere'), at.read),
    ).rejects.toThrow("is not under Consola's worktree folder");
  });

  it("a step's session in another folder than its run's checkout forks in place", async () => {
    const source = stepSession({
      workItem: { provider: 'github', repo: 'sprocket/catalog-portal', type: 'pr', number: 51 },
    });
    const { launcher, workspaces, continuationFolder } = launcherFor(source, {
      kind: 'item',
      cwd: path.join(scopeDir, 'catalog-portal-pr-51-automation'),
      head: 'c'.repeat(40),
    });
    await launcher.forkWithFullTools('ws-1', STEP_ID);
    expect(continuationFolder).not.toHaveBeenCalled();
    expect(((workspaces.createSession.mock.calls[0] as unknown[])[1] as NewSessionFields).cwd).toBe(
      targetDir,
    );
  });

  it('a legacy automation session, or one with no runner wired, forks in place as before', async () => {
    const legacy = sessionFixture({
      hasStarted: true,
      toolPolicy: 'read-only',
      automation: { name: 'review-requests', runId: 'run-1' },
      cwd: targetDir,
    });
    const { launcher, workspaces, refusal } = launcherFor(legacy, null, true);
    await launcher.forkWithFullTools('ws-1', 'session-1');
    expect(refusal).not.toHaveBeenCalled();
    expect(((workspaces.createSession.mock.calls[0] as unknown[])[1] as NewSessionFields).cwd).toBe(
      targetDir,
    );
  });
});
