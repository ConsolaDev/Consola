import { create } from 'zustand';
import type {
  AgentStatus,
  AgentInitEvent,
  AgentMessageEvent,
  AgentToolEvent,
  AgentResultEvent
} from '../../shared/types';
import { agentBridge } from '../services/agentBridge';

// Content block types from SDK
export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock;

// Processing state (simplified from streaming)
export interface ProcessingState {
  isProcessing: boolean;
  currentMessageId: string | null;
}

// Message type for chat display
export interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  contentBlocks?: ContentBlock[];
  timestamp: number;
}

// Tool execution tracking
export interface ToolExecution {
  id: string;
  toolUseId?: string;  // From SDK - correlates with tool_use block
  toolName: string;
  toolInput: unknown;
  toolResponse?: unknown;
  status: 'pending' | 'complete' | 'error';
  timestamp: number;
}

// Per-instance state
export interface InstanceState {
  // Status
  status: AgentStatus;

  // Session
  sessionId: string | null;
  model: string | null;
  availableTools: string[];
  mcpServers: { name: string; status: string }[];

  // Messages
  messages: Message[];

  // Tools
  activeTools: ToolExecution[];
  toolHistory: ToolExecution[];

  // Results
  lastResult: AgentResultEvent | null;
  error: string | null;

  // Processing
  processing: ProcessingState;
}

