import { describe, expect, it } from 'vitest';
import type { HarnessUpdates } from '../../shared/harness';
import {
  allowedGroupUpdates,
  allowedHarnessUpdates,
  allowedScopeUpdates,
  allowedSessionUpdates,
  allowedWorkspaceUpdates,
  type SessionUpdates,
} from './updateFilters';

describe('allowedHarnessUpdates', () => {
  it('passes through a normal update', () => {
    const result = allowedHarnessUpdates({ name: 'Work', accentColor: '#3b82f6' });

    expect(result).toEqual({ name: 'Work', accentColor: '#3b82f6' });
  });

  it('preserves an explicit binaryPath: undefined as an own key, so a clear reaches the service', () => {
    const result = allowedHarnessUpdates({ binaryPath: undefined });

    // Not `result.binaryPath === undefined` — that also passes when the key was
    // dropped entirely, which is exactly the bug that shipped.
    expect('binaryPath' in result).toBe(true);
    expect(result.binaryPath).toBeUndefined();
  });

  it('omits binaryPath entirely when the key is absent from the input', () => {
    const result = allowedHarnessUpdates({ name: 'Work' });

    expect('binaryPath' in result).toBe(false);
  });

  it('drops every forbidden field', () => {
    // Cast through `as unknown as HarnessUpdates` to model what IPC can
    // deliver once TypeScript's `Pick<>` is gone: a stale or untrusted
    // renderer is not held to the compile-time contract.
    const payload = {
      id: 'attacker-controlled',
      driverId: 'claude',
      isBuiltIn: true,
      archived: true,
      name: 'Legit rename',
    } as unknown as HarnessUpdates;

    const result = allowedHarnessUpdates(payload);

    expect(result).not.toHaveProperty('id');
    expect(result).not.toHaveProperty('driverId');
    expect(result).not.toHaveProperty('isBuiltIn');
    expect(result).not.toHaveProperty('archived');
    expect(result.name).toBe('Legit rename');
  });

  it('drops an explicit name: undefined rather than clobbering a real name', () => {
    const result = allowedHarnessUpdates({ name: undefined });

    expect('name' in result).toBe(false);
  });
});

describe('allowedWorkspaceUpdates', () => {
  it('drops forbidden fields', () => {
    const payload = {
      id: 'attacker-controlled',
      sessions: [],
      name: 'Legit rename',
    } as unknown as Parameters<typeof allowedWorkspaceUpdates>[0];

    const result = allowedWorkspaceUpdates(payload);

    expect(result).not.toHaveProperty('id');
    expect(result).not.toHaveProperty('sessions');
    expect(result.name).toBe('Legit rename');
  });

  it('drops an explicit name: undefined rather than clobbering a real name', () => {
    const result = allowedWorkspaceUpdates({ name: undefined });

    expect('name' in result).toBe(false);
  });
});

describe('allowedScopeUpdates', () => {
  it('passes a rename through', () => {
    expect(allowedScopeUpdates({ name: 'renamed' })).toEqual({ name: 'renamed' });
  });

  it('drops path and isGitRepo even alongside a legitimate rename', () => {
    const payload = {
      name: 'Legit rename',
      path: '/attacker/controlled',
      isGitRepo: false,
      id: 'attacker-controlled',
    } as unknown as Parameters<typeof allowedScopeUpdates>[0];

    const result = allowedScopeUpdates(payload);

    expect(result).not.toHaveProperty('path');
    expect(result).not.toHaveProperty('isGitRepo');
    expect(result).not.toHaveProperty('id');
    expect(result.name).toBe('Legit rename');
  });

  it('drops an explicit name: undefined rather than clobbering a real name', () => {
    expect('name' in allowedScopeUpdates({ name: undefined })).toBe(false);
  });
});

describe('allowedGroupUpdates', () => {
  it('passes a rename through', () => {
    expect(allowedGroupUpdates({ name: 'renamed' })).toEqual({ name: 'renamed' });
  });

  it('drops conductorSessionId and archivedAt even alongside a legitimate rename', () => {
    const payload = {
      name: 'Legit rename',
      conductorSessionId: 'attacker-controlled',
      archivedAt: undefined,
      parentGroupId: 'attacker-controlled',
    } as unknown as Parameters<typeof allowedGroupUpdates>[0];

    const result = allowedGroupUpdates(payload);

    // archivedAt has its own archive/restore verbs; an explicitly-undefined
    // key here must not become a silent un-archive through the rename door.
    expect(result).not.toHaveProperty('conductorSessionId');
    expect(result).not.toHaveProperty('archivedAt');
    expect(result).not.toHaveProperty('parentGroupId');
    expect(result.name).toBe('Legit rename');
  });

  it('drops an explicit name: undefined rather than clobbering a real name', () => {
    expect('name' in allowedGroupUpdates({ name: undefined })).toBe(false);
  });
});

