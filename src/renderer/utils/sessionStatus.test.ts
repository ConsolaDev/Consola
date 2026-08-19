import { describe, expect, it } from 'vitest';
import {
  anyOtherWorkspaceNeedsAttention,
  sessionStatusFor,
  workspaceStatusFor,
} from './sessionStatus';
import type { Workspace } from '../../shared/workspace';

function workspace(id: string, instanceIds: string[]): Workspace {
  return {
    id,
    name: id,
    path: `/code/${id}`,
    isGitRepo: true,
    defaultHarnessId: 'default',
    createdAt: 1,
    updatedAt: 1,
    sessions: instanceIds.map((instanceId, index) => ({
      id: `${id}-s${index}`,
      name: `Session ${index}`,
      workspaceId: id,
      instanceId,
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      hasStarted: true,
      harnessId: 'default',
      createdAt: 1,
      lastActiveAt: 1,
    })),
  };
}

const IDLE = { isBusy: false, isAwaitingConfirmation: false, hasExited: false };

describe('sessionStatusFor', () => {
  it('is null for a terminal that has not started', () => {
    expect(sessionStatusFor(undefined)).toBeNull();
  });

  it('ranks an exit above a waiting menu, and a waiting menu above work', () => {
    expect(sessionStatusFor({ ...IDLE, hasExited: true, isAwaitingConfirmation: true })).toBe('error');
    expect(sessionStatusFor({ ...IDLE, isAwaitingConfirmation: true, isBusy: true })).toBe('attention');
    expect(sessionStatusFor({ ...IDLE, isBusy: true })).toBe('running');
    expect(sessionStatusFor(IDLE)).toBeNull();
  });
});

describe('workspaceStatusFor', () => {
  it('surfaces the most urgent status among its sessions', () => {
    const terminals = {
      a: { ...IDLE, isBusy: true },
      b: { ...IDLE, isAwaitingConfirmation: true },
    };

    expect(workspaceStatusFor(workspace('w1', ['a', 'b']), terminals)).toBe('attention');
  });

  it('is null when nothing is happening', () => {
    expect(workspaceStatusFor(workspace('w1', ['a']), { a: IDLE })).toBeNull();
  });

  it('ranks a dead process above a waiting menu across a workspace, matching a single session', () => {
    const terminals = {
      a: { ...IDLE, isAwaitingConfirmation: true },
      b: { ...IDLE, hasExited: true },
    };

    expect(workspaceStatusFor(workspace('w1', ['a', 'b']), terminals)).toBe('error');
  });
});

describe('anyOtherWorkspaceNeedsAttention', () => {
  it('ignores the workspace this window is already showing', () => {
    const workspaces = [workspace('w1', ['a']), workspace('w2', ['b'])];
    const terminals = { a: { ...IDLE, isAwaitingConfirmation: true }, b: IDLE };

    expect(anyOtherWorkspaceNeedsAttention(workspaces, 'w1', terminals)).toBe(false);
    expect(anyOtherWorkspaceNeedsAttention(workspaces, 'w2', terminals)).toBe(true);
  });

  it('does not count work in progress as needing you', () => {
    const workspaces = [workspace('w1', ['a'])];
    const terminals = { a: { ...IDLE, isBusy: true } };

    expect(anyOtherWorkspaceNeedsAttention(workspaces, null, terminals)).toBe(false);
  });

  it('is true when any other workspace needs attention, not only when all of them do', () => {
    const workspaces = [workspace('active', ['a']), workspace('waiting', ['b']), workspace('idle', ['c'])];
    const terminals = {
      a: IDLE,
      b: { ...IDLE, isAwaitingConfirmation: true },
      c: IDLE,
    };

    expect(anyOtherWorkspaceNeedsAttention(workspaces, 'active', terminals)).toBe(true);
  });
});
