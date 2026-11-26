import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { AuthPrompts, AUTH_TIMEOUT_MS, cleanRealm, decideLogin } from './HttpAuth';

describe('decideLogin', () => {
  const ok = {
    isMainFrame: true,
    isRequestForNavigation: true,
    requestUrl: 'https://staging.example.com/admin',
    isProxy: false,
  };

  it('prompts for the main frame’s own navigation', () => {
    expect(decideLogin(ok)).toBe(true);
  });

  it('refuses a request that is not a navigation: a fetch cannot raise a prompt', () => {
    expect(decideLogin({ ...ok, isRequestForNavigation: false })).toBe(false);
  });

  it('refuses an iframe’s navigation, which Electron also calls a navigation request', () => {
    expect(decideLogin({ ...ok, isMainFrame: false })).toBe(false);
  });

  it('fails closed when a flag is missing or not exactly true', () => {
    expect(decideLogin({ ...ok, isMainFrame: undefined })).toBe(false);
    expect(decideLogin({ ...ok, isRequestForNavigation: undefined })).toBe(false);
    expect(decideLogin({ ...ok, isMainFrame: 1 })).toBe(false);
    expect(decideLogin({ ...ok, isRequestForNavigation: 'true' })).toBe(false);
  });

  it('refuses a proxy', () => {
    expect(decideLogin({ ...ok, isProxy: true })).toBe(false);
  });

  it('refuses an address that is not a web address', () => {
    expect(decideLogin({ ...ok, requestUrl: 'not a url' })).toBe(false);
    expect(decideLogin({ ...ok, requestUrl: 'file:///etc/passwd' })).toBe(false);
  });
});

