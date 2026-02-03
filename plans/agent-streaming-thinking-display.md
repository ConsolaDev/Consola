# Implementation Plan: Agent View Streaming & Thinking Display

**Date**: 2026-02-03
**Based on**: research/2026-02-03-agent-view-streaming-gaps.md
**Status**: Ready for implementation

## Overview

Implement real-time streaming text display, thinking block visualization, and improved tool status in the Agent view. Currently, the agent only shows final results after Claude finishes responding. This plan adds live streaming as Claude types, collapsible thinking sections, and better visual feedback.

## Current State Analysis

### What Exists
- `ClaudeAgentService.ts:120` - Sets `includePartialMessages: true` (streaming enabled)
- `ClaudeAgentService.ts:193-198` - Emits `stream` events with delta content
- `preload.ts` - Has `onStream` callback registration ready
- `agentBridge.ts` - Has `onStream` method exposed

### Critical Gaps
1. **Store doesn't handle streams** - `agentStore.ts:234-244` - No `onStream` handler registered
2. **Thinking filtered out** - `agentStore.ts:72-82` - `extractTextContent()` only keeps `type === 'text'`
3. **No streaming state** - Store has no fields for partial message accumulation
4. **Simple UI** - `ChatMessage.tsx` only renders plain text, no support for thinking/streaming

## Desired End State

When Claude responds:
1. Text appears character-by-character as it streams (typewriter effect)
2. Thinking blocks appear in collapsible sections with "Thinking..." label
3. A pulsing cursor indicates active streaming
4. Different visual states for "thinking" vs "writing"
5. Tool use blocks show inline with expandable input/output

## What We're NOT Doing

- Syntax highlighting for code blocks (future enhancement)
- Markdown rendering (keep it simple for now)
- Persistence of thinking blocks across sessions
- Custom animations or complex transitions

---

## Phase 1: Extend Store State for Streaming

### Overview
Add streaming-related state to the agent store and register the stream event handler.

### Changes Required

#### 1. Update Store Types and State
**File**: `src/renderer/stores/agentStore.ts`

Add new interfaces:
```typescript
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

// Enhanced message with content blocks
export interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;           // Plain text (for user messages and backwards compat)
  contentBlocks?: ContentBlock[];  // Structured blocks (for assistant)
  isStreaming?: boolean;     // Currently being streamed
  timestamp: number;
}

// Streaming state
interface StreamingState {
  activeMessageId: string | null;  // UUID of message being streamed
  textBuffer: string;              // Accumulated text delta
  thinkingBuffer: string;          // Accumulated thinking delta
  isThinking: boolean;             // Currently in thinking phase
}
```

Add to AgentState:
```typescript
interface AgentState {
  // ... existing fields

  // Streaming
  streaming: StreamingState;

  // New handlers
  _handleStream: (data: StreamEvent) => void;
}
```

#### 2. Implement Stream Handler
**File**: `src/renderer/stores/agentStore.ts`

Add stream event processing:
```typescript
_handleStream: (data: { event: any; uuid: string }) => {
  const { event, uuid } = data;

  if (event.type === 'content_block_start') {
    // New block starting
    if (event.content_block?.type === 'thinking') {
      set(state => ({
        streaming: { ...state.streaming, isThinking: true }
      }));
    }
  }

  if (event.type === 'content_block_delta') {
    const delta = event.delta;

    if (delta.type === 'thinking_delta') {
      set(state => ({
        streaming: {
          ...state.streaming,
          thinkingBuffer: state.streaming.thinkingBuffer + (delta.thinking || '')
        }
      }));
    }

    if (delta.type === 'text_delta') {
      set(state => ({
        streaming: {
          ...state.streaming,
          textBuffer: state.streaming.textBuffer + (delta.text || ''),
          isThinking: false
        }
      }));
    }
  }

  // Update streaming message in real-time
  set(state => {
    const messages = [...state.messages];
    const streamingIdx = messages.findIndex(m => m.id === uuid && m.isStreaming);

    if (streamingIdx >= 0) {
      messages[streamingIdx] = {
        ...messages[streamingIdx],
        content: state.streaming.textBuffer,
        contentBlocks: buildContentBlocks(state.streaming)
      };
    } else if (state.streaming.textBuffer || state.streaming.thinkingBuffer) {
      // Create new streaming message
      messages.push({
        id: uuid,
        type: 'assistant',
        content: state.streaming.textBuffer,
        contentBlocks: buildContentBlocks(state.streaming),
        isStreaming: true,
        timestamp: Date.now()
      });
    }

    return { messages };
  });
}
```

