import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, Workspace } from '../../shared/workspace';
import { ConductorTools, type ConductorToolsDeps } from './ConductorTools';

let control: ConductorTools;
let deps: ConductorToolsDeps;

/** v6 session fixture. Cast tolerates fields v6 adds beyond this plan's use. */
export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'cond-1',
    name: 'conductor',
    workspaceId: 'ws-1',
    instanceId: 'inst-cond',
    claudeSessionId: '00000000-0000-4000-8000-000000000001',
    hasStarted: false,
    harnessId: 'default',
    scopeId: 'scope-1',
    groupId: 'grp-1',
    kind: 'conductor',
    createdAt: 0,
    lastActiveAt: 0,
    ...overrides,
  } as Session;
}

export function makeWorkspace(overrides: Record<string, unknown> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'Sprocket',
    defaultHarnessId: 'default',
    scopes: [
      { id: 'scope-1', name: 'app', path: '/repos/app', isGitRepo: true, createdAt: 0 },
      { id: 'scope-2', name: 'parent', path: '/repos/parent', isGitRepo: false, createdAt: 0 },
    ],
    groups: [{ id: 'grp-1', name: 'symbalance-api', createdAt: 0 }],
    sessions: [makeSession()],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as unknown as Workspace;
}

beforeEach(() => {
  deps = {
    getWorkspaces: vi.fn(() => [makeWorkspace()]),
    launchSession: vi.fn(),
    queuePrompt: vi.fn(() => true),
    getStatus: vi.fn(() => 'ready' as const),
  };
  control = new ConductorTools(deps);
});

