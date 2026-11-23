import { describe, expect, it, vi } from 'vitest';
import { makeSession, makeWorkspace } from '../conductor/ConductorTools.test-helpers';
import { browserRefusal, closeConnectionsWithoutAccess } from './browserToolAccess';

describe('browserRefusal by tool policy (slice 3-B)', () => {
  const WORKSPACE_ON = makeWorkspace();

  it('lets a session with no policy use the browser', () => {
    expect(browserRefusal(WORKSPACE_ON, makeSession())).toBeNull();
  });

  it('refuses a read-only session as before', () => {
    expect(browserRefusal(WORKSPACE_ON, makeSession({ toolPolicy: 'read-only' }))).toMatch(
      /read-only/,
    );
  });

  it.each([['edit'], ['write']] as const)('refuses the browser to a %s session', (policy) =>
    expect(browserRefusal(WORKSPACE_ON, makeSession({ toolPolicy: policy }))).toBe(
      "A step's session cannot use the browser.",
    ),
  );
});

describe('closeConnectionsWithoutAccess', () => {
  it('closes the connections of tabs whose session may no longer use the browser, with the reason', () => {
    const closed: Array<[string, string]> = [];
    const refusals: Record<string, string | null> = {
      'tab-off':
        "Agents may not use this workspace's browser; the person turned that off in its settings.",
      'tab-gone': 'This session no longer exists.',
      'tab-ok': null,
    };
    const result = closeConnectionsWithoutAccess(
      {
        connectedTabs: () => ['tab-off', 'tab-ok', 'tab-gone'],
        disconnect: (tabId, reason) => closed.push([tabId, reason]),
      },
      (tabId) => refusals[tabId] ?? null,
    );
    expect(closed).toEqual([
      ['tab-off', refusals['tab-off'] as string],
      ['tab-gone', 'This session no longer exists.'],
    ]);
    expect(result).toEqual(['tab-off', 'tab-gone']);
  });

  it('closes nothing while every session may', () => {
    const closed: string[] = [];
    closeConnectionsWithoutAccess(
      { connectedTabs: () => ['a', 'b'], disconnect: (tabId) => closed.push(tabId) },
      () => null,
    );
    expect(closed).toEqual([]);
  });

  it('closes the rest when one cannot be closed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const closed: string[] = [];
    const result = closeConnectionsWithoutAccess(
      {
        connectedTabs: () => ['a', 'b', 'c'],
        disconnect: (tabId) => {
          if (tabId === 'a') throw new Error('Object has been destroyed');
          closed.push(tabId);
        },
      },
      () => 'This session no longer exists.',
    );
    expect(closed).toEqual(['b', 'c']);
    expect(result).toEqual(['b', 'c']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
