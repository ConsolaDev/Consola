// IPC Channel names for communication between main and renderer processes

export const IPC_CHANNELS = {
    // Terminal lifecycle (renderer -> main)
    TERMINAL_CREATE: 'terminal:create',       // Start/attach a session terminal
    TERMINAL_INPUT: 'terminal:input',         // User input -> PTY
    TERMINAL_PASTE: 'terminal:paste',         // Bracketed-paste a block of text
    TERMINAL_RESIZE: 'terminal:resize',       // Terminal dimension changes
    TERMINAL_MODE_SWITCH: 'terminal:mode-switch', // Request claude/shell change
    TERMINAL_RESTART: 'terminal:restart',     // Relaunch claude after it exited
    TERMINAL_DESTROY: 'terminal:destroy',     // Tear down a session terminal

    // Terminal events (main -> renderer)
    TERMINAL_DATA: 'terminal:data',           // PTY output -> renderer
    TERMINAL_MODE_CHANGED: 'terminal:mode-changed', // Active PTY changed
    TERMINAL_ACTIVITY: 'terminal:activity',   // Busy/idle inferred from output
    TERMINAL_AWAITING_CONFIRMATION: 'terminal:awaiting-confirmation', // Menu on screen
    TERMINAL_EXIT: 'terminal:exit',           // A PTY exited

    // Claude CLI queries (renderer -> main)
    CLAUDE_AVAILABLE: 'claude:available',         // Is the binary resolvable?
    CLAUDE_SESSION_NAME: 'claude:session-name',   // Name from Claude's own index

    // Dialog channels
    DIALOG_SELECT_FOLDERS: 'dialog:select-folders',  // Open folder picker (multi-select)
    DIALOG_SELECT_FOLDER: 'dialog:select-folder',    // Open folder picker (single select for workspace)

    // File operations
    FILE_READ: 'file:read',  // Read file contents
    FILE_LIST_DIRECTORY: 'file:list-directory',  // List directory contents

    // Git operations
    GIT_GET_STATUS: 'git:get-status',  // Get git status and stats
    GIT_GET_DIFF: 'git:get-diff',      // Get file diff
    GIT_STAGE_FILE: 'git:stage-file',  // Stage a file (git add)
    GIT_UNSTAGE_FILE: 'git:unstage-file',  // Unstage a file (git reset HEAD)
    GIT_COMMIT: 'git:commit',          // Create a commit
    GIT_GET_STAGED_DIFF: 'git:get-staged-diff',  // Get unified diff of all staged files

    // Commit message generation (headless `claude -p`)
    GENERATE_COMMIT_MESSAGE: 'git:generate-commit-message',
} as const;

export const DEFAULT_DIMENSIONS = {
    cols: 80,
    rows: 24,
};
