import { afterEach, describe, expect, it, vi } from 'vitest';
import { goToGitHub, takeGitHubReturn } from './gitHubRedirect';

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

describe('takeGitHubReturn', () => {
  it('is null and leaves the address alone without a result', () => {
    const { replaceState } = pageAt('http://localhost:5175/?tab=1#/connections');
    expect(takeGitHubReturn()).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('returns the result and removes only it, keeping the section', () => {
    const { replaceState } = pageAt('http://localhost:5175/?github=connected&tab=1#/connections');
    expect(takeGitHubReturn()).toEqual({ kind: 'ended', result: 'connected' });
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?tab=1#/connections');
  });

  it('leaves a bare path and the section when the result was the only parameter', () => {
    const { replaceState } = pageAt('http://localhost:5175/?github=taken#/connections');
    expect(takeGitHubReturn()).toEqual({ kind: 'ended', result: 'taken' });
    expect(replaceState).toHaveBeenCalledWith(null, '', '/#/connections');
  });

  it('takes a result it does not know as unknown, and still clears it', () => {
    const { replaceState } = pageAt('http://localhost:5175/?github=%3Cscript%3E#/connections');
    expect(takeGitHubReturn()).toEqual({ kind: 'ended', result: 'unknown' });
    expect(replaceState).toHaveBeenCalledWith(null, '', '/#/connections');
  });

  it('returns the choice to make, and clears it with the result', () => {
    const { replaceState } = pageAt(
      'http://localhost:5175/?github=choose&choice=eyJ3b3Jr.c2ln&tab=1#/settings/connections',
    );
    expect(takeGitHubReturn()).toEqual({ kind: 'choose', choice: 'eyJ3b3Jr.c2ln' });
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?tab=1#/settings/connections');
  });

  it('returns the choice that names the accounts another workspace holds, and clears it', () => {
    const { replaceState } = pageAt(
      'http://localhost:5175/?github=taken_elsewhere&choice=eyJ3b3Jr.c2ln#/settings/connections',
    );
    expect(takeGitHubReturn()).toEqual({ kind: 'choose', choice: 'eyJ3b3Jr.c2ln' });
    expect(replaceState).toHaveBeenCalledWith(null, '', '/#/settings/connections');
  });

  it('takes a choose with no choice as a Connect that did not finish', () => {
    const { replaceState } = pageAt('http://localhost:5175/?github=choose#/settings/connections');
    expect(takeGitHubReturn()).toEqual({ kind: 'ended', result: 'unknown' });
    expect(replaceState).toHaveBeenCalledWith(null, '', '/#/settings/connections');
  });

  it('clears a choice that came without a result, and offers nothing', () => {
    const { replaceState } = pageAt('http://localhost:5175/?choice=x.y#/settings/connections');
    expect(takeGitHubReturn()).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/#/settings/connections');
  });
});

describe('goToGitHub', () => {
  it('sends the page to the address', () => {
    const { assign } = pageAt('http://localhost:5175/#/connections');
    goToGitHub('https://github.com/login/oauth/authorize?client_id=Iv23li&state=s');
    expect(assign).toHaveBeenCalledWith(
      'https://github.com/login/oauth/authorize?client_id=Iv23li&state=s',
    );
  });
});
