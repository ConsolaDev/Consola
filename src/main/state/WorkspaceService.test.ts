import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonStateFile } from './JsonStateFile';
import { WorkspaceService, type WorkspaceStateFile } from './WorkspaceService';
import type { Workspace } from '../../shared/workspace';

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

  it('setGitHubBinding sets, replaces and clears the binding', () => {
    const workspace = service.createWorkspace('consola', '/code/consola', true);

    service.setGitHubBinding(workspace.id, { accountLogin: 'SymJavi', org: 'sympower' });
    expect(service.getAll()[0].github).toEqual({ accountLogin: 'SymJavi', org: 'sympower' });

    service.setGitHubBinding(workspace.id, { accountLogin: 'personal' });
    expect(service.getAll()[0].github).toEqual({ accountLogin: 'personal' });

    service.setGitHubBinding(workspace.id, null);
    // Absent, not null: absence is what "pure local workspace" means on disk.
    expect(service.getAll()[0]).not.toHaveProperty('github');

    const reloaded = build();
    expect(reloaded.getAll()[0]).not.toHaveProperty('github');
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
