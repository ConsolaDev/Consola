import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppUpdateService } from './AppUpdateService';

function setup(enabled = true) {
    const updater = Object.assign(new EventEmitter(), {
        autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: true, allowDowngrade: true,
        checkForUpdates: vi.fn().mockResolvedValue({ isUpdateAvailable: false }),
        downloadUpdate: vi.fn().mockImplementation(async () => {
            updater.emit('download-progress', { percent: 42.3 });
            updater.emit('update-downloaded', { version: '1.1.0' });
            return [];
        }),
        quitAndInstall: vi.fn(),
    });
    const publish = vi.fn();
    const service = new AppUpdateService(updater, '1.0.0', enabled, publish);
    return { service, updater, publish };
}

afterEach(() => vi.useRealTimers());

describe('AppUpdateService', () => {
    it('does not check or install from a local/development build', async () => {
        const { service, updater } = setup(false);
        service.start();
        await service.check();
        await service.install(async () => true);
        expect(service.getState().status).toBe('disabled');
        expect(updater.checkForUpdates).not.toHaveBeenCalled();
        expect(updater.quitAndInstall).not.toHaveBeenCalled();
        service.dispose();
    });

    it('downloads an available release and waits for explicit restart confirmation', async () => {
        const { service, updater, publish } = setup();
        updater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version: '1.1.0' } });
        await service.check();
        expect(publish.mock.calls.map(([state]) => state.status)).toContain('downloading');
        expect(publish.mock.calls.some(([state]) => state.progress === 42)).toBe(true);
        expect(service.getState()).toMatchObject({ status: 'ready', version: '1.1.0', currentVersion: '1.0.0' });
        expect(updater.autoInstallOnAppQuit).toBe(false);
        expect(updater.allowPrerelease).toBe(false);
        expect(updater.allowDowngrade).toBe(false);
        expect(updater.quitAndInstall).not.toHaveBeenCalled();
        await service.install(async () => false);
        expect(updater.quitAndInstall).not.toHaveBeenCalled();
        await service.check();
        expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
        await service.install(async () => true);
        expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
        service.dispose();
    });

    it('does not offer an install before a verified download is ready', async () => {
        const { service, updater } = setup();
        const confirm = vi.fn().mockResolvedValue(true);
        await service.install(confirm);
        expect(confirm).not.toHaveBeenCalled();
        expect(updater.quitAndInstall).not.toHaveBeenCalled();
        service.dispose();
    });

    it('coalesces simultaneous checks and recovers after a failed request', async () => {
        const { service, updater } = setup();
        let reject!: (error: Error) => void;
        updater.checkForUpdates.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
        const first = service.check();
        await service.check();
        expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
        reject(new Error('Offline'));
        await first;
        expect(service.getState()).toMatchObject({ status: 'error', message: 'Offline' });
        await service.check();
        expect(service.getState()).toMatchObject({ status: 'idle', message: undefined });
        service.dispose();
    });

    it('allows retry after a download failure', async () => {
        const { service, updater } = setup();
        updater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version: '1.1.0' } });
        updater.downloadUpdate.mockRejectedValueOnce(new Error('Interrupted download'));
        await service.check();
        expect(service.getState().status).toBe('error');
        await service.check();
        expect(service.getState().status).toBe('ready');
        service.dispose();
    });

    it('checks on startup and every four hours, stopping on disposal', async () => {
        vi.useFakeTimers();
        const { service, updater } = setup();
        service.start();
        service.start();
        await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
        expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
        service.dispose();
        await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
        expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    });

    it('does not show two restart dialogs when multiple windows request installation', async () => {
        const { service, updater } = setup();
        updater.emit('update-downloaded', { version: '1.1.0' });
        let resolve!: (confirmed: boolean) => void;
        const confirm = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
        const first = service.install(confirm);
        await service.install(confirm);
        expect(confirm).toHaveBeenCalledTimes(1);
        resolve(true);
        await first;
        expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
        service.dispose();
    });
});
