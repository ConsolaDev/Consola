import type {
  AgentStatus,
  AgentInitEvent,
  AgentMessageEvent,
  AgentToolEvent,
  AgentResultEvent,
  AgentQueryOptions,
  AgentInputRequest,
  AgentInputResponse,
  SessionEndEvent,
  SessionStartEvent
} from '../../shared/types';

/**
 * Agent Bridge - Isolates all window.claudeAgentAPI access to this single file.
 *
 * Why: Electron's contextBridge can only expose APIs on the window object.
 * This bridge wraps that access so the rest of the app doesn't touch window directly.
 */

function getAPI() {
  if (typeof window !== 'undefined' && window.claudeAgentAPI) {
    return window.claudeAgentAPI;
  }
  return null;
}

export const agentBridge = {
  /** Check if the agent API is available */
  isAvailable: (): boolean => {
    return getAPI() !== null;
  },

  /** Start a new agent query */
  startQuery: (options: AgentQueryOptions): void => {
    getAPI()?.startQuery(options);
  },

  /** Interrupt the current query for a specific instance */
  interrupt: (instanceId: string): void => {
    getAPI()?.interrupt(instanceId);
  },

  /** Get current agent status for a specific instance */
  getStatus: async (instanceId: string): Promise<AgentStatus | null> => {
    return getAPI()?.getStatus(instanceId) ?? null;
  },

  /** Destroy an agent instance */
  destroyInstance: (instanceId: string): void => {
    getAPI()?.destroyInstance(instanceId);
  },

  /** Respond to an input/permission request */
  respondToInput: (response: AgentInputResponse): void => {
    getAPI()?.respondToInput(response);
  },

  /** Initialize session (pre-load skills/commands) */
  initialize: async (instanceId: string, cwd: string): Promise<{
    skills: string[];
    slashCommands: string[];
    plugins: { name: string; path: string }[];
  } | null> => {
    return getAPI()?.initialize(instanceId, cwd) ?? null;
  },

  /** Subscribe to session initialization */
  onInit: (callback: (data: AgentInitEvent) => void): void => {
    getAPI()?.onInit(callback);
  },

  /** Subscribe to assistant messages */
  onAssistantMessage: (callback: (data: AgentMessageEvent) => void): void => {
    getAPI()?.onAssistantMessage(callback);
  },

  /** Subscribe to stream events */
  onStream: (callback: (data: unknown) => void): void => {
    getAPI()?.onStream(callback);
  },

  /** Subscribe to tool pending events */
  onToolPending: (callback: (data: AgentToolEvent) => void): void => {
    getAPI()?.onToolPending(callback);
  },

  /** Subscribe to tool complete events */
  onToolComplete: (callback: (data: AgentToolEvent) => void): void => {
    getAPI()?.onToolComplete(callback);
  },

  /** Subscribe to result events */
  onResult: (callback: (data: AgentResultEvent) => void): void => {
    getAPI()?.onResult(callback);
  },

  /** Subscribe to error events */
  onError: (callback: (data: { instanceId: string; message: string }) => void): void => {
    getAPI()?.onError(callback);
  },

  /** Subscribe to status changes */
  onStatusChanged: (callback: (data: AgentStatus & { instanceId: string }) => void): void => {
    getAPI()?.onStatusChanged(callback);
  },

  /** Subscribe to notifications */
  onNotification: (callback: (data: { instanceId: string; message: string; title?: string }) => void): void => {
    getAPI()?.onNotification(callback);
  },

  /** Subscribe to input/permission requests */
  onInputRequest: (callback: (data: AgentInputRequest) => void): void => {
    getAPI()?.onInputRequest(callback);
  },

  /** Subscribe to session end events */
  onSessionEnd: (callback: (data: SessionEndEvent) => void): void => {
    getAPI()?.onSessionEnd(callback);
  },

  /** Subscribe to session start events */
  onSessionStart: (callback: (data: SessionStartEvent) => void): void => {
    getAPI()?.onSessionStart(callback);
  },

  /** Remove a listener */
  removeListener: (event: string, callback: Function): void => {
    getAPI()?.removeListener(event, callback);
  },
};
