import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applicationDirs, detectTargets, FINDER_PATH } from './targets';

let root: string;
/** A stand-in for /Applications. */
let applications: string;
/** A stand-in for ~/Applications, where JetBrains Toolbox puts its apps. */
let homeApplications: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'consola-open-in-')));
  applications = path.join(root, 'Applications');
  homeApplications = path.join(root, 'home', 'Applications');
  fs.mkdirSync(applications, { recursive: true });
  fs.mkdirSync(homeApplications, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** An app bundle, which is a folder, under `dir`. */
const install = (dir: string, bundle: string) =>
  fs.mkdirSync(path.join(dir, bundle, 'Contents'), { recursive: true });

const onMac = () => detectTargets({ platform: 'darwin', dirs: [applications, homeApplications] });

describe('detectTargets on macOS', () => {
  it('offers Finder alone, last, when nothing else is installed', async () => {
    expect(await onMac()).toEqual([
      { id: 'finder', label: 'Finder', kind: 'file-manager', appPath: FINDER_PATH },
    ]);
  });

  it('finds the apps installed, in the table’s order, with the bundle each was found as', async () => {
    install(applications, 'Zed.app');
    install(applications, 'Visual Studio Code.app');
    install(applications, 'Xcode.app');
    expect(await onMac()).toEqual([
      {
        id: 'vscode',
        label: 'VS Code',
        kind: 'app',
        appPath: path.join(applications, 'Visual Studio Code.app'),
      },
      { id: 'zed', label: 'Zed', kind: 'app', appPath: path.join(applications, 'Zed.app') },
      { id: 'xcode', label: 'Xcode', kind: 'app', appPath: path.join(applications, 'Xcode.app') },
      { id: 'finder', label: 'Finder', kind: 'file-manager', appPath: FINDER_PATH },
    ]);
  });

  it('knows each app by every name it installs under', async () => {
    install(homeApplications, 'IntelliJ IDEA CE.app');
    install(applications, 'PyCharm Professional Edition.app');
    install(applications, 'Visual Studio Code - Insiders.app');
    const found = await onMac();
    expect(found.map(({ id, appPath }) => [id, appPath])).toEqual([
      ['vscode-insiders', path.join(applications, 'Visual Studio Code - Insiders.app')],
      ['intellij', path.join(homeApplications, 'IntelliJ IDEA CE.app')],
      ['pycharm', path.join(applications, 'PyCharm Professional Edition.app')],
      ['finder', FINDER_PATH],
    ]);
  });

  it('lists an app once, as found in the first folder that has it', async () => {
    install(applications, 'IntelliJ IDEA.app');
    install(homeApplications, 'IntelliJ IDEA CE.app');
    install(homeApplications, 'Cursor.app');
    install(applications, 'Cursor.app');
    const found = await onMac();
    expect(found.map(({ id, appPath }) => [id, appPath])).toEqual([
      ['cursor', path.join(applications, 'Cursor.app')],
      ['intellij', path.join(applications, 'IntelliJ IDEA.app')],
      ['finder', FINDER_PATH],
    ]);
  });

  it('takes only a bundle, which is a folder, for an app', async () => {
    fs.writeFileSync(path.join(applications, 'Sublime Text.app'), 'not a bundle');
    expect((await onMac()).map((target) => target.id)).toEqual(['finder']);
  });

  it('looks in /Applications, ~/Applications and /System/Applications', () => {
    expect(applicationDirs('/Users/javidev')).toEqual([
      '/Applications',
      '/Users/javidev/Applications',
      '/System/Applications',
    ]);
  });
});

describe('detectTargets elsewhere', () => {
  it('offers only the file manager, whatever is installed', async () => {
    install(applications, 'Visual Studio Code.app');
    expect(await detectTargets({ platform: 'linux', dirs: [applications] })).toEqual([
      { id: 'file-manager', label: 'File Manager', kind: 'file-manager' },
    ]);
    expect(await detectTargets({ platform: 'win32', dirs: [applications] })).toEqual([
      { id: 'file-manager', label: 'File Manager', kind: 'file-manager' },
    ]);
  });
});
