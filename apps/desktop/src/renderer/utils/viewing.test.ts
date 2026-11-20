import { describe, expect, it, vi } from 'vitest';
import { createSessionRecord, createWorkspaceRecord, type Workspace } from '../../shared/workspace';
import { ViewingReporter, isSessionViewed, viewedInstanceId, viewedSessionId } from './viewing';

function workspace(): Workspace {
  const record = createWorkspaceRecord('w1', '/code/w1', true);
  return {
    ...record,
    sessions: [
      {
        ...createSessionRecord({
          name: 's',
          workspaceId: 'w1',
          instanceId: 'inst-a',
          harnessId: record.defaultHarnessId,
          scopeId: record.scopes[0].id,
        }),
        id: 'a',
      },
    ],
  };
}

describe('viewedInstanceId', () => {
  it("is the active session's terminal", () => {
    expect(viewedInstanceId({ activeSessionId: 'a', overlay: null }, workspace())).toBe('inst-a');
  });

  it('is nothing behind an overlay: the session runs on but is not being looked at', () => {
    expect(viewedInstanceId({ activeSessionId: 'a', overlay: 'inbox' }, workspace())).toBeNull();
  });

  it('is nothing with no session, no workspace, or a session that no longer exists', () => {
    expect(viewedInstanceId({ activeSessionId: null, overlay: null }, workspace())).toBeNull();
    expect(viewedInstanceId({ activeSessionId: 'a', overlay: null }, undefined)).toBeNull();
    expect(viewedInstanceId({ activeSessionId: 'gone', overlay: null }, workspace())).toBeNull();
  });
});

describe('ViewingReporter', () => {
  it('reports a view on activation and clears it on deactivation', () => {
    const sink = { setViewing: vi.fn(), setFocused: vi.fn() };
    const reporter = new ViewingReporter(sink);

    reporter.view('inst-a');
    reporter.view(null);

    expect(sink.setViewing.mock.calls).toEqual([['inst-a'], [null]]);
  });

  it('sends nothing when nothing changed', () => {
    const sink = { setViewing: vi.fn(), setFocused: vi.fn() };
    const reporter = new ViewingReporter(sink);

    reporter.view('inst-a');
    reporter.view('inst-a');
    reporter.focus(true);
    reporter.focus(true);

    expect(sink.setViewing).toHaveBeenCalledTimes(1);
    expect(sink.setFocused).toHaveBeenCalledTimes(1);
  });

  it('reports focus on its own channel, so an unfocused window never reads as seeing', () => {
    const sink = { setViewing: vi.fn(), setFocused: vi.fn() };
    const reporter = new ViewingReporter(sink);

    reporter.view('inst-a');
    reporter.focus(false);

    expect(sink.setFocused).toHaveBeenCalledWith(false);
  });
});

describe('isSessionViewed', () => {
  const view = { activeSessionId: 'a', overlay: null };

  it('is true only for the active session, uncovered, in a focused window', () => {
    expect(isSessionViewed(view, 'a', true)).toBe(true);
    expect(isSessionViewed(view, 'b', true)).toBe(false);
    expect(isSessionViewed({ ...view, overlay: 'inbox' }, 'a', true)).toBe(false);
    expect(isSessionViewed(view, 'a', false)).toBe(false);
  });
});

describe('the two predicates agree', () => {
  it('a session is viewed exactly when its terminal is the one reported', () => {
    const ws = workspace();
    const views = [
      { activeSessionId: 'a', overlay: null },
      { activeSessionId: 'a', overlay: 'inbox' },
      { activeSessionId: 'gone', overlay: null },
      { activeSessionId: null, overlay: null },
    ];
    for (const view of views) {
      const reported = viewedInstanceId(view, ws) === 'inst-a';
      expect(isSessionViewed(view, 'a', true)).toBe(reported);
      expect(viewedSessionId(view) === 'a').toBe(reported);
    }
  });
});
