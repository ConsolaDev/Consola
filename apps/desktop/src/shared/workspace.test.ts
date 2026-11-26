import { describe, expect, it, vi } from 'vitest';
import {
  CURRENT_WORKSPACE_STATE_VERSION,
  createSessionRecord,
  createWorkspaceRecord,
  generateUuid,
  migrateWorkspaceState,
  checkoutPathForSession,
  primaryScope,
  scopeForSession,
  switchedSession,
} from './workspace';
import type { Session } from './workspace';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('generateUuid', () => {
  it('produces a v4 UUID, which is what `claude --session-id` requires', () => {
    expect(generateUuid()).toMatch(UUID_V4);
  });

  it('makes one from random bytes where randomUUID is missing (not a secure context)', () => {
    const random = vi.spyOn(Math, 'random');
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    try {
      const made = [generateUuid(), generateUuid()];
      expect(made[0]).toMatch(UUID_V4);
      expect(made[1]).toMatch(UUID_V4);
      expect(made[0]).not.toBe(made[1]);
      expect(random).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      random.mockRestore();
    }
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
            {
              id: 's1',
              name: 'Old',
              workspaceId: 'w1',
              instanceId: 'i1',
              createdAt: 1,
              lastActiveAt: 2,
            },
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
            {
              id: 's1',
              name: 'Old',
              workspaceId: 'w1',
              instanceId: 'i1',
              createdAt: 1,
              lastActiveAt: 2,
            },
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
            {
              id: 'scope-1',
              name: 'consola',
              path: '/code/consola',
              isGitRepo: true,
              createdAt: 1,
            },
          ],
          groups: [],
          actions: [],
          sectionDefaults: {},
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
    expect(migrated.workspaces[0].actions).toEqual([]);
    expect(migrated.workspaces[0]).not.toHaveProperty('provider');
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
            {
              id: 's1',
              name: 'A',
              workspaceId: 'w1',
              instanceId: 'i1',
              claudeSessionId: '11111111-1111-4111-8111-111111111111',
              hasStarted: true,
              harnessId: 'default',
              createdAt: 1,
              lastActiveAt: 1,
            },
            {
              id: 's2',
              name: 'B',
              workspaceId: 'w1',
              instanceId: 'i2',
              claudeSessionId: '22222222-2222-4222-8222-222222222222',
              hasStarted: false,
              harnessId: 'default',
              createdAt: 2,
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

  it('carries a v2 workspace through the whole ladder', () => {
    const state = {
      workspaces: [
        {
          id: 'w1',
          name: 'consola',
          projects: [{ path: '/code/consola', isGitRepo: true }],
          sessions: [
            {
              id: 's1',
              name: 'Old',
              workspaceId: 'w1',
              instanceId: 'i1',
              createdAt: 1,
              lastActiveAt: 2,
            },
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

    // v7: a local-only workspace gains the two empty fields and nothing else.
    expect(workspace.actions).toEqual([]);
    expect(workspace.sectionDefaults).toEqual({});
    expect(workspace).not.toHaveProperty('provider');
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
            {
              id: 's1',
              name: 'A',
              workspaceId: 'w1',
              instanceId: 'i1',
              claudeSessionId: '11111111-1111-4111-8111-111111111111',
              hasStarted: true,
              harnessId: 'default',
              createdAt: 1,
              lastActiveAt: 1,
            },
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
            {
              id: 's2',
              name: 'B',
              workspaceId: 'w2',
              instanceId: 'i2',
              claudeSessionId: '22222222-2222-4222-8222-222222222222',
              hasStarted: true,
              harnessId: 'default',
              createdAt: 1,
              lastActiveAt: 1,
            },
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

describe('migrateWorkspaceState v6 -> v7', () => {
  function v6Session(overrides: Record<string, unknown> = {}) {
    return {
      id: 's1',
      name: 'PR #51 - Extract billing client',
      workspaceId: 'w1',
      instanceId: 'i1',
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      hasStarted: true,
      harnessId: 'default',
      scopeId: 'scope-1',
      kind: 'interactive',
      createdAt: 1,
      lastActiveAt: 2,
      ...overrides,
    };
  }

  function v6Workspace(overrides: Record<string, unknown> = {}) {
    return {
      id: 'w1',
      name: 'Sprocket',
      defaultHarnessId: 'default',
      scopes: [
        {
          id: 'scope-1',
          name: 'catalog-portal',
          path: '/repos/catalog-portal',
          isGitRepo: true,
          createdAt: 1,
        },
      ],
      groups: [],
      sessions: [],
      createdAt: 1,
      updatedAt: 2,
      ...overrides,
    };
  }

  it('turns the github binding into a provider binding and seeds the default actions', () => {
    const state = {
      workspaces: [v6Workspace({ github: { accountLogin: 'JaviDev', org: 'sprocket' } })],
    };

    const migrated = migrateWorkspaceState(state, 6) as { workspaces: any[] };
    const workspace = migrated.workspaces[0];

    expect(workspace.provider).toEqual({ id: 'github', accountLogin: 'JaviDev', org: 'sprocket' });
    expect(workspace).not.toHaveProperty('github');
    expect(workspace.actions.map((action: { name: string }) => action.name)).toEqual([
      'Review',
      'Address review',
      'Fix CI',
      'Implement',
      'Triage',
    ]);
    const idOf = (name: string) =>
      workspace.actions.find((action: { name: string }) => action.name === name).id;
    expect(workspace.sectionDefaults).toEqual({
      'needs-your-review': idOf('Review'),
      'needs-team-review': idOf('Review'),
      'needs-action': idOf('Address review'),
      waiting: idOf('Fix CI'),
      issues: idOf('Implement'),
    });
  });

  it('never lets one bound workspace pick up an action id minted for another', () => {
    // Mirrors 'never lets one workspace pick up a scope minted for another':
    // many workspaces migrate in the same pass, and each workspace's own
    // createDefaultActions() call must mint its own ids — a shared closure
    // would let two bound workspaces collide on one action set.
    const state = {
      workspaces: [
        v6Workspace({ id: 'w1', github: { accountLogin: 'JaviDev' } }),
        v6Workspace({
          id: 'w2',
          name: 'Other',
          scopes: [
            {
              id: 'scope-2',
              name: 'other-app',
              path: '/repos/other-app',
              isGitRepo: true,
              createdAt: 1,
            },
          ],
          github: { accountLogin: 'OtherAcct' },
        }),
      ],
    };

    const migrated = migrateWorkspaceState(state, 6) as { workspaces: any[] };
    const [w1, w2] = migrated.workspaces;

    const w1Ids = new Set(w1.actions.map((action: { id: string }) => action.id));
    const w2Ids = new Set(w2.actions.map((action: { id: string }) => action.id));
    expect([...w1Ids].some((id) => w2Ids.has(id))).toBe(false);

    // Each workspace's section defaults point only at its own actions.
    for (const actionId of Object.values<string>(w1.sectionDefaults)) {
      expect(w1Ids.has(actionId)).toBe(true);
    }
    for (const actionId of Object.values<string>(w2.sectionDefaults)) {
      expect(w2Ids.has(actionId)).toBe(true);
    }
  });

  it('omits org from the provider binding when the github binding had none', () => {
    const state = { workspaces: [v6Workspace({ github: { accountLogin: 'personal' } })] };

    const migrated = migrateWorkspaceState(state, 6) as { workspaces: any[] };

    // toEqual alone would pass even if `org: undefined` snuck in — assert the
    // key is truly absent, not merely undefined-valued.
    expect(migrated.workspaces[0].provider).toEqual({ id: 'github', accountLogin: 'personal' });
    expect(migrated.workspaces[0].provider).not.toHaveProperty('org');
  });

  it('leaves a local-only workspace byte-for-byte alone apart from the two empty fields', () => {
    const input = v6Workspace({ sessions: [v6Session()] });

    const migrated = migrateWorkspaceState({ workspaces: [input] }, 6) as { workspaces: any[] };

    // Key order matters here: JSON.stringify is how the file is written, and
    // "identical apart from the new fields" is the spec's promise; the v8
    // rung, run at the end of the same ladder, adds the empty label list.
    expect(JSON.stringify(migrated.workspaces[0])).toBe(
      JSON.stringify({ ...input, actions: [], sectionDefaults: {}, labels: [] }),
    );
    expect(migrated.workspaces[0]).not.toHaveProperty('provider');
  });

  it('backfills workItemAction by item type: Review for PRs, Implement for issues', () => {
    const pr = { provider: 'github', repo: 'sprocket/catalog-portal', type: 'pr', number: 51 };
    const issue = {
      provider: 'github',
      repo: 'sprocket/media-upload-api',
      type: 'issue',
      number: 87,
    };
    const state = {
      workspaces: [
        v6Workspace({
          github: { accountLogin: 'JaviDev' },
          sessions: [
            v6Session({ id: 's-pr', workItem: pr }),
            v6Session({ id: 's-issue', workItem: issue }),
            v6Session({ id: 's-kept', workItem: pr, workItemAction: 'Fix CI' }),
            v6Session({ id: 's-plain' }),
          ],
        }),
      ],
    };

    const migrated = migrateWorkspaceState(state, 6) as { workspaces: any[] };
    const [prSession, issueSession, keptSession, plainSession] = migrated.workspaces[0].sessions;

    expect(prSession.workItemAction).toBe('Review');
    expect(issueSession.workItemAction).toBe('Implement');
    // A name already on the record is history, not something to rewrite.
    expect(keptSession.workItemAction).toBe('Fix CI');
    expect(plainSession).not.toHaveProperty('workItemAction');
  });

  it('does not reseed a workspace that somehow already carries actions', () => {
    const existing = [{ id: 'a1', name: 'Mine', appliesTo: ['pr'], prompt: 'Do the thing.' }];
    const state = {
      workspaces: [
        v6Workspace({
          github: { accountLogin: 'JaviDev' },
          actions: existing,
          sectionDefaults: { waiting: 'a1' },
        }),
      ],
    };

    const migrated = migrateWorkspaceState(state, 6) as { workspaces: any[] };

    expect(migrated.workspaces[0].actions).toEqual(existing);
    expect(migrated.workspaces[0].sectionDefaults).toEqual({ waiting: 'a1' });
  });

  it('leaves an already-v7 bound workspace untouched at version 7', () => {
    const workspace = {
      ...v6Workspace(),
      provider: { id: 'github', accountLogin: 'JaviDev', org: 'sprocket' },
      actions: [{ id: 'a1', name: 'Review', appliesTo: ['pr'], prompt: 'Review it.' }],
      sectionDefaults: { 'needs-your-review': 'a1' },
      sessions: [
        v6Session({
          workItem: { provider: 'github', repo: 'sprocket/catalog-portal', type: 'pr', number: 51 },
          workItemAction: 'Review',
        }),
      ],
    };

    const migrated = migrateWorkspaceState({ workspaces: [workspace] }, 7) as { workspaces: any[] };

    // v8 gains only the empty label list; everything else round-trips.
    expect(migrated.workspaces[0]).toEqual({ ...workspace, labels: [] });
  });
});

describe('migrateWorkspaceState v7 -> v8', () => {
  const session = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    workspaceId: 'w1',
    instanceId: `i-${id}`,
    claudeSessionId: `c-${id}`,
    hasStarted: true,
    harnessId: 'claude',
    scopeId: 'sc',
    kind: 'interactive',
    createdAt: 1,
    lastActiveAt: 1,
    ...extra,
  });
  const group = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    createdAt: 1,
    ...extra,
  });
  const workspaceOf = (groups: unknown[], sessions: unknown[]) => ({
    id: 'w1',
    name: 'W',
    defaultHarnessId: 'claude',
    scopes: [],
    groups,
    actions: [],
    sectionDefaults: {},
    sessions,
    createdAt: 1,
    updatedAt: 1,
  });
  const run = (ws: unknown, from = 7) =>
    (migrateWorkspaceState({ workspaces: [ws] }, from) as { workspaces: any[] }).workspaces[0];

  it('names a nested group by its ancestor path and gives its sessions every ancestor label', () => {
    const migrated = run(
      workspaceOf(
        [
          group('g-root', { name: 'Platform', emoji: '🏗' }),
          group('g-mid', { name: 'API', parentGroupId: 'g-root' }),
          group('g-leaf', { name: 'Auth', parentGroupId: 'g-mid' }),
        ],
        [session('s1', { groupId: 'g-leaf' }), session('s2', { groupId: 'g-root' })],
      ),
    );

    expect(migrated.labels).toEqual([
      { id: 'g-root', name: 'Platform', emoji: '🏗' },
      { id: 'g-mid', name: 'Platform / API' },
      { id: 'g-leaf', name: 'Platform / API / Auth' },
    ]);
    expect(migrated.sessions[0].labelIds).toEqual(['g-leaf', 'g-mid', 'g-root']);
    expect(migrated.sessions[1].labelIds).toEqual(['g-root']);
  });

  it('makes a conductor the parent of the other members of its group, and not of itself', () => {
    const migrated = run(
      workspaceOf(
        [group('g1', { conductorSessionId: 'cond' })],
        [
          session('cond', { kind: 'conductor', groupId: 'g1' }),
          session('w-a', { groupId: 'g1' }),
          session('w-b', { groupId: 'g1' }),
          session('elsewhere'),
        ],
      ),
    );
    const byId = Object.fromEntries(migrated.sessions.map((s: any) => [s.id, s]));

    expect(byId['w-a'].parentSessionId).toBe('cond');
    expect(byId['w-b'].parentSessionId).toBe('cond');
    expect(byId.cond).not.toHaveProperty('parentSessionId');
    expect(byId.cond.kind).toBe('conductor');
    expect(byId.cond.labelIds).toEqual(['g1']);
    expect(byId.elsewhere).not.toHaveProperty('parentSessionId');
  });

  it('turns an archived group with members into a label', () => {
    const migrated = run(
      workspaceOf(
        [group('old', { name: 'Old', archivedAt: 9 })],
        [session('s1', { groupId: 'old' })],
      ),
    );

    expect(migrated.labels).toEqual([{ id: 'old', name: 'Old' }]);
    expect(migrated.sessions[0].labelIds).toEqual(['old']);
  });

  it('skips an archived group with no members, but keeps an empty live one', () => {
    const migrated = run(
      workspaceOf([group('dead', { archivedAt: 9 }), group('empty')], [session('s1')]),
    );

    expect(migrated.labels).toEqual([{ id: 'empty', name: 'empty' }]);
  });

  it('keeps an archived ancestor of a member group, so no session names a label that is not there', () => {
    const migrated = run(
      workspaceOf(
        [
          group('parent', { name: 'P', archivedAt: 9 }),
          group('child', { name: 'C', parentGroupId: 'parent' }),
        ],
        [session('s1', { groupId: 'child' })],
      ),
    );

    expect(migrated.labels.map((l: any) => l.id)).toEqual(['parent', 'child']);
    expect(migrated.sessions[0].labelIds).toEqual(['child', 'parent']);
  });

  it('leaves an ungrouped session with no labels and no parent, byte for byte', () => {
    const plain = session('s1');
    const migrated = run(workspaceOf([group('g1', { conductorSessionId: 'cond' })], [plain]));

    expect(migrated.sessions[0]).toEqual(plain);
    expect(migrated.sessions[0]).not.toHaveProperty('labelIds');
    expect(migrated.sessions[0]).not.toHaveProperty('parentSessionId');
  });

  it('leaves members parentless when the conductor no longer exists', () => {
    const migrated = run(
      workspaceOf(
        [group('g1', { conductorSessionId: 'deleted' })],
        [session('s1', { groupId: 'g1' })],
      ),
    );

    expect(migrated.sessions[0]).not.toHaveProperty('parentSessionId');
    expect(migrated.sessions[0].labelIds).toEqual(['g1']);
  });

  it('ignores a groupId that names no group, rather than inventing a label for it', () => {
    const migrated = run(workspaceOf([], [session('s1', { groupId: 'ghost' })]));

    expect(migrated.labels).toEqual([]);
    expect(migrated.sessions[0]).not.toHaveProperty('labelIds');
  });

  it('survives a parentGroupId cycle and a dangling parent', () => {
    const migrated = run(
      workspaceOf(
        [
          group('a', { parentGroupId: 'b' }),
          group('b', { parentGroupId: 'a' }),
          group('c', { parentGroupId: 'missing' }),
        ],
        [session('s1', { groupId: 'a' }), session('s2', { groupId: 'c' })],
      ),
    );

    expect(migrated.sessions[0].labelIds.sort()).toEqual(['a', 'b']);
    expect(migrated.sessions[1].labelIds).toEqual(['c']);
    expect(migrated.labels.find((l: any) => l.id === 'c').name).toBe('c');
  });

  it('is idempotent: a second run changes nothing', () => {
    const input = workspaceOf(
      [
        group('g-root', { name: 'Platform' }),
        group('g-leaf', { name: 'Auth', parentGroupId: 'g-root', conductorSessionId: 'cond' }),
        group('old', { archivedAt: 9 }),
      ],
      [
        session('cond', { kind: 'conductor', groupId: 'g-leaf' }),
        session('w', { groupId: 'g-leaf' }),
        session('free'),
      ],
    );
    const once = run(input);
    const twice = run(once);

    expect(twice).toEqual(once);
  });

  it('does not overwrite a parent or label ids that are already there', () => {
    const migrated = run(
      workspaceOf(
        [group('g1', { conductorSessionId: 'cond' })],
        [
          session('cond', { kind: 'conductor' }),
          session('s1', { groupId: 'g1', parentSessionId: 'other', labelIds: ['mine'] }),
        ],
      ),
    );

    expect(migrated.sessions[1].parentSessionId).toBe('other');
    expect(migrated.sessions[1].labelIds).toEqual(['mine', 'g1']);
  });

  it('keeps the group model: groups, groupId and conductorSessionId survive untouched', () => {
    const groups = [group('g1', { conductorSessionId: 'cond' })];
    const migrated = run(
      workspaceOf(groups, [
        session('cond', { kind: 'conductor', groupId: 'g1' }),
        session('s1', { groupId: 'g1' }),
      ]),
    );

    expect(migrated.groups).toEqual(groups);
    expect(migrated.sessions[0].groupId).toBe('g1');
    expect(migrated.sessions[1].groupId).toBe('g1');
  });

  it('is idempotent over the records the runtime writers create', () => {
    // What createConductor and ConductorTools now write: the label shares the
    // group's id, the conductor and its worker carry it, the worker is parented.
    const created = workspaceOf(
      [group('g1', { conductorSessionId: 'cond' })],
      [
        session('cond', { kind: 'conductor', groupId: 'g1', labelIds: ['g1'] }),
        session('w-a', { groupId: 'g1', labelIds: ['g1'], parentSessionId: 'cond' }),
      ],
    );
    (created as any).labels = [{ id: 'g1', name: 'g1' }];

    const once = run(created);
    const twice = run(once);

    expect(once.labels).toEqual([{ id: 'g1', name: 'g1' }]);
    expect(twice).toEqual(once);
    expect(once.sessions[0].labelIds).toEqual(['g1']);
    expect(once.sessions[1].labelIds).toEqual(['g1']);
    expect(once.sessions[1].parentSessionId).toBe('cond');
  });

  it('does not mutate its input', () => {
    const input = workspaceOf([group('g1')], [session('s1', { groupId: 'g1' })]);
    const snapshot = JSON.parse(JSON.stringify(input));
    run(input);
    expect(input).toEqual(snapshot);
  });

  it('runs at the end of the ladder for state older than v7, and not at all for v8', () => {
    const v6 = {
      ...workspaceOf([group('g1')], [session('s1', { groupId: 'g1' })]),
    };
    expect(run(v6, 6).sessions[0].labelIds).toEqual(['g1']);
    const v8 = { ...workspaceOf([group('g1')], [session('s1', { groupId: 'g1' })]) };
    expect(run(v8, 8)).not.toHaveProperty('labels');
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
    expect(workspace.provider).toBeUndefined();
    expect(workspace.actions).toEqual([]);
    expect(workspace.sectionDefaults).toEqual({});
  });
});

describe('switchedSession', () => {
  it("drops a step's grants with its model, and keeps its tool policy and cap", () => {
    const session = {
      ...createSessionRecord({
        name: 'catalog-review · look',
        workspaceId: 'w1',
        instanceId: 'i1',
        harnessId: 'claude-work',
        model: 'haiku',
        scopeId: 's1',
        toolPolicy: 'read-only',
        maxTurns: 6,
        grants: {
          driverId: 'claude',
          servers: [{ name: 'grafana' }],
          skills: [],
          strict: true,
          allowedTools: ['mcp__grafana__*'],
        },
      }),
      agentCwd: '/elsewhere',
    } as Session;
    const switched = switchedSession(session, {
      harnessId: 'claude-personal',
      claudeSessionId: 'new-id',
      hasStarted: true,
    });
    expect(switched).not.toHaveProperty('grants');
    expect(switched).not.toHaveProperty('model');
    expect(switched).not.toHaveProperty('agentCwd');
    expect(switched).toMatchObject({
      toolPolicy: 'read-only',
      maxTurns: 6,
      harnessId: 'claude-personal',
    });
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
  };

  it('primaryScope is the first scope', () => {
    expect(primaryScope(workspace)?.path).toBe('/code/consola');
  });

  it('scopeForSession resolves the session scope and falls back to primary', () => {
    const scope = workspace.scopes[0];
    expect(scopeForSession(workspace, { scopeId: scope.id })?.id).toBe(scope.id);
    expect(scopeForSession(workspace, { scopeId: 'gone' })?.id).toBe(scope.id);
    expect(scopeForSession(workspace, undefined)?.id).toBe(scope.id);
  });

  it("checkoutPathForSession prefers the session's own checkout over its scope's", () => {
    const scope = workspace.scopes[0];
    const tree = '/home/me/.consola/worktrees/consola-session-1';
    expect(checkoutPathForSession(workspace, { scopeId: scope.id, cwd: tree })).toBe(tree);
    expect(checkoutPathForSession(workspace, { scopeId: scope.id })).toBe('/code/consola');
    expect(checkoutPathForSession(workspace, undefined)).toBe('/code/consola');
  });

  it('checkoutPathForSession follows an agent that moved itself into another checkout', () => {
    const scope = workspace.scopes[0];
    const entered = '/code/consola/.claude/worktrees/assistant';
    expect(checkoutPathForSession(workspace, { scopeId: scope.id, agentCwd: entered })).toBe(
      entered,
    );
    // Over a checkout Consola launched it in, too: the agent left that one.
    expect(
      checkoutPathForSession(workspace, {
        scopeId: scope.id,
        cwd: '/home/me/.consola/worktrees/consola-session-1',
        agentCwd: entered,
      }),
    ).toBe(entered);
  });
});
