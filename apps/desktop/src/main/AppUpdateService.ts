import type { AppUpdater } from 'electron-updater';
import type { AppUpdateState } from '../shared/appUpdates';

type UpdateEvent = 'error' | 'download-progress' | 'update-downloaded';

type Updater = Pick<AppUpdater, 'checkForUpdates' | 'downloadUpdate' |
    'quitAndInstall' | 'autoDownload' | 'autoInstallOnAppQuit' | 'allowPrerelease' | 'allowDowngrade'> & {
    on(event: UpdateEvent, listener: (...args: any[]) => void): void;
    removeListener(event: UpdateEvent, listener: (...args: any[]) => void): void;
};

export class AppUpdateService {
    private state: AppUpdateState;
    private timer?: ReturnType<typeof setInterval>;
    private busy = false;
    private installing = false;
    private disposed = false;
    private readonly listeners: Array<[UpdateEvent, (...args: any[]) => void]> = [];

    constructor(private readonly updater: Updater, version: string, enabled: boolean,
        private readonly publish: (state: AppUpdateState) => void) {
        this.state = { currentVersion: version, status: enabled ? 'idle' : 'disabled',
            ...(!enabled && { message: 'Automatic updates are available in the distributed macOS app.' }) };
        updater.autoDownload = false;
        updater.autoInstallOnAppQuit = false;
        updater.allowPrerelease = false;
        updater.allowDowngrade = false;
        this.listen('error', (error: Error) => this.fail(error));
        this.listen('download-progress', ({ percent }: { percent: number }) => {
            this.set({ status: 'downloading', progress: Math.round(percent) });
        });
        this.listen('update-downloaded', ({ version }: { version: string }) => {
            this.set({ status: 'ready', version, progress: 100, message: undefined });
        });
    }

    getState = (): AppUpdateState => ({ ...this.state });

    start(): void {
        if (this.timer || this.state.status === 'disabled') return;
        void this.check();
        this.timer = setInterval(() => { void this.check(); }, 4 * 60 * 60 * 1000);
        this.timer.unref();
    }

    async check(): Promise<AppUpdateState> {
        if (this.disposed || this.busy || ['disabled', 'ready'].includes(this.state.status)) return this.getState();
        this.busy = true;
        this.set({ status: 'checking', message: undefined, progress: undefined, version: undefined });
        try {
            // autoDownload is off so the single operation guard covers both phases.
            const result = await this.updater.checkForUpdates();
            if (this.disposed) return this.getState();
            this.set({ checkedAt: Date.now() });
            if (result?.isUpdateAvailable) {
                this.set({ status: 'downloading', version: result.updateInfo.version, progress: 0 });
                await this.updater.downloadUpdate();
            } else {
                this.set({ status: 'idle' });
            }
        } catch (error) {
            this.fail(error);
        } finally {
            this.busy = false;
        }
        return this.getState();
    }

    async install(confirm: () => Promise<boolean>): Promise<void> {
        if (this.disposed || this.state.status !== 'ready' || this.installing) return;
        this.installing = true;
        try {
            if (await confirm() && !this.disposed) this.updater.quitAndInstall(false, true);
        } catch (error) {
            this.fail(error);
        } finally {
            this.installing = false;
        }
    }

    dispose(): void {
        this.disposed = true;
        clearInterval(this.timer);
        for (const [event, listener] of this.listeners) this.updater.removeListener(event, listener);
    }

    private listen(event: UpdateEvent, listener: (...args: any[]) => void): void {
        this.listeners.push([event, listener]);
        this.updater.on(event, listener);
    }

    private fail(error: unknown): void {
        this.set({ status: 'error', message: error instanceof Error ? error.message : 'Unable to update. Try again later.' });
    }

    private set(patch: Partial<AppUpdateState>): void {
        if (this.disposed) return;
        this.state = { ...this.state, ...patch };
        this.publish(this.getState());
    }
}
