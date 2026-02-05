import { create } from 'zustand';
import type {
  AgentStatus,
  AgentInitEvent,
  AgentMessageEvent,
  AgentToolEvent,
  AgentResultEvent,
  AgentInputRequest,
  SessionEndEvent,
  SessionStartEvent
} from '../../shared/types';
import { agentBridge } from '../services/agentBridge';
import { sessionStorageBridge } from '../services/sessionStorageBridge';

// File content attached to text blocks
export interface FileAttachment {
  filePath: string;
  content: string;
  numLines: number;
  startLine: number;
  totalLines: number;
}

// Content block types from SDK
export interface TextBlock {
  type: 'text';
  text: string;
  file?: FileAttachment;
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
export interface UserMessage {
  id: string;
  type: 'user';
  content: string;
  timestamp: number;
}

export interface AssistantMessage {
  id: string;
  type: 'assistant';
  content: string;
  contentBlocks?: ContentBlock[];
  timestamp: number;
}

export interface SystemMessage {
  id: string;
  type: 'system';
  subtype: 'session-cleared' | 'session-compacted';
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | SystemMessage;

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

// Question types for AskUserQuestion
export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

// Pending input request from agent
export interface PendingInputRequest {
  requestId: string;
  type: 'permission' | 'question';
  toolName?: string;
  toolInput?: Record<string, unknown>;
  description?: string;
  questions?: Question[];  // For 'question' type
  timestamp: number;
  status: 'pending' | 'approved' | 'rejected';
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
  skills: string[];
  slashCommands: string[];
  plugins: { name: string; path: string }[];

  // Messages
  messages: Message[];

  // Tool history (for inline display in messages)
  toolHistory: ToolExecution[];

  // Pending input requests (awaiting user response)
  pendingInputs: PendingInputRequest[];

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
    additionalDirectories?: string[];
  }) => void;
  interrupt: (instanceId: string) => void;
  clearMessages: (instanceId: string) => void;
  clearError: (instanceId: string) => void;
  respondToInput: (instanceId: string, requestId: string, action: 'approve' | 'reject' | 'modify', options?: {
    modifiedInput?: Record<string, unknown>;
    feedback?: string;
    answers?: Record<string, string>;  // For question responses
  }) => void;

  // Session persistence
  saveInstanceHistory: (instanceId: string) => Promise<void>;
  loadInstanceHistory: (instanceId: string) => Promise<void>;

  // Session initialization (pre-load skills/commands)
  initializeSession: (instanceId: string, cwd: string) => Promise<void>;

