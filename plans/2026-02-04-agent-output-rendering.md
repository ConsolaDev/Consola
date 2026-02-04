# Implementation Plan: Agent Output Rendering - Full Visibility

**Created**: 2026-02-04
**Status**: Ready for Implementation
**Research**: [research/2026-02-04-agent-output-rendering.md](../research/2026-02-04-agent-output-rendering.md)

## Overview

Implement full visibility into agent tool executions, similar to the Claude Code terminal interface. Transform the minimal "Used {toolName}" rendering into rich tool blocks showing inputs, outputs, status, and diff visualization for file edits.

## Current State Analysis

### What Exists
- Tool data is captured: `toolName`, `toolInput`, `toolResponse` available in store
- `tool_use` blocks contain full `input` object but only `name` is displayed (`ChatMessage.tsx:48-53`)
- ToolExecution tracking exists in store (`agentStore.ts:48-55`)
- Tool events handled: `tool-pending`, `tool-complete` (`agentStore.ts:312-357`)
- ThinkingBlock provides collapsible pattern to follow (`ThinkingBlock.tsx`)
- Basic tool status badge styling exists (`styles.css:90-103`)

### Key Discoveries
- `ToolUseBlock.input` contains full parameters (command, file_path, old_string, new_string, etc.)
- Tool matching uses `toolName` + `status: 'pending'` - no unique ID correlation
- SDK hooks (`ClaudeAgentService.ts:121-150`) don't pass `tool_use_id`
- Tool responses stored in `toolHistory` after completion

### What's Missing
- Rich tool block rendering with inputs/outputs
- Collapsible output sections for long content
- Diff visualization for Edit operations
- Status indicators (pending/complete/error)
- Correlation between `tool_use` blocks and `tool-complete` events by ID

## Desired End State

After implementation:
1. Each `tool_use` block renders as a rich ToolBlock component
2. ToolBlock shows: status bullet, tool name, primary argument (command, file path, pattern)
3. Tool outputs are collapsible with line count and expand/collapse toggle
4. Edit operations show unified diff with red/green highlighting
5. Users can follow agent activity like in Claude Code terminal

## What We're NOT Doing (This Plan)

- Streaming partial tool output (outputs arrive complete)
- Sub-agent nesting for Task tools (future enhancement)
- Virtualization for very long conversations
- Real-time output for Bash commands (SDK limitation)
- Keyboard shortcuts for expand/collapse all

---

## Implementation Approach

Build a new `ToolBlock` component hierarchy that renders tool_use blocks with full detail. Correlate tool responses by adding `toolUseId` to the event flow. Style to match terminal aesthetic with status bullets and collapsible outputs.

---

## Phase 1: ToolBlock Component Foundation

### Overview
Create the core ToolBlock component with header, status indicator, and basic input display.

### Changes Required

#### 1. Create `src/renderer/components/Agent/ToolBlock.tsx`
**Purpose**: Main component for rendering tool executions

Key features:
- Status bullet (colored circle: yellow=pending, green=complete, red=error)
- Tool name in bold
- Primary argument display (parsed from input)
- Wrapper for output section (implemented in Phase 2)

```tsx
interface ToolBlockProps {
  name: string;
  input: unknown;
  status: 'pending' | 'complete' | 'error';
  output?: unknown;
}
```

#### 2. Create `src/renderer/components/Agent/toolInputParser.ts`
**Purpose**: Parse tool inputs for display

Handle different tool input structures:
| Tool | Input Shape | Display Format |
|------|-------------|----------------|
| Bash | `{ command }` | `Bash(command)` |
| Read | `{ file_path, limit?, offset? }` | `Read(file_path)` |
| Edit | `{ file_path, old_string, new_string }` | `Edit(file_path)` |
| Write | `{ file_path, content }` | `Write(file_path)` |
| Grep | `{ pattern, path? }` | `Grep(pattern)` |
| Glob | `{ pattern, path? }` | `Glob(pattern)` |
| Task | `{ prompt, subagent_type }` | `Task(subagent_type)` |

```typescript
interface ParsedToolInput {
  displayName: string;     // e.g., "Bash", "Edit"
  primaryArg: string;      // e.g., "npm run build", "src/index.ts"
  secondaryInfo?: string;  // e.g., line range for Read
  rawInput: unknown;       // Full input for detailed view
}

export function parseToolInput(toolName: string, input: unknown): ParsedToolInput;
```

#### 3. Update `src/renderer/components/Agent/styles.css`
**Changes**: Add tool block styles

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
  flex-shrink: 0;
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
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 400px;
}
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] TypeScript compilation succeeds

