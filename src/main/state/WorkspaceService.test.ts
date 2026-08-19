import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JsonStateFile } from './JsonStateFile';
import { WorkspaceService, type WorkspaceStateFile } from './WorkspaceService';

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
      ],
      5
    );

    expect(imported).toBe(true);
    expect(service.getAll()).toHaveLength(1);

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
      ],
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
      ],
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
      ],
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
  });
});