// Default instance state factory
function createDefaultInstanceState(): InstanceState {
  return {
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
}

interface AgentState {
  // Global state
  isAvailable: boolean;

  // Per-instance state
  instances: Record<string, InstanceState>;

  // Instance management
  getInstance: (instanceId: string) => InstanceState;
  getOrCreateInstance: (instanceId: string) => InstanceState;
  destroyInstance: (instanceId: string) => void;

  // Actions (per-instance)
  sendMessage: (instanceId: string, cwd: string, prompt: string, options?: {
    allowedTools?: string[];
    maxTurns?: number;
  }) => void;
  interrupt: (instanceId: string) => void;
  clearMessages: (instanceId: string) => void;
  clearError: (instanceId: string) => void;

  // Internal actions for event handling
  _handleInit: (data: AgentInitEvent) => void;
  _handleAssistantMessage: (data: AgentMessageEvent) => void;
  _handleToolPending: (data: AgentToolEvent) => void;
  _handleToolComplete: (data: AgentToolEvent) => void;
  _handleResult: (data: AgentResultEvent) => void;
  _handleError: (data: { instanceId: string; message: string }) => void;
  _handleStatusChanged: (data: AgentStatus & { instanceId: string }) => void;
  _handleStream: (data: { instanceId: string; event: any; uuid: string }) => void;
}

// Extract all content blocks from SDK message
function extractContentBlocks(content: unknown): ContentBlock[] {
  if (!Array.isArray(content)) return [];

  return content
    .filter((block: any) =>
      block.type === 'text' ||
      block.type === 'thinking' ||
      block.type === 'tool_use'
    )
    .map((block: any): ContentBlock => {
      if (block.type === 'text') {
        return { type: 'text', text: block.text };
      }
      if (block.type === 'thinking') {
        return { type: 'thinking', thinking: block.thinking, signature: block.signature };
      }
      if (block.type === 'tool_use') {
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      }
      return block;
    });
}

// Get plain text for backwards compatibility
function getPlainText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

// Generate a UUID (fallback for environments without crypto.randomUUID)
function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

// Helper to update instance state immutably
function updateInstance(
  state: AgentState,
  instanceId: string,
  updater: (instance: InstanceState) => Partial<InstanceState>
): Partial<AgentState> {
  const instance = state.instances[instanceId] || createDefaultInstanceState();
  const updates = updater(instance);
  return {
    instances: {
      ...state.instances,
      [instanceId]: { ...instance, ...updates }
    }
  };
}

export const useAgentStore = create<AgentState>((set, get) => ({
  // Initial state
  isAvailable: agentBridge.isAvailable(),
  instances: {},

  // === Instance Management ===

  getInstance: (instanceId: string) => {
    return get().instances[instanceId] || createDefaultInstanceState();
  },

  getOrCreateInstance: (instanceId: string) => {
    const state = get();
    if (!state.instances[instanceId]) {
      set({
        instances: {
          ...state.instances,
          [instanceId]: createDefaultInstanceState()
        }
      });
    }
    return get().instances[instanceId];
  },

  destroyInstance: (instanceId: string) => {
    // Notify main process to destroy the service
    agentBridge.destroyInstance(instanceId);

    // Remove from local state
    set(state => {
      const { [instanceId]: _, ...remaining } = state.instances;
      return { instances: remaining };
    });
  },

  // === Public Actions ===

  sendMessage: (instanceId, cwd, prompt, options = {}) => {
    // Ensure instance exists
    get().getOrCreateInstance(instanceId);

    // Add user message to store
    const userMessage: Message = {
      id: generateId(),
      type: 'user',
      content: prompt,
      timestamp: Date.now()
    };

    set(state => updateInstance(state, instanceId, (instance) => ({
      messages: [...instance.messages, userMessage],
      error: null
    })));

    // Start query via bridge
    const instance = get().instances[instanceId];
    agentBridge.startQuery({
      instanceId,
      cwd,
      prompt,
      ...options,
      continue: instance?.sessionId !== null
    });
  },

  interrupt: (instanceId) => {
    agentBridge.interrupt(instanceId);
  },

  clearMessages: (instanceId) => {
    set(state => updateInstance(state, instanceId, () => ({
      messages: [],
      activeTools: [],
      toolHistory: [],
      lastResult: null,
      sessionId: null
    })));
  },

  clearError: (instanceId) => {
    set(state => updateInstance(state, instanceId, () => ({
      error: null
    })));
  },

  // === Internal Event Handlers ===

  _handleInit: (data: AgentInitEvent) => {
    const { instanceId, ...initData } = data;
    set(state => updateInstance(state, instanceId, () => ({
      sessionId: initData.sessionId,
      model: initData.model,
      availableTools: initData.tools,
      mcpServers: initData.mcpServers
    })));
  },

  _handleAssistantMessage: (data: AgentMessageEvent) => {
    const { instanceId, ...messageData } = data;
    const contentBlocks = extractContentBlocks(messageData.content);
    const plainText = getPlainText(contentBlocks);

    const message: Message = {
      id: messageData.uuid,
      type: 'assistant',
      content: plainText,
      contentBlocks,
      timestamp: Date.now()
    };

    set(state => updateInstance(state, instanceId, (instance) => ({
      messages: [...instance.messages, message],
      processing: { isProcessing: false, currentMessageId: null }
    })));
  },

  _handleToolPending: (data: AgentToolEvent) => {
    const { instanceId, ...toolData } = data;
    const tool: ToolExecution = {
      id: generateId(),
      toolUseId: toolData.toolUseId,
      toolName: toolData.toolName,
      toolInput: toolData.toolInput,
      status: 'pending',
      timestamp: Date.now()
    };
    set(state => updateInstance(state, instanceId, (instance) => ({
      activeTools: [...instance.activeTools, tool]
    })));
  },

  _handleToolComplete: (data: AgentToolEvent) => {
    const { instanceId, ...toolData } = data;
    set(state => {
      const instance = state.instances[instanceId];
      if (!instance) return state;

      // Find the pending tool - prefer matching by toolUseId, fall back to name
      let pendingIndex = -1;
      if (toolData.toolUseId) {
        pendingIndex = instance.activeTools.findIndex(
          t => t.toolUseId === toolData.toolUseId && t.status === 'pending'
        );
      }
      // Fallback to name-based matching if no toolUseId or not found
      if (pendingIndex === -1) {
        pendingIndex = instance.activeTools.findIndex(
          t => t.toolName === toolData.toolName && t.status === 'pending'
        );
      }

      if (pendingIndex === -1) {
        return state;
      }

      const pendingTool = instance.activeTools[pendingIndex];
      const completedTool: ToolExecution = {
        ...pendingTool,
        toolUseId: toolData.toolUseId || pendingTool.toolUseId,
        toolResponse: toolData.toolResponse,
        status: 'complete'
      };

      // Remove from active, add to history
      const newActiveTools = [...instance.activeTools];
      newActiveTools.splice(pendingIndex, 1);

      return updateInstance(state, instanceId, () => ({
        activeTools: newActiveTools,
        toolHistory: [...instance.toolHistory, completedTool]
      }));
    });
  },

  _handleResult: (data: AgentResultEvent) => {
    const { instanceId, ...resultData } = data;
    set(state => updateInstance(state, instanceId, () => ({
      lastResult: { instanceId, ...resultData },
      processing: { isProcessing: false, currentMessageId: null }
    })));
  },

  _handleError: (data: { instanceId: string; message: string }) => {
    const { instanceId, message } = data;
    set(state => updateInstance(state, instanceId, () => ({
      error: message,
      processing: { isProcessing: false, currentMessageId: null }
    })));
  },

  _handleStatusChanged: (data: AgentStatus & { instanceId: string }) => {
    const { instanceId, ...status } = data;
    set(state => updateInstance(state, instanceId, () => ({
      status,
      // Reset processing when agent stops running
      ...(status.isRunning ? {} : { processing: { isProcessing: false, currentMessageId: null } })
    })));
  },

  _handleStream: (data: { instanceId: string; event: any; uuid: string }) => {
    const { instanceId, uuid } = data;
    // Just mark that we're processing - don't accumulate text
    set(state => {
      const instance = state.instances[instanceId];
      if (!instance || instance.processing.isProcessing) {
        return state;
      }
      return updateInstance(state, instanceId, () => ({
        processing: { isProcessing: true, currentMessageId: uuid }
      }));
    });
  }
}));

// Initialize event listeners when module loads
if (typeof window !== 'undefined') {
  const store = useAgentStore.getState();

  agentBridge.onInit(store._handleInit);
  agentBridge.onAssistantMessage(store._handleAssistantMessage);
  agentBridge.onToolPending(store._handleToolPending);
  agentBridge.onToolComplete(store._handleToolComplete);
  agentBridge.onResult(store._handleResult);
  agentBridge.onError(store._handleError);
  agentBridge.onStatusChanged(store._handleStatusChanged);
  agentBridge.onStream(store._handleStream);
}
