---
date: 2026-02-04T16:00:00-08:00
git_commit: 95cb700f41e7dd2f2b6ccb102baf23264f600e47
branch: master
repository: consola
topic: "Agent Output Rendering - Full Visibility Implementation"
tags: [research, codebase, agent, ui, tool-rendering]
status: complete
---

# Research: Agent Output Rendering - Full Visibility Implementation

**Date**: 2026-02-04
**Git Commit**: 95cb700f41e7dd2f2b6ccb102baf23264f600e47
**Branch**: master
**Repository**: consola

## Research Question

How to render everything the agent is doing internally (full visibility) similar to the Claude Code terminal interface, including:
- Tool executions with inputs and outputs
- Collapsible content for long outputs
- Status indicators
- Diff visualization for file edits

## Summary

The current implementation captures rich tool data (`toolInput`, `toolResponse`) but only renders a minimal "Used {toolName}" inline. The SDK provides all the information needed for full visibility - it's just not being displayed.

---

## Current State Analysis

### What Data Is Available

From `src/main/ClaudeAgentService.ts` and SDK hooks:

| Event | Available Data | Currently Used |
|-------|----------------|----------------|
| `tool-pending` | `toolName`, `toolInput` | Only `toolName` |
| `tool-complete` | `toolName`, `toolInput`, `toolResponse` | Only `toolName` |
| `assistant-message` | Full content blocks including `tool_use` with `input` | Only `name` |

### Current Rendering (ChatMessage.tsx:48-53)

```tsx
if (block.type === 'tool_use') {
  return (
    <Box key={idx} className="tool-use-inline">
      <Text size="1" color="gray">Used {block.name}</Text>
    </Box>
  );
}
```

**Problem**: The `block.input` contains the full tool input (command, file path, etc.) but it's ignored.

### Data Structures Available

From `agentStore.ts`:

```typescript
// ToolUseBlock - from assistant message content
interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;      // e.g., "Bash", "Edit", "Read", "Grep"
  input: unknown;    // Full input parameters
}

// ToolExecution - from tool events
interface ToolExecution {
  id: string;
  toolName: string;
  toolInput: unknown;     // Full input
  toolResponse?: unknown; // Full response (when complete)
  status: 'pending' | 'complete' | 'error';
  timestamp: number;
}
```

---

## Proposed Solution

### 1. New Component: ToolBlock

Create a new component that renders tool executions with full detail:

```
src/renderer/components/Agent/ToolBlock.tsx
```

**Features:**
- Status indicator (colored bullet)
- Tool name with primary input (e.g., command, file path)
- Collapsible output section
- Syntax highlighting for code/diffs
- Line count for truncated content

### 2. Visual Design (Matching Terminal)

Based on the terminal screenshot reference:

```
● Bash(npm run build 2>&1 | tail -25)
  └ > consola@1.0.0 build:renderer
    > vite build --config vite.config.ts
    ... +23 lines (click to expand)

● Update(src/renderer/components/Agent/AgentPanel.tsx)
  └ Added 1 line, removed 1 line
    112     {/* Input */}
    113     <ChatInput
    114 -     onSend={sendMessage}
    114 +     onSend={handleSend}
    ...
```

**Visual Elements:**
- `●` Green bullet for success, yellow for pending, red for error
- Tool name in bold with primary argument in parentheses
- `└` connector for output
- Diff coloring: red background for removed, green for added
- Truncation with line count and expand affordance

### 3. Tool Input Parsing

Different tools have different input structures. Parse and display appropriately:

| Tool | Input Structure | Display |
|------|-----------------|---------|
| **Bash** | `{ command: string }` | `Bash(command)` |
| **Read** | `{ file_path: string, limit?, offset? }` | `Read(file_path)` |
| **Edit** | `{ file_path, old_string, new_string }` | `Update(file_path)` with diff |
| **Write** | `{ file_path, content }` | `Write(file_path)` |
| **Grep** | `{ pattern, path? }` | `Grep(pattern)` |
| **Glob** | `{ pattern, path? }` | `Glob(pattern)` |
| **Task** | `{ prompt, subagent_type }` | `Task(subagent_type): prompt...` |

### 4. Component Architecture

```
ChatMessage
├── MarkdownRenderer (for text blocks)
├── ThinkingBlock (for thinking blocks)
└── ToolBlock (NEW - for tool_use blocks)
    ├── ToolHeader (bullet + name + args)
    ├── ToolOutput (collapsible response)
    │   ├── DiffView (for Edit tools)
    │   ├── CodeBlock (for Bash/Read output)
    │   └── TextOutput (for other tools)
    └── ToolStatus (pending/complete indicator)
```

### 5. State Management Changes

Modify `agentStore.ts` to correlate tool_use blocks with tool responses:

