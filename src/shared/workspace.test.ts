import { describe, expect, it } from 'vitest';
import {
  CURRENT_WORKSPACE_STATE_VERSION,
  generateUuid,
  migrateWorkspaceState,
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
      createdAt: 1,
      lastActiveAt: 2,
    };
    const state = {
      workspaces: [
        {
          id: 'w1',
          name: 'consola',
          path: '/code/consola',
          isGitRepo: true,
          defaultHarnessId: 'work',
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
  });
});