  // Internal actions for event handling
  _handleInit: (data: AgentInitEvent) => void;
  _handleAssistantMessage: (data: AgentMessageEvent) => void;
  _handleToolPending: (data: AgentToolEvent) => void;
  _handleToolComplete: (data: AgentToolEvent) => void;
  _handleResult: (data: AgentResultEvent) => void;
  _handleError: (data: { instanceId: string; message: string }) => void;
  _handleStatusChanged: (data: AgentStatus & { instanceId: string }) => void;
  _handleStream: (data: { instanceId: string; event: any; uuid: string }) => void;
  _handleInputRequest: (data: AgentInputRequest) => void;
  _handleSessionEnd: (data: SessionEndEvent) => void;
  _handleSessionStart: (data: SessionStartEvent) => void;
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
        const textBlock: TextBlock = { type: 'text', text: block.text };
        // Extract file attachment if present
        if (block.file && typeof block.file === 'object') {
          textBlock.file = {
            filePath: block.file.filePath || '',
            content: block.file.content || '',
            numLines: block.file.numLines || 0,
            startLine: block.file.startLine || 1,
            totalLines: block.file.totalLines || 0,
          };
        }
        return textBlock;
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
    const { additionalDirectories, ...restOptions } = options;
    agentBridge.startQuery({
      instanceId,
      cwd,
      additionalDirectories,
      prompt,
      ...restOptions,
      continue: instance?.sessionId !== null
    });
  },

  interrupt: (instanceId) => {
    agentBridge.interrupt(instanceId);
  },

  clearMessages: (instanceId) => {
    set(state => updateInstance(state, instanceId, () => ({
      messages: [],
      toolHistory: [],
      pendingInputs: [],
      lastResult: null,
      sessionId: null
    })));

    // Persist the cleared state
    get().saveInstanceHistory(instanceId);
  },

  clearError: (instanceId) => {
    set(state => updateInstance(state, instanceId, () => ({
      error: null
    })));
  },

  saveInstanceHistory: async (instanceId) => {
    const instance = get().instances[instanceId];
    if (instance) {
      await sessionStorageBridge.saveHistory(instanceId, {
        messages: instance.messages,
        toolHistory: instance.toolHistory,
      });
    }
  },

  loadInstanceHistory: async (instanceId) => {
    const data = await sessionStorageBridge.loadHistory(instanceId);
    if (data) {
      set((state) => updateInstance(state, instanceId, () => ({
        messages: data.messages as Message[],
        toolHistory: data.toolHistory as ToolExecution[],
      })));
    }
  },

  initializeSession: async (instanceId, cwd) => {
    console.log('[agentStore] initializeSession called:', instanceId, cwd);
    // Ensure instance exists
    get().getOrCreateInstance(instanceId);

    try {
      console.log('[agentStore] Calling agentBridge.initialize');
      const result = await agentBridge.initialize(instanceId, cwd);
      console.log('[agentStore] Got result:', result);
      if (result) {
        set(state => updateInstance(state, instanceId, () => ({
          skills: result.skills,
          slashCommands: result.slashCommands,
          plugins: result.plugins
        })));
        console.log('[agentStore] Updated state with skills:', result.skills);
      }
    } catch (error) {
      console.warn('[agentStore] Failed to initialize session:', error);
    }
  },

  respondToInput: (instanceId, requestId, action, options = {}) => {
    // Send response to main process
    agentBridge.respondToInput({
      instanceId,
      requestId,
      action,
      modifiedInput: options.modifiedInput,
      feedback: options.feedback,
      answers: options.answers
    });

    // Update local state to mark as resolved
    set(state => {
      const instance = state.instances[instanceId];
      if (!instance) return state;

      const newPendingInputs = instance.pendingInputs.map(input =>
        input.requestId === requestId
          ? { ...input, status: action === 'approve' || action === 'modify' ? 'approved' as const : 'rejected' as const }
          : input
      );

      return updateInstance(state, instanceId, () => ({
        pendingInputs: newPendingInputs
      }));
    });
  },

  // === Internal Event Handlers ===

  _handleInit: (data: AgentInitEvent) => {
    const { instanceId, ...initData } = data;
    set(state => updateInstance(state, instanceId, () => ({
      sessionId: initData.sessionId,
      model: initData.model,
      availableTools: initData.tools,
      mcpServers: initData.mcpServers,
      skills: initData.skills || [],
      slashCommands: initData.slashCommands || [],
      plugins: initData.plugins || []
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
      toolHistory: [...instance.toolHistory, tool]
    })));
  },

  _handleToolComplete: (data: AgentToolEvent) => {
    const { instanceId, ...toolData } = data;
    set(state => {
      const instance = state.instances[instanceId];
      if (!instance) return state;

      // Find the pending tool in history - prefer matching by toolUseId, fall back to name
      let pendingIndex = -1;
      if (toolData.toolUseId) {
        pendingIndex = instance.toolHistory.findIndex(
          t => t.toolUseId === toolData.toolUseId && t.status === 'pending'
        );
      }
      // Fallback to name-based matching if no toolUseId or not found
      if (pendingIndex === -1) {
        pendingIndex = instance.toolHistory.findIndex(
          t => t.toolName === toolData.toolName && t.status === 'pending'
        );
      }

      if (pendingIndex === -1) {
        return state;
      }

      // Update the tool in place
      const newToolHistory = [...instance.toolHistory];
      newToolHistory[pendingIndex] = {
        ...newToolHistory[pendingIndex],
        toolUseId: toolData.toolUseId || newToolHistory[pendingIndex].toolUseId,
        toolResponse: toolData.toolResponse,
        status: 'complete'
      };

      return updateInstance(state, instanceId, () => ({
        toolHistory: newToolHistory
      }));
    });
  },

  _handleResult: (data: AgentResultEvent) => {
    const { instanceId, ...resultData } = data;
    set(state => updateInstance(state, instanceId, () => ({
      lastResult: { instanceId, ...resultData },
      processing: { isProcessing: false, currentMessageId: null }
    })));

    // Persist session history after each completed turn
    get().saveInstanceHistory(instanceId);
  },

  _handleError: (data: { instanceId: string; message: string }) => {
    const { instanceId, message } = data;
    set(state => updateInstance(state, instanceId, () => ({
      error: message,
      processing: { isProcessing: false, currentMessageId: null }
    })));

    // Persist session history even on error to preserve conversation
    get().saveInstanceHistory(instanceId);
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
  },

  _handleInputRequest: (data: AgentInputRequest) => {
    const { instanceId, ...requestData } = data;
    const pendingInput: PendingInputRequest = {
      requestId: requestData.requestId,
      type: requestData.type,
      toolName: requestData.toolName,
      toolInput: requestData.toolInput,
      description: requestData.description,
      questions: requestData.questions?.map(q => ({
        question: q.question,
        header: q.header,
        options: q.options || [],
        multiSelect: q.multiSelect
      })),
      timestamp: Date.now(),
      status: 'pending'
    };

    set(state => updateInstance(state, instanceId, (instance) => ({
      pendingInputs: [...instance.pendingInputs, pendingInput]
    })));
  },

  _handleSessionEnd: (data: SessionEndEvent) => {
    const { instanceId, reason } = data;

    if (reason === 'clear') {
      // Insert a visual divider - DON'T clear messages
      const systemMessage: SystemMessage = {
        id: generateId(),
        type: 'system',
        subtype: 'session-cleared',
        timestamp: Date.now()
      };

      set(state => updateInstance(state, instanceId, (instance) => ({
        messages: [...instance.messages, systemMessage]
      })));
    }
  },

  _handleSessionStart: (data: SessionStartEvent) => {
    const { instanceId, sessionId, source } = data;

    // Update session ID for the new session
    set(state => updateInstance(state, instanceId, () => ({
      sessionId
    })));

    // Add compact divider if this is from /compact
    if (source === 'compact') {
      const systemMessage: SystemMessage = {
        id: generateId(),
        type: 'system',
        subtype: 'session-compacted',
        timestamp: Date.now()
      };

      set(state => updateInstance(state, instanceId, (instance) => ({
        messages: [...instance.messages, systemMessage]
      })));
    }
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
  agentBridge.onInputRequest(store._handleInputRequest);
  agentBridge.onSessionEnd(store._handleSessionEnd);
  agentBridge.onSessionStart(store._handleSessionStart);
}
