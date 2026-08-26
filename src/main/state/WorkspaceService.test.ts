import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonStateFile } from './JsonStateFile';
import { WorkspaceService, type WorkspaceStateFile } from './WorkspaceService';
import type { Workspace } from '../../shared/workspace';
import type { WorkItemAction } from '../../shared/workItemActions';

let dir: string;
let service: WorkspaceService;

function build(): WorkspaceService {
  const file = new JsonStateFile<WorkspaceStateFile>(path.join(dir, 'workspaces.json'));
  const built = new WorkspaceService(file);
  built.load();
  return built;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consola-ws-'));
  service = build();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('WorkspaceService', () => {
  it('starts empty and reports that nothing has been imported yet', () => {
    expect(service.hasState()).toBe(false);
    expect(service.getAll()).toEqual([]);
  });

  it('persists a created workspace across a reload', () => {
    service.createWorkspace('consola', '/code/consola', true);

    const reloaded = build();

    expect(reloaded.getAll()).toHaveLength(1);
    expect(reloaded.getAll()[0].name).toBe('consola');
    expect(reloaded.hasState()).toBe(true);
  });

  it('notifies listeners on every mutation', () => {
    const listener = vi.fn();
    service.onChange(listener);

    const workspace = service.createWorkspace('consola', '/code/consola', true);
    service.updateWorkspace(workspace.id, { name: 'renamed' });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1][0][0].name).toBe('renamed');
  });

  it('gives a new session its own conversation id and marks it unstarted', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);

    const session = service.createSession(workspace.id, {
      name: 'New Session',
      workspaceId: workspace.id,
      instanceId: 'instance-1',
      harnessId: 'default',
      scopeId: workspace.scopes[0].id,
    });

    expect(session?.claudeSessionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(session?.hasStarted).toBe(false);
    expect(service.getAll()[0].sessions).toHaveLength(1);
  });

  it('returns undefined rather than throwing for a session in a missing workspace', () => {
    const session = service.createSession('nope', {
      name: 'New Session',
      workspaceId: 'nope',
      instanceId: 'instance-1',
      harnessId: 'default',
      scopeId: 'nope',
    });

    expect(session).toBeUndefined();
  });

  it('drops a workspace and its sessions together', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    service.createSession(workspace.id, {
      name: 'New Session',
      workspaceId: workspace.id,
      instanceId: 'instance-1',
      harnessId: 'default',
      scopeId: workspace.scopes[0].id,
    });

    service.deleteWorkspace(workspace.id);

    expect(service.getAll()).toEqual([]);
  });

  it('accepts an import once and ignores every later one', () => {
    const imported = service.importState(
      [
        {
          id: 'w1',
          name: 'consola',
          path: '/code/consola',
          isGitRepo: true,
          defaultHarnessId: 'default',
          sessions: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ] as unknown as Workspace[],
      5
    );

    expect(imported).toBe(true);
    expect(service.getAll()).toHaveLength(1);
    expect(service.getAll()[0].scopes[0].path).toBe('/code/consola');

    const second = service.importState(
      [
        {
          id: 'w2',
          name: 'other',
          path: '/code/other',
          isGitRepo: false,
          defaultHarnessId: 'default',
          sessions: [],
          createdAt: 2,
          updatedAt: 2,
        },
      ] as unknown as Workspace[],
      5
    );

    expect(second).toBe(false);
    expect(service.getAll()).toHaveLength(1);
    expect(service.getAll()[0].id).toBe('w1');
  });

  it('treats an imported empty list as state, so a second import cannot replace it', () => {
    expect(service.importState([], 5)).toBe(true);

    const second = service.importState(
      [
        {
          id: 'w1',
          name: 'late',
          path: '/code/late',
          isGitRepo: false,
          defaultHarnessId: 'default',
          sessions: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ] as unknown as Workspace[],
      5
    );

    expect(second).toBe(false);
    expect(service.getAll()).toEqual([]);
  });

  it('refuses an import once anything has been written, even on a fresh install', () => {
    const kept = service.createWorkspace('consola', '/code/consola', true);

    const accepted = service.importState(
      [
        {
          id: 'stale',
          name: 'stale',
          path: '/code/stale',
          isGitRepo: false,
          defaultHarnessId: 'default',
          sessions: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ] as unknown as Workspace[],
      5
    );

    expect(accepted).toBe(false);
    expect(service.getAll().map((entry) => entry.id)).toEqual([kept.id]);
  });

  it('does not adopt state that failed to reach disk', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);

    const file = new JsonStateFile<WorkspaceStateFile>(path.join(dir, 'workspaces.json'));
    const failing = new WorkspaceService(file);
    failing.load();
    vi.spyOn(file, 'write').mockImplementation(() => {
      throw new Error('ENOSPC');
    });

    expect(() => failing.createWorkspace('other', '/code/other', false)).toThrow('ENOSPC');

    // The caller saw the failure; nothing else may see the phantom record.
    expect(failing.getAll().map((entry) => entry.id)).toEqual([workspace.id]);
  });

  it('runs the migration ladder on imported state', () => {
    service.importState(
      [
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
              lastActiveAt: 1,
            },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
      4
    );

    expect(service.getAll()[0].defaultHarnessId).toBe('default');
    expect(service.getAll()[0].sessions[0].harnessId).toBe('default');
    expect(service.getAll()[0].sessions[0].scopeId).toBe(service.getAll()[0].scopes[0].id);

    // v7 reached through the same ladder: empty verbs for a local-only import.
    expect(service.getAll()[0].actions).toEqual([]);
    expect(service.getAll()[0].sectionDefaults).toEqual({});
    expect(service.getAll()[0]).not.toHaveProperty('provider');
  });

  it('addScope appends a scope and persists it', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);

    const scope = service.addScope(workspace.id, {
      name: 'docs',
      path: '/code/consola/docs',
      isGitRepo: false,
    });

    expect(scope.id).not.toBe(workspace.scopes[0].id);
    const reloaded = build();
    expect(reloaded.getAll()[0].scopes.map((s) => s.path)).toEqual([
      '/code/consola',
      '/code/consola/docs',
    ]);
  });

  it('addScope throws for an unknown workspace', () => {
    expect(() =>
      service.addScope('nope', { name: 'x', path: '/x', isGitRepo: false })
    ).toThrow();
  });

  it('removeScope drops an unreferenced scope', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const scope = service.addScope(workspace.id, {
      name: 'docs',
      path: '/code/consola/docs',
      isGitRepo: false,
    });

    service.removeScope(workspace.id, scope.id);

    expect(service.getAll()[0].scopes).toHaveLength(1);
  });

  it('removeScope refuses while a session references the scope', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const scope = workspace.scopes[0];
    service.createSession(workspace.id, {
      name: 'New Session',
      workspaceId: workspace.id,
      instanceId: 'instance-1',
      harnessId: 'default',
      scopeId: scope.id,
    });

    // The pointer must outlive its referents: unlike harnesses there is no
    // archive tier — a scope is only a pointer.
    expect(() => service.removeScope(workspace.id, scope.id)).toThrow(/session/i);
    expect(service.getAll()[0].scopes).toHaveLength(1);
  });

  it('removeScope refuses to drop the last scope', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const scope = workspace.scopes[0];

    expect(() => service.removeScope(workspace.id, scope.id)).toThrow(/at least one scope/i);
    expect(service.getAll()[0].scopes).toHaveLength(1);
  });

  it('updateScope renames a scope in place, leaving siblings and identity untouched', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const other = service.addScope(workspace.id, {
      name: 'docs',
      path: '/code/consola/docs',
      isGitRepo: false,
    });

    service.updateScope(workspace.id, workspace.scopes[0].id, { name: 'renamed' });

    const scopes = build().getAll()[0].scopes;
    expect(scopes.find((s) => s.id === workspace.scopes[0].id)?.name).toBe('renamed');
    expect(scopes.find((s) => s.id === workspace.scopes[0].id)?.path).toBe('/code/consola');
    expect(scopes.find((s) => s.id === other.id)?.name).toBe('docs');
  });

  it('updateScope is a no-op for an unknown workspace or scope', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);

    service.updateScope('nope', workspace.scopes[0].id, { name: 'x' });
    service.updateScope(workspace.id, 'nope', { name: 'x' });

    expect(service.getAll()[0].scopes[0].name).toBe('consola');
  });

  it('createSession returns undefined for an unknown scope', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);

    const session = service.createSession(workspace.id, {
      name: 'New Session',
      workspaceId: workspace.id,
      instanceId: 'instance-1',
      harnessId: 'default',
      scopeId: 'not-a-scope',
    });

    expect(session).toBeUndefined();
    expect(service.getAll()[0].sessions).toEqual([]);
  });

  const pr51 = { provider: 'github' as const, repo: 'sympower/controller-app', type: 'pr' as const, number: 51 };
  const issue87 = { provider: 'github' as const, repo: 'sympower/msa-resource-bff', type: 'issue' as const, number: 87 };

  function sessionIn(workspace: Workspace, extra: Partial<Parameters<typeof service.createSession>[1]> = {}) {
    const session = service.createSession(workspace.id, {
      name: 'By hand',
      workspaceId: workspace.id,
      instanceId: 'instance-1',
      harnessId: 'default',
      scopeId: workspace.scopes[0].id,
      ...extra,
    });
    if (!session) throw new Error('fixture session was refused');
    return session;
  }

  it('updateSession links an unlinked session and unlinks it again', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const session = sessionIn(workspace);

    service.updateSession(workspace.id, session.id, { workItem: pr51 });
    expect(service.getAll()[0].sessions[0].workItem).toEqual(pr51);
    // Linking never records an action: the session was not started as one.
    expect(service.getAll()[0].sessions[0]).not.toHaveProperty('workItemAction');

    service.updateSession(workspace.id, session.id, { workItem: undefined });
    // Absent on disk, not undefined-valued: JSON.stringify drops the key.
    expect(build().getAll()[0].sessions[0]).not.toHaveProperty('workItem');
  });

  it('updateSession treats re-linking to the same item as a no-op success', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const session = sessionIn(workspace, { workItem: pr51 });
    const listener = vi.fn();
    service.onChange(listener);

    expect(() =>
      service.updateSession(workspace.id, session.id, { workItem: { ...pr51, repo: 'Sympower/Controller-App' } })
    ).not.toThrow();

    expect(listener).not.toHaveBeenCalled();
    expect(service.getAll()[0].sessions[0].workItem).toEqual(pr51);
  });

  it('updateSession refuses to link a conductor session', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const session = sessionIn(workspace, { kind: 'conductor' });

    expect(() => service.updateSession(workspace.id, session.id, { workItem: pr51 })).toThrow(
      'A conductor session cannot be linked to a work item.'
    );
    expect(service.getAll()[0].sessions[0]).not.toHaveProperty('workItem');
  });

  it('updateSession refuses to link a session already linked to a different item', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const session = sessionIn(workspace, { workItem: pr51 });

    expect(() => service.updateSession(workspace.id, session.id, { workItem: issue87 })).toThrow(
      /already linked to sympower\/controller-app pr #51/
    );
    expect(service.getAll()[0].sessions[0].workItem).toEqual(pr51);
  });

  it('updateSession unlinking a launched session drops its action label with it', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const session = sessionIn(workspace, { workItem: pr51, workItemAction: 'Review' });

    service.updateSession(workspace.id, session.id, { workItem: undefined });

    // The label described a launch this session no longer belongs to.
    expect(service.getAll()[0].sessions[0]).not.toHaveProperty('workItem');
    expect(service.getAll()[0].sessions[0]).not.toHaveProperty('workItemAction');
  });

  it('setProviderBinding sets, replaces and clears the binding, seeding actions once', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    expect(workspace.actions).toEqual([]);

    service.setProviderBinding(workspace.id, { id: 'github', accountLogin: 'SymJavi', org: 'sympower' });
    const bound = service.getAll()[0];
    expect(bound.provider).toEqual({ id: 'github', accountLogin: 'SymJavi', org: 'sympower' });
    // Binding is what switches the Inbox on, so it is what seeds the verbs.
    expect(bound.actions.map((action) => action.name)).toEqual([
      'Review', 'Address review', 'Fix CI', 'Implement', 'Triage',
    ]);
    expect(Object.keys(bound.sectionDefaults).sort()).toEqual([
      'issues', 'needs-action', 'needs-team-review', 'needs-your-review', 'waiting',
    ]);

    service.setProviderBinding(workspace.id, { id: 'github', accountLogin: 'personal' });
    expect(service.getAll()[0].provider).toEqual({ id: 'github', accountLogin: 'personal' });
    // Rebinding keeps the actions the user may have edited since.
    expect(service.getAll()[0].actions).toEqual(bound.actions);

    service.setProviderBinding(workspace.id, null);
    // Absent, not null: absence is what "pure local workspace" means on disk.
    expect(service.getAll()[0]).not.toHaveProperty('provider');
    // Unbinding clears only the binding — the actions are the user's.
    expect(service.getAll()[0].actions).toEqual(bound.actions);
    expect(service.getAll()[0].sectionDefaults).toEqual(bound.sectionDefaults);

    const reloaded = build();
    expect(reloaded.getAll()[0]).not.toHaveProperty('provider');
    expect(reloaded.getAll()[0].actions).toEqual(bound.actions);
  });

  it('setProviderBinding does not reseed a workspace that already has actions', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const mine: WorkItemAction[] = [{ id: 'a1', name: 'Mine', appliesTo: ['pr'], prompt: 'Do the thing.' }];
    service.setActions(workspace.id, mine, { waiting: 'a1' });

    service.setProviderBinding(workspace.id, { id: 'github', accountLogin: 'SymJavi' });

    expect(service.getAll()[0].actions).toEqual(mine);
    expect(service.getAll()[0].sectionDefaults).toEqual({ waiting: 'a1' });
  });

  it('setActions replaces actions and defaults in one write and persists them', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const actions: WorkItemAction[] = [
      { id: 'a1', name: 'Review', appliesTo: ['pr'], prompt: 'Review it.' },
      { id: 'a2', name: 'Triage', appliesTo: ['issue'], prompt: 'Triage it.' },
    ];

    service.setActions(workspace.id, actions, { 'needs-your-review': 'a1', issues: 'a2' });

    const reloaded = build().getAll()[0];
    expect(reloaded.actions).toEqual(actions);
    expect(reloaded.sectionDefaults).toEqual({ 'needs-your-review': 'a1', issues: 'a2' });
  });

  it('setActions rejects an invalid write with its message and commits nothing', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const listener = vi.fn();
    service.onChange(listener);
    const actions: WorkItemAction[] = [{ id: 'a1', name: 'Review', appliesTo: ['pr'], prompt: 'Review it.' }];

    expect(() => service.setActions(workspace.id, actions, { issues: 'a1' })).toThrow(
      '"Review" cannot be the default for "issues": it does not apply to issues.'
    );

    expect(listener).not.toHaveBeenCalled();
    expect(service.getAll()[0].actions).toEqual([]);
  });

  it('setActions keeps only the record fields — an IPC payload cannot ride extra keys in', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const payload = [
      { id: 'a1', name: 'Review', appliesTo: ['pr'], prompt: 'Review it.', extra: 'nope' },
    ] as unknown as WorkItemAction[];

    service.setActions(workspace.id, payload, {});

    expect(service.getAll()[0].actions).toEqual([
      { id: 'a1', name: 'Review', appliesTo: ['pr'], prompt: 'Review it.' },
    ]);
  });

  it('createGroup and archiveGroup manage the group list', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);

    const group = service.createGroup(workspace.id, { name: 'bump lodash' });
    expect(service.getAll()[0].groups[0].name).toBe('bump lodash');
    expect(service.getAll()[0].groups[0].archivedAt).toBeUndefined();

    service.archiveGroup(workspace.id, group.id);
    expect(service.getAll()[0].groups[0].archivedAt).toEqual(expect.any(Number));

    const reloaded = build();
    expect(reloaded.getAll()[0].groups[0].archivedAt).toEqual(expect.any(Number));
  });

  it('createGroup carries parent and conductor references', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const parent = service.createGroup(workspace.id, { name: 'parent' });

    const child = service.createGroup(workspace.id, {
      name: 'child',
      parentGroupId: parent.id,
      conductorSessionId: 'sess-1',
    });

    expect(child.parentGroupId).toBe(parent.id);
    expect(child.conductorSessionId).toBe('sess-1');
  });

  it('updates a group in place, leaving its siblings untouched', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const group = service.createGroup(workspace.id, { name: 'symbalance-api' });
    const other = service.createGroup(workspace.id, { name: 'untouched' });

    service.updateGroup(workspace.id, group.id, { conductorSessionId: 'cond-1' });

    const groups = build().getAll()[0].groups;
    expect(groups.find((g) => g.id === group.id)?.conductorSessionId).toBe('cond-1');
    expect(groups.find((g) => g.id === other.id)?.conductorSessionId).toBeUndefined();
  });

  it('archives a group via updateGroup', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const group = service.createGroup(workspace.id, { name: 'doomed' });

    service.updateGroup(workspace.id, group.id, { archivedAt: 123 });

    expect(build().getAll()[0].groups.find((g) => g.id === group.id)?.archivedAt).toBe(123);
  });

  it('renames a group via updateGroup without touching its lifecycle fields', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const group = service.createGroup(workspace.id, {
      name: 'old name',
      conductorSessionId: 'cond-1',
    });

    service.updateGroup(workspace.id, group.id, { name: 'new name' });

    const reloaded = build().getAll()[0].groups.find((g) => g.id === group.id);
    expect(reloaded?.name).toBe('new name');
    expect(reloaded?.conductorSessionId).toBe('cond-1');
    expect(reloaded?.archivedAt).toBeUndefined();
  });

  it('restoreGroup persists as absence, indistinguishable from never archived', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const group = service.createGroup(workspace.id, { name: 'phoenix' });
    service.archiveGroup(workspace.id, group.id);

    service.restoreGroup(workspace.id, group.id);

    // Absent, not null or undefined-valued: JSON.stringify drops the
    // explicitly-undefined key on persist, so a restored group round-trips
    // exactly like one that was never archived.
    const reloaded = build().getAll()[0].groups.find((g) => g.id === group.id);
    expect(reloaded).not.toHaveProperty('archivedAt');
  });
});
