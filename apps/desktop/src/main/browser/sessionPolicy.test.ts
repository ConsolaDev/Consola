import type { Session } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { browserPartitionFor } from '../../shared/browser';
import {
  configurePartition,
  decidePermission,
  downloadDialogTitle,
  partitionFor,
} from './sessionPolicy';

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

  it('configures a partition once', () => {
    const { session } = fakeSession();
    configurePartition('persist:test-once', session as unknown as Session);
    configurePartition('persist:test-once', session as unknown as Session);
    expect(session.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
  });
});
