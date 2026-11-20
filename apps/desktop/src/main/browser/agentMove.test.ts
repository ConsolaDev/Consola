import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AgentMoveBrowser, moveAsAgent } from './agentMove';
import { CALL_DEADLINE_MS } from './PageDriver';

class FakeGuest extends EventEmitter {
  asWebContents() {
    return this as unknown as WebContents;
  }
}

/** A browser that records the marks a move asks for and lets go of, in order. */
class FakeBrowser implements AgentMoveBrowser {
  readonly events: string[] = [];
  guest: FakeGuest | undefined;

  holdForToolCall(tabId: string, options?: { mount?: boolean }): () => void {
    this.events.push(`hold ${tabId} mount=${options?.mount ?? true}`);
    return () => this.events.push(`release ${tabId}`);
  }

  guestFor(): WebContents | undefined {
    return this.guest?.asWebContents();
  }
}

let browser: FakeBrowser;
/** Hears the move for the download rule, into the same record. */
let person: { noteAgentMove(tabId: string): void };

beforeEach(() => {
  browser = new FakeBrowser();
  person = { noteAgentMove: (tabId) => browser.events.push(`move noted ${tabId}`) };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('moveAsAgent', () => {
  it('notes the move for the download rule first, and marks a tab with no page for the move alone', () => {
    const result = moveAsAgent({ browser, person }, 'tab1', () => {
      browser.events.push('moved');
      return 'went';
    });
    expect(result).toBe('went');
    expect(browser.events).toEqual([
      'move noted tab1',
      'hold tab1 mount=false',
      'moved',
      'release tab1',
    ]);
  });

  it('marks a loaded tab until its page has loaded what the move asked for', () => {
    const guest = new FakeGuest();
    browser.guest = guest;
    moveAsAgent({ browser, person }, 'tab1', () => browser.events.push('moved'));
    expect(browser.events).toEqual(['move noted tab1', 'hold tab1 mount=false', 'moved']);

    guest.emit('did-stop-loading');
    guest.emit('did-stop-loading');
    expect(browser.events).toEqual([
      'move noted tab1',
      'hold tab1 mount=false',
      'moved',
      'release tab1',
    ]);
    expect(guest.listenerCount('did-stop-loading')).toBe(0);
    expect(guest.listenerCount('destroyed')).toBe(0);
  });

  it('lets go when the page goes before it has loaded', () => {
    const guest = new FakeGuest();
    browser.guest = guest;
    moveAsAgent({ browser, person }, 'tab1', () => {});
    guest.emit('destroyed');
    expect(browser.events.at(-1)).toBe('release tab1');
    expect(guest.listenerCount('did-stop-loading')).toBe(0);
  });

  it('lets go after a call’s deadline when the page never says it loaded', () => {
    vi.useFakeTimers();
    const guest = new FakeGuest();
    browser.guest = guest;
    moveAsAgent({ browser, person }, 'tab1', () => {});
    vi.advanceTimersByTime(CALL_DEADLINE_MS - 1);
    expect(browser.events).not.toContain('release tab1');
    vi.advanceTimersByTime(1);
    expect(browser.events.at(-1)).toBe('release tab1');
    expect(guest.listenerCount('did-stop-loading')).toBe(0);
  });

  it('lets go at once of a move that throws, and throws', () => {
    browser.guest = new FakeGuest();
    expect(() =>
      moveAsAgent({ browser, person }, 'tab1', () => {
        throw new Error('There is no such tab.');
      }),
    ).toThrow('There is no such tab.');
    expect(browser.events).toEqual(['move noted tab1', 'hold tab1 mount=false', 'release tab1']);
    expect(browser.guest.listenerCount('did-stop-loading')).toBe(0);
  });
});