```typescript
// Add to Message interface
interface Message {
  // ... existing fields
  toolResults?: Map<string, ToolExecution>; // tool_use_id -> response
}

// When tool-complete fires, find the corresponding tool_use block
// by matching toolName and toolInput
```

### 6. Collapsible Output Implementation

```tsx
interface ToolOutputProps {
  content: string;
  maxLines?: number; // default 5
}

function ToolOutput({ content, maxLines = 5 }: ToolOutputProps) {
  const [expanded, setExpanded] = useState(false);
  const lines = content.split('\n');
  const shouldTruncate = lines.length > maxLines;

  const displayContent = expanded
    ? content
    : lines.slice(0, maxLines).join('\n');

  return (
    <Box className="tool-output">
      <pre>{displayContent}</pre>
      {shouldTruncate && !expanded && (
        <button onClick={() => setExpanded(true)}>
          ... +{lines.length - maxLines} lines (click to expand)
        </button>
      )}
    </Box>
  );
}
```

### 7. Diff Rendering for Edit Operations

For Edit tool blocks, parse old_string/new_string and render a unified diff:

```tsx
function DiffView({ oldStr, newStr, filePath }: DiffViewProps) {
  // Generate unified diff
  // Render with line numbers
  // Red background for removed lines
  // Green background for added lines
}
```

---

## Implementation Plan

### Phase 1: ToolBlock Component
1. Create `ToolBlock.tsx` with basic structure
2. Parse tool inputs for display header
3. Add status bullet indicator
4. Style to match terminal aesthetic

### Phase 2: Tool Output Display
1. Add collapsible output section
2. Implement line truncation with expand
3. Add syntax highlighting for code blocks

### Phase 3: Diff Visualization
1. Create `DiffView` component for Edit operations
2. Parse old_string/new_string into diff format
3. Add line numbers and coloring

### Phase 4: State Correlation
1. Track tool_use_id in tool events (requires ClaudeAgentService change)
2. Correlate tool responses with tool_use blocks
3. Update ToolBlock when response arrives

### Phase 5: Polish
1. Add keyboard shortcuts (expand/collapse all)
2. Add copy button for outputs
3. Smooth animations for expand/collapse

---

## CSS Design Tokens

```css
/* Tool Block */
.tool-block {
  margin: var(--space-2) 0;
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
}

.tool-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.tool-bullet {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.tool-bullet.pending { background: var(--yellow-9); }
.tool-bullet.complete { background: var(--green-9); }
.tool-bullet.error { background: var(--red-9); }

.tool-name {
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-primary);
}

.tool-args {
  color: var(--color-text-secondary);
}

.tool-output {
  margin-left: var(--space-4);
  padding-left: var(--space-3);
  border-left: 1px solid var(--color-border);
}

.tool-output-connector {
  color: var(--color-text-tertiary);
}

/* Diff styling */
.diff-line-removed {
  background: var(--red-a3);
  color: var(--red-11);
}

.diff-line-added {
  background: var(--green-a3);
  color: var(--green-11);
}

.diff-line-number {
  color: var(--color-text-tertiary);
  user-select: none;
  padding-right: var(--space-2);
}

/* Expand/collapse */
.tool-expand-button {
  color: var(--color-text-tertiary);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.tool-expand-button:hover {
  color: var(--color-text-secondary);
}
```

---

## Files to Modify

| File | Changes |
|------|---------|
| `src/renderer/components/Agent/ToolBlock.tsx` | **NEW** - Main tool rendering component |
| `src/renderer/components/Agent/DiffView.tsx` | **NEW** - Diff visualization |
| `src/renderer/components/Agent/ChatMessage.tsx` | Replace inline tool_use with ToolBlock |
| `src/renderer/components/Agent/styles.css` | Add tool block styles |
| `src/renderer/stores/agentStore.ts` | Correlate tool responses with tool_use |
| `src/main/ClaudeAgentService.ts` | Forward `tool_use_id` in events |
| `src/shared/types.ts` | Add `toolUseId` to AgentToolEvent |

---

## Code References

- Current tool rendering: `src/renderer/components/Agent/ChatMessage.tsx:48-53`
- Tool data structures: `src/renderer/stores/agentStore.ts:23-28, 48-55`
- Tool event handling: `src/renderer/stores/agentStore.ts:312-357`
- SDK event processing: `src/main/ClaudeAgentService.ts:121-150`
- Existing ThinkingBlock pattern: `src/renderer/components/Agent/ThinkingBlock.tsx`

---

## Open Questions

1. **Streaming**: Should tool output stream in real-time or appear when complete?
2. **Sub-agents**: How to nest Task tool outputs (they spawn child conversations)?
3. **Large outputs**: Maximum lines before forcing collapse? (suggest 100)
4. **Performance**: Virtualization needed for very long conversations?
