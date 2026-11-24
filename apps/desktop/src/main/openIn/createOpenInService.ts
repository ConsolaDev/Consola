import { execFile } from 'node:child_process';
import * as os from 'node:os';
import { promisify } from 'node:util';
import { nativeImage, shell } from 'electron';
import { exposeToTests, isTest, openInApplicationsDir } from '../test-mode';
import { createRecordingLauncher, createSystemLauncher } from './launchers';
import type { Launcher } from './launchers';
import { OpenInService } from './OpenInService';
import { applicationDirs, detectTargets } from './targets';

const execFileAsync = promisify(execFile);

/** `open -a` hands the folder to Launch Services and exits; a hung one is given up on. */
const OPEN_TIMEOUT_MS = 10_000;

/** An app's icon, read at twice the 16px the button and menu draw it at. */
const ICON_PX = 32;

/**
 * "Open in" as the app runs it: the computer's application folders, each
 * app's icon from the system, and the system's own `open`.
 *
 * A test run opens nothing, whatever it is asked: its launcher records what
 * would have opened, for the e2e to read (`exposeToTests('openIn')`). It
 * looks for apps only in the folder the test gave
 * (`openInApplicationsDir`), so it offers Finder alone otherwise, whatever
 * this computer has installed.
 */
export function createOpenInService(): OpenInService {
  const testDir = openInApplicationsDir();
  const dirs = isTest ? (testDir ? [testDir] : []) : applicationDirs(os.homedir());
  let launch: Launcher;
  if (isTest) {
    const recorder = createRecordingLauncher();
    exposeToTests('openIn', recorder);
    launch = recorder.launch;
  } else {
    launch = createSystemLauncher({
      run: async (command, args) => {
        await execFileAsync(command, args, { timeout: OPEN_TIMEOUT_MS });
      },
      openPath: (folder) => shell.openPath(folder),
    });
  }
  return new OpenInService({
    detect: () => detectTargets({ platform: process.platform, dirs }),
    // Quick Look's thumbnail of the bundle, which is its icon. Not
    // `app.getFileIcon`: on macOS 27 with Electron 43 it answers a blank
    // placeholder for every app at 'small' and 'normal', and takes main down
    // at 'large'.
    readIcon: async (appPath) => {
      const image = await nativeImage.createThumbnailFromPath(appPath, {
        width: ICON_PX,
        height: ICON_PX,
      });
      return image.isEmpty() ? undefined : image.toDataURL();
    },
    launch,
  });
}
