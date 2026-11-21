import { EventEmitter } from 'node:events';
import type { BrowserWindow, Session, WebContents, WebPreferences } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { browserPartitionFor } from '../../shared/browser';
import {
  decideAppNavigation,
  decideAttach,
  decideNavigation,
  installGuestPolicy,
  onGuestAttached,
  shouldRevertNavigation,
} from './guestPolicy';

const partition = browserPartitionFor('ws-1');
const context = { workspaceId: 'ws-1' as string | null | undefined };

describe('decideAttach', () => {
  it('allows the workspace partition with a web address', () => {
    const decision = decideAttach({ partition, src: 'https://example.com/' }, {}, context);
    expect(decision.allow).toBe(true);
  });

  it('allows about:blank, the empty page a tab starts on', () => {
    expect(decideAttach({ partition, src: 'about:blank' }, {}, context).allow).toBe(true);
  });

  it('refuses a window that holds no workspace', () => {
    for (const workspaceId of [null, undefined]) {
      const decision = decideAttach({ partition, src: 'https://a.test' }, {}, { workspaceId });
      expect(decision.allow).toBe(false);
    }
  });

  it("refuses another workspace's partition", () => {
    const decision = decideAttach(
      { partition: browserPartitionFor('ws-2'), src: 'https://a.test' },
      {},
      context,
    );
    expect(decision.allow).toBe(false);
  });

  it('refuses a missing or ordinary partition', () => {
    expect(decideAttach({ src: 'https://a.test' }, {}, context).allow).toBe(false);
    expect(
      decideAttach({ partition: 'persist:other', src: 'https://a.test' }, {}, context).allow,
    ).toBe(false);
  });

  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hi',
    'chrome://settings',
    '',
    'nonsense',
  ])('refuses src %j', (src) => {
    expect(decideAttach({ partition, src }, {}, context).allow).toBe(false);
  });

  it('refuses a missing src', () => {
    expect(decideAttach({ partition }, {}, context).allow).toBe(false);
  });

  it('strips every way the renderer could give a guest a preload or arguments', () => {
    const decision = decideAttach(
      { partition, src: 'https://a.test' },
      // `preloadURL` is not in Electron's typings, but a renderer can still send it.
      {
        preload: '/evil.js',
        preloadURL: 'file:///evil.js',
        additionalArguments: ['--x'],
        zoomFactor: 2,
      } as WebPreferences,
      context,
    );
    if (!decision.allow) throw new Error('expected allow');
    expect(decision.webPreferences).not.toHaveProperty('preload');
    expect(decision.webPreferences).not.toHaveProperty('preloadURL');
    expect(decision.webPreferences).not.toHaveProperty('additionalArguments');
    // Nothing else the renderer asked for survives.
    expect(decision.webPreferences).not.toHaveProperty('zoomFactor');
    expect(decision.webPreferences.partition).toBe(partition);
  });

  it('forces the isolation preferences whatever the renderer asked for', () => {
    const decision = decideAttach(
      { partition, src: 'https://a.test' },
      {
        nodeIntegration: true,
        nodeIntegrationInSubFrames: true,
        contextIsolation: false,
        sandbox: false,
        webSecurity: false,
        allowRunningInsecureContent: true,
      },
      context,
    );
    if (!decision.allow) throw new Error('expected allow');
    expect(decision.webPreferences).toMatchObject({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    });
  });

  it("refuses preferences that name another workspace's partition", () => {
    const decision = decideAttach(
      { partition, src: 'https://a.test' },
      { partition: browserPartitionFor('ws-2') } as WebPreferences,
      context,
    );
    expect(decision.allow).toBe(false);
  });

  it('refuses preferences that name the default session', () => {
    const decision = decideAttach(
      { partition, src: 'https://a.test' },
      { partition: '' } as WebPreferences,
      context,
    );
    expect(decision.allow).toBe(false);
  });

  it('accepts preferences that repeat the same partition', () => {
    const decision = decideAttach(
      { partition, src: 'https://a.test' },
      { partition } as WebPreferences,
      context,
    );
    expect(decision.allow).toBe(true);
  });

  it('never lets a guest nest guests or bring its own session', () => {
    const decision = decideAttach(
      { partition, src: 'https://a.test' },
      { webviewTag: true, session: {} } as unknown as WebPreferences,
      context,
    );
    if (!decision.allow) throw new Error('expected allow');
    expect(decision.webPreferences.webviewTag).toBe(false);
    expect(decision.webPreferences).not.toHaveProperty('session');
  });

  it('does not mutate the preferences it was given', () => {
    const given = { preload: '/evil.js', sandbox: false };
    decideAttach({ partition, src: 'https://a.test' }, given, context);
    expect(given).toEqual({ preload: '/evil.js', sandbox: false });
  });

  it('gives a reason when it refuses', () => {
    const decision = decideAttach({ partition, src: 'file:///x' }, {}, context);
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason.length).toBeGreaterThan(0);
  });
});

