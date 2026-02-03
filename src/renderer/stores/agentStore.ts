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

// Streaming state
export interface StreamingState {
  activeMessageId: string | null;
  textBuffer: string;
  thinkingBuffer: string;
  isThinking: boolean;
}

// Message type for chat display
export interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  contentBlocks?: ContentBlock[];
  isStreaming?: boolean;
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

  // Streaming
  streaming: StreamingState;

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

// Build content blocks from streaming state
function buildContentBlocks(streaming: StreamingState): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (streaming.thinkingBuffer) {
    blocks.push({ type: 'thinking', thinking: streaming.thinkingBuffer });
  }
  if (streaming.textBuffer) {
    blocks.push({ type: 'text', text: streaming.textBuffer });
  }
  return blocks;
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
  streaming: {
    activeMessageId: null,
    textBuffer: '',
    thinkingBuffer: '',
    isThinking: false
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

    set(state => {
      // Check if this is finalizing a streaming message
      const existingIdx = state.messages.findIndex(
        m => m.id === data.uuid && m.isStreaming
      );

      const message: Message = {
        id: data.uuid,
        type: 'assistant',
        content: plainText,
        contentBlocks,
        isStreaming: false,
        timestamp: Date.now()
      };

      if (existingIdx >= 0) {
        // Replace streaming message with final
        const messages = [...state.messages];
        messages[existingIdx] = message;
        return {
          messages,
          streaming: { activeMessageId: null, textBuffer: '', thinkingBuffer: '', isThinking: false }
        };
      } else {
        // Add new message
        return {
          messages: [...state.messages, message],
          streaming: { activeMessageId: null, textBuffer: '', thinkingBuffer: '', isThinking: false }
        };
      }
    });
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
    const { event, uuid } = data;

    // Handle content block start
    if (event.type === 'content_block_start') {
      if (event.content_block?.type === 'thinking') {
        set(state => ({
          streaming: { ...state.streaming, isThinking: true, activeMessageId: uuid }
        }));
      } else if (event.content_block?.type === 'text') {
        set(state => ({
          streaming: { ...state.streaming, isThinking: false, activeMessageId: uuid }
        }));
      }
    }

    // Handle content block delta
    if (event.type === 'content_block_delta') {
      const delta = event.delta;

      if (delta?.type === 'thinking_delta') {
        set(state => ({
          streaming: {
            ...state.streaming,
            thinkingBuffer: state.streaming.thinkingBuffer + (delta.thinking || ''),
            activeMessageId: uuid
          }
        }));
      }

      if (delta?.type === 'text_delta') {
        set(state => ({
          streaming: {
            ...state.streaming,
            textBuffer: state.streaming.textBuffer + (delta.text || ''),
            isThinking: false,
            activeMessageId: uuid
          }
        }));
      }
    }

    // Update or create streaming message
    set(state => {
      const { streaming } = state;

      // Only create/update if we have content
      if (!streaming.textBuffer && !streaming.thinkingBuffer) {
        return state;
      }

      const messages = [...state.messages];
      const streamingIdx = messages.findIndex(m => m.id === uuid && m.isStreaming);

      if (streamingIdx >= 0) {
        // Update existing streaming message
        messages[streamingIdx] = {
          ...messages[streamingIdx],
          content: streaming.textBuffer,
          contentBlocks: buildContentBlocks(streaming)
        };
      } else {
        // Create new streaming message
        messages.push({
          id: uuid,
          type: 'assistant',
          content: streaming.textBuffer,
          contentBlocks: buildContentBlocks(streaming),
          isStreaming: true,
          timestamp: Date.now()
        });
      }

      return { messages };
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
