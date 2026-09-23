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
  it('moves workspaces in both directions and persists and broadcasts their order without changing records', () => {
    const a = service.createWorkspace('A', '/a', false);
    const b = service.createWorkspace('B', '/b', false);
    const c = service.createWorkspace('C', '/c', false);
    const listener = vi.fn();
    service.onChange(listener);

    service.moveWorkspace(c.id, a.id);
    expect(service.getAll()).toEqual([c, a, b]);
    expect(listener).toHaveBeenLastCalledWith([c, a, b]);
    expect(build().getAll()).toEqual([c, a, b]);
    service.moveWorkspace(c.id, null);
    expect(build().getAll()).toEqual([a, b, c]);
  });

  it('applies a move to current records, retaining workspaces created or renamed by other windows', () => {
    const a = service.createWorkspace('A', '/a', false);
    const b = service.createWorkspace('B', '/b', false);
    const c = service.createWorkspace('Added while dragging', '/c', false);
    service.updateWorkspace(a.id, { name: 'Renamed while dragging' });
    service.moveWorkspace(b.id, a.id);
    expect(service.getAll().map(workspace => workspace.id)).toEqual([b.id, a.id, c.id]);
    expect(service.getAll()[1].name).toBe('Renamed while dragging');
  });

  it('ignores unchanged moves and records deleted while dragging; rejects malformed moves', () => {
    const a = service.createWorkspace('A', '/a', false);
    const b = service.createWorkspace('B', '/b', false);
    const listener = vi.fn();
    service.onChange(listener);
    service.moveWorkspace(a.id, a.id);
    service.moveWorkspace(a.id, b.id);
    service.moveWorkspace(b.id, null);
    service.moveWorkspace('deleted', a.id);
    service.moveWorkspace(a.id, 'deleted');
    expect(() => service.moveWorkspace(a.id, undefined as unknown as null)).toThrow('Invalid workspace move');
    expect(listener).not.toHaveBeenCalled();
    expect(build().getAll()).toEqual([a, b]);
  });

  it('does not adopt or broadcast a reordered list when saving fails', () => {
    const a = service.createWorkspace('A', '/a', false);
    const b = service.createWorkspace('B', '/b', false);
    const listener = vi.fn();
    service.onChange(listener);
    const write = vi.spyOn(JsonStateFile.prototype, 'write').mockImplementation(() => { throw new Error('Disk full'); });
    try {
      expect(() => service.moveWorkspace(b.id, a.id)).toThrow('Disk full');
      expect(service.getAll()).toEqual([a, b]);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
    expect(build().getAll()).toEqual([a, b]);
  });

  it('persists and broadcasts icon changes independently of scopes, then resets across reloads', () => {
    const workspace = service.createWorkspace('Work', '/code/work', true);
    const other = service.createWorkspace('Personal', '/code/personal', false);
    const listener = vi.fn();
    service.onChange(listener);

    service.updateWorkspace(workspace.id, { icon: 'emoji-rocket' });
    expect(listener.mock.calls[0][0][0].icon).toBe('emoji-rocket');
    service.updateWorkspace(workspace.id, { name: 'Renamed' });
    const reloaded = build();
    expect(reloaded.getAll()[0]).toMatchObject({ icon: 'emoji-rocket', scopes: workspace.scopes });
    expect(reloaded.getAll()[1]).toEqual(other);

    reloaded.updateWorkspace(workspace.id, { icon: 'briefcase' });
    expect(build().getAll()[0].icon).toBe('briefcase');
    const image = {
      type: 'image' as const,
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    };
    reloaded.updateWorkspace(workspace.id, { icon: image });
    expect(build().getAll()[0].icon).toEqual(image);
    reloaded.updateWorkspace(workspace.id, { icon: undefined });
    expect(build().getAll()[0]).not.toHaveProperty('icon');
  });

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

  it('removeScope deletes all its sessions atomically, retaining groups and sessions in other scopes', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const scope = workspace.scopes[0];
    const otherScope = service.addScope(workspace.id, { name: 'docs', path: '/docs', isGitRepo: false });
    const otherWorkspace = service.createWorkspace('Other', '/other', false);
    const group = service.createGroup(workspace.id, { name: 'Shared group' });
    const child = service.createGroup(workspace.id, { name: 'Child', parentGroupId: group.id });
    const fields = {
      name: 'Session',
      workspaceId: workspace.id,
      harnessId: 'default',
      scopeId: scope.id,
    };
    service.createSession(workspace.id, { ...fields, instanceId: 'ungrouped' });
    service.createSession(workspace.id, { ...fields, instanceId: 'grouped', groupId: child.id });
    const conductor = service.createSession(workspace.id, {
      ...fields, instanceId: 'conductor', kind: 'conductor', groupId: group.id,
    })!;
    service.updateGroup(workspace.id, group.id, { conductorSessionId: conductor.id });
    const survivor = service.createSession(workspace.id, {
      ...fields, instanceId: 'survivor', scopeId: otherScope.id, groupId: group.id,
    });
    service.updateGroup(workspace.id, child.id, { conductorSessionId: survivor!.id });
    const listener = vi.fn();
    service.onChange(listener);

    service.removeScope(workspace.id, scope.id);

    expect(listener).toHaveBeenCalledTimes(1);
    const saved = build().getAll();
    expect(saved[0].scopes).toEqual([otherScope]);
    expect(saved[0].sessions).toEqual([survivor]);
    expect(saved[0].groups).toEqual([group, { ...child, conductorSessionId: survivor!.id }]);
    expect(saved[1]).toEqual(otherWorkspace);
    expect(listener).toHaveBeenCalledWith(saved);
  });

  it('removeScope leaves the scope, sessions and groups intact when persistence fails', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    service.addScope(workspace.id, { name: 'docs', path: '/docs', isGitRepo: false });
    const group = service.createGroup(workspace.id, { name: 'Group' });
    const session = service.createSession(workspace.id, {
      name: 'Session', workspaceId: workspace.id, instanceId: 'i1', harnessId: 'default',
      scopeId: workspace.scopes[0].id, groupId: group.id, kind: 'conductor',
    });
    service.updateGroup(workspace.id, group.id, { conductorSessionId: session!.id });
    const before = service.getAll();
    const listener = vi.fn();
    service.onChange(listener);
    const write = vi.spyOn(JsonStateFile.prototype, 'write').mockImplementation(() => { throw new Error('Disk full'); });
    try {
      expect(() => service.removeScope(workspace.id, workspace.scopes[0].id)).toThrow('Disk full');
      expect(service.getAll()).toEqual(before);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
    expect(build().getAll()).toEqual(before);
  });

  it('removeScope ignores an already removed scope', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const scope = service.addScope(workspace.id, { name: 'docs', path: '/docs', isGitRepo: false });
    service.removeScope(workspace.id, scope.id);
    const listener = vi.fn();
    service.onChange(listener);
    service.removeScope(workspace.id, scope.id);
    expect(listener).not.toHaveBeenCalled();
  });

  it('removes the last scope and its sessions, retaining the workspace and groups across reload', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const scope = workspace.scopes[0];
    const group = service.createGroup(workspace.id, { name: 'Work' });
    const fields = {
      name: 'Session', workspaceId: workspace.id, instanceId: 'i1', harnessId: 'default', scopeId: scope.id, groupId: group.id,
    };
    service.createSession(workspace.id, fields);

    service.removeScope(workspace.id, scope.id);

    const reloaded = build();
    expect(reloaded.getAll()).toEqual([{
      ...workspace, scopes: [], sessions: [], groups: [group], updatedAt: expect.any(Number),
    }]);
    expect(reloaded.createSession(workspace.id, fields)).toBeUndefined();
    const added = reloaded.addScope(workspace.id, {
      name: 'New scope', path: '/new', isGitRepo: false,
    });
    expect(reloaded.createSession(workspace.id, { ...fields, scopeId: added.id })).toMatchObject({
      scopeId: added.id, groupId: group.id,
    });
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

  it('relocates a scope and its nested session directories without losing session identity or history', () => {
    const workspace = service.createWorkspace('Project', '/old/project', false);
    const scope = workspace.scopes[0];
    const sibling = service.addScope(workspace.id, { name: 'Other', path: '/old/project/other', isGitRepo: false });
    const group = service.createGroup(workspace.id, { name: 'Work' });
    for (const [index, cwd] of [undefined, '/old/project', '/old/project/subdir', '/old/project-other', '/external/checkout'].entries()) {
      const session = service.createSession(workspace.id, {
        name: `Session ${index}`, workspaceId: workspace.id, instanceId: `instance-${index}`,
        harnessId: 'default', scopeId: scope.id, groupId: group.id, cwd,
      })!;
      service.updateSession(workspace.id, session.id, { hasStarted: true });
    }
    service.createSession(workspace.id, {
      name: 'Other scope', workspaceId: workspace.id, instanceId: 'other',
      harnessId: 'default', scopeId: sibling.id, cwd: '/old/project/other',
    });
    const before = service.getAll()[0];
    const destination = path.join(dir, 'moved');
    fs.mkdirSync(path.join(destination, '.git'), { recursive: true });

    service.updateScope(workspace.id, scope.id, { path: destination });

    const after = build().getAll()[0];
    expect(after.scopes).toEqual([{ ...scope, path: destination, isGitRepo: true }, sibling]);
    expect(after.groups).toEqual(before.groups);
    expect(after.sessions).toEqual(before.sessions.map((session, index) =>
      index === 1 ? { ...session, cwd: destination } :
      index === 2 ? { ...session, cwd: path.join(destination, 'subdir') } : session
    ));
  });

  it('rejects invalid destinations without changing persisted state', () => {
    const workspace = service.createWorkspace('Project', '/old/project', true);
    const file = path.join(dir, 'file');
    fs.writeFileSync(file, 'not a directory');
    const listener = vi.fn();
    service.onChange(listener);
    for (const destination of ['', 'relative/path', path.join(dir, 'missing'), file]) {
      expect(() => service.updateScope(workspace.id, workspace.scopes[0].id, {
        name: 'Must not change', path: destination,
      })).toThrow(/folder/i);
      expect(build().getAll()).toEqual([workspace]);
    }
    expect(listener).not.toHaveBeenCalled();
  });

  it('refreshes repository metadata when changing to a non-repository folder', () => {
    const workspace = service.createWorkspace('Project', '/old/project', true);
    service.updateScope(workspace.id, workspace.scopes[0].id, { path: dir });
    expect(build().getAll()[0].scopes[0]).toMatchObject({ path: dir, isGitRepo: false });
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

  it('setActions persists an action pointed at one of the workspace\'s groups', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const group = service.createGroup(workspace.id, { name: 'PR reviews' });
    const actions: WorkItemAction[] = [
      { id: 'a1', name: 'Review', appliesTo: ['pr'], prompt: 'Review it.', groupId: group.id },
    ];

    service.setActions(workspace.id, actions, {});

    expect(build().getAll()[0].actions).toEqual(actions);
  });

  it('setActions rejects an action pointed at a group the workspace does not have', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const actions: WorkItemAction[] = [
      { id: 'a1', name: 'Review', appliesTo: ['pr'], prompt: 'Review it.', groupId: 'g-gone' },
    ];

    expect(() => service.setActions(workspace.id, actions, {})).toThrow(
      '"Review" lands in a group that does not exist.'
    );
    expect(service.getAll()[0].actions).toEqual([]);
  });

  it('setActions accepts an archived group as a target — launching there restores it', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    const group = service.createGroup(workspace.id, { name: 'PR reviews' });
    service.archiveGroup(workspace.id, group.id);
    const actions: WorkItemAction[] = [
      { id: 'a1', name: 'Review', appliesTo: ['pr'], prompt: 'Review it.', groupId: group.id },
    ];

    service.setActions(workspace.id, actions, {});

    expect(service.getAll()[0].actions[0].groupId).toBe(group.id);
  });

  it('setActions leaves an unrouted action without a groupId key, so it round-trips as before', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);
    service.setActions(
      workspace.id,
      [{ id: 'a1', name: 'Review', appliesTo: ['pr'], prompt: 'Review it.' }],
      {}
    );

    expect(service.getAll()[0].actions[0]).not.toHaveProperty('groupId');
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