describe('decideNavigation', () => {
  it('allows http and https', () => {
    expect(decideNavigation('http://localhost:3000/')).toBe(true);
    expect(decideNavigation('https://example.com/a?b=1')).toBe(true);
  });

  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hi',
    'chrome://gpu',
    'consola-asset://x/y',
    'about:blank',
    'not a url',
  ])('refuses %j', (url) => {
    expect(decideNavigation(url)).toBe(false);
  });
});

describe('decideAppNavigation', () => {
  const dev = { devOrigin: 'http://localhost:5173' };
  const prod = { pageFileUrl: 'file:///Applications/Consola.app/dist/renderer/index.html' };

  it('lets the dev server reload and route itself in development', () => {
    expect(decideAppNavigation('http://localhost:5173/', dev)).toBe(true);
    expect(decideAppNavigation('http://localhost:5173/#/x', dev)).toBe(true);
  });

  it('refuses any other origin in development', () => {
    expect(decideAppNavigation('http://localhost:5174/', dev)).toBe(false);
    expect(decideAppNavigation('https://example.com/', dev)).toBe(false);
    expect(decideAppNavigation('file:///etc/passwd', dev)).toBe(false);
  });

  it('lets the bundled page reload itself in production, hash and all', () => {
    expect(decideAppNavigation(prod.pageFileUrl, prod)).toBe(true);
    expect(decideAppNavigation(`${prod.pageFileUrl}#/workspace`, prod)).toBe(true);
  });

  it('refuses everything else in production', () => {
    expect(decideAppNavigation('https://example.com/', prod)).toBe(false);
    expect(decideAppNavigation('file:///etc/passwd', prod)).toBe(false);
    expect(
      decideAppNavigation('file:///Applications/Consola.app/dist/renderer/other.html', prod),
    ).toBe(false);
    expect(decideAppNavigation('http://localhost:5173/', prod)).toBe(false);
  });

  it('refuses an address that does not parse', () => {
    expect(decideAppNavigation('nonsense', dev)).toBe(false);
    expect(decideAppNavigation('nonsense', prod)).toBe(false);
  });
});

describe('shouldRevertNavigation', () => {
  it('lets a main frame go to a web page or stay blank', () => {
    expect(shouldRevertNavigation('https://example.com/', true)).toBe(false);
    expect(shouldRevertNavigation('about:blank', true)).toBe(false);
  });

  it.each(['data:text/html,hi', 'file:///etc/hosts', 'javascript:1', 'chrome://gpu', 'bad'])(
    'reverts a main frame at %j',
    (url) => {
      expect(shouldRevertNavigation(url, true)).toBe(true);
    },
  );

  it('ignores sub-frames, which cannot replace the page', () => {
    expect(shouldRevertNavigation('data:text/html,hi', false)).toBe(false);
  });
});

describe('installGuestPolicy', () => {
  /** A window holding workspace `ws-1`, and a guest it attaches in that workspace's partition. */
  function attaching() {
    const host = new EventEmitter();
    const window = { webContents: host, isDestroyed: () => false } as unknown as BrowserWindow;
    const session = {} as Session;
    installGuestPolicy(window, { workspaceOf: () => 'ws-1', prepare: () => session });
    const guest = Object.assign(new EventEmitter(), {
      id: 41,
      session,
      setWindowOpenHandler: vi.fn(),
      stop: vi.fn(),
      close: vi.fn(),
    });
    const attach = () => host.emit('did-attach-webview', {}, guest);
    return { window, guest, attach };
  }

  it('tells every listener of an attached guest, even past one that throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const heard: number[] = [];
    const stops = [
      onGuestAttached(() => {
        throw new Error('Object has been destroyed');
      }),
      onGuestAttached((_guest, _window, _workspaceId, guestId) => heard.push(guestId)),
    ];
    const { attach, guest } = attaching();
    attach();
    expect(heard).toEqual([41]);
    expect(guest.close).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed'), expect.anything());
    for (const stop of stops) stop();
    warn.mockRestore();
  });

  it('secures the guest before any listener hears of it', () => {
    let secured = false;
    const stop = onGuestAttached((guest) => {
      secured = (guest as unknown as EventEmitter).listenerCount('will-navigate') > 0;
    });
    const { attach, guest } = attaching();
    attach();
    expect(secured).toBe(true);
    expect((guest as unknown as WebContents).setWindowOpenHandler).toHaveBeenCalled();
    stop();
  });
});