#### Manual Verification
- [ ] ToolBlock renders with correct status bullet color
- [ ] Tool name displays in bold
- [ ] Primary argument shows correctly for Bash, Read, Edit tools
- [ ] Long arguments truncate with ellipsis

---

## Phase 2: Tool Output Display with Collapsible Content

### Overview
Add collapsible output section to ToolBlock for displaying tool responses.

### Changes Required

#### 1. Create `src/renderer/components/Agent/ToolOutput.tsx`
**Purpose**: Collapsible output display with line truncation

Key features:
- Auto-collapse if content exceeds threshold (default: 10 lines)
- Show first N lines with gradient fade when collapsed
- "+X more lines" expand button
- Collapse button when expanded
- Connector line to visually link to header

```tsx
interface ToolOutputProps {
  content: string;
  maxLines?: number;  // Default 10
  language?: string;  // For syntax highlighting (optional)
}
```

#### 2. Create `src/renderer/components/Agent/toolOutputParser.ts`
**Purpose**: Convert tool responses to displayable strings

Handle different response types:
- String responses: display as-is
- Object responses: JSON.stringify with indentation
- Array responses: join with newlines or JSON format
- Error responses: extract message

```typescript
export function parseToolOutput(response: unknown): {
  content: string;
  language?: string;  // 'json', 'bash', etc.
  isError: boolean;
};
```

#### 3. Update `src/renderer/components/Agent/ToolBlock.tsx`
**Changes**: Integrate ToolOutput component

- Add output section below header when `output` prop provided
- Pass parsed output to ToolOutput component

#### 4. Update `src/renderer/components/Agent/styles.css`
**Changes**: Add output styles

```css
.tool-output-container {
  margin-left: var(--space-4);
  margin-top: var(--space-1);
  padding-left: var(--space-3);
  border-left: 1px solid var(--color-border);
}

.tool-output-connector {
  color: var(--color-text-tertiary);
  margin-right: var(--space-1);
}

.tool-output-content {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--color-bg-secondary);
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.tool-output-content.collapsed {
  position: relative;
  max-height: calc(var(--font-size-xs) * var(--line-height-normal) * 10);
}

.tool-output-content.collapsed::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 40px;
  background: linear-gradient(transparent, var(--color-bg-secondary));
  pointer-events: none;
}

.tool-expand-button {
  color: var(--color-text-tertiary);
  font-size: var(--font-size-xs);
  cursor: pointer;
  margin-top: var(--space-1);
  padding: var(--space-1);
}

.tool-expand-button:hover {
  color: var(--color-text-secondary);
}
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] TypeScript compilation succeeds

#### Manual Verification
- [ ] Tool outputs display below the header
- [ ] Outputs >10 lines auto-collapse
- [ ] Expand button shows correct line count
- [ ] Clicking expand shows full output
- [ ] Collapse button works
- [ ] Gradient fade visible when collapsed

---

## Phase 3: Diff Visualization for Edit Operations

### Overview
Create specialized diff view for Edit tool operations showing unified diff with line coloring.

### Changes Required

#### 1. Create `src/renderer/components/Agent/DiffView.tsx`
**Purpose**: Render unified diff for Edit operations

Key features:
- Generate unified diff from old_string/new_string
- Line numbers for context
- Red background for removed lines (prefixed with -)
- Green background for added lines (prefixed with +)
- Gray for context lines
- File path header
- Line count summary ("Added X lines, removed Y lines")

```tsx
interface DiffViewProps {
  filePath: string;
  oldString: string;
  newString: string;
  maxLines?: number;  // For collapsing long diffs
}
```

Use simple line-by-line comparison:
```typescript
function generateSimpleDiff(oldStr: string, newStr: string): DiffLine[] {
  // Basic implementation: show removed lines, then added lines
  // For more sophisticated diffs, could use a diff library
}
```

#### 2. Update `src/renderer/components/Agent/ToolBlock.tsx`
**Changes**: Route Edit tools to DiffView

- Check if tool name is "Edit"
- Extract `old_string`, `new_string`, `file_path` from input
- Render DiffView instead of generic ToolOutput

#### 3. Update `src/renderer/components/Agent/styles.css`
**Changes**: Add diff styles

```css
/* Diff View */
.diff-view {
  margin-left: var(--space-4);
  margin-top: var(--space-1);
  padding-left: var(--space-3);
  border-left: 1px solid var(--color-border);
}

.diff-header {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  margin-bottom: var(--space-1);
}

