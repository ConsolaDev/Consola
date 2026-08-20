import { describe, expect, it } from 'vitest';
import {
  CURRENT_WORKSPACE_STATE_VERSION,
  createSessionRecord,
  createWorkspaceRecord,
  generateUuid,
  migrateWorkspaceState,
  primaryScope,
  scopeForSession,
  type Workspace,
} from './workspace';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('generateUuid', () => {
  it('produces a v4 UUID, which is what `claude --session-id` requires', () => {
    expect(generateUuid()).toMatch(UUID_V4);
  });
});

describe('migrateWorkspaceState', () => {
  it('lifts a v2 workspace out of its first project', () => {
    const state = {
      workspaces: [
        {
          id: 'w1',
          name: 'consola',
          projects: [{ path: '/code/consola', isGitRepo: true }],
          sessions: [
            { id: 's1', name: 'Old', workspaceId: 'w1', instanceId: 'i1', createdAt: 1, lastActiveAt: 2 },
          ],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };

    const migrated = migrateWorkspaceState(state, 2) as { workspaces: any[] };
    const workspace = migrated.workspaces[0];

    expect(workspace.path).toBe('/code/consola');
    expect(workspace.isGitRepo).toBe(true);
    expect(workspace.projects).toBeUndefined();

    // The deliberate fix: the v2 branch fills these too, not just the v3 branch,
    // so a session migrated straight from v2 still gets a usable session ID.
    const session = workspace.sessions[0];
    expect(session.claudeSessionId).toMatch(UUID_V4);
    expect(session.hasStarted).toBe(false);
  });

  it('mints a session UUID for pre-v4 sessions, which had no conversation of their own', () => {
    const state = {
      workspaces: [
        {
          id: 'w1',
          name: 'consola',
          path: '/code/consola',
          isGitRepo: true,
          sessions: [
            { id: 's1', name: 'Old', workspaceId: 'w1', instanceId: 'i1', createdAt: 1, lastActiveAt: 2 },
          ],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };

    const migrated = migrateWorkspaceState(state, 3) as { workspaces: any[] };
    const session = migrated.workspaces[0].sessions[0];

    expect(session.claudeSessionId).toMatch(UUID_V4);
    expect(session.hasStarted).toBe(false);
  });

  it('backfills the built-in harness so pre-v5 transcripts stay resolvable', () => {
    const state = {
      workspaces: [
        {
          id: 'w1',
          name: 'consola',
          path: '/code/consola',
          isGitRepo: true,
          sessions: [
            {
              id: 's1',
              name: 'Old',
              workspaceId: 'w1',
              instanceId: 'i1',
              claudeSessionId: '11111111-1111-4111-8111-111111111111',
              hasStarted: true,
              createdAt: 1,
              lastActiveAt: 2,
            },
          ],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };

    const migrated = migrateWorkspaceState(state, 4) as { workspaces: any[] };

    expect(migrated.workspaces[0].defaultHarnessId).toBe('default');
    expect(migrated.workspaces[0].sessions[0].harnessId).toBe('default');
  });

  it('leaves an already-current state alone', () => {
    const session = {
      id: 's1',
      name: 'Current',
      workspaceId: 'w1',
      instanceId: 'i1',
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      hasStarted: true,
      harnessId: 'work',
      scopeId: 'scope-1',
      kind: 'interactive',
      createdAt: 1,
      lastActiveAt: 2,
    };
    const state = {
      workspaces: [
        {
          id: 'w1',
          name: 'consola',
          defaultHarnessId: 'work',
          scopes: [
            { id: 'scope-1', name: 'consola', path: '/code/consola', isGitRepo: true, createdAt: 1 },
          ],
          groups: [],
          sessions: [session],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };

    const migrated = migrateWorkspaceState(state, CURRENT_WORKSPACE_STATE_VERSION) as {
      workspaces: any[];
    };

    expect(migrated.workspaces[0].sessions[0]).toEqual(session);
    expect(migrated.workspaces[0].defaultHarnessId).toBe('work');
    expect(migrated.workspaces[0].scopes).toHaveLength(1);
  });
});

describe('createWorkspaceRecord', () => {
  it('mints a single scope from the folder instead of a path field', () => {
    const workspace = createWorkspaceRecord('consola', '/code/consola', true);

    expect(workspace).not.toHaveProperty('path');
    expect(workspace).not.toHaveProperty('isGitRepo');
    expect(workspace.scopes).toHaveLength(1);
    expect(workspace.scopes[0].path).toBe('/code/consola');
    expect(workspace.scopes[0].isGitRepo).toBe(true);
    expect(workspace.scopes[0].name).toBe('consola');
    expect(workspace.groups).toEqual([]);
    expect(workspace.github).toBeUndefined();
  });
});

describe('createSessionRecord', () => {
  it('defaults kind to interactive and carries the scope', () => {
    const session = createSessionRecord({
      name: 'New Session',
      workspaceId: 'w1',
      instanceId: 'i1',
      harnessId: 'default',
      scopeId: 'scope-1',
    });

    expect(session.kind).toBe('interactive');
    expect(session.scopeId).toBe('scope-1');
    expect(session.cwd).toBeUndefined();
    expect(session.groupId).toBeUndefined();
    expect(session.workItem).toBeUndefined();
  });

  it('keeps an explicit kind', () => {
    const session = createSessionRecord({
      name: 'Conductor',
      workspaceId: 'w1',
      instanceId: 'i1',
      harnessId: 'default',
      scopeId: 'scope-1',
      kind: 'conductor',
    });

    expect(session.kind).toBe('conductor');
  });
});

describe('scope helpers', () => {
  const workspace = {
    ...createWorkspaceRecord('consola', '/code/consola', true),
  } as Workspace;

  it('primaryScope is the first scope', () => {
    expect(primaryScope(workspace)?.path).toBe('/code/consola');
  });

  it('scopeForSession resolves the session scope and falls back to primary', () => {
    const scope = workspace.scopes[0];
    expect(scopeForSession(workspace, { scopeId: scope.id })?.id).toBe(scope.id);
    expect(scopeForSession(workspace, { scopeId: 'gone' })?.id).toBe(scope.id);
    expect(scopeForSession(workspace, undefined)?.id).toBe(scope.id);
  });
});
