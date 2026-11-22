import { afterEach, describe, expect, it, vi } from 'vitest';
import { goToGitHub, takeGitHubResult } from './gitHubRedirect';

/** The tests run in Node, so the page's `window` is a stand-in with just what the module reads. */
function pageAt(href: string) {
  const replaceState = vi.fn();
  const assign = vi.fn();
  vi.stubGlobal('window', { location: { href, assign }, history: { replaceState } });
  return { replaceState, assign };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('takeGitHubResult', () => {
  it('is null and leaves the address alone without a result', () => {
    const { replaceState } = pageAt('http://localhost:5175/?tab=1#/connections');
    expect(takeGitHubResult()).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('returns the result and removes only it, keeping the section', () => {
    const { replaceState } = pageAt('http://localhost:5175/?github=connected&tab=1#/connections');
    expect(takeGitHubResult()).toBe('connected');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?tab=1#/connections');
  });

  it('leaves a bare path and the section when the result was the only parameter', () => {
    const { replaceState } = pageAt('http://localhost:5175/?github=taken#/connections');
    expect(takeGitHubResult()).toBe('taken');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/#/connections');
  });

  it('takes a result it does not know as unknown, and still clears it', () => {
    const { replaceState } = pageAt('http://localhost:5175/?github=%3Cscript%3E#/connections');
    expect(takeGitHubResult()).toBe('unknown');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/#/connections');
  });
});

describe('goToGitHub', () => {
  it('sends the page to the address', () => {
    const { assign } = pageAt('http://localhost:5175/#/connections');
    goToGitHub('https://github.com/apps/consola-dev/installations/new?state=s');
    expect(assign).toHaveBeenCalledWith(
      'https://github.com/apps/consola-dev/installations/new?state=s',
    );
  });
});