.diff-content {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.diff-line {
  display: flex;
  padding: 0 var(--space-2);
}

.diff-line-number {
  color: var(--color-text-tertiary);
  user-select: none;
  min-width: 3ch;
  text-align: right;
  padding-right: var(--space-2);
}

.diff-line-content {
  flex: 1;
  white-space: pre-wrap;
  word-break: break-all;
}

.diff-line.removed {
  background: var(--red-a3);
}

.diff-line.removed .diff-line-content {
  color: var(--red-11);
}

.diff-line.added {
  background: var(--green-a3);
}

.diff-line.added .diff-line-content {
  color: var(--green-11);
}

.diff-line.context {
  background: var(--color-bg-secondary);
}
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] TypeScript compilation succeeds

#### Manual Verification
- [ ] Edit tools show diff view instead of raw output
- [ ] Removed lines have red background with - prefix
- [ ] Added lines have green background with + prefix
- [ ] Line numbers display correctly
- [ ] Long diffs can collapse/expand
- [ ] File path shows in diff header

---

## Phase 4: Tool Response Correlation

### Overview
Add `toolUseId` to event flow to properly correlate tool_use blocks with their responses.

### Changes Required

#### 1. Update `src/shared/types.ts`
**Changes**: Add toolUseId to AgentToolEvent

```typescript
export interface AgentToolEvent {
  instanceId: string;
  toolName: string;
  toolInput: unknown;
  toolResponse?: unknown;
  toolUseId?: string;  // NEW: Correlate with tool_use block
}
```

#### 2. Update `src/main/ClaudeAgentService.ts`
**Changes**: Extract and forward tool_use_id from SDK hooks

The SDK hooks receive the full tool_use block context. Update to extract ID:

```typescript
PreToolUse: [{
  hooks: [async (input: PreToolUseHookInput & { tool_use_id?: string }) => {
    this.emit('tool-pending', {
      toolName: input.tool_name,
      toolInput: input.tool_input,
      toolUseId: input.tool_use_id  // Forward the ID
    });
    return {};
  }]
}],
PostToolUse: [{
  hooks: [async (input: PostToolUseHookInput & { tool_use_id?: string }) => {
    this.emit('tool-complete', {
      toolName: input.tool_name,
      toolInput: input.tool_input,
      toolResponse: input.tool_response,
      toolUseId: input.tool_use_id  // Forward the ID
    });
    return {};
  }]
}]
```

#### 3. Update `src/renderer/stores/agentStore.ts`
**Changes**:
- Add `toolUseId` to ToolExecution interface
- Match tool responses by ID instead of name
- Store tool results in a Map for lookup

```typescript
export interface ToolExecution {
  id: string;
  toolUseId?: string;  // NEW: From SDK
  toolName: string;
  toolInput: unknown;
  toolResponse?: unknown;
  status: 'pending' | 'complete' | 'error';
  timestamp: number;
}

// Update _handleToolPending and _handleToolComplete to use toolUseId
```

#### 4. Update `src/renderer/components/Agent/ChatMessage.tsx`
**Changes**: Look up tool results by ID when rendering tool_use blocks

```typescript
// Get tool result from store
const instance = useAgentStore(state => state.getInstance(instanceId));

// In render:
if (block.type === 'tool_use') {
  const toolResult = instance.toolHistory.find(t => t.toolUseId === block.id);
  return (
    <ToolBlock
      key={idx}
      name={block.name}
      input={block.input}
      status={toolResult ? 'complete' : 'pending'}
      output={toolResult?.toolResponse}
    />
  );
}
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] TypeScript compilation succeeds

#### Manual Verification
- [ ] Tool pending state shows while tool runs
- [ ] Tool complete state shows after tool finishes
- [ ] Correct output matches correct tool block (by ID, not name)
- [ ] Multiple same-name tools show correct respective outputs

---

## Phase 5: Integration and Polish

### Overview
Integrate ToolBlock into ChatMessage and polish the overall experience.

### Changes Required

#### 1. Update `src/renderer/components/Agent/ChatMessage.tsx`
**Changes**: Replace inline tool_use rendering with ToolBlock

```tsx
import { ToolBlock } from './ToolBlock';
import { useAgentStore } from '../../stores/agentStore';

// Add instanceId to props or get from context
interface ChatMessageProps {
  // ... existing props
  instanceId: string;
}

