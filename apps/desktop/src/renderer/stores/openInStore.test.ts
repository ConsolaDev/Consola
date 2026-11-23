import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenInTarget } from '../../shared/openIn';

// Main's answers, stood in for: nothing opens. Node runs these with web
// storage off (vitest.config.ts), so a Map stands in for the settings'
// localStorage, as in settingsStore.test.ts.
const bridge = vi.hoisted(() => {
  const data = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
  return { list: vi.fn(), open: vi.fn() };
});
vi.mock('../services/openInBridge', () => ({ openInBridge: bridge }));

import {
  loadOpenInTargets,
  openFolderInFavourite,
  pickOpenIn,
  useOpenInStore,
} from './openInStore';
import { useSettingsStore } from './settingsStore';
import { useToastStore } from './toastStore';

const VS_CODE: OpenInTarget = { id: 'vscode', label: 'VS Code', kind: 'app' };
const FINDER: OpenInTarget = { id: 'finder', label: 'Finder', kind: 'file-manager' };
const FOLDER = '/Users/javidev/catalog-portal';

const toasts = () => useToastStore.getState().toasts.map((toast) => toast.message);

beforeEach(() => {
  bridge.list.mockReset().mockResolvedValue([VS_CODE, FINDER]);
  bridge.open.mockReset().mockResolvedValue({ ok: true });
  useOpenInStore.setState(useOpenInStore.getInitialState(), true);
  useSettingsStore.setState({ openInFavourite: null });
  useToastStore.setState({ toasts: [] });
});

describe('loadOpenInTargets', () => {
  it('keeps what main listed, asking once for callers at the same time', async () => {
    expect(useOpenInStore.getState().targets).toBeNull();
    await Promise.all([loadOpenInTargets(), loadOpenInTargets()]);
    expect(bridge.list).toHaveBeenCalledTimes(1);
    expect(useOpenInStore.getState().targets).toEqual([VS_CODE, FINDER]);
  });

  it('keeps the last list when main cannot answer', async () => {
    await loadOpenInTargets();
    bridge.list.mockRejectedValueOnce(new Error('main went away'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await loadOpenInTargets()).toEqual([VS_CODE, FINDER]);
    expect(useOpenInStore.getState().targets).toEqual([VS_CODE, FINDER]);
    warn.mockRestore();
  });

  it('holds an empty list when main never answered, so the menu can open and ask again', async () => {
    bridge.list.mockRejectedValueOnce(new Error('main went away'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await loadOpenInTargets()).toEqual([]);
    expect(useOpenInStore.getState().targets).toEqual([]);
    expect(await loadOpenInTargets()).toEqual([VS_CODE, FINDER]);
    warn.mockRestore();
  });
});

describe('openFolderInFavourite', () => {
  it('opens in Finder before any pick, asking for the list first when there is none', async () => {
    await openFolderInFavourite(FOLDER);
    expect(bridge.list).toHaveBeenCalledTimes(1);
    expect(bridge.open).toHaveBeenCalledWith({ targetId: 'finder', path: FOLDER });
  });

  it('opens in the app last picked, without asking for the list again', async () => {
    await loadOpenInTargets();
    useSettingsStore.getState().setOpenInFavourite('vscode');
    await openFolderInFavourite(FOLDER);
    expect(bridge.list).toHaveBeenCalledTimes(1);
    expect(bridge.open).toHaveBeenCalledWith({ targetId: 'vscode', path: FOLDER });
  });

  it('says in a toast why the folder did not open', async () => {
    bridge.open.mockResolvedValueOnce({ ok: false, error: `${FOLDER} does not exist.` });
    await openFolderInFavourite(FOLDER);
    expect(toasts()).toEqual([`${FOLDER} does not exist.`]);
  });

  it('asks for the list again after one that failed, and says so when it fails again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.list.mockRejectedValueOnce(new Error('main went away'));
    await loadOpenInTargets();
    expect(useOpenInStore.getState().targets).toEqual([]);

    await openFolderInFavourite(FOLDER);
    expect(bridge.list).toHaveBeenCalledTimes(2);
    expect(bridge.open).toHaveBeenCalledWith({ targetId: 'finder', path: FOLDER });

    useOpenInStore.setState({ targets: [] });
    bridge.list.mockRejectedValueOnce(new Error('main went away'));
    await openFolderInFavourite(FOLDER);
    expect(bridge.open).toHaveBeenCalledTimes(1);
    expect(toasts()).toEqual([
      "Couldn't open the folder: Consola could not list the apps to open it in.",
    ]);
    warn.mockRestore();
  });

  it('says so too when main could not be asked', async () => {
    bridge.open.mockRejectedValueOnce(new Error('Refused open-in:open'));
    await openFolderInFavourite(FOLDER);
    expect(toasts()).toEqual(["Couldn't open the folder: Refused open-in:open"]);
  });
});

describe('pickOpenIn', () => {
  it('opens in the app picked and makes it the favourite', async () => {
    await pickOpenIn(VS_CODE, FOLDER);
    expect(bridge.open).toHaveBeenCalledWith({ targetId: 'vscode', path: FOLDER });
    expect(useSettingsStore.getState().openInFavourite).toBe('vscode');
  });
});
