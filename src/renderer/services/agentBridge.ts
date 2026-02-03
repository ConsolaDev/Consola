import type {
  AgentStatus,
  AgentInitEvent,
  AgentMessageEvent,
  AgentToolEvent,
  AgentResultEvent,
  AgentQueryOptions
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

  /** Interrupt the current query */
  interrupt: (): void => {
    getAPI()?.interrupt();
  },

  /** Get current agent status */
  getStatus: async (): Promise<AgentStatus | null> => {
    return getAPI()?.getStatus() ?? null;
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
  onError: (callback: (data: { message: string }) => void): void => {
    getAPI()?.onError(callback);
  },

  /** Subscribe to status changes */
  onStatusChanged: (callback: (data: AgentStatus) => void): void => {
    getAPI()?.onStatusChanged(callback);
  },

  /** Subscribe to notifications */
  onNotification: (callback: (data: { message: string; title?: string }) => void): void => {
    getAPI()?.onNotification(callback);
  },

  /** Remove a listener */
  removeListener: (event: string, callback: Function): void => {
    getAPI()?.removeListener(event, callback);
  },
};
