# Implementation Plan: Claude Agent SDK Integration

**Created**: 2026-02-03
**Status**: Draft
**Priority**: High

## Overview

Integrate the `@anthropic-ai/claude-agent-sdk` into the Electron application to provide programmatic control over Claude agents, enabling a rich UI layer on top of Claude Code's capabilities including commands, skills, MCP connections, and tool management.

## Current State Analysis

### Existing Architecture
- **Electron v28.0.0** with React v19.2.4 renderer
- **Dual PTY model** in `TerminalService.ts` spawning `claude` CLI
- **IPC communication** via channels defined in `src/shared/constants.ts`
- **Zustand** for state management in renderer
- **XTerm.js** for terminal display

### Key Integration Points
- `src/main/TerminalService.ts:107-135` - Current Claude PTY spawning
- `src/main/ipc-handlers.ts:9-51` - IPC handler registration pattern
- `src/preload/preload.ts:1-67` - Context bridge API exposure
- `src/renderer/stores/terminalStore.ts:1-34` - Zustand store pattern

## Desired End State

A fully integrated Claude Agent SDK that:
1. Provides programmatic control over Claude agents from the main process
2. Streams structured events (messages, tool usage, status) to the renderer
3. Supports all SDK features: tools, hooks, MCP servers, subagents, sessions
4. Maintains the existing terminal mode for raw CLI access when needed
5. Enables building rich UI components for agent interaction

## What We're NOT Doing

- Implementing OAuth authentication (blocked by Anthropic for third-party apps)
- Replacing the terminal entirely (keeping it as an alternative mode)
- Building a full IDE (focusing on agent interaction primitives)
- Implementing all Claude Code commands as UI (starting with core features)

## Implementation Approach

Use a phased approach, building from core infrastructure outward:
1. Service layer in main process
2. IPC communication
3. Preload bridge
4. State management
5. UI components
6. Advanced features

---

## Phase 1: Core SDK Service Layer

### Overview
Create `ClaudeAgentService` in the main process that wraps the Claude Agent SDK, manages sessions, and emits typed events.

### Changes Required

#### 1. Install Dependencies
**File**: `package.json`
**Changes**: Add Claude Agent SDK dependency

```bash
npm install @anthropic-ai/claude-agent-sdk
```

#### 2. Create ClaudeAgentService
**File**: `src/main/ClaudeAgentService.ts` (new)
**Changes**: Create service class extending EventEmitter

```typescript
import { EventEmitter } from 'events';
import { query, Options, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

export interface AgentQueryOptions {
  prompt: string;
  allowedTools?: string[];
  maxTurns?: number;
  resume?: string;
  continue?: boolean;
}

export interface AgentStatus {
  isRunning: boolean;
  sessionId: string | null;
  model: string | null;
  permissionMode: string | null;
}

export class ClaudeAgentService extends EventEmitter {
  private currentQuery: AsyncGenerator<SDKMessage, void> | null = null;
  private abortController: AbortController | null = null;
  private status: AgentStatus = {
    isRunning: false,
    sessionId: null,
    model: null,
    permissionMode: null
  };

  constructor(private cwd: string) {
    super();
  }

  async startQuery(options: AgentQueryOptions): Promise<void> {
    if (this.status.isRunning) {
      throw new Error('Query already in progress');
    }

    this.abortController = new AbortController();
    this.status.isRunning = true;
    this.emit('status-changed', this.status);

    const sdkOptions: Options = {
      cwd: this.cwd,
      abortController: this.abortController,
      allowedTools: options.allowedTools,
      maxTurns: options.maxTurns,
      resume: options.resume,
      continue: options.continue,
      includePartialMessages: true,
      hooks: {
        PreToolUse: [{
          hooks: [async (input) => {
            this.emit('tool-pending', {
              toolName: input.tool_name,
              toolInput: input.tool_input
            });
            return {};
          }]
        }],
        PostToolUse: [{
          hooks: [async (input) => {
            this.emit('tool-complete', {
              toolName: input.tool_name,
              toolInput: input.tool_input,
              toolResponse: input.tool_response
            });
            return {};
          }]
        }],
        Notification: [{
          hooks: [async (input) => {
            this.emit('notification', {
              message: input.message,
              title: input.title
            });
            return {};
          }]
        }]
      }
    };

    try {
      this.currentQuery = query({ prompt: options.prompt, options: sdkOptions });

      for await (const message of this.currentQuery) {
        this.handleMessage(message);
      }
    } catch (error) {
      this.emit('error', error);
    } finally {
      this.status.isRunning = false;
      this.currentQuery = null;
      this.abortController = null;
      this.emit('status-changed', this.status);
    }
  }

  private handleMessage(message: SDKMessage): void {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          this.status.sessionId = message.session_id;
          this.status.model = message.model;
          this.status.permissionMode = message.permissionMode;
          this.emit('init', {
            sessionId: message.session_id,
            model: message.model,
            tools: message.tools,
            mcpServers: message.mcp_servers
          });
        }
        break;

      case 'assistant':
        this.emit('assistant-message', {
          uuid: message.uuid,
          sessionId: message.session_id,
          content: message.message.content
        });
        break;

      case 'stream_event':
        this.emit('stream', {
          event: message.event,
          uuid: message.uuid
        });
        break;

      case 'result':
        this.emit('result', {
          subtype: message.subtype,
          sessionId: message.session_id,
          result: 'result' in message ? message.result : null,
          isError: message.is_error,
          numTurns: message.num_turns,
          totalCostUsd: message.total_cost_usd,
          usage: message.usage
        });
        break;
    }

    this.emit('message', message);
  }

  async interrupt(): Promise<void> {
    this.abortController?.abort();
  }

  getStatus(): AgentStatus {
    return { ...this.status };
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  destroy(): void {
    this.interrupt();
    this.removeAllListeners();
  }
}
```

