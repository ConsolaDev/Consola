import type { Session, WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserPartitionFor } from '../../shared/browser';
import {
  configurePartition,
  decideDownload,
  decidePermission,
  downloadDialogTitle,
  gateDownloads,
  partitionFor,
} from './sessionPolicy';

const T0 = 1_700_000_000_000;

describe('decideDownload', () => {
  it('cancels a download that starts while an agent acts on its tab and the person did not touch it', () => {
    expect(decideDownload({ actInFlight: true, now: T0 })).toBe('cancel');
    // A click's download reaches main after the click returns.
    expect(decideDownload({ actInFlight: false, actEndedAt: T0 - 2_900, now: T0 })).toBe('cancel');
  });

  it('allows it when the person pressed in that tab within 3 s, act or not', () => {
    expect(decideDownload({ actInFlight: true, personInputAt: T0 - 2_900, now: T0 })).toBe('allow');
    expect(decideDownload({ actInFlight: true, personInputAt: T0 - 3_100, now: T0 })).toBe(
      'cancel',
    );
  });

  it('allows it when no agent acted on the tab just now', () => {
    expect(decideDownload({ actInFlight: false, now: T0 })).toBe('allow');
    expect(decideDownload({ actInFlight: false, actEndedAt: T0 - 3_100, now: T0 })).toBe('allow');
  });
});

describe('decidePermission', () => {
  it.each(['fullscreen', 'pointerLock', 'clipboard-sanitized-write'])('allows %s', (permission) => {
    expect(decidePermission(permission)).toBe(true);
  });

  it.each([
    'media',
    'geolocation',
    'notifications',
    'clipboard-read',
    'midi',
    'openExternal',
    'display-capture',
    'unknown-future-permission',
  ])('denies %s', (permission) => {
    expect(decidePermission(permission)).toBe(false);
  });
});

describe('partitionFor', () => {
  it('is the shared partition string for that workspace', () => {
    expect(partitionFor('ws-1')).toBe(browserPartitionFor('ws-1'));
  });
});

describe('downloadDialogTitle', () => {
  it('names the site that offers the file', () => {
    expect(downloadDialogTitle('https://files.example.com:8443/a.zip')).toBe(
      'Save a file from files.example.com:8443',
    );
  });

  it('falls back to a plain title for an address with no host', () => {
    expect(downloadDialogTitle('blob:')).toBe('Save file');
    expect(downloadDialogTitle('not a url')).toBe('Save file');
  });
});

describe('configurePartition', () => {
  function fakeSession() {
    const listeners = new Map<string, (...args: never[]) => void>();
    const session = {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn(),
      setCertificateVerifyProc: vi.fn(),
      on: vi.fn((event: string, listener: (...args: never[]) => void) =>
        listeners.set(event, listener),
      ),
    };
    return { session, listeners };
  }

  it('refuses display capture with null, since an empty answer throws in main', () => {
    const { session } = fakeSession();
    configurePartition('persist:test-display', session as unknown as Session);
    const handler = session.setDisplayMediaRequestHandler.mock.calls[0][0];
    const callback = vi.fn();
    handler({}, callback);
    expect(callback).toHaveBeenCalledWith(null);
  });

  it('installs no certificate verify proc: certificates are decided per page', () => {
    const { session } = fakeSession();
    configurePartition('persist:test-certs', session as unknown as Session);
    expect(session.setCertificateVerifyProc).not.toHaveBeenCalled();
  });

  it('leaves every download to Electron’s save dialog: no path is ever set for it', () => {
    const { session, listeners } = fakeSession();
    configurePartition('persist:test-downloads', session as unknown as Session);
    const item = {
      getURL: () => 'https://files.example.com/a.zip',
      setSaveDialogOptions: vi.fn(),
      setSavePath: vi.fn(),
    };
    (listeners.get('will-download') as unknown as (e: unknown, i: unknown) => void)({}, item);
    expect(item.setSavePath).not.toHaveBeenCalled();
    expect(item.setSaveDialogOptions).toHaveBeenCalledWith({
      title: 'Save a file from files.example.com',
    });
  });

  describe('with a gate on downloads', () => {
    afterEach(() => gateDownloads(null));

    function download(listeners: Map<string, (...args: never[]) => void>, from: unknown) {
      const item = {
        getURL: () => 'https://files.example.com/a.zip',
        setSaveDialogOptions: vi.fn(),
        setSavePath: vi.fn(),
        cancel: vi.fn(),
      };
      const event = { preventDefault: vi.fn() };
      (listeners.get('will-download') as unknown as (e: unknown, i: unknown, w: unknown) => void)(
        event,
        item,
        from,
      );
      return { item, event };
    }

    it('cancels what the gate cancels, before any save dialog is asked for', () => {
      const { session, listeners } = fakeSession();
      configurePartition('persist:test-gate', session as unknown as Session);
      const page = { id: 7 } as unknown as WebContents;
      const seen: unknown[] = [];
      gateDownloads((from) => {
        seen.push(from);
        return 'cancel';
      });
      const { item, event } = download(listeners, page);
      expect(seen).toEqual([page]);
      expect(event.preventDefault).toHaveBeenCalled();
      expect(item.setSaveDialogOptions).not.toHaveBeenCalled();
    });

    it('lets the rest through to the save dialog', () => {
      const { session, listeners } = fakeSession();
      configurePartition('persist:test-gate-allow', session as unknown as Session);
      gateDownloads(() => 'allow');
      const { item, event } = download(listeners, undefined);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(item.setSaveDialogOptions).toHaveBeenCalled();
    });
  });

  it('configures a partition once', () => {
    const { session } = fakeSession();
    configurePartition('persist:test-once', session as unknown as Session);
    configurePartition('persist:test-once', session as unknown as Session);
    expect(session.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
  });
});