describe('tool handlers enforce the group boundary', () => {
  const worker = () =>
    makeSession({ id: 'w-1', name: 'adapter · implement', instanceId: 'inst-w1', kind: 'interactive' });
  const foreign = () =>
    makeSession({ id: 'f-1', name: 'other', instanceId: 'inst-f1', kind: 'interactive', groupId: 'grp-OTHER' });

  beforeEach(() => {
    deps.getWorkspaces = vi.fn(() => [
      makeWorkspace({ sessions: [makeSession(), worker(), foreign()] }),
    ]);
    control = new ConductorTools(deps);
  });

  describe('handleSpawnSession', () => {
    it('rejects a scopePath that is not one of the workspace scopes', async () => {
      await expect(
        control.handleSpawnSession('cond-1', {
          name: 'w',
          scopePath: '/somewhere/else',
          prompt: 'go',
        })
      ).rejects.toThrow(/not one of this workspace's scopes/);
      expect(deps.launchSession).not.toHaveBeenCalled();
    });

    it("forces the conductor's own group and kind interactive, whatever the args", async () => {
      // instanceId is set AFTER the ...fields spread: fields carries the
      // instanceId handleSpawnSession minted internally, and it must not be
      // what the mock hands back — the assertion below pins that the id in
      // the result is the one launchSession returned, not an echo of the arg.
      deps.launchSession = vi.fn(async (_wsId, fields) =>
        makeSession({ id: 'new-1', ...fields, instanceId: 'inst-new' } as Partial<Session>)
      );
      control = new ConductorTools(deps);

      const result = await control.handleSpawnSession('cond-1', {
        name: 'worker',
        scopePath: '/repos/parent',
        prompt: '[task:1] implement the adapter',
      });

      expect(result.sessionId).toBe('new-1');
      expect(result.instanceId).toBe('inst-new');
      const fields = (deps.launchSession as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(fields.groupId).toBe('grp-1');          // the conductor's group, not an argument
      expect(fields.kind).toBe('interactive');
      expect(fields.scopeId).toBe('scope-2');        // resolved from scopePath
      expect(fields.harnessId).toBe('default');      // inherited from the conductor
      expect(fields.initialPrompt).toBe('[task:1] implement the adapter');
    });

    it("defaults to the conductor's own scope when scopePath is omitted", async () => {
      deps.launchSession = vi.fn(async () => makeSession({ id: 'new-2', instanceId: 'i2' }));
      control = new ConductorTools(deps);

      await control.handleSpawnSession('cond-1', { name: 'w', prompt: 'go' });

      const fields = (deps.launchSession as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(fields.scopeId).toBe('scope-1');
    });

    it('rejects a cwd outside the resolved scope', async () => {
      await expect(
        control.handleSpawnSession('cond-1', {
          name: 'w',
          scopePath: '/repos/app',
          cwd: '/repos/parent/other',
          prompt: 'go',
        })
      ).rejects.toThrow(/cwd must be inside/);
    });

    it('accepts a cwd legitimately inside the resolved scope', async () => {
      deps.launchSession = vi.fn(async () => makeSession({ id: 'new-3', instanceId: 'inst-new3' }));
      control = new ConductorTools(deps);

      await control.handleSpawnSession('cond-1', {
        name: 'w',
        scopePath: '/repos/app',
        cwd: '/repos/app/packages/core',
        prompt: 'go',
      });

      const fields = (deps.launchSession as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(fields.cwd).toBe('/repos/app/packages/core');
      expect(fields.scopeId).toBe('scope-1');
    });

    it('normalizes .. segments in cwd before comparing against the scope', async () => {
      await expect(
        control.handleSpawnSession('cond-1', {
          name: 'w',
          scopePath: '/repos/app',
          cwd: '/repos/app/../parent/other',
          prompt: 'go',
        })
      ).rejects.toThrow(/cwd must be inside/);
    });

    it('rejects a caller that is not a conductor — a worker id cannot drive the tools', async () => {
      await expect(
        control.handleSpawnSession('w-1', { name: 'x', prompt: 'go' })
      ).rejects.toThrow(/not a conductor/);
    });
  });

  describe('resolveConductor failure modes', () => {
    it('rejects a caller id that matches no session in any workspace', () => {
      expect(() => control.handleGroupStatus('no-such-id')).toThrow(/no longer exists/);
    });

    it('rejects a conductor whose record has no group', () => {
      deps.getWorkspaces = vi.fn(() => [
        makeWorkspace({ sessions: [makeSession({ groupId: undefined }), worker(), foreign()] }),
      ]);
      control = new ConductorTools(deps);
      expect(() => control.handleGroupStatus('cond-1')).toThrow(/has no group/);
    });
  });

  describe('handleSendPrompt', () => {
    it('enqueues on a group member through the guarded FIFO', () => {
      const result = control.handleSendPrompt('cond-1', { sessionId: 'w-1', prompt: 'continue' });
      expect(result).toEqual({ queued: true });
      expect(deps.queuePrompt).toHaveBeenCalledWith('inst-w1', 'continue');
    });

    it('rejects a session outside the group', () => {
      expect(() =>
        control.handleSendPrompt('cond-1', { sessionId: 'f-1', prompt: 'hi' })
      ).toThrow(/not in your group/);
      expect(deps.queuePrompt).not.toHaveBeenCalled();
    });

    it('reports a dead terminal instead of silently dropping the prompt', () => {
      deps.queuePrompt = vi.fn(() => false);
      control = new ConductorTools(deps);
      expect(() =>
        control.handleSendPrompt('cond-1', { sessionId: 'w-1', prompt: 'hi' })
      ).toThrow(/no live terminal/);
    });

    it('rejects a session in another workspace, even one sharing the group id', () => {
      deps.getWorkspaces = vi.fn(() => [
        makeWorkspace({ sessions: [makeSession(), worker(), foreign()] }),
        makeWorkspace({
          id: 'ws-2',
          sessions: [
            makeSession({
              id: 'x-2',
              name: 'other workspace',
              instanceId: 'inst-x2',
              kind: 'interactive',
              groupId: 'grp-1',
              workspaceId: 'ws-2',
            }),
          ],
        }),
      ]);
      control = new ConductorTools(deps);

      expect(() =>
        control.handleSendPrompt('cond-1', { sessionId: 'x-2', prompt: 'hi' })
      ).toThrow(/not in your group/);
      expect(deps.queuePrompt).not.toHaveBeenCalled();
    });
  });

  describe('handleSessionStatus', () => {
    it('answers with the terse status and name for a group member', () => {
      deps.getStatus = vi.fn(() => 'needs-attention' as const);
      control = new ConductorTools(deps);
      expect(control.handleSessionStatus('cond-1', { sessionId: 'w-1' })).toEqual({
        status: 'needs-attention',
        name: 'adapter · implement',
      });
    });

    it('rejects a session outside the group', () => {
      expect(() => control.handleSessionStatus('cond-1', { sessionId: 'f-1' })).toThrow(
        /not in your group/
      );
    });

    it('rejects a session in another workspace, even one sharing the group id', () => {
      deps.getWorkspaces = vi.fn(() => [
        makeWorkspace({ sessions: [makeSession(), worker(), foreign()] }),
        makeWorkspace({
          id: 'ws-2',
          sessions: [
            makeSession({
              id: 'x-2',
              name: 'other workspace',
              instanceId: 'inst-x2',
              kind: 'interactive',
              groupId: 'grp-1',
              workspaceId: 'ws-2',
            }),
          ],
        }),
      ]);
      control = new ConductorTools(deps);

      expect(() => control.handleSessionStatus('cond-1', { sessionId: 'x-2' })).toThrow(
        /not in your group/
      );
    });
  });

  describe('handleGroupStatus', () => {
    it('lists every group member with its status — the bell, not the package', () => {
      const rows = control.handleGroupStatus('cond-1');
      expect(rows).toEqual([
        { sessionId: 'cond-1', name: 'conductor', status: 'ready' },
        { sessionId: 'w-1', name: 'adapter · implement', status: 'ready' },
      ]);
    });

    it('does not list a same-groupId session that belongs to a different workspace', () => {
      deps.getWorkspaces = vi.fn(() => [
        makeWorkspace({ sessions: [makeSession(), worker(), foreign()] }),
        makeWorkspace({
          id: 'ws-2',
          sessions: [
            makeSession({
              id: 'x-2',
              name: 'other workspace',
              instanceId: 'inst-x2',
              kind: 'interactive',
              groupId: 'grp-1',
              workspaceId: 'ws-2',
            }),
          ],
        }),
      ]);
      control = new ConductorTools(deps);

      const rows = control.handleGroupStatus('cond-1');
      expect(rows).not.toContainEqual(expect.objectContaining({ sessionId: 'x-2' }));
      expect(rows).toEqual([
        { sessionId: 'cond-1', name: 'conductor', status: 'ready' },
        { sessionId: 'w-1', name: 'adapter · implement', status: 'ready' },
      ]);
    });
  });
});
