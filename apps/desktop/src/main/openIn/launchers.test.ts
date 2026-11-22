import { describe, expect, it, vi } from 'vitest';
import { createRecordingLauncher, createSystemLauncher } from './launchers';
import { FINDER_PATH, type DetectedTarget } from './targets';

const VS_CODE: DetectedTarget = {
  id: 'vscode',
  label: 'VS Code',
  kind: 'app',
  appPath: '/Applications/Visual Studio Code.app',
};
const FINDER: DetectedTarget = {
  id: 'finder',
  label: 'Finder',
  kind: 'file-manager',
  appPath: FINDER_PATH,
};
const FOLDER = '/Users/javidev/catalog-portal';

type Deps = Parameters<typeof createSystemLauncher>[0];

/** A launcher over stand-ins for `execFile` and `shell.openPath`: nothing runs. */
function launcher(overrides: Partial<Deps> = {}) {
  const deps: Deps = {
    run: vi.fn<Deps['run']>(async () => {}),
    openPath: vi.fn<Deps['openPath']>(async () => ''),
    ...overrides,
  };
  return { launch: createSystemLauncher(deps), ...deps };
}

describe('createSystemLauncher', () => {
  it('opens an app with open -a, as an argument list, the folder after --', async () => {
    const { launch, run, openPath } = launcher();
    expect(await launch(VS_CODE, FOLDER)).toBeNull();
    expect(run).toHaveBeenCalledWith('/usr/bin/open', [
      '-a',
      '/Applications/Visual Studio Code.app',
      '--',
      FOLDER,
    ]);
    expect(openPath).not.toHaveBeenCalled();
  });

  it('opens the file manager on the folder itself', async () => {
    const { launch, run, openPath } = launcher();
    expect(await launch(FINDER, FOLDER)).toBeNull();
    expect(openPath).toHaveBeenCalledWith(FOLDER);
    expect(run).not.toHaveBeenCalled();
  });

  it('says why open failed, in its own words', async () => {
    const failure = Object.assign(new Error('Command failed: /usr/bin/open'), {
      stderr: "Unable to find application named 'Visual Studio Code'\n",
    });
    const { launch } = launcher({ run: async () => Promise.reject(failure) });
    expect(await launch(VS_CODE, FOLDER)).toBe(
      "Unable to find application named 'Visual Studio Code'",
    );
    const { launch: quiet } = launcher({
      run: async () => Promise.reject(new Error('spawn /usr/bin/open ENOENT')),
    });
    expect(await quiet(VS_CODE, FOLDER)).toBe('spawn /usr/bin/open ENOENT');
  });

  it('says why the file manager did not open', async () => {
    const { launch } = launcher({ openPath: async () => 'Failed to open path' });
    expect(await launch(FINDER, FOLDER)).toBe('Failed to open path');
  });
});

describe('createRecordingLauncher', () => {
  it('records what would have opened, and opens nothing', async () => {
    const recorder = createRecordingLauncher();
    expect(await recorder.launch(VS_CODE, FOLDER)).toBeNull();
    expect(await recorder.launch(FINDER, '/Users/javidev/notes')).toBeNull();
    expect(recorder.launches).toEqual([
      { targetId: 'vscode', appPath: '/Applications/Visual Studio Code.app', folder: FOLDER },
      { targetId: 'finder', appPath: FINDER_PATH, folder: '/Users/javidev/notes' },
    ]);
  });
});
