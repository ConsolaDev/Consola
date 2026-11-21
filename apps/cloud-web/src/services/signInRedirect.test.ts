import { afterEach, describe, expect, it, vi } from 'vitest';
import { takeSignInErrorCode } from './signInRedirect';

/** The tests run in Node, so the page's `window` is a stand-in with just what the module reads. */
function pageAt(href: string) {
  const replaceState = vi.fn();
  vi.stubGlobal('window', { location: { href }, history: { replaceState } });
  return replaceState;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('takeSignInErrorCode', () => {
  it('is null and leaves the address alone without an error', () => {
    const replaceState = pageAt('http://localhost:5175/?tab=1');
    expect(takeSignInErrorCode()).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('returns the code and removes error and error_description from the address', () => {
    const replaceState = pageAt(
      'http://localhost:5175/?error=access_denied&error_description=nope&tab=1#top',
    );
    expect(takeSignInErrorCode()).toBe('access_denied');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?tab=1#top');
  });

  it('leaves a bare path when the error was the only parameter', () => {
    const replaceState = pageAt('http://localhost:5175/?error=access_denied');
    expect(takeSignInErrorCode()).toBe('access_denied');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
  });
});
