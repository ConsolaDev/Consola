export const UPDATE_CHANNELS = {
    GET: 'app-update:get', CHECK: 'app-update:check',
    INSTALL: 'app-update:install', CHANGED: 'app-update:changed',
} as const;

export interface AppUpdateState {
    status: 'disabled' | 'idle' | 'checking' | 'downloading' | 'ready' | 'error';
    currentVersion: string;
    version?: string;
    progress?: number;
    message?: string;
    checkedAt?: number;
}

export interface AppUpdateAPI {
    getState(): Promise<AppUpdateState>;
    check(): Promise<AppUpdateState>;
    install(): Promise<void>;
    onChanged(callback: (state: AppUpdateState) => void): () => void;
}
