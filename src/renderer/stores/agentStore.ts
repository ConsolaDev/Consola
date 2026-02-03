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

  // Processing
  processing: ProcessingState;

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
  _handleStream: (data: { event: any; uuid: string }) => void;
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
  processing: {
    isProcessing: false,
    currentMessageId: null
  },

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
    const contentBlocks = extractContentBlocks(data.content);
    const plainText = getPlainText(contentBlocks);

    const message: Message = {
      id: data.uuid,
      type: 'assistant',
      content: plainText,
      contentBlocks,
      timestamp: Date.now()
    };

    set(state => ({
      messages: [...state.messages, message],
      processing: { isProcessing: false, currentMessageId: null }
    }));
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
  },

  _handleStream: (data: { event: any; uuid: string }) => {
    // Just mark that we're processing - don't accumulate text
    set(state => {
      if (!state.processing.isProcessing) {
        return {
          processing: { isProcessing: true, currentMessageId: data.uuid }
        };
      }
      return state;
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
