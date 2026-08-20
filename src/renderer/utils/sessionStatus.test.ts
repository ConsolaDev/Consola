import { describe, expect, it } from 'vitest';
import {
  anyOtherWorkspaceNeedsAttention,
  sessionStatusFor,
  workspaceStatusFor,
} from './sessionStatus';
import { createSessionRecord, createWorkspaceRecord, type Workspace } from '../../shared/workspace';

// Built through the record creators rather than hand-rolled, so a shape
// change to Workspace/Session updates this fixture automatically. The
// specific id is what the tests key off of; everything else the creators
// fill in is incidental to what these tests check.
function workspace(id: string, instanceIds: string[]): Workspace {
  const record = createWorkspaceRecord(id, `/code/${id}`, true);
  const scopeId = record.scopes[0].id;
  return {
    ...record,
    id,
    sessions: instanceIds.map((instanceId, index) =>
      createSessionRecord({
        name: `Session ${index}`,
        workspaceId: id,
        instanceId,
        harnessId: record.defaultHarnessId,
        scopeId,
      })
    ),
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
