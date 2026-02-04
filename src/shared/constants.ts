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

    // Claude Agent channels (Renderer -> Main)
    AGENT_START: 'agent:start',           // Start a new agent query
    AGENT_INTERRUPT: 'agent:interrupt',   // Interrupt running query
    AGENT_GET_STATUS: 'agent:get-status', // Get current agent status
    AGENT_DESTROY_INSTANCE: 'agent:destroy-instance', // Destroy agent instance

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

    // Claude Agent channels (Renderer -> Main) - Responses
    AGENT_INPUT_RESPONSE: 'agent:input-response',   // User responds to input request

    // Dialog channels
    DIALOG_SELECT_FOLDERS: 'dialog:select-folders',  // Open folder picker

    // File operations
    FILE_READ: 'file:read',  // Read file contents
} as const;

export const DEFAULT_INSTANCE_ID = 'default';

export const DEFAULT_DIMENSIONS = {
    cols: 80,
    rows: 24,
};