#### 3. Add Type Definitions
**File**: `src/shared/types.ts`
**Changes**: Add agent-related types

```typescript
// Add after existing types

export interface AgentInitEvent {
  sessionId: string;
  model: string;
  tools: string[];
  mcpServers: { name: string; status: string }[];
}

export interface AgentMessageEvent {
  uuid: string;
  sessionId: string;
  content: unknown;
}

export interface AgentToolEvent {
  toolName: string;
  toolInput: unknown;
  toolResponse?: unknown;
}

export interface AgentResultEvent {
  subtype: string;
  sessionId: string;
  result: string | null;
  isError: boolean;
  numTurns: number;
  totalCostUsd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface AgentStatus {
  isRunning: boolean;
  sessionId: string | null;
  model: string | null;
  permissionMode: string | null;
}
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] TypeScript compiles without errors
- [ ] No new lint errors

#### Manual Verification
- [ ] ClaudeAgentService can be instantiated
- [ ] Service emits typed events when query runs
- [ ] Abort/interrupt works correctly

---

## Phase 2: IPC Communication Layer

### Overview
Add IPC channels and handlers to bridge the ClaudeAgentService to the renderer process, enabling bidirectional communication.

### Changes Required

#### 1. Add IPC Channel Constants
**File**: `src/shared/constants.ts`
**Changes**: Add agent-related channels

```typescript
// Add after existing constants

// Claude Agent channels (Renderer → Main)
export const AGENT_START = 'agent:start';
export const AGENT_INTERRUPT = 'agent:interrupt';
export const AGENT_GET_STATUS = 'agent:get-status';

// Claude Agent channels (Main → Renderer)
export const AGENT_INIT = 'agent:init';
export const AGENT_MESSAGE = 'agent:message';
export const AGENT_ASSISTANT_MESSAGE = 'agent:assistant-message';
export const AGENT_STREAM = 'agent:stream';
export const AGENT_TOOL_PENDING = 'agent:tool-pending';
export const AGENT_TOOL_COMPLETE = 'agent:tool-complete';
export const AGENT_RESULT = 'agent:result';
export const AGENT_ERROR = 'agent:error';
export const AGENT_STATUS_CHANGED = 'agent:status-changed';
export const AGENT_NOTIFICATION = 'agent:notification';
```

#### 2. Update IPC Handlers
**File**: `src/main/ipc-handlers.ts`
**Changes**: Add agent service and handlers

```typescript
import { ClaudeAgentService } from './ClaudeAgentService';
import * as constants from '../shared/constants';

// Add to setupIpcHandlers function:

// Create agent service
const agentService = new ClaudeAgentService(process.cwd());

// Forward agent events to renderer
agentService.on('init', (data) => {
  mainWindow.webContents.send(constants.AGENT_INIT, data);
});

agentService.on('assistant-message', (data) => {
  mainWindow.webContents.send(constants.AGENT_ASSISTANT_MESSAGE, data);
});