#### 3. Register Stream Handler
**File**: `src/renderer/stores/agentStore.ts`

Add to initialization block:
```typescript
if (typeof window !== 'undefined') {
  const store = useAgentStore.getState();
  // ... existing handlers
  agentBridge.onStream(store._handleStream);  // Add this line
}
```

#### 4. Update Assistant Message Handler
**File**: `src/renderer/stores/agentStore.ts`

Modify `_handleAssistantMessage` to:
- Finalize streaming message (set `isStreaming: false`)
- Include all content blocks (text, thinking, tool_use)
- Reset streaming state

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] TypeScript compiles without errors

#### Manual Verification
- [ ] Console shows stream events being received
- [ ] Store state updates with streaming content

---

## Phase 2: Update Content Extraction

### Overview
Modify `extractTextContent` to preserve thinking blocks and add helper functions for content block processing.

### Changes Required

#### 1. Replace extractTextContent
**File**: `src/renderer/stores/agentStore.ts`

```typescript
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
```

#### 2. Update _handleAssistantMessage
```typescript
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
        messages: [...state.messages, message]
      };
    }
  });
}
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] TypeScript compiles without errors

#### Manual Verification
- [ ] Messages with thinking blocks preserve the thinking content
- [ ] Tool use blocks are captured in contentBlocks

---

## Phase 3: Enhance ChatMessage Component

### Overview
Update ChatMessage to render content blocks with collapsible thinking sections and streaming indicators.

### Changes Required

#### 1. Add ThinkingBlock Component
**File**: `src/renderer/components/Agent/ThinkingBlock.tsx` (new file)

```typescript
import { useState } from 'react';
import { Box, Text, Flex } from '@radix-ui/themes';
import { ChevronDownIcon, ChevronRightIcon } from '@radix-ui/react-icons';

interface ThinkingBlockProps {
  content: string;
  defaultExpanded?: boolean;
}

export function ThinkingBlock({ content, defaultExpanded = false }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <Box className="thinking-block">
      <Flex
        align="center"
        gap="1"
        className="thinking-header"
        onClick={() => setExpanded(!expanded)}
        style={{ cursor: 'pointer' }}
      >
        {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        <Text size="1" color="gray">Thinking</Text>
      </Flex>
      {expanded && (
        <Box className="thinking-content">
          <Text size="2" color="gray">{content}</Text>
        </Box>
      )}
    </Box>
  );
}
```

#### 2. Add StreamingIndicator Component
**File**: `src/renderer/components/Agent/StreamingIndicator.tsx` (new file)

```typescript
import { Box } from '@radix-ui/themes';

interface StreamingIndicatorProps {
  isThinking: boolean;
}

export function StreamingIndicator({ isThinking }: StreamingIndicatorProps) {
  return (
    <Box className={`streaming-indicator ${isThinking ? 'thinking' : 'writing'}`}>
      <span className="cursor" />
    </Box>
  );
}
```

#### 3. Update ChatMessage Component
**File**: `src/renderer/components/Agent/ChatMessage.tsx`

```typescript
import { Box, Text } from '@radix-ui/themes';
import { ThinkingBlock } from './ThinkingBlock';
import { StreamingIndicator } from './StreamingIndicator';
import type { ContentBlock } from '../../stores/agentStore';

interface ChatMessageProps {
  type: 'user' | 'assistant';
  content: string;
  contentBlocks?: ContentBlock[];
  isStreaming?: boolean;
  isThinking?: boolean;
  timestamp: number;
}

export function ChatMessage({
  type,
  content,
  contentBlocks,
  isStreaming,
  isThinking,
  timestamp
}: ChatMessageProps) {
  const isUser = type === 'user';

  // Render content blocks for assistant messages
  const renderContent = () => {
    if (isUser || !contentBlocks?.length) {
      return <Text as="div" className="message-content">{content}</Text>;
    }

    return (
      <Box className="message-content">
        {contentBlocks.map((block, idx) => {
          if (block.type === 'thinking') {
            return (
              <ThinkingBlock
                key={idx}
                content={block.thinking}
                defaultExpanded={isStreaming}
              />
            );
          }
          if (block.type === 'text') {
            return <Text key={idx} as="div">{block.text}</Text>;
          }
          if (block.type === 'tool_use') {
            return (
              <Box key={idx} className="tool-use-inline">
                <Text size="1" color="gray">Using {block.name}...</Text>
              </Box>
            );
          }
          return null;
        })}
        {isStreaming && <StreamingIndicator isThinking={isThinking || false} />}
      </Box>
    );
  };

  return (
    <Box className={`chat-message ${isUser ? 'user' : 'assistant'} ${isStreaming ? 'streaming' : ''}`}>
      <Text size="1" className="message-meta">
        {isUser ? 'You' : 'Claude'} · {new Date(timestamp).toLocaleTimeString()}
        {isStreaming && <span className="streaming-badge">streaming</span>}
      </Text>
      {renderContent()}
    </Box>
  );
}
```

#### 4. Update AgentPanel to Pass Streaming State
**File**: `src/renderer/components/Agent/AgentPanel.tsx`

```typescript
// In the messages.map():
messages.map(msg => (
  <ChatMessage
    key={msg.id}
    type={msg.type}
    content={msg.content}
    contentBlocks={msg.contentBlocks}
    isStreaming={msg.isStreaming}
    isThinking={streaming.isThinking && msg.isStreaming}
    timestamp={msg.timestamp}
  />
))
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] TypeScript compiles without errors

