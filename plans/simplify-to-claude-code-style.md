# Implementation Plan: Simplify to Claude Code Style Display

**Date**: 2026-02-03
**Status**: Ready for implementation

## Overview

Replace the character-by-character streaming display with Claude Code's approach: show a spinner with rotating "thinking verbs" while Claude processes, then display the complete response. This is simpler and matches the familiar Claude Code CLI experience.

## Current State Analysis

### What Exists Now
- `StreamingIndicator.tsx` - Cursor animation during streaming
- `ThinkingBlock.tsx` - Collapsible thinking content
- `agentStore.ts` - Accumulates streaming text/thinking buffers
- `ChatMessage.tsx` - Renders content blocks with streaming indicator

### What Claude Code Does
1. Shows a spinner with rotating verbs during thinking: "Pondering...", "Cogitating...", "Thinking..."
2. Uses braille spinner characters: `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`
3. Displays the complete response only after Claude finishes
4. Thinking content is typically hidden or shown in a separate collapsed section

## Desired End State

When Claude responds:
1. A spinner appears with rotating verbs ("Thinking...", "Pondering...", "Processing...")
2. The spinner animates while Claude processes
3. When complete, the full response appears (no streaming text)
4. Thinking blocks remain collapsible but are collapsed by default
5. Tool use shows with current ToolStatus component (already works well)

## What We're NOT Doing

- Character-by-character text streaming
- Real-time thinking text display
- Complex streaming state management
- The exact braille spinner (use CSS spinner instead for simplicity)

## Implementation Approach

Simplify the streaming system to only track "is processing" state, remove text accumulation, and add a processing indicator component with rotating verbs.

---

## Phase 1: Create ProcessingIndicator Component

### Overview
Replace StreamingIndicator with a ProcessingIndicator that shows rotating verbs like Claude Code.

### Changes Required

#### 1. Create ProcessingIndicator Component
**File**: `src/renderer/components/Agent/ProcessingIndicator.tsx` (new file)

```typescript
import { useState, useEffect } from 'react';
import { Flex, Text } from '@radix-ui/themes';

const THINKING_VERBS = [
  'Thinking',
  'Pondering',
  'Processing',
  'Analyzing',
  'Considering',
  'Computing',
  'Reasoning',
  'Evaluating',
  'Deliberating',
  'Cogitating'
];

export function ProcessingIndicator() {
  const [verbIndex, setVerbIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setVerbIndex(prev => (prev + 1) % THINKING_VERBS.length);
    }, 2000); // Change verb every 2 seconds
    return () => clearInterval(interval);
  }, []);

  return (
    <Flex align="center" gap="2" className="processing-indicator">
      <span className="spinner" />
      <Text size="2" color="gray">{THINKING_VERBS[verbIndex]}...</Text>
    </Flex>
  );
}
```

#### 2. Add CSS for ProcessingIndicator
**File**: `src/renderer/components/Agent/styles.css`

```css
/* Processing Indicator */
.processing-indicator {
  padding: 12px 16px;
  background: var(--gray-a2);
  border-radius: 8px;
  margin-bottom: 12px;
}

.processing-indicator .spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--gray-6);
  border-top-color: var(--accent-9);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`

#### Manual Verification
- [ ] Spinner animates smoothly
- [ ] Verbs rotate every 2 seconds

---

## Phase 2: Simplify Store - Remove Streaming Buffers

### Overview
Remove text/thinking buffer accumulation. Keep only `isProcessing` state.

### Changes Required

#### 1. Simplify StreamingState
**File**: `src/renderer/stores/agentStore.ts`

Replace complex StreamingState with simple:
```typescript
interface ProcessingState {
  isProcessing: boolean;
  currentMessageId: string | null;
}
```

#### 2. Simplify _handleStream
Only track that processing started, don't accumulate text:
```typescript
_handleStream: (data: { event: any; uuid: string }) => {
  // Just mark that we're processing
  set(state => {
    if (!state.processing.isProcessing) {
      return {
        processing: { isProcessing: true, currentMessageId: data.uuid }
      };
    }
    return state;
  });
}
```

#### 3. Update _handleAssistantMessage
Reset processing state when message arrives:
```typescript
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
}
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] TypeScript compiles without errors

---

## Phase 3: Update UI Components

### Overview
Update AgentPanel to show ProcessingIndicator, simplify ChatMessage.

### Changes Required

#### 1. Update AgentPanel
**File**: `src/renderer/components/Agent/AgentPanel.tsx`

Show ProcessingIndicator when processing:
```typescript
{/* Processing indicator */}
{isProcessing && <ProcessingIndicator />}

{/* Messages */}
{messages.map(msg => (
  <ChatMessage
    key={msg.id}
    type={msg.type}
    content={msg.content}
    contentBlocks={msg.contentBlocks}
    timestamp={msg.timestamp}
  />
))}
```

#### 2. Simplify ChatMessage
**File**: `src/renderer/components/Agent/ChatMessage.tsx`

Remove streaming props, keep thinking block support but default collapsed:
```typescript
interface ChatMessageProps {
  type: 'user' | 'assistant';
  content: string;
  contentBlocks?: ContentBlock[];
  timestamp: number;
}
```

#### 3. Update ThinkingBlock
Default to collapsed, change label to "View thinking":
```typescript
<Text size="1" color="gray">View thinking ({content.length} chars)</Text>
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`

#### Manual Verification
- [ ] ProcessingIndicator shows while Claude processes
- [ ] Complete message appears when done
- [ ] Thinking blocks collapsed by default

---

## Phase 4: Clean Up Unused Code

### Overview
Remove StreamingIndicator and unused streaming CSS.

### Changes Required

#### 1. Delete StreamingIndicator
**File**: Delete `src/renderer/components/Agent/StreamingIndicator.tsx`

#### 2. Clean up CSS
**File**: `src/renderer/components/Agent/styles.css`

Remove:
- `.streaming-indicator` and related styles
- `@keyframes blink`
- `@keyframes pulse`
- `.chat-message.streaming`
- `.streaming-badge`

#### 3. Update useAgent hook
Remove streaming-specific returns, keep `isProcessing`:
```typescript
return {
  // ... existing
  isProcessing: store.processing.isProcessing,
};
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] No unused imports/exports

---

## Phase 5: Update Message Type

### Overview
Remove `isStreaming` from Message interface since we no longer stream.

### Changes Required

#### 1. Update Message interface
**File**: `src/renderer/stores/agentStore.ts`

```typescript
export interface Message {
  id: string;
  type: 'user' | 'assistant';
  content: string;
  contentBlocks?: ContentBlock[];
  timestamp: number;
  // Remove: isStreaming?: boolean;
}
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] TypeScript compiles without errors

---

## Testing Strategy

### Manual Testing Steps
1. Send a prompt to Claude
2. Verify spinner appears with rotating verbs
3. Verify complete response appears when done (not character by character)
4. Verify thinking blocks appear collapsed
5. Verify clicking thinking block expands it
6. Verify tool use still displays correctly

## References

- Claude Code spinner verbs pattern
- Current implementation: `src/renderer/components/Agent/`
- Store: `src/renderer/stores/agentStore.ts`