agentService.on('stream', (data) => {
  mainWindow.webContents.send(constants.AGENT_STREAM, data);
});

agentService.on('tool-pending', (data) => {
  mainWindow.webContents.send(constants.AGENT_TOOL_PENDING, data);
});

agentService.on('tool-complete', (data) => {
  mainWindow.webContents.send(constants.AGENT_TOOL_COMPLETE, data);
});

agentService.on('result', (data) => {
  mainWindow.webContents.send(constants.AGENT_RESULT, data);
});

agentService.on('error', (error) => {
  mainWindow.webContents.send(constants.AGENT_ERROR, {
    message: error.message
  });
});

agentService.on('status-changed', (status) => {
  mainWindow.webContents.send(constants.AGENT_STATUS_CHANGED, status);
});

agentService.on('notification', (data) => {
  mainWindow.webContents.send(constants.AGENT_NOTIFICATION, data);
});

// Handle agent commands from renderer
ipcMain.on(constants.AGENT_START, async (_, options) => {
  try {
    await agentService.startQuery(options);
  } catch (error) {
    mainWindow.webContents.send(constants.AGENT_ERROR, {
      message: error.message
    });
  }
});

ipcMain.on(constants.AGENT_INTERRUPT, () => {
  agentService.interrupt();
});

ipcMain.handle(constants.AGENT_GET_STATUS, () => {
  return agentService.getStatus();
});

// Add cleanup
// In cleanupIpcHandlers:
agentService.destroy();
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] All IPC channels are properly typed

#### Manual Verification
- [ ] Events flow from main to renderer
- [ ] Commands flow from renderer to main
- [ ] Status queries return correct data

---

## Phase 3: Preload API Extension

### Overview
Expose the Claude Agent API to the renderer process via the context bridge, maintaining security isolation.

### Changes Required

#### 1. Extend Preload Script
**File**: `src/preload/preload.ts`
**Changes**: Add claudeAgentAPI exposure

```typescript
import * as constants from '../shared/constants';

// Add callback storage
const agentCallbacks = {
  init: new Set<Function>(),
  assistantMessage: new Set<Function>(),
  stream: new Set<Function>(),
  toolPending: new Set<Function>(),
  toolComplete: new Set<Function>(),
  result: new Set<Function>(),
  error: new Set<Function>(),
  statusChanged: new Set<Function>(),
  notification: new Set<Function>()
};

// Register IPC listeners
ipcRenderer.on(constants.AGENT_INIT, (_, data) => {
  agentCallbacks.init.forEach(cb => cb(data));
});

ipcRenderer.on(constants.AGENT_ASSISTANT_MESSAGE, (_, data) => {
  agentCallbacks.assistantMessage.forEach(cb => cb(data));
});

ipcRenderer.on(constants.AGENT_STREAM, (_, data) => {
  agentCallbacks.stream.forEach(cb => cb(data));
});

ipcRenderer.on(constants.AGENT_TOOL_PENDING, (_, data) => {
  agentCallbacks.toolPending.forEach(cb => cb(data));
});

ipcRenderer.on(constants.AGENT_TOOL_COMPLETE, (_, data) => {
  agentCallbacks.toolComplete.forEach(cb => cb(data));
});

ipcRenderer.on(constants.AGENT_RESULT, (_, data) => {
  agentCallbacks.result.forEach(cb => cb(data));
});

ipcRenderer.on(constants.AGENT_ERROR, (_, data) => {
  agentCallbacks.error.forEach(cb => cb(data));
});

ipcRenderer.on(constants.AGENT_STATUS_CHANGED, (_, data) => {
  agentCallbacks.statusChanged.forEach(cb => cb(data));
});

ipcRenderer.on(constants.AGENT_NOTIFICATION, (_, data) => {
  agentCallbacks.notification.forEach(cb => cb(data));
});

// Expose to renderer
contextBridge.exposeInMainWorld('claudeAgentAPI', {
  // Commands
  startQuery: (options: {
    prompt: string;
    allowedTools?: string[];
    maxTurns?: number;
    resume?: string;
    continue?: boolean;
  }) => {
    ipcRenderer.send(constants.AGENT_START, options);
  },

  interrupt: () => {
    ipcRenderer.send(constants.AGENT_INTERRUPT);
  },

  getStatus: (): Promise<{
    isRunning: boolean;
    sessionId: string | null;
    model: string | null;
    permissionMode: string | null;
  }> => {
    return ipcRenderer.invoke(constants.AGENT_GET_STATUS);
  },

  // Event subscriptions
  onInit: (callback: Function) => {
    agentCallbacks.init.add(callback);
  },

  onAssistantMessage: (callback: Function) => {
    agentCallbacks.assistantMessage.add(callback);
  },

  onStream: (callback: Function) => {
    agentCallbacks.stream.add(callback);
  },

  onToolPending: (callback: Function) => {
    agentCallbacks.toolPending.add(callback);
  },

  onToolComplete: (callback: Function) => {
    agentCallbacks.toolComplete.add(callback);
  },

  onResult: (callback: Function) => {
    agentCallbacks.result.add(callback);
  },

  onError: (callback: Function) => {
    agentCallbacks.error.add(callback);
  },

  onStatusChanged: (callback: Function) => {
    agentCallbacks.statusChanged.add(callback);
  },

  onNotification: (callback: Function) => {
    agentCallbacks.notification.add(callback);
  },

  // Cleanup
  removeListener: (event: string, callback: Function) => {
    const callbacks = agentCallbacks[event as keyof typeof agentCallbacks];
    if (callbacks) {
      callbacks.delete(callback);
    }
  }
});
```