describe('allowedSessionUpdates', () => {
  it('passes through a normal update', () => {
    const result = allowedSessionUpdates({ name: 'Refactor the parser', hasStarted: true });

    expect(result).toEqual({ name: 'Refactor the parser', hasStarted: true });
  });

  it('drops harnessId even alongside a legitimate field', () => {
    // Cast through `as unknown as SessionUpdates` to model what IPC can deliver
    // once TypeScript's `Pick<>` is gone. This is the invariant that matters
    // most here: the transcript lives in the harness's config directory, so a
    // rewritten harnessId would resume against the wrong profile — or nothing.
    const payload = { harnessId: 'other', name: 'Legit rename' } as unknown as SessionUpdates;

    const result = allowedSessionUpdates(payload);

    expect(result).not.toHaveProperty('harnessId');
    expect(result.name).toBe('Legit rename');
  });

  it('drops model even alongside a legitimate field', () => {
    // Same invariant as harnessId, one layer along: the model is replayed on
    // every relaunch, so a rewritten one would silently move a conversation
    // onto a different model part-way through.
    const payload = { model: 'haiku', name: 'Legit rename' } as unknown as SessionUpdates;

    const result = allowedSessionUpdates(payload);

    expect(result).not.toHaveProperty('model');
    expect(result.name).toBe('Legit rename');
  });

  it('drops every field that names the session or its terminal', () => {
    const payload = {
      id: 'attacker-controlled',
      workspaceId: 'somewhere-else',
      instanceId: 'someone-elses-pty',
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      createdAt: 0,
      lastActiveAt: 42,
    } as unknown as SessionUpdates;

    const result = allowedSessionUpdates(payload);

    expect(result).toEqual({ lastActiveAt: 42 });
  });

  it('drops an explicit name: undefined rather than clobbering a real name', () => {
    const result = allowedSessionUpdates({ name: undefined });

    expect('name' in result).toBe(false);
  });

  it('passes nameIsUserSet through alongside the rename that sets it', () => {
    const result = allowedSessionUpdates({ name: 'My name', nameIsUserSet: true });

    expect(result).toEqual({ name: 'My name', nameIsUserSet: true });
  });

  it('drops an explicit nameIsUserSet: undefined — the flag is set, never cleared', () => {
    const result = allowedSessionUpdates({ nameIsUserSet: undefined });

    expect('nameIsUserSet' in result).toBe(false);
  });

  it('passes groupId through — regrouping is organizational, not identity', () => {
    const result = allowedSessionUpdates({ groupId: 'g1' });

    expect(result).toEqual({ groupId: 'g1' });
  });

  it('preserves an explicit groupId: undefined as an own key, so leaving a group reaches the service', () => {
    const result = allowedSessionUpdates({ groupId: undefined });

    // Same mechanism as harness binaryPath: presence separates "clear this"
    // from "leave it alone".
    expect('groupId' in result).toBe(true);
    expect(result.groupId).toBeUndefined();
  });

  it('omits groupId entirely when the key is absent from the input', () => {
    const result = allowedSessionUpdates({ name: 'Renamed' });

    expect('groupId' in result).toBe(false);
  });

  it('drops scopeId, cwd, kind and workItem even alongside a legitimate field', () => {
    // The session's place, working directory, nature and origin are fixed at
    // creation, exactly like harnessId and model: immutable by omission.
    const payload = {
      scopeId: 'other-scope',
      cwd: '/somewhere/else',
      kind: 'conductor',
      workItem: { provider: 'github', repo: 'a/b', type: 'pr', number: 1 },
      name: 'Legit rename',
    } as unknown as SessionUpdates;

    const result = allowedSessionUpdates(payload);

    expect(result).not.toHaveProperty('scopeId');
    expect(result).not.toHaveProperty('cwd');
    expect(result).not.toHaveProperty('kind');
    expect(result).not.toHaveProperty('workItem');
    expect(result.name).toBe('Legit rename');
  });
});
