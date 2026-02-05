import { useCallback, useEffect, useMemo } from 'react';
import { useAgentStore, InstanceState } from '../stores/agentStore';
import { agentBridge } from '../services/agentBridge';
import { ModelUsage } from '../../shared/types';

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
  skills: [],
  slashCommands: [],
  plugins: [],
  messages: [],
  toolHistory: [],
  pendingInputs: [],
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
 * @param additionalDirectories - Additional directories the agent can access
 */
export function useAgent(instanceId: string | null, cwd: string = '', additionalDirectories: string[] = []) {
  const isAvailable = useAgentStore(state => state.isAvailable);
  const instance = useAgentStore(state =>
    instanceId ? state.instances[instanceId] : undefined
  );
  const storeSendMessage = useAgentStore(state => state.sendMessage);
  const storeInterrupt = useAgentStore(state => state.interrupt);
  const storeClearMessages = useAgentStore(state => state.clearMessages);
  const storeClearError = useAgentStore(state => state.clearError);
  const storeRespondToInput = useAgentStore(state => state.respondToInput);
  const storeInitializeSession = useAgentStore(state => state.initializeSession);

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

  // Initialize session to pre-load skills/commands (only if we have an instanceId and cwd)
  useEffect(() => {
    if (!instanceId || !cwd) return;

    // Only initialize if we don't already have skills loaded
    const currentInstance = useAgentStore.getState().instances[instanceId];
    if (!currentInstance || (currentInstance.skills.length === 0 && currentInstance.slashCommands.length === 0)) {
      storeInitializeSession(instanceId, cwd);
    }
  }, [instanceId, cwd, storeInitializeSession]);

  // Memoized actions - all become no-ops if instanceId is null
  const sendMessage = useCallback((prompt: string, options?: {
    allowedTools?: string[];
    maxTurns?: number;
  }) => {
    if (instanceId) {
      storeSendMessage(instanceId, cwd, prompt, {
        ...options,
        additionalDirectories,
      });
    }
  }, [instanceId, cwd, additionalDirectories, storeSendMessage]);

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

  const respondToInput = useCallback((requestId: string, action: 'approve' | 'reject' | 'modify', options?: {
    modifiedInput?: Record<string, unknown>;
    feedback?: string;
    answers?: Record<string, string>;
  }) => {
    if (instanceId) {
      storeRespondToInput(instanceId, requestId, action, options);
    }
  }, [instanceId, storeRespondToInput]);

  // Extract usage for the current model from lastResult.modelUsage
  const currentModelUsage = useMemo((): ModelUsage | null => {
    if (!instanceState?.lastResult?.modelUsage || !instanceState?.model) {
      return null;
    }
    // modelUsage is keyed by model ID
    return instanceState.lastResult.modelUsage[instanceState.model] ?? null;
  }, [instanceState?.lastResult?.modelUsage, instanceState?.model]);

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
    skills: instanceState.skills,
    slashCommands: instanceState.slashCommands,
    plugins: instanceState.plugins,

    // Messages
    messages: instanceState.messages,

    // Tool history (for inline display in messages)
    toolHistory: instanceState.toolHistory,

    // Pending input requests
    pendingInputs: instanceState.pendingInputs,

    // Results
    lastResult: instanceState.lastResult,
    error: instanceState.error,

    // Model usage (for context status bar)
    modelUsage: currentModelUsage,

    // Processing
    isProcessing: instanceState.processing.isProcessing,

    // Actions
    sendMessage,
    interrupt,
    clearMessages,
    clearError,
    respondToInput
  }), [
    isAvailable,
    instanceId,
    instanceState,
    currentModelUsage,
    sendMessage,
    interrupt,
    clearMessages,
    clearError,
    respondToInput
  ]);
}