#### 2. Add Type Declaration
**File**: `src/shared/types.ts`
**Changes**: Add ClaudeAgentAPI interface to Window

```typescript
// Add to existing Window interface extension
interface Window {
  terminalAPI: TerminalAPI;
  claudeAgentAPI: ClaudeAgentAPI;
}

export interface ClaudeAgentAPI {
  startQuery: (options: {
    prompt: string;
    allowedTools?: string[];
    maxTurns?: number;
    resume?: string;
    continue?: boolean;
  }) => void;
  interrupt: () => void;
  getStatus: () => Promise<AgentStatus>;
  onInit: (callback: (data: AgentInitEvent) => void) => void;
  onAssistantMessage: (callback: (data: AgentMessageEvent) => void) => void;
  onStream: (callback: (data: unknown) => void) => void;
  onToolPending: (callback: (data: AgentToolEvent) => void) => void;
  onToolComplete: (callback: (data: AgentToolEvent) => void) => void;
  onResult: (callback: (data: AgentResultEvent) => void) => void;
  onError: (callback: (data: { message: string }) => void) => void;
  onStatusChanged: (callback: (data: AgentStatus) => void) => void;
  onNotification: (callback: (data: { message: string; title?: string }) => void) => void;
  removeListener: (event: string, callback: Function) => void;
}
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] Preload compiles without type errors

#### Manual Verification
- [ ] `window.claudeAgentAPI` is available in renderer
- [ ] All methods are callable
- [ ] Events are received in renderer

---

## Phase 4: State Management

### Overview
Create Zustand stores for agent state, enabling reactive UI updates.

### Changes Required

#### 1. Create Agent Bridge Service
**File**: `src/renderer/services/agentBridge.ts` (new)
**Changes**: Create bridge to window.claudeAgentAPI

```typescript
import type {
  AgentStatus,
  AgentInitEvent,
  AgentMessageEvent,
  AgentToolEvent,
  AgentResultEvent
} from '../../shared/types';

const getAPI = () => {
  if (typeof window !== 'undefined' && window.claudeAgentAPI) {
    return window.claudeAgentAPI;
  }
  return null;
};

export const agentBridge = {
  isAvailable: () => getAPI() !== null,

  startQuery: (options: {
    prompt: string;
    allowedTools?: string[];
    maxTurns?: number;
    resume?: string;
    continue?: boolean;
  }) => {
    getAPI()?.startQuery(options);
  },

  interrupt: () => {
    getAPI()?.interrupt();
  },

  getStatus: async (): Promise<AgentStatus | null> => {
    return getAPI()?.getStatus() ?? null;
  },

  onInit: (callback: (data: AgentInitEvent) => void) => {
    getAPI()?.onInit(callback);
  },

  onAssistantMessage: (callback: (data: AgentMessageEvent) => void) => {
    getAPI()?.onAssistantMessage(callback);
  },

  onToolPending: (callback: (data: AgentToolEvent) => void) => {
    getAPI()?.onToolPending(callback);
  },

  onToolComplete: (callback: (data: AgentToolEvent) => void) => {
    getAPI()?.onToolComplete(callback);
  },

  onResult: (callback: (data: AgentResultEvent) => void) => {
    getAPI()?.onResult(callback);
  },

  onError: (callback: (data: { message: string }) => void) => {
    getAPI()?.onError(callback);
  },

  onStatusChanged: (callback: (data: AgentStatus) => void) => {
    getAPI()?.onStatusChanged(callback);
  },

  onNotification: (callback: (data: { message: string; title?: string }) => void) => {
    getAPI()?.onNotification(callback);
  },

  removeListener: (event: string, callback: Function) => {
    getAPI()?.removeListener(event, callback);
  }
};
```

#### 2. Create Agent Store
**File**: `src/renderer/stores/agentStore.ts` (new)
**Changes**: Create Zustand store for agent state

```typescript
import { create } from 'zustand';
import type {
  AgentStatus,
  AgentInitEvent,
  AgentMessageEvent,
  AgentToolEvent,
  AgentResultEvent
} from '../../shared/types';
import { agentBridge } from '../services/agentBridge';

interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface ToolExecution {
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

  // Actions
  sendMessage: (prompt, options = {}) => {
    // Add user message to store
    const userMessage: Message = {
      id: crypto.randomUUID(),
      type: 'user',
      content: prompt,
      timestamp: Date.now()
    };

    set(state => ({
      messages: [...state.messages, userMessage],
      error: null
    }));

    // Start query
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
      lastResult: null
    });
  },

  clearError: () => {
    set({ error: null });
  }
}));

// Initialize event listeners
if (typeof window !== 'undefined') {
  agentBridge.onInit((data: AgentInitEvent) => {
    useAgentStore.setState({
      sessionId: data.sessionId,
      model: data.model,
      availableTools: data.tools,
      mcpServers: data.mcpServers
    });
  });

  agentBridge.onAssistantMessage((data: AgentMessageEvent) => {
    const content = extractTextContent(data.content);
    if (content) {
      const message: Message = {
        id: data.uuid,
        type: 'assistant',
        content,
        timestamp: Date.now()
      };
      useAgentStore.setState(state => ({
        messages: [...state.messages, message]
      }));
    }
  });

  agentBridge.onToolPending((data: AgentToolEvent) => {
    const tool: ToolExecution = {
      id: crypto.randomUUID(),
      toolName: data.toolName,
      toolInput: data.toolInput,
      status: 'pending',
      timestamp: Date.now()
    };
    useAgentStore.setState(state => ({
      activeTools: [...state.activeTools, tool]
    }));
  });

  agentBridge.onToolComplete((data: AgentToolEvent) => {
    useAgentStore.setState(state => {
      const activeTools = state.activeTools.filter(
        t => t.toolName !== data.toolName
      );
      const completedTool = state.activeTools.find(
        t => t.toolName === data.toolName
      );

      if (completedTool) {
        const updatedTool = {
          ...completedTool,
          toolResponse: data.toolResponse,
          status: 'complete' as const
        };
        return {
          activeTools,
          toolHistory: [...state.toolHistory, updatedTool]
        };
      }
      return { activeTools };
    });
  });

  agentBridge.onResult((data: AgentResultEvent) => {
    useAgentStore.setState({ lastResult: data });
  });

  agentBridge.onError((data) => {
    useAgentStore.setState({ error: data.message });
  });

  agentBridge.onStatusChanged((status: AgentStatus) => {
    useAgentStore.setState({ status });
  });
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
```

#### 3. Create useAgent Hook
**File**: `src/renderer/hooks/useAgent.ts` (new)
**Changes**: Create hook for agent interactions

```typescript
import { useCallback, useEffect } from 'react';
import { useAgentStore } from '../stores/agentStore';
import { agentBridge } from '../services/agentBridge';

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

  const sendMessage = useCallback((prompt: string, options?: {
    allowedTools?: string[];
    maxTurns?: number;
  }) => {
    store.sendMessage(prompt, options);
  }, [store.sendMessage]);

  const interrupt = useCallback(() => {
    store.interrupt();
  }, [store.interrupt]);

  return {
    // State
    isAvailable: store.isAvailable,
    isRunning: store.status.isRunning,
    sessionId: store.sessionId,
    model: store.model,
    availableTools: store.availableTools,
    mcpServers: store.mcpServers,
    messages: store.messages,
    activeTools: store.activeTools,
    toolHistory: store.toolHistory,
    lastResult: store.lastResult,
    error: store.error,

    // Actions
    sendMessage,
    interrupt,
    clearMessages: store.clearMessages,
    clearError: store.clearError
  };
}
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] Store compiles without type errors

