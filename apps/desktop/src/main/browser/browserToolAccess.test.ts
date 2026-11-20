import { describe, expect, it } from 'vitest';
import { closeConnectionsWithoutAccess } from './browserToolAccess';

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
});
