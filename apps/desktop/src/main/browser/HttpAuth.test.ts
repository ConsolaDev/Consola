import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthPrompts, AUTH_TIMEOUT_MS, decideLogin } from './HttpAuth';

describe('decideLogin', () => {
  const ok = {
    requestUrl: 'https://staging.example.com/admin',
    pageUrl: 'https://staging.example.com/',
    isProxy: false,
  };

  it('prompts for the page’s own origin', () => {
    expect(decideLogin(ok)).toBe(true);
  });

  it('refuses a proxy', () => {
    expect(decideLogin({ ...ok, isProxy: true })).toBe(false);
  });

  it('refuses another origin: a different host, port or scheme', () => {
    expect(decideLogin({ ...ok, requestUrl: 'https://evil.example.net/x' })).toBe(false);
    expect(decideLogin({ ...ok, requestUrl: 'https://staging.example.com:8443/x' })).toBe(false);
    expect(decideLogin({ ...ok, requestUrl: 'http://staging.example.com/x' })).toBe(false);
  });

  it('refuses when either address is not a web address or cannot be read', () => {
    expect(decideLogin({ ...ok, pageUrl: '' })).toBe(false);
    expect(decideLogin({ ...ok, pageUrl: 'about:blank' })).toBe(false);
    expect(decideLogin({ ...ok, requestUrl: 'not a url' })).toBe(false);
  });
});

describe('AuthPrompts', () => {
  const host = { name: 'host' } as never;
  const other = { name: 'other' } as never;
  let sent: Array<{ channel: string; payload: unknown }>;
  let prompts: AuthPrompts;
  let n: number;

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    n = 0;
    prompts = new AuthPrompts({
      send: (_window, channel, payload) => sent.push({ channel, payload }),
      newId: () => `req${++n}`,
    });
  });
  afterEach(() => vi.useRealTimers());

  const ask = (callback = vi.fn(), guestId = 1) => {
    prompts.request({
      guestId,
      host,
      origin: 'https://staging.example.com',
      realm: 'Staging',
      callback,
    });
    return callback;
  };

  it('tells the window who is asking, with no credentials in it', () => {
    ask();
    expect(sent).toEqual([
      {
        channel: 'browser:auth-request',
        payload: { id: 'req1', origin: 'https://staging.example.com', realm: 'Staging' },
      },
    ]);
  });

  it('answers once with what the window sent, and not again', () => {
    const callback = ask();
    expect(prompts.answer(host, 'req1', { username: 'u', password: 'p' })).toBe(true);
    expect(callback).toHaveBeenCalledWith('u', 'p');
    expect(prompts.answer(host, 'req1', { username: 'x', password: 'y' })).toBe(false);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('cancels when the window answers null', () => {
    const callback = ask();
    prompts.answer(host, 'req1', null);
    expect(callback).toHaveBeenCalledWith();
  });

  it('ignores an answer from a window that was not asked, or to an unknown request', () => {
    const callback = ask();
    expect(prompts.answer(other, 'req1', { username: 'u', password: 'p' })).toBe(false);
    expect(prompts.answer(host, 'nope', { username: 'u', password: 'p' })).toBe(false);
    expect(callback).not.toHaveBeenCalled();
    // The real window can still answer.
    expect(prompts.answer(host, 'req1', { username: 'u', password: 'p' })).toBe(true);
  });

  it('treats a malformed answer as a cancel', () => {
    const callback = ask();
    prompts.answer(host, 'req1', { username: 1, password: {} } as never);
    expect(callback).toHaveBeenCalledWith();
  });

  it('cancels after two minutes and tells the window to close its dialog', () => {
    const callback = ask();
    vi.advanceTimersByTime(AUTH_TIMEOUT_MS);
    expect(callback).toHaveBeenCalledWith();
    expect(sent.at(-1)).toEqual({ channel: 'browser:auth-cancelled', payload: { id: 'req1' } });
    expect(prompts.answer(host, 'req1', { username: 'u', password: 'p' })).toBe(false);
  });

  it('cancels the prompts of a guest that went away, and only that guest', () => {
    const gone = ask(vi.fn(), 1);
    const staying = ask(vi.fn(), 2);
    prompts.cancelGuest(1);
    expect(gone).toHaveBeenCalledWith();
    expect(staying).not.toHaveBeenCalled();
    expect(sent.at(-1)).toEqual({ channel: 'browser:auth-cancelled', payload: { id: 'req1' } });
  });

  it('cancels every prompt of a window that closed', () => {
    const callback = ask();
    prompts.cancelWindow(host);
    expect(callback).toHaveBeenCalledWith();
  });

  it('holds one prompt per guest: a second request cancels the one it replaces', () => {
    const first = ask(vi.fn(), 1);
    const second = ask(vi.fn(), 1);
    expect(first).toHaveBeenCalledWith();
    expect(second).not.toHaveBeenCalled();
  });
});
