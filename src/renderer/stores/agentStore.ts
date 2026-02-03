import { create } from 'zustand';
import type {
  AgentStatus,
  AgentInitEvent,
  AgentMessageEvent,
  AgentToolEvent,
  AgentResultEvent
} from '../../shared/types';
import { agentBridge } from '../services/agentBridge';

// Message type for chat display
export interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// Tool execution tracking
export interface ToolExecution {
  id: string;
  toolName: string;
  toolInput: unknown;
  toolResponse?: unknown;
  status: 'pending' | 'complete' | 'error';
  timestamp: number;
}

interface AgentState {
  // Connection
  isAvailable: boolean;

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

  // Actions
  sendMessage: (prompt: string, options?: {
    allowedTools?: string[];
    maxTurns?: number;
  }) => void;
  interrupt: () => void;
  clearMessages: () => void;
  clearError: () => void;

  // Internal actions for event handling
  _handleInit: (data: AgentInitEvent) => void;
  _handleAssistantMessage: (data: AgentMessageEvent) => void;
  _handleToolPending: (data: AgentToolEvent) => void;
  _handleToolComplete: (data: AgentToolEvent) => void;
  _handleResult: (data: AgentResultEvent) => void;
  _handleError: (data: { message: string }) => void;
  _handleStatusChanged: (status: AgentStatus) => void;
}

// Helper to extract text from message content
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block: any) => block.type === 'text')
      .map((block: any) => block.text)
      .join('\n');
  }
  return '';
}

// Generate a UUID (fallback for environments without crypto.randomUUID)
function generateId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  // Initial state
  isAvailable: agentBridge.isAvailable(),
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

  // === Public Actions ===

  sendMessage: (prompt, options = {}) => {
    // Add user message to store
    const userMessage: Message = {
      id: generateId(),
      type: 'user',
      content: prompt,
      timestamp: Date.now()
    };

    set(state => ({
      messages: [...state.messages, userMessage],
      error: null
    }));

    // Start query via bridge
    agentBridge.startQuery({
      prompt,
      ...options,
      continue: get().sessionId !== null
    });
  },

  interrupt: () => {
    agentBridge.interrupt();
  },

  clearMessages: () => {
    set({
      messages: [],
      activeTools: [],
      toolHistory: [],
      lastResult: null,
      sessionId: null
    });
  },

  clearError: () => {
    set({ error: null });
  },

  // === Internal Event Handlers ===

  _handleInit: (data: AgentInitEvent) => {
    set({
      sessionId: data.sessionId,
      model: data.model,
      availableTools: data.tools,
      mcpServers: data.mcpServers
    });
  },

  _handleAssistantMessage: (data: AgentMessageEvent) => {
    const content = extractTextContent(data.content);
    if (content) {
      const message: Message = {
        id: data.uuid,
        type: 'assistant',
        content,
        timestamp: Date.now()
      };
      set(state => ({
        messages: [...state.messages, message]
      }));
    }
  },

  _handleToolPending: (data: AgentToolEvent) => {
    const tool: ToolExecution = {
      id: generateId(),
      toolName: data.toolName,
      toolInput: data.toolInput,
      status: 'pending',
      timestamp: Date.now()
    };
    set(state => ({
      activeTools: [...state.activeTools, tool]
    }));
  },

  _handleToolComplete: (data: AgentToolEvent) => {
    set(state => {
      // Find the pending tool
      const pendingIndex = state.activeTools.findIndex(
        t => t.toolName === data.toolName && t.status === 'pending'
      );

      if (pendingIndex === -1) {
        return state;
      }

      const pendingTool = state.activeTools[pendingIndex];
      const completedTool: ToolExecution = {
        ...pendingTool,
        toolResponse: data.toolResponse,
        status: 'complete'
      };

      // Remove from active, add to history
      const newActiveTools = [...state.activeTools];
      newActiveTools.splice(pendingIndex, 1);

      return {
        activeTools: newActiveTools,
        toolHistory: [...state.toolHistory, completedTool]
      };
    });
  },

  _handleResult: (data: AgentResultEvent) => {
    set({ lastResult: data });
  },

  _handleError: (data: { message: string }) => {
    set({ error: data.message });
  },

  _handleStatusChanged: (status: AgentStatus) => {
    set({ status });
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
}
