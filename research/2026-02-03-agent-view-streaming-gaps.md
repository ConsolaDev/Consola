---
date: 2026-02-03T22:45:00+01:00
git_commit: 91af988c53ab671aa2d7ce3f4c84eed1cc7c20ff
branch: master
repository: consola
topic: "Agent View Not Rendering All Claude Outputs (Thinking, Streaming)"
tags: [research, codebase, agent-sdk, streaming, ui]
status: complete
---

# Research: Agent View Not Rendering All Claude Outputs

**Date**: 2026-02-03 22:45:00 +01:00
**Git Commit**: 91af988c53ab671aa2d7ce3f4c84eed1cc7c20ff
**Branch**: master
**Repository**: consola

## Research Question

Why is the agent view not rendering all outputs from Claude (like thinking content)? Currently only showing the final result of queries. How can this be improved?

## Summary

The current implementation has the infrastructure for streaming (`includePartialMessages: true` is set, `stream_event` messages are forwarded via IPC) but **the renderer does not process or display streaming content**. The store only handles complete `assistant` messages, ignoring `stream_event` messages entirely. Additionally, thinking blocks within assistant messages are filtered out by `extractTextContent()`.

## Detailed Findings

### 1. ClaudeAgentService (Main Process)

**File**: `src/main/ClaudeAgentService.ts`

**What it does:**
- Line 120: Sets `includePartialMessages: true` - this enables streaming events from SDK
- Lines 193-198: Handles `stream_event` messages and emits them as `'stream'` events
- Lines 185-191: Handles complete `assistant` messages

**Current message handling** (lines 169-214):
```typescript
case 'stream_event':
  this.emit('stream', {
    event: message.event,
    uuid: message.uuid
  });
  break;

case 'assistant':
  this.emit('assistant-message', {
    uuid: message.uuid,
    sessionId: message.session_id,
    content: message.message.content  // Contains text, thinking, tool_use blocks
  });
  break;
```

**Gap identified**: The service forwards stream events but doesn't extract the delta content (text chunks, thinking chunks) for easier consumption.

### 2. IPC Layer

**File**: `src/shared/constants.ts`

**Channels exist for streaming** (lines 27):
- `AGENT_STREAM: 'agent:stream'` - Channel exists and is forwarded

**File**: `src/main/ipc-handlers.ts`

**Stream events are forwarded** (would be around line 80-85 based on the pattern):
```typescript
agentService.on('stream', (data) => {
  mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM, data);
});
```

### 3. Preload Bridge

**File**: `src/preload/preload.ts`

**Stream callback storage exists** (line 27):
```typescript
stream: new Set<AgentCallback<unknown>>(),
```

**Stream IPC listener exists** (lines 45-47):
```typescript
ipcRenderer.on(IPC_CHANNELS.AGENT_STREAM, (_event, data: unknown) => {
    agentCallbacks.stream.forEach(cb => cb(data));
});
```

**Stream subscription exposed** (lines 161-163):
```typescript
onStream: (callback: AgentCallback<unknown>): void => {
    agentCallbacks.stream.add(callback);
},
```

### 4. Agent Store (Renderer)

**File**: `src/renderer/stores/agentStore.ts`

**Critical Gap #1 - No stream handler registered** (lines 234-244):
```typescript
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
  // NOTE: No agentBridge.onStream() call!
}
```

**Critical Gap #2 - extractTextContent filters out thinking** (lines 72-82):
```typescript
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((block: any) => block.type === 'text')  // Only text blocks!
      .map((block: any) => block.text)
      .join('\n');
  }
  return '';
}
```

This explicitly filters to only `type === 'text'` blocks, ignoring:
- `type === 'thinking'` blocks (extended thinking)
- `type === 'tool_use'` blocks (tool invocations)

**Critical Gap #3 - No state for streaming content**:
The store interface (lines 29-70) has no fields for:
- Streaming text accumulation
- Thinking content
- Partial message display

### 5. Agent Bridge

**File**: `src/renderer/services/agentBridge.ts`

**onStream method exists but is not used**:
```typescript
onStream: (callback: (data: unknown) => void): void => {
  getAPI()?.onStream(callback);
},
```

### 6. UI Components

**File**: `src/renderer/components/Agent/AgentPanel.tsx`

**Only displays complete messages** (lines 46-53):
```typescript
messages.map(msg => (
  <ChatMessage
    key={msg.id}
    type={msg.type}
    content={msg.content}
    timestamp={msg.timestamp}
  />
))
```

**No streaming indicator** - Only shows `isRunning` state but no live content.

**File**: `src/renderer/components/Agent/ChatMessage.tsx`

**Simple text display** - No support for:
- Thinking blocks (collapsible sections)
- Tool use blocks (visual indicators)
- Streaming text with cursor

## Architecture Documentation

### Current Data Flow

```
SDK query() iterator
    ↓
ClaudeAgentService.handleMessage()
    ↓ emits 'stream', 'assistant-message', etc.
IPC handlers forward to renderer
    ↓ sends via IPC channels
Preload callbacks invoke registered handlers
    ↓
agentStore handlers update state
    ↓
React components render from state
```

### Message Types from SDK

| SDK Message Type | Emitted Event | Store Handler | UI Display |
|-----------------|---------------|---------------|------------|
| `system` (init) | `init` | `_handleInit` | Session info stored |
| `stream_event` | `stream` | **NONE** | **NOT DISPLAYED** |
| `assistant` | `assistant-message` | `_handleAssistantMessage` | Only text blocks |
| `result` | `result` | `_handleResult` | Stored but not shown |

### SDK Stream Event Structure

When `includePartialMessages: true`, SDK emits:
```typescript
{
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    delta: {
      type: 'text_delta' | 'thinking_delta' | 'input_json_delta',
      text?: string,      // for text_delta
      thinking?: string,  // for thinking_delta
      partial_json?: string  // for input_json_delta
    }
  },
  uuid: string,
  session_id: string
}
```

### Assistant Message Content Structure

```typescript
message.message.content = [
  { type: 'thinking', thinking: '...reasoning...', signature: '...' },
  { type: 'text', text: '...visible response...' },
  { type: 'tool_use', id: '...', name: 'Read', input: {...} }
]
```

## Code References

- `src/main/ClaudeAgentService.ts:120` - `includePartialMessages: true` is set
- `src/main/ClaudeAgentService.ts:193-198` - Stream events emitted but not processed downstream
- `src/renderer/stores/agentStore.ts:72-82` - `extractTextContent()` filters out thinking blocks
- `src/renderer/stores/agentStore.ts:234-244` - Missing `onStream` handler registration
- `src/renderer/stores/agentStore.ts:29-70` - Store interface lacks streaming state
- `src/renderer/components/Agent/AgentPanel.tsx:46-53` - Only renders complete messages

## Open Questions

1. Should thinking blocks be shown by default or in a collapsible section?
2. How should tool_use blocks be visually represented inline with text?
3. Should streaming text replace the final message or be shown separately during generation?
4. What visual indicator should show Claude is "thinking" vs "writing"?