#### Manual Verification
- [ ] Thinking blocks appear with collapsible header
- [ ] Click expands/collapses thinking content
- [ ] Streaming indicator shows during response

---

## Phase 4: Add Streaming CSS Styles

### Overview
Add CSS for thinking blocks, streaming indicators, and visual feedback.

### Changes Required

#### 1. Add Streaming Styles
**File**: `src/renderer/styles/agent.css` (or appropriate stylesheet)

```css
/* Thinking Block */
.thinking-block {
  margin: 8px 0;
  padding: 8px;
  background: var(--gray-a2);
  border-radius: 4px;
  border-left: 2px solid var(--gray-8);
}

.thinking-header {
  user-select: none;
}

.thinking-header:hover {
  color: var(--gray-12);
}

.thinking-content {
  margin-top: 8px;
  padding-left: 16px;
  font-style: italic;
  white-space: pre-wrap;
}

/* Streaming Indicator */
.streaming-indicator {
  display: inline-block;
  margin-left: 2px;
}

.streaming-indicator .cursor {
  display: inline-block;
  width: 8px;
  height: 16px;
  background: var(--accent-9);
  animation: blink 1s step-end infinite;
}

.streaming-indicator.thinking .cursor {
  background: var(--gray-8);
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes blink {
  50% { opacity: 0; }
}

@keyframes pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

/* Streaming Message */
.chat-message.streaming {
  border-left: 2px solid var(--accent-9);
}

.streaming-badge {
  margin-left: 8px;
  padding: 2px 6px;
  font-size: 10px;
  background: var(--accent-a3);
  color: var(--accent-11);
  border-radius: 4px;
}

/* Tool Use Inline */
.tool-use-inline {
  margin: 4px 0;
  padding: 4px 8px;
  background: var(--blue-a2);
  border-radius: 4px;
  font-family: monospace;
}
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`

#### Manual Verification
- [ ] Thinking blocks have distinct visual style
- [ ] Cursor blinks during text streaming
- [ ] Cursor pulses during thinking
- [ ] Streaming messages have visual indicator

---

## Phase 5: Update useAgent Hook

### Overview
Expose streaming state through the useAgent hook for components to consume.

### Changes Required

#### 1. Update useAgent Hook
**File**: `src/renderer/hooks/useAgent.ts`

Add streaming state to the returned object:
```typescript
export function useAgent() {
  const {
    // ... existing fields
    streaming,
  } = useAgentStore();

  return {
    // ... existing returns
    streaming,
    isThinking: streaming.isThinking,
  };
}
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] TypeScript compiles without errors

#### Manual Verification
- [ ] Hook returns streaming state
- [ ] Components can access isThinking

---

## Testing Strategy

### Unit Tests
- Test `extractContentBlocks` with various content structures
- Test stream event handling for different delta types
- Test message state transitions (streaming -> final)

### Integration Tests
- Verify stream events flow from main to renderer
- Verify store updates correctly on stream events
- Verify UI renders streaming content

### Manual Testing Steps
1. Send a prompt that triggers thinking (complex reasoning task)
2. Verify thinking appears with collapsible header
3. Verify text streams character-by-character
4. Verify cursor shows during streaming
5. Verify final message replaces streaming message
6. Verify thinking can be expanded/collapsed after completion

## References

- Research document: `research/2026-02-03-agent-view-streaming-gaps.md`
- ClaudeAgentService stream handling: `src/main/ClaudeAgentService.ts:193-198`
- Store initialization: `src/renderer/stores/agentStore.ts:234-244`
- Current message rendering: `src/renderer/components/Agent/ChatMessage.tsx`
