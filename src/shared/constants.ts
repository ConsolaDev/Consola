// IPC Channel names for communication between main and renderer processes

export const IPC_CHANNELS = {
    // Terminal data flow
    TERMINAL_DATA: 'terminal:data',       // PTY output -> renderer
    TERMINAL_INPUT: 'terminal:input',     // User input -> PTY
    TERMINAL_RESIZE: 'terminal:resize',   // Terminal dimension changes

    // Mode management
    MODE_SWITCH: 'mode:switch',           // Request mode change
    MODE_CHANGED: 'mode:changed',         // Notify mode changed

    // Session management (reserved for future multi-instance support)
    SESSION_CREATE: 'session:create',
    SESSION_DESTROY: 'session:destroy',
    SESSION_LIST: 'session:list',
} as const;

export const DEFAULT_INSTANCE_ID = 'default';

export const DEFAULT_DIMENSIONS = {
    cols: 80,
    rows: 24,
};