// In render:
if (block.type === 'tool_use') {
  const toolResult = findToolResult(block.id);
  return (
    <ToolBlock
      key={idx}
      name={block.name}
      input={block.input}
      status={toolResult ? toolResult.status : 'pending'}
      output={toolResult?.toolResponse}
    />
  );
}
```

#### 2. Create `src/renderer/components/Agent/index.ts`
**Changes**: Export new components

```typescript
export { ToolBlock } from './ToolBlock';
export { ToolOutput } from './ToolOutput';
export { DiffView } from './DiffView';
// ... existing exports
```

#### 3. Add copy button to tool outputs
**File**: `ToolOutput.tsx`
**Changes**: Add copy-to-clipboard functionality

```tsx
const [copied, setCopied] = useState(false);

const handleCopy = async () => {
  await navigator.clipboard.writeText(content);
  setCopied(true);
  setTimeout(() => setCopied(false), 2000);
};
```

#### 4. Final style adjustments
**File**: `styles.css`
**Changes**: Ensure consistent spacing and visual hierarchy

- Verify tool blocks don't have excessive margin
- Check contrast ratios for diff colors
- Ensure copy button doesn't overlap content

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] TypeScript compilation succeeds
- [ ] No console errors in dev mode

#### Manual Verification
- [ ] Tool blocks render inline with messages
- [ ] Bash commands show with command in header
- [ ] Read operations show file path
- [ ] Edit operations show diff
- [ ] Grep/Glob show pattern
- [ ] Copy button works
- [ ] Collapse/expand works for all tool types
- [ ] Visual style matches terminal aesthetic

---

## Testing Strategy

### Unit Tests
- `toolInputParser.ts`: Test parsing for each tool type
- `toolOutputParser.ts`: Test string, object, array, error responses
- `DiffView`: Test diff generation with various inputs

### Integration Tests
- ToolBlock renders with pending/complete states
- ChatMessage correctly integrates ToolBlock
- Tool correlation works with multiple tools

### Manual Testing Steps
1. Send a message that triggers Bash tool
2. Verify command shows in header, output is collapsible
3. Send a message that triggers Edit tool
4. Verify diff view shows with correct coloring
5. Send a message that triggers multiple tools
6. Verify each tool shows correct respective output
7. Send a message that triggers Read with large file
8. Verify output collapses and shows line count
9. Test copy button on tool outputs
10. Test expand/collapse toggle

---

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `src/renderer/components/Agent/ToolBlock.tsx` | CREATE | Main tool rendering component |
| `src/renderer/components/Agent/ToolOutput.tsx` | CREATE | Collapsible output display |
| `src/renderer/components/Agent/DiffView.tsx` | CREATE | Diff visualization for Edit |
| `src/renderer/components/Agent/toolInputParser.ts` | CREATE | Parse tool inputs for display |
| `src/renderer/components/Agent/toolOutputParser.ts` | CREATE | Parse tool responses |
| `src/renderer/components/Agent/ChatMessage.tsx` | UPDATE | Use ToolBlock for tool_use blocks |
| `src/renderer/components/Agent/styles.css` | UPDATE | Add tool block and diff styles |
| `src/renderer/components/Agent/index.ts` | UPDATE | Export new components |
| `src/renderer/stores/agentStore.ts` | UPDATE | Add toolUseId, improve correlation |
| `src/main/ClaudeAgentService.ts` | UPDATE | Forward toolUseId in events |
| `src/shared/types.ts` | UPDATE | Add toolUseId to AgentToolEvent |

---

## Open Questions (Resolved)

| Question | Resolution |
|----------|------------|
| Streaming tool output? | No - SDK delivers complete responses |
| Sub-agent nesting? | Deferred - future enhancement |
| Max lines before collapse? | 10 lines default, configurable |
| Performance/virtualization? | Deferred - evaluate after implementation |

---

## References

- Research document: `research/2026-02-04-agent-output-rendering.md`
- Existing collapsible pattern: `src/renderer/components/Agent/ThinkingBlock.tsx`
- Tool event handling: `src/renderer/stores/agentStore.ts:312-357`
- SDK hook integration: `src/main/ClaudeAgentService.ts:121-150`
- Current tool rendering: `src/renderer/components/Agent/ChatMessage.tsx:48-53`

---

## Future Enhancements (Not In Scope)

1. **Sub-agent Display**: Nested view for Task tool outputs showing child conversations
2. **Keyboard Shortcuts**: Expand/collapse all tools with hotkey
3. **Search in Outputs**: Find text within tool outputs
4. **Output Virtualization**: For conversations with many tools
5. **Streaming Bash Output**: If SDK adds support
6. **Syntax Highlighting**: Code highlighting in tool outputs (coordinate with markdown plan)
