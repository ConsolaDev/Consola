import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { autoUpdater } from 'electron-updater';
import { UPDATE_CHANNELS } from '../shared/appUpdates';
import { AppUpdateService } from './AppUpdateService';

export function setupAppUpdates(): () => void {
    let enabled = false;
    if (app.isPackaged && process.platform === 'darwin') {
        const metadata = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'));
        enabled = metadata.consolaAutoUpdates === true;
    }
    const service = new AppUpdateService(autoUpdater, app.getVersion(), enabled, state => {
        for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
                window.webContents.send(UPDATE_CHANNELS.CHANGED, state);
            }
        }
    });
    ipcMain.handle(UPDATE_CHANNELS.GET, () => service.getState());
    ipcMain.handle(UPDATE_CHANNELS.CHECK, () => service.check());
    ipcMain.handle(UPDATE_CHANNELS.INSTALL, () => service.install(async () => {
        const result = await dialog.showMessageBox({
            type: 'question', buttons: ['Later', 'Restart and install'], defaultId: 0, cancelId: 0,
            title: 'Update Consola', message: 'Restart Consola to install the update?',
            detail: 'Running agents and terminal commands will stop. Saved workspaces and conversations will remain.',
        });
        return result.response === 1;
    }));
    service.start();
    return () => {
        service.dispose();
        for (const channel of [UPDATE_CHANNELS.GET, UPDATE_CHANNELS.CHECK, UPDATE_CHANNELS.INSTALL]) {
            ipcMain.removeHandler(channel);
        }
    };
}