#### Manual Verification
- [ ] Store updates reactively when events arrive
- [ ] Messages are added correctly
- [ ] Tool state tracks pending/complete correctly

---

## Phase 5: UI Components

### Overview
Build React components for agent interaction: chat interface, tool status panel, and input controls.

### Changes Required

#### 1. Create Chat Message Component
**File**: `src/renderer/components/Agent/ChatMessage.tsx` (new)

```typescript
import React from 'react';
import { Box, Text } from '@radix-ui/themes';

interface ChatMessageProps {
  type: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export function ChatMessage({ type, content, timestamp }: ChatMessageProps) {
  const isUser = type === 'user';

  return (
    <Box
      p="3"
      style={{
        backgroundColor: isUser ? 'var(--accent-3)' : 'var(--gray-2)',
        borderRadius: '8px',
        marginLeft: isUser ? '20%' : '0',
        marginRight: isUser ? '0' : '20%',
        marginBottom: '8px'
      }}
    >
      <Text size="1" color="gray" mb="1">
        {isUser ? 'You' : 'Claude'} · {new Date(timestamp).toLocaleTimeString()}
      </Text>
      <Text as="div" style={{ whiteSpace: 'pre-wrap' }}>
        {content}
      </Text>
    </Box>
  );
}
```

#### 2. Create Tool Status Component
**File**: `src/renderer/components/Agent/ToolStatus.tsx` (new)

```typescript
import React from 'react';
import { Box, Text, Flex, Badge } from '@radix-ui/themes';

interface ToolExecution {
  id: string;
  toolName: string;
  toolInput: unknown;
  status: 'pending' | 'complete' | 'error';
}

interface ToolStatusProps {
  activeTools: ToolExecution[];
}

export function ToolStatus({ activeTools }: ToolStatusProps) {
  if (activeTools.length === 0) return null;

  return (
    <Box p="2" style={{ borderTop: '1px solid var(--gray-5)' }}>
      <Text size="1" color="gray" mb="2">Active Tools</Text>
      <Flex direction="column" gap="1">
        {activeTools.map(tool => (
          <Flex key={tool.id} align="center" gap="2">
            <Badge color={tool.status === 'pending' ? 'yellow' : 'green'}>
              {tool.status}
            </Badge>
            <Text size="2">{tool.toolName}</Text>
          </Flex>
        ))}
      </Flex>
    </Box>
  );
}
```

#### 3. Create Chat Input Component
**File**: `src/renderer/components/Agent/ChatInput.tsx` (new)

```typescript
import React, { useState, useCallback, KeyboardEvent } from 'react';
import { Box, Flex, TextArea, Button } from '@radix-ui/themes';

interface ChatInputProps {
  onSend: (message: string) => void;
  onInterrupt: () => void;
  isRunning: boolean;
  disabled: boolean;
}

export function ChatInput({ onSend, onInterrupt, isRunning, disabled }: ChatInputProps) {
  const [input, setInput] = useState('');

  const handleSend = useCallback(() => {
    if (input.trim() && !isRunning) {
      onSend(input.trim());
      setInput('');
    }
  }, [input, isRunning, onSend]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  return (
    <Box p="3" style={{ borderTop: '1px solid var(--gray-5)' }}>
      <Flex gap="2">
        <TextArea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask Claude..."
          disabled={disabled || isRunning}
          style={{ flex: 1 }}
        />
        {isRunning ? (
          <Button color="red" onClick={onInterrupt}>
            Stop
          </Button>
        ) : (
          <Button onClick={handleSend} disabled={!input.trim() || disabled}>
            Send
          </Button>
        )}
      </Flex>
    </Box>
  );
}
```

#### 4. Create Agent Panel Component
**File**: `src/renderer/components/Agent/AgentPanel.tsx` (new)

