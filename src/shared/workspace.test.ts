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

    // The full ladder runs from v2 all the way to v6, so the lifted
    // path/isGitRepo end up on the scope the v6 rung mints, not the workspace.
    expect(workspace.path).toBeUndefined();
    expect(workspace.isGitRepo).toBeUndefined();
    expect(workspace.projects).toBeUndefined();
    expect(workspace.scopes[0].path).toBe('/code/consola');
    expect(workspace.scopes[0].isGitRepo).toBe(true);

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

  it('folds path and isGitRepo into a single scope at v6', () => {
    const state = {
      workspaces: [
        {
          id: 'w1',
          name: 'My Renamed Workspace',
          path: '/code/consola',
          isGitRepo: true,
          defaultHarnessId: 'work',
          sessions: [
            {
              id: 's1',
              name: 'Old',
              workspaceId: 'w1',
              instanceId: 'i1',
              claudeSessionId: '11111111-1111-4111-8111-111111111111',
              hasStarted: true,
              harnessId: 'work',
              model: 'sonnet',
              createdAt: 1,
              lastActiveAt: 2,
            },
          ],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };

    const migrated = migrateWorkspaceState(state, 5) as { workspaces: any[] };
    const workspace = migrated.workspaces[0];

    // path/isGitRepo die on the workspace…
    expect(workspace).not.toHaveProperty('path');
    expect(workspace).not.toHaveProperty('isGitRepo');

    // …and live on as the single scope.
    expect(workspace.scopes).toHaveLength(1);
    const scope = workspace.scopes[0];
    expect(scope.path).toBe('/code/consola');
    expect(scope.isGitRepo).toBe(true);
    expect(scope.name).toBe('consola'); // folder basename, not the renamed workspace
    expect(scope.createdAt).toBe(1);
    expect(typeof scope.id).toBe('string');
    expect(scope.id.length).toBeGreaterThan(0);

    expect(workspace.groups).toEqual([]);
    expect(workspace).not.toHaveProperty('github');

    // The session is bound to the scope and nothing else about it moved.
    const session = workspace.sessions[0];
    expect(session.scopeId).toBe(scope.id);
    expect(session.kind).toBe('interactive');
    expect(session).not.toHaveProperty('groupId');
    expect(session).not.toHaveProperty('cwd');
    expect(session).not.toHaveProperty('workItem');
    expect(session.harnessId).toBe('work');
    expect(session.model).toBe('sonnet');
    expect(session.claudeSessionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(session.hasStarted).toBe(true);
  });

  it('gives every session in a workspace the same scope id', () => {
    const state = {
      workspaces: [
        {
          id: 'w1',
          name: 'consola',
          path: '/code/consola',
          isGitRepo: false,
          defaultHarnessId: 'default',
          sessions: [
            { id: 's1', name: 'A', workspaceId: 'w1', instanceId: 'i1', claudeSessionId: '11111111-1111-4111-8111-111111111111', hasStarted: true, harnessId: 'default', createdAt: 1, lastActiveAt: 1 },
            { id: 's2', name: 'B', workspaceId: 'w1', instanceId: 'i2', claudeSessionId: '22222222-2222-4222-8222-222222222222', hasStarted: false, harnessId: 'default', createdAt: 2, lastActiveAt: 2 },
          ],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };

    const migrated = migrateWorkspaceState(state, 5) as { workspaces: any[] };
    const workspace = migrated.workspaces[0];

    expect(workspace.sessions[0].scopeId).toBe(workspace.scopes[0].id);
    expect(workspace.sessions[1].scopeId).toBe(workspace.scopes[0].id);
  });

  it('names the scope after the workspace when the path is empty', () => {
    const state = {
      workspaces: [
        {
          id: 'w1',
          name: 'orphan',
          path: '',
          isGitRepo: false,
          defaultHarnessId: 'default',
          sessions: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };

    const migrated = migrateWorkspaceState(state, 5) as { workspaces: any[] };
    const scope = migrated.workspaces[0].scopes[0];

    expect(scope.name).toBe('orphan');
    expect(scope.path).toBe('');
    expect(scope.isGitRepo).toBe(false);
  });

  it('migrates a workspace with no sessions', () => {
    const state = {
      workspaces: [
        {
          id: 'w1',
          name: 'empty',
          path: '/code/empty',
          isGitRepo: false,
          defaultHarnessId: 'default',
          sessions: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };

    const migrated = migrateWorkspaceState(state, 5) as { workspaces: any[] };

    expect(migrated.workspaces[0].scopes).toHaveLength(1);
    expect(migrated.workspaces[0].sessions).toEqual([]);
    expect(migrated.workspaces[0].groups).toEqual([]);
  });

  it('carries a v2 workspace through the whole ladder to v6', () => {
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
    const session = workspace.sessions[0];

    // v3: lifted out of projects; v4: session UUID; v5: harness; v6: scope.
    expect(workspace).not.toHaveProperty('projects');
    expect(workspace).not.toHaveProperty('path');
    expect(workspace.defaultHarnessId).toBe('default');
    expect(workspace.scopes[0].path).toBe('/code/consola');
    expect(workspace.scopes[0].isGitRepo).toBe(true);
    expect(session.claudeSessionId).toMatch(UUID_V4);
    expect(session.harnessId).toBe('default');
    expect(session.scopeId).toBe(workspace.scopes[0].id);
    expect(session.kind).toBe('interactive');
  });

  it('carries a v4 workspace through harness backfill and scoping together', () => {
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
    const workspace = migrated.workspaces[0];

    expect(workspace.defaultHarnessId).toBe('default');
    expect(workspace.sessions[0].harnessId).toBe('default');
    expect(workspace.sessions[0].scopeId).toBe(workspace.scopes[0].id);
  });

  it('keeps pre-existing scopes and scopeIds if a file somehow already has them', () => {
    const existingScope = {
      id: 'scope-kept',
      name: 'kept',
      path: '/code/kept',
      isGitRepo: false,
      createdAt: 1,
    };
    const state = {
      workspaces: [
        {
          id: 'w1',
          name: 'consola',
          path: '/code/consola',
          isGitRepo: true,
          defaultHarnessId: 'default',
          scopes: [existingScope],
          sessions: [
            {
              id: 's1',
              name: 'Old',
              workspaceId: 'w1',
              instanceId: 'i1',
              claudeSessionId: '11111111-1111-4111-8111-111111111111',
              hasStarted: true,
              harnessId: 'default',
              scopeId: 'scope-kept',
              kind: 'conductor',
              createdAt: 1,
              lastActiveAt: 2,
            },
          ],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };

    const migrated = migrateWorkspaceState(state, 5) as { workspaces: any[] };
    const workspace = migrated.workspaces[0];

    expect(workspace.scopes).toEqual([existingScope]);
    expect(workspace.sessions[0].scopeId).toBe('scope-kept');
    expect(workspace.sessions[0].kind).toBe('conductor');
  });

  it('never lets one workspace pick up a scope minted for another', () => {
    // A real state.json holds many workspaces migrated in the same pass — if the
    // v6 rung ever hoisted the minted scope out of the per-workspace closure,
    // every workspace would collapse onto one scope id and every session would
    // point at the wrong folder.
    const state = {
      workspaces: [
        {
          id: 'w1',
          name: 'consola',
          path: '/code/consola',
          isGitRepo: true,
          defaultHarnessId: 'default',
          sessions: [
            { id: 's1', name: 'A', workspaceId: 'w1', instanceId: 'i1', claudeSessionId: '11111111-1111-4111-8111-111111111111', hasStarted: true, harnessId: 'default', createdAt: 1, lastActiveAt: 1 },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: 'w2',
          name: 'other',
          path: '/code/other',
          isGitRepo: false,
          defaultHarnessId: 'default',
          sessions: [
            { id: 's2', name: 'B', workspaceId: 'w2', instanceId: 'i2', claudeSessionId: '22222222-2222-4222-8222-222222222222', hasStarted: true, harnessId: 'default', createdAt: 1, lastActiveAt: 1 },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };

    const migrated = migrateWorkspaceState(state, 5) as { workspaces: any[] };
    const [w1, w2] = migrated.workspaces;

    expect(w1.scopes[0].id).not.toBe(w2.scopes[0].id);
    expect(w1.scopes[0].path).toBe('/code/consola');
    expect(w2.scopes[0].path).toBe('/code/other');
    expect(w1.sessions[0].scopeId).toBe(w1.scopes[0].id);
    expect(w2.sessions[0].scopeId).toBe(w2.scopes[0].id);
    expect(w1.sessions[0].scopeId).not.toBe(w2.scopes[0].id);
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
