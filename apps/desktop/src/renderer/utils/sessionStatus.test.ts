import { describe, expect, it } from 'vitest';
import { anyOtherWorkspaceNeedsAttention, workspaceStatusFor } from './sessionStatus';
import { createSessionRecord, createWorkspaceRecord, type Workspace } from '../../shared/workspace';

// Built through the record creators rather than hand-rolled, so a shape
// change to Workspace/Session updates this fixture automatically. Each session's
// id is the name given, which is what an attention map is keyed by.
function workspace(id: string, sessionIds: string[]): Workspace {
  const record = createWorkspaceRecord(id, `/code/${id}`, true);
  const scopeId = record.scopes[0].id;
  return {
    ...record,
    id,
    sessions: sessionIds.map((sessionId, index) => ({
      ...createSessionRecord({
        name: `Session ${index}`,
        workspaceId: id,
        instanceId: `inst-${sessionId}`,
        harnessId: record.defaultHarnessId,
        scopeId,
      }),
      id: sessionId,
    })),
  };
}

describe('workspaceStatusFor', () => {
  it('surfaces the most urgent status among its sessions', () => {
    const attention = { a: 'working', b: 'needs-attention' } as const;
    expect(workspaceStatusFor(workspace('w1', ['a', 'b']), attention)).toBe('needs-attention');
  });

  it('is ready when nothing is happening, or nothing is known', () => {
    expect(workspaceStatusFor(workspace('w1', ['a']), { a: 'ready' })).toBe('ready');
    expect(workspaceStatusFor(workspace('w1', ['a']), {})).toBe('ready');
    expect(workspaceStatusFor(workspace('w1', []), {})).toBe('ready');
  });

  it('ranks a waiting menu above a dead process: the rank inversion', () => {
    const attention = { a: 'needs-attention', b: 'exited' } as const;
    expect(workspaceStatusFor(workspace('w1', ['a', 'b']), attention)).toBe('needs-attention');
  });

  it('ranks an unvisited finish above work still in progress', () => {
    const attention = { a: 'working', b: 'done' } as const;
    expect(workspaceStatusFor(workspace('w1', ['a', 'b']), attention)).toBe('done');
  });

  it('ignores settled sessions', () => {
    expect(workspaceStatusFor(workspace('w1', ['a', 'b']), { a: 'settled', b: 'settled' })).toBe('ready');
    expect(workspaceStatusFor(workspace('w1', ['a', 'b']), { a: 'settled', b: 'working' })).toBe('working');
  });
});

describe('anyOtherWorkspaceNeedsAttention', () => {
  it('ignores the workspace this window is already showing', () => {
    const workspaces = [workspace('w1', ['a']), workspace('w2', ['b'])];
    const attention = { a: 'needs-attention', b: 'ready' } as const;

    expect(anyOtherWorkspaceNeedsAttention(workspaces, 'w1', attention)).toBe(false);
    expect(anyOtherWorkspaceNeedsAttention(workspaces, 'w2', attention)).toBe(true);
  });

  it('does not count work in progress, calm, finished or settled sessions as needing you', () => {
    const workspaces = [workspace('w1', ['a', 'b', 'c', 'd'])];
    const attention = { a: 'working', b: 'ready', c: 'done', d: 'settled' } as const;

    expect(anyOtherWorkspaceNeedsAttention(workspaces, null, attention)).toBe(false);
  });

  it('is true when any other workspace needs attention, not only when all of them do', () => {
    const workspaces = [workspace('active', ['a']), workspace('waiting', ['b']), workspace('idle', ['c'])];
    const attention = { a: 'ready', b: 'needs-attention', c: 'ready' } as const;

    expect(anyOtherWorkspaceNeedsAttention(workspaces, 'active', attention)).toBe(true);
  });

  // Tested by name, not rank. `exited` ranks below `working` and `ready` now, so a
  // rank-based rewrite would stop reporting a dead process beside a busy one.
  it('is still true for an exited session after the rank inversion', () => {
    expect(anyOtherWorkspaceNeedsAttention([workspace('w2', ['b'])], 'w1', { b: 'exited' })).toBe(true);
    const mixed = { a: 'exited', b: 'working', c: 'ready' } as const;
    expect(anyOtherWorkspaceNeedsAttention([workspace('w2', ['a', 'b', 'c'])], 'w1', mixed)).toBe(true);
  });
});