```typescript
import React, { useRef, useEffect } from 'react';
import { Box, Flex, ScrollArea, Text } from '@radix-ui/themes';
import { useAgent } from '../../hooks/useAgent';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { ToolStatus } from './ToolStatus';

export function AgentPanel() {
  const {
    isAvailable,
    isRunning,
    messages,
    activeTools,
    error,
    sendMessage,
    interrupt,
    clearError
  } = useAgent();

  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  if (!isAvailable) {
    return (
      <Flex align="center" justify="center" p="4">
        <Text color="gray">Claude Agent API not available</Text>
      </Flex>
    );
  }

  return (
    <Flex direction="column" style={{ height: '100%' }}>
      {/* Messages */}
      <ScrollArea ref={scrollRef} style={{ flex: 1 }}>
        <Box p="3">
          {messages.length === 0 ? (
            <Text color="gray" align="center">
              Start a conversation with Claude
            </Text>
          ) : (
            messages.map(msg => (
              <ChatMessage
                key={msg.id}
                type={msg.type}
                content={msg.content}
                timestamp={msg.timestamp}
              />
            ))
          )}
        </Box>
      </ScrollArea>

      {/* Error display */}
      {error && (
        <Box p="2" style={{ backgroundColor: 'var(--red-3)' }}>
          <Flex justify="between" align="center">
            <Text color="red" size="2">{error}</Text>
            <Button size="1" variant="ghost" onClick={clearError}>
              Dismiss
            </Button>
          </Flex>
        </Box>
      )}

      {/* Tool status */}
      <ToolStatus activeTools={activeTools} />

      {/* Input */}
      <ChatInput
        onSend={sendMessage}
        onInterrupt={interrupt}
        isRunning={isRunning}
        disabled={false}
      />
    </Flex>
  );
}
```

#### 5. Create Index Export
**File**: `src/renderer/components/Agent/index.tsx` (new)

```typescript
export { AgentPanel } from './AgentPanel';
export { ChatMessage } from './ChatMessage';
export { ChatInput } from './ChatInput';
export { ToolStatus } from './ToolStatus';
```

#### 6. Add Third Mode to App
**File**: `src/renderer/App.tsx`
**Changes**: Add AGENT mode alongside SHELL and CLAUDE

```typescript
// Update to include AgentPanel as a view option
import { AgentPanel } from './components/Agent';

// In the component, add conditional rendering based on mode
// When mode is 'AGENT', show AgentPanel instead of Terminal
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] All components compile without errors

#### Manual Verification
- [ ] Chat messages display correctly
- [ ] Tool status shows pending/complete tools
- [ ] Input sends messages and clears
- [ ] Interrupt button stops running queries
- [ ] Auto-scroll works on new messages

---

## Phase 6: Advanced Features (Future)

### Overview
Optional enhancements for full Claude Code feature parity.

### Potential Features

1. **MCP Server Manager UI**
   - List connected MCP servers
   - Add/remove servers
   - View server tools

2. **Custom UI Tools**
   - Create MCP tools that trigger UI actions
   - File picker tool
   - Confirmation dialog tool
   - Progress indicator tool

3. **Session Browser**
   - List past sessions
   - Resume sessions
   - Export conversations

4. **Skill Browser**
   - List available skills
   - Invoke skills from UI
   - Create custom skills

5. **Settings Panel**
   - Configure allowed tools
   - Set spending limits
   - Choose models

---

## Testing Strategy

### Unit Tests
- ClaudeAgentService event emission
- Store state transitions
- Bridge method calls

### Integration Tests
- IPC message flow
- Event propagation through layers

### E2E Tests
- Full query cycle from UI
- Tool execution display
- Error handling

### Manual Testing Steps
1. Start app, verify Agent mode available
2. Send message, verify it appears in chat
3. Verify tool usage shows in status
4. Verify response appears after completion
5. Test interrupt during long query
6. Verify error messages display correctly

---

## References

### Internal Files
- `src/main/TerminalService.ts` - Pattern for main process services
- `src/main/ipc-handlers.ts` - IPC handler registration
- `src/preload/preload.ts` - Context bridge pattern
- `src/renderer/stores/terminalStore.ts` - Zustand store pattern
- `src/renderer/services/terminalBridge.ts` - Bridge service pattern

### External Documentation
- [Claude Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Claude Agent SDK GitHub](https://github.com/anthropics/claude-agent-sdk-typescript)
- [NPM: @anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [Claude Code Documentation](https://code.claude.com/docs)

---

## Implementation Order

1. **Phase 1** - Core SDK Service (foundation)
2. **Phase 2** - IPC Communication (enables testing)
3. **Phase 3** - Preload API (enables renderer access)
4. **Phase 4** - State Management (enables reactive UI)
5. **Phase 5** - UI Components (user-facing features)
6. **Phase 6** - Advanced Features (enhancement)

Each phase builds on the previous, allowing incremental testing and validation.