describe('cleanRealm', () => {
  it('drops control and bidirectional characters, and cuts it short', () => {
    expect(cleanRealm('Admin‮evil\u0000\n⁦x‏؜')).toBe('Adminevilx');
    expect(cleanRealm('a'.repeat(500))).toHaveLength(200);
    expect(cleanRealm(undefined)).toBe('');
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
      tabId: 't1',
      callback,
    });
    return callback;
  };

  it('tells the window who is asking, with no credentials in it', () => {
    ask();
    expect(sent).toEqual([
      {
        channel: 'browser:auth-request',
        payload: {
          id: 'req1',
          tabId: 't1',
          origin: 'https://staging.example.com',
          realm: 'Staging',
        },
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

  it('names the tab a request is for, to the window that was asked only', () => {
    ask();
    expect(prompts.requestTab(host, 'req1')).toBe('t1');
    expect(prompts.requestTab(other, 'req1')).toBeNull();
    expect(prompts.requestTab(host, 'nope')).toBeNull();
    prompts.answer(host, 'req1', null);
    expect(prompts.requestTab(host, 'req1')).toBeNull();
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
    prompts.answer(host, 'req1', { username: 1, password: {} });
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

  it('tells the window the tab once an unbound guest binds, under the same id', () => {
    prompts.request({
      guestId: 3,
      host,
      origin: 'https://staging.example.com',
      realm: '',
      tabId: null,
      callback: vi.fn(),
    });
    expect(sent.at(-1)?.payload).toMatchObject({ id: 'req1', tabId: null });
    prompts.bindTab(3, 'tab9');
    expect(sent.at(-1)?.payload).toMatchObject({ id: 'req1', tabId: 'tab9' });
    prompts.bindTab(3, 'tab9');
    expect(sent).toHaveLength(2);
  });

  it('cancels at once when the window is already gone', () => {
    const gone = {
      isDestroyed: () => true,
      webContents: { isDestroyed: () => true },
    } as never;
    const callback = vi.fn();
    prompts.request({ guestId: 1, host: gone, origin: 'o', realm: '', tabId: null, callback });
    expect(callback).toHaveBeenCalledWith();
    expect(sent).toHaveLength(0);
  });
});

describe('AuthPrompts.guard', () => {
  class FakeGuest extends EventEmitter {
    asWebContents() {
      return this as unknown as WebContents;
    }
  }
  const host = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false },
  } as never;
  const info = { isProxy: false, realm: 'Fixture' };
  const URL_A = 'https://staging.example.com/admin';

  let sent: Array<{ channel: string; payload: unknown }>;
  let prompts: AuthPrompts;
  let guest: FakeGuest;
  let tab: string | null;

  beforeEach(() => {
    sent = [];
    tab = 't1';
    let n = 0;
    prompts = new AuthPrompts({
      send: (_w, channel, payload) => sent.push({ channel, payload }),
      newId: () => `req${++n}`,
    });
    guest = new FakeGuest();
    prompts.guard(guest.asWebContents(), host, 1, () => tab);
  });

  const navigate = (url: string) =>
    guest.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: false });
  function login(
    url = URL_A,
    flags: { isMainFrame?: boolean; isRequestForNavigation?: boolean } = {},
  ) {
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();
    const details = { url, isMainFrame: true, isRequestForNavigation: true, ...flags };
    guest.emit('login', event, details, info, callback);
    return callback;
  }
  const requests = () => sent.filter((m) => m.channel === 'browser:auth-request');

  it('prompts, with the tab, for a main-frame navigation, naming the request’s own origin', () => {
    const callback = login('https://other.example.org/x');
    expect(callback).not.toHaveBeenCalled();
    expect(requests()).toHaveLength(1);
    expect(requests()[0].payload).toMatchObject({
      tabId: 't1',
      origin: 'https://other.example.org',
      realm: 'Fixture',
    });
  });

  it('prompts for a first load the guard never saw start', () => {
    // No did-start-navigation was observed: the guest began loading before it was guarded.
    expect(login()).not.toHaveBeenCalled();
    expect(requests()).toHaveLength(1);
  });

  it('cancels a request that is not a navigation, however often it comes', () => {
    for (let i = 0; i < 3; i++) {
      expect(login(URL_A, { isRequestForNavigation: false })).toHaveBeenCalledWith();
    }
    expect(requests()).toHaveLength(0);
  });

  it('cancels an iframe’s navigation, of the page’s origin or another', () => {
    navigate(URL_A);
    expect(login(URL_A, { isMainFrame: false })).toHaveBeenCalledWith();
    expect(login('http://localhost:1/secret', { isMainFrame: false })).toHaveBeenCalledWith();
    expect(requests()).toHaveLength(0);
  });

  it('cancels when Electron stops saying which frame asked', () => {
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();
    guest.emit('login', event, { url: URL_A, isRequestForNavigation: true }, info, callback);
    expect(callback).toHaveBeenCalledWith();
  });

  it.each(['did-stop-loading'])('withdraws a waiting prompt on %s', (ending) => {
    const waiting = login();
    guest.emit(ending);
    expect(waiting).toHaveBeenCalledWith();
    expect(sent.at(-1)?.channel).toBe('browser:auth-cancelled');
  });

  it('withdraws a waiting prompt when the main frame’s load fails, but not a subframe’s', () => {
    const waiting = login();
    guest.emit('did-fail-load', {}, -105, 'x', 'https://other.example/', false);
    expect(waiting).not.toHaveBeenCalled();
    guest.emit('did-fail-load', {}, -105, 'x', URL_A, true);
    expect(waiting).toHaveBeenCalledWith();
  });

  it('withdraws a waiting prompt when the page navigates away, not for a subframe', () => {
    const waiting = login();
    guest.emit('did-start-navigation', { url: 'https://c.example/', isMainFrame: false });
    expect(waiting).not.toHaveBeenCalled();
    navigate('https://elsewhere.example.com/');
    expect(waiting).toHaveBeenCalledWith();
    expect(sent.at(-1)?.channel).toBe('browser:auth-cancelled');
  });

  it('does not ask again for a page the person cancelled, until it navigates', () => {
    const first = login();
    const { id } = requests()[0].payload as { id: string };
    prompts.answer(host, id, null);
    expect(first).toHaveBeenCalledWith();

    expect(login()).toHaveBeenCalledWith();
    expect(requests()).toHaveLength(1);

    navigate(URL_A);
    expect(login()).not.toHaveBeenCalled();
    expect(requests()).toHaveLength(2);
  });

  it('holds a prompt raised before the guest has a tab, naming none yet', () => {
    tab = null;
    login();
    expect(requests()[0].payload).toMatchObject({ tabId: null });
  });

  it('cancels instead of throwing when the window is gone', () => {
    const gone = {
      isDestroyed: () => true,
      webContents: { isDestroyed: () => true },
    } as never;
    const other = new FakeGuest();
    prompts.guard(other.asWebContents(), gone, 2, () => null);
    const callback = vi.fn();
    const details = { url: URL_A, isMainFrame: true, isRequestForNavigation: true };
    other.emit('login', { preventDefault: vi.fn() }, details, info, callback);
    expect(callback).toHaveBeenCalledWith();
  });

  it('cancels a prompt whose guest is destroyed', () => {
    const waiting = login();
    guest.emit('destroyed');
    expect(waiting).toHaveBeenCalledWith();
  });
});
