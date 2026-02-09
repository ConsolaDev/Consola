// IPC Channel names for communication between main and renderer processes

export const IPC_CHANNELS = {
    // Terminal data flow
    TERMINAL_DATA: 'terminal:data',       // PTY output -> renderer
    TERMINAL_INPUT: 'terminal:input',     // User input -> PTY
    TERMINAL_RESIZE: 'terminal:resize',   // Terminal dimension changes

    // Mode management
    MODE_SWITCH: 'mode:switch',           // Request mode change
    MODE_CHANGED: 'mode:changed',         // Notify mode changed

    // Session management
    SESSION_CREATE: 'session:create',
    SESSION_DESTROY: 'session:destroy',
    SESSION_LIST: 'session:list',
    SESSION_GENERATE_NAME: 'session:generate-name',

    // Claude Agent channels (Renderer -> Main)
    AGENT_START: 'agent:start',           // Start a new agent query
    AGENT_INTERRUPT: 'agent:interrupt',   // Interrupt running query
    AGENT_GET_STATUS: 'agent:get-status', // Get current agent status
    AGENT_DESTROY_INSTANCE: 'agent:destroy-instance', // Destroy agent instance
    AGENT_INITIALIZE: 'agent:initialize', // Initialize session (pre-load skills/commands)

    // Claude Agent channels (Main -> Renderer)
    AGENT_INIT: 'agent:init',                       // Session initialized
    AGENT_MESSAGE: 'agent:message',                 // Raw SDK message
    AGENT_ASSISTANT_MESSAGE: 'agent:assistant-message', // Assistant response
    AGENT_STREAM: 'agent:stream',                   // Streaming event
    AGENT_TOOL_PENDING: 'agent:tool-pending',       // Tool execution started
    AGENT_TOOL_COMPLETE: 'agent:tool-complete',     // Tool execution completed
    AGENT_RESULT: 'agent:result',                   // Final result
    AGENT_ERROR: 'agent:error',                     // Error occurred
    AGENT_STATUS_CHANGED: 'agent:status-changed',   // Status update
    AGENT_NOTIFICATION: 'agent:notification',       // Notification from agent
    AGENT_INPUT_REQUEST: 'agent:input-request',     // Agent needs user input/approval
    AGENT_SESSION_END: 'agent:session-end',         // Session ended (clear, logout, etc.)
    AGENT_SESSION_START: 'agent:session-start',     // Session started (startup, resume, clear, compact)

    // Claude Agent channels (Renderer -> Main) - Responses
    AGENT_INPUT_RESPONSE: 'agent:input-response',   // User responds to input request

    // Trust mode channels (auto-approve all for session)
    AGENT_SET_TRUST_MODE: 'agent:set-trust-mode',     // Set trust mode (renderer -> main)
    AGENT_TRUST_MODE_CHANGED: 'agent:trust-mode-changed', // Trust mode changed (main -> renderer)

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

    // Commit message generation
    AGENT_GENERATE_COMMIT_MESSAGE: 'agent:generate-commit-message',

    // Media attachment channels
    MEDIA_ADD_FROM_PATH: 'media:add-from-path',       // Save image from file path
    MEDIA_REMOVE: 'media:remove',                      // Remove a specific attachment
    MEDIA_GET_BASE64: 'media:get-base64',              // Read image as base64 for SDK
    MEDIA_CLEANUP_INSTANCE: 'media:cleanup-instance',  // Clean up all media for an instance

    // Dialog channels - images
    DIALOG_SELECT_IMAGES: 'dialog:select-images',      // Open image file picker
} as const;

export const DEFAULT_INSTANCE_ID = 'default';

// Supported image types for media attachments
export const SUPPORTED_IMAGE_TYPES: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
};

export const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB per image
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

export const DEFAULT_DIMENSIONS = {
    cols: 80,
    rows: 24,
};
