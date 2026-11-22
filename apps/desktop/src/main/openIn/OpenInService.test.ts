import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenInService, type OpenInServiceDeps } from './OpenInService';
import { FINDER_PATH, type DetectedTarget } from './targets';

const VS_CODE: DetectedTarget = {
  id: 'vscode',
  label: 'VS Code',
  kind: 'app',
  appPath: '/Applications/Visual Studio Code.app',
};
const ZED: DetectedTarget = {
  id: 'zed',
  label: 'Zed',
  kind: 'app',
  appPath: '/Applications/Zed.app',
};
const FINDER: DetectedTarget = {
  id: 'finder',
  label: 'Finder',
  kind: 'file-manager',
  appPath: FINDER_PATH,
};

let root: string;
/** A session's folder. */
let folder: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-open-in-service-')));
  folder = path.join(root, 'catalog-portal');
  fs.mkdirSync(folder);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** VS Code and Finder installed, unless `overrides` says otherwise; nothing is ever launched. */
function service(overrides: Partial<OpenInServiceDeps> = {}) {
  const deps: OpenInServiceDeps = {
    detect: vi.fn(async () => [VS_CODE, FINDER]),
    readIcon: vi.fn(async (appPath: string) => `data:image/png;base64,${path.basename(appPath)}`),
    launch: vi.fn(async () => null),
    ...overrides,
  };
  return { openIn: new OpenInService(deps), ...deps };
}

/** Lets a refresh started behind an answer finish. */
const settle = () => new Promise((done) => setTimeout(done, 0));

describe('OpenInService.list', () => {
  it('answers what was found, each with its own icon', async () => {
    const { openIn } = service();
    expect(await openIn.list()).toEqual([
      {
        id: 'vscode',
        label: 'VS Code',
        kind: 'app',
        icon: 'data:image/png;base64,Visual Studio Code.app',
      },
      {
        id: 'finder',
        label: 'Finder',
        kind: 'file-manager',
        icon: 'data:image/png;base64,Finder.app',
      },
    ]);
  });

  it('keeps the answer for the run, and refreshes it behind each later answer', async () => {
    const detect = vi
      .fn<OpenInServiceDeps['detect']>()
      .mockResolvedValueOnce([VS_CODE, FINDER])
      .mockResolvedValue([VS_CODE, ZED, FINDER]);
    const { openIn } = service({ detect });
    expect((await openIn.list()).map((target) => target.id)).toEqual(['vscode', 'finder']);
    // Answered from the cache at once, though Zed was installed since.
    expect((await openIn.list()).map((target) => target.id)).toEqual(['vscode', 'finder']);
    expect(detect).toHaveBeenCalledTimes(2);
    await settle();
    expect((await openIn.list()).map((target) => target.id)).toEqual(['vscode', 'zed', 'finder']);
  });

  it('looks once for callers that ask before the first answer', async () => {
    const { openIn, detect } = service();
    await Promise.all([openIn.list(), openIn.list()]);
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it('reads an app’s icon once, and offers an app whose icon cannot be read without one', async () => {
    const readIcon = vi.fn(async (appPath: string) => {
      if (appPath === FINDER_PATH) throw new Error('no icon');
      return 'data:image/png;base64,code';
    });
    const { openIn } = service({ readIcon });
    await openIn.list();
    const answer = await openIn.list();
    await settle();
    expect(answer).toEqual([
      { id: 'vscode', label: 'VS Code', kind: 'app', icon: 'data:image/png;base64,code' },
      { id: 'finder', label: 'Finder', kind: 'file-manager' },
    ]);
    expect(readIcon.mock.calls.filter(([appPath]) => appPath === VS_CODE.appPath)).toHaveLength(1);
  });

  it('reads no icon for a file manager with no bundle', async () => {
    const fileManager: DetectedTarget = {
      id: 'file-manager',
      label: 'File Manager',
      kind: 'file-manager',
    };
    const { openIn, readIcon } = service({ detect: async () => [fileManager] });
    expect(await openIn.list()).toEqual([
      { id: 'file-manager', label: 'File Manager', kind: 'file-manager' },
    ]);
    expect(readIcon).not.toHaveBeenCalled();
  });
});

describe('OpenInService.open', () => {
  it('opens the folder in an app it found', async () => {
    const { openIn, launch } = service();
    expect(await openIn.open({ targetId: 'vscode', path: folder })).toEqual({ ok: true });
    expect(launch).toHaveBeenCalledWith(VS_CODE, folder);
  });

  it('opens in an app the last refresh found', async () => {
    const detect = vi
      .fn<OpenInServiceDeps['detect']>()
      .mockResolvedValueOnce([FINDER])
      .mockResolvedValue([ZED, FINDER]);
    const { openIn, launch } = service({ detect });
    await openIn.list();
    await openIn.list();
    await settle();
    expect(await openIn.open({ targetId: 'zed', path: folder })).toEqual({ ok: true });
    expect(launch).toHaveBeenCalledWith(ZED, folder);
  });

  it('refuses an app it did not find', async () => {
    const { openIn, launch } = service();
    expect(await openIn.open({ targetId: 'zed', path: folder })).toEqual({
      ok: false,
      error: 'Consola found no app “zed” on this computer.',
    });
    expect(await openIn.open({ targetId: 'Terminal', path: folder })).toMatchObject({ ok: false });
    expect(launch).not.toHaveBeenCalled();
  });

  it('refuses a path that is not absolute', async () => {
    const { openIn, launch } = service();
    expect(await openIn.open({ targetId: 'vscode', path: 'catalog-portal' })).toEqual({
      ok: false,
      error: '“catalog-portal” is not a full path to a folder.',
    });
    expect(await openIn.open({ targetId: 'vscode', path: '' })).toMatchObject({ ok: false });
    expect(launch).not.toHaveBeenCalled();
  });

  it('refuses a folder that is not there', async () => {
    const { openIn, launch } = service();
    const gone = path.join(root, 'gone');
    expect(await openIn.open({ targetId: 'vscode', path: gone })).toEqual({
      ok: false,
      error: `${gone} does not exist.`,
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it('refuses a file', async () => {
    const { openIn, launch } = service();
    const file = path.join(folder, 'README.md');
    fs.writeFileSync(file, '# Catalog portal\n');
    expect(await openIn.open({ targetId: 'finder', path: file })).toEqual({
      ok: false,
      error: `${file} is not a folder.`,
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it('refuses a request that is not one', async () => {
    const { openIn, launch } = service();
    for (const request of [null, 'vscode', { targetId: 'vscode' }, { targetId: 7, path: folder }]) {
      expect(await openIn.open(request)).toEqual({
        ok: false,
        error: 'Consola was not told which app and folder to open.',
      });
    }
    expect(launch).not.toHaveBeenCalled();
  });

  it('says why the app did not open', async () => {
    const { openIn } = service({
      launch: async () => "Unable to find application named 'Visual Studio Code'",
    });
    expect(await openIn.open({ targetId: 'vscode', path: folder })).toEqual({
      ok: false,
      error:
        "Couldn't open the folder in VS Code: Unable to find application named 'Visual Studio Code'",
    });
  });
});
