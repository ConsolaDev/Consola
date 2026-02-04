import { useCallback, useEffect, useMemo } from 'react';
import { useAgentStore, InstanceState } from '../stores/agentStore';
import { agentBridge } from '../services/agentBridge';

// Default empty state for when no instance is specified
const emptyInstanceState: InstanceState = {
  status: {
    isRunning: false,
    sessionId: null,
    model: null,
    permissionMode: null
  },
  sessionId: null,
  model: null,
  availableTools: [],
  mcpServers: [],
  messages: [],
  activeTools: [],
  toolHistory: [],
  lastResult: null,
  error: null,
  processing: {
    isProcessing: false,
    currentMessageId: null
  }
};

/**
 * Hook for Claude Agent operations in React components.
 * Provides reactive state and memoized actions scoped to a specific instance.
 *
 * @param instanceId - The instance ID to scope this hook to (null for home tab/no agent)
 * @param cwd - The working directory for this agent instance
 */
export function useAgent(instanceId: string | null, cwd: string = process.cwd()) {
  const isAvailable = useAgentStore(state => state.isAvailable);
  const instance = useAgentStore(state =>
    instanceId ? state.instances[instanceId] : undefined
  );
  const storeSendMessage = useAgentStore(state => state.sendMessage);
  const storeInterrupt = useAgentStore(state => state.interrupt);
  const storeClearMessages = useAgentStore(state => state.clearMessages);
  const storeClearError = useAgentStore(state => state.clearError);

  // Use instance state or empty state
  const instanceState = instance || emptyInstanceState;

  // Sync status on mount (only if we have an instanceId)
  useEffect(() => {
    if (!instanceId) return;

    const syncStatus = async () => {
      const status = await agentBridge.getStatus(instanceId);
      if (status) {
        const currentInstance = useAgentStore.getState().instances[instanceId];
        if (currentInstance) {
          useAgentStore.setState(state => ({
            instances: {
              ...state.instances,
              [instanceId]: { ...currentInstance, status }
            }
          }));
        }
      }
    };
    syncStatus();
  }, [instanceId]);

  // Memoized actions - all become no-ops if instanceId is null
  const sendMessage = useCallback((prompt: string, options?: {
    allowedTools?: string[];
    maxTurns?: number;
  }) => {
    if (instanceId) {
      storeSendMessage(instanceId, cwd, prompt, options);
    }
  }, [instanceId, cwd, storeSendMessage]);

  const interrupt = useCallback(() => {
    if (instanceId) {
      storeInterrupt(instanceId);
    }
  }, [instanceId, storeInterrupt]);

  const clearMessages = useCallback(() => {
    if (instanceId) {
      storeClearMessages(instanceId);
    }
  }, [instanceId, storeClearMessages]);

  const clearError = useCallback(() => {
    if (instanceId) {
      storeClearError(instanceId);
    }
  }, [instanceId, storeClearError]);

  return useMemo(() => ({
    // Connection state
    isAvailable,

    // Whether this hook has a valid instance
    hasInstance: instanceId !== null,

    // Running state
    isRunning: instanceState.status.isRunning,

    // Session info
    sessionId: instanceState.sessionId,
    model: instanceState.model,
    availableTools: instanceState.availableTools,
    mcpServers: instanceState.mcpServers,

    // Messages
    messages: instanceState.messages,

    // Tool tracking
    activeTools: instanceState.activeTools,
    toolHistory: instanceState.toolHistory,

    // Results
    lastResult: instanceState.lastResult,
    error: instanceState.error,

    // Processing
    isProcessing: instanceState.processing.isProcessing,

    // Actions
    sendMessage,
    interrupt,
    clearMessages,
    clearError
  }), [
    isAvailable,
    instanceId,
    instanceState,
    sendMessage,
    interrupt,
    clearMessages,
    clearError
  ]);
}
