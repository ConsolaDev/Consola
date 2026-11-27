import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentSlackLinkToken,
  goToSlack,
  leaveSlackLink,
  onSlackLinkChange,
  takeSlackResult,
} from './slackAddress';

/** The tests run in Node, so the page's `window` is a stand-in with just what the module reads. */
function pageAt(href: string) {
  const listeners = new Set<() => void>();
  const location = {
    href,
    hash: new URL(href).hash,
    assign: vi.fn(),
    replace: vi.fn(),
  };
  const replaceState = vi.fn();
  vi.stubGlobal('window', {
    location,
    history: { replaceState },
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'hashchange') listeners.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === 'hashchange') listeners.delete(listener);
    },
  });
  /** What a browser does when the hash changes: sets it, then tells every listener. */
  const moveTo = (hash: string) => {
    location.hash = hash;
    for (const listener of listeners) listener();
  };
  return { location, replaceState, listeners, moveTo };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the link page’s address', () => {
  it('names the link’s token, or none', () => {
    pageAt('http://localhost:5175/#/slack/link/tok%2Ben');
    expect(currentSlackLinkToken()).toBe('tok+en');
    pageAt('http://localhost:5175/#/overview');
    expect(currentSlackLinkToken()).toBeNull();
  });

  it('is heard as it changes, until stopped', () => {
    const { moveTo, listeners } = pageAt('http://localhost:5175/#/overview');
    const heard: Array<string | null> = [];
    const stop = onSlackLinkChange((token) => heard.push(token));
    moveTo('#/slack/link/abc');
    moveTo('#/runs');
    stop();
    expect(heard).toEqual(['abc', null]);
    expect(listeners.size).toBe(0);
  });

  it('is left for the dashboard, in its place in the history', () => {
    const { location } = pageAt('http://localhost:5175/#/slack/link/abc');
    leaveSlackLink();
    expect(location.replace).toHaveBeenCalledWith('#/');
  });
});

describe('takeSlackResult', () => {
  it('is null and leaves the address alone without a result', () => {
    const { replaceState } = pageAt('http://localhost:5175/#/factories/f-1/settings');
    expect(takeSlackResult()).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('returns the result and removes only it, keeping the factory’s settings', () => {
    const { replaceState } = pageAt(
      'http://localhost:5175/?slack=installed&tab=1#/factories/f-1/settings',
    );
    expect(takeSlackResult()).toBe('installed');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?tab=1#/factories/f-1/settings');
  });

  it('takes a result it does not know as unknown, and still clears it', () => {
    const { replaceState } = pageAt(
      'http://localhost:5175/?slack=%3Cscript%3E#/settings/connections',
    );
    expect(takeSlackResult()).toBe('unknown');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/#/settings/connections');
  });
});

describe('goToSlack', () => {
  it('sends the page to the address', () => {
    const { location } = pageAt('http://localhost:5175/#/factories/f-1/settings');
    goToSlack('https://slack.com/oauth/v2/authorize?state=s');
    expect(location.assign).toHaveBeenCalledWith('https://slack.com/oauth/v2/authorize?state=s');
  });
});
