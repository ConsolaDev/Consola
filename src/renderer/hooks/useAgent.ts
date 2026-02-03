import { useCallback, useEffect } from 'react';
import { useAgentStore } from '../stores/agentStore';
import { agentBridge } from '../services/agentBridge';

/**
 * Hook for Claude Agent operations in React components.
 * Provides reactive state and memoized actions.
 */
export function useAgent() {
  const store = useAgentStore();

  // Sync status on mount
  useEffect(() => {
    const syncStatus = async () => {
      const status = await agentBridge.getStatus();
      if (status) {
        useAgentStore.setState({ status });
      }
    };
    syncStatus();
  }, []);

  // Memoized actions
  const sendMessage = useCallback((prompt: string, options?: {
    allowedTools?: string[];
    maxTurns?: number;
  }) => {
    store.sendMessage(prompt, options);
  }, [store.sendMessage]);

  const interrupt = useCallback(() => {
    store.interrupt();
  }, [store.interrupt]);

  const clearMessages = useCallback(() => {
    store.clearMessages();
  }, [store.clearMessages]);

  const clearError = useCallback(() => {
    store.clearError();
  }, [store.clearError]);

  return {
    // Connection state
    isAvailable: store.isAvailable,

    // Running state
    isRunning: store.status.isRunning,

    // Session info
    sessionId: store.sessionId,
    model: store.model,
    availableTools: store.availableTools,
    mcpServers: store.mcpServers,

    // Messages
    messages: store.messages,

    // Tool tracking
    activeTools: store.activeTools,
    toolHistory: store.toolHistory,

    // Results
    lastResult: store.lastResult,
    error: store.error,

    // Actions
    sendMessage,
    interrupt,
    clearMessages,
    clearError
  };
}
