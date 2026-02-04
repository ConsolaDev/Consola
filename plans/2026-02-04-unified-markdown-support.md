# Implementation Plan: Unified Markdown Support

**Created**: 2026-02-04
**Status**: Ready for Implementation
**Research**: [research/2026-02-04-markdown-support-agent-panel.md](../research/2026-02-04-markdown-support-agent-panel.md)

## Overview

Add unified markdown rendering support across the application:
1. **Agent panel chat** - User and assistant messages with proper formatting
2. **Content area file viewer** - Rendering .md files (planning docs, research files, etc.)
3. Syntax highlighting for code blocks
4. Collapsible/expandable sections for long code outputs (>15 lines)

## Current State Analysis

### What Exists
- Agent panel renders messages as plain text via `<Text>` components (`ChatMessage.tsx:21-51`)
- CSS uses `white-space: pre-wrap` for text preservation
- No markdown libraries installed
- `ContextPlaceholder` exists as placeholder for future file viewing
- Electron IPC pattern established via `preload.ts` and `agentBridge.ts`

### Key Discoveries
- No `readFile` API exposed in preload - needs to be added for file viewing
- ThinkingBlock already implements collapsible pattern - can reference for CodeBlock
- Uses Radix UI themes + lucide-react icons
- React 19.2.4, TypeScript, Vite build

### What's Missing
- Markdown parsing/rendering
- Syntax highlighting
- File reading capability for content area
- Collapsible code blocks

## Desired End State

After implementation:
1. Chat messages (user & assistant) render with full markdown support
2. Code blocks have syntax highlighting with language labels
3. Long code blocks (>15 lines) auto-collapse with "Show X more lines" toggle
4. .md files can be viewed in the content area with same rendering quality
5. Single shared `Markdown` component folder used by both contexts

## What We're NOT Doing (This Plan)

- Markdown editing (read-only rendering only)
- Code execution from code blocks
- File saving/editing
- Light/dark theme switching for code blocks (use oneDark theme)

---

## Streaming & Tool Output Consideration

### The Question
Should we use Streamdown instead of react-markdown to handle real-time streaming of AI responses, including tool executions (bash commands) and their outputs?

### Analysis of Current Architecture

Based on code analysis of `ClaudeAgentService.ts` and `agentStore.ts`:

| Event Type | When Received | What It Contains | Currently Handled? |
|------------|---------------|------------------|-------------------|
| `stream_event` | During generation | Partial text chunks | ❌ Only sets `isProcessing=true` |
| `assistant-message` | After complete | Full content blocks array | ✅ Renders as message |
| `tool-pending` | Before tool runs | `toolName`, `toolInput` | ✅ Shows in ToolStatus |
| `tool-complete` | After tool runs | `toolName`, `toolInput`, `toolResponse` | ✅ Moves to toolHistory |

### Current Gaps

1. **No streaming text display** - `_handleStream` (agentStore.ts:384-396) only marks processing state, doesn't accumulate or display partial text
2. **Tool outputs not visible in chat** - Only shown in ToolStatus component, not in message flow
3. **No way to follow the process** - User can't see what Claude is typing or what commands are running

### Recommendation: Phased Approach

**This plan (Phase 1-6)**: Use **react-markdown** for static/complete content
- Finished messages
- File viewing
- This gets us 80% of value quickly

**Future Plan (Phase 7+)**: Add streaming support
- Handle `stream_event` to show partial text as Claude types
- Create `ToolExecutionBlock` component to show commands + collapsible outputs inline
- Consider Streamdown OR custom streaming accumulator

### Why NOT Streamdown Now?

1. **Streamdown is chat-focused** - Won't help with file viewing
2. **Tool outputs arrive complete** - They don't stream, so Streamdown doesn't help there
3. **We need unified solution** - Same components for chat and files
4. **Can add streaming later** - react-markdown works, we can optimize later

### Future Phase 7: Streaming & Tool Execution Display

When ready to add streaming, the architecture would be:

```
src/renderer/components/
├── Markdown/
│   ├── MarkdownRenderer.tsx      # For complete content
│   ├── StreamingMarkdown.tsx     # NEW: For streaming content
│   ├── CodeBlock.tsx             # Shared by both
│   └── ToolExecutionBlock.tsx    # NEW: For tool_use + result display
```

**StreamingMarkdown** would:
- Accumulate text from `stream_event`
- Handle incomplete markdown gracefully (either via Streamdown or custom logic)
- Clear on new message

**ToolExecutionBlock** would:
- Show tool name (e.g., "Bash")
- Show command being run (from `toolInput`)
- Collapsible output section (from `toolResponse`)
- Status indicator (pending/running/complete/error)
- Copy button for command and output

This keeps the current plan focused while documenting the path forward.

## Implementation Approach

Use **react-markdown** + **react-syntax-highlighter** (Prism) as a unified solution. Create shared components in `src/renderer/components/Markdown/` that can be imported by both the Agent panel and the file viewer.

---

## Phase 1: Install Dependencies & Create Shared Markdown Components

### Overview
Set up the foundation - install libraries and create the shared Markdown component folder with MarkdownRenderer and CodeBlock components.

### Changes Required

#### 1. Install Dependencies
```bash
npm install react-markdown react-syntax-highlighter remark-gfm @types/react-syntax-highlighter
```

#### 2. Create `src/renderer/components/Markdown/CodeBlock.tsx`
**Purpose**: Collapsible code block with syntax highlighting

Key features:
- Syntax highlighting using Prism (oneDark theme)
- Auto-collapse for code >15 lines
- Copy button with feedback
- Language label header
- Gradient fade for collapsed state
- Accessible toggle button with `aria-expanded`

Reference implementation in research doc lines 213-312.

#### 3. Create `src/renderer/components/Markdown/MarkdownRenderer.tsx`
**Purpose**: Main markdown rendering component

Key features:
- Uses react-markdown with remark-gfm plugin
- Custom code component that routes to CodeBlock
- Inline code styling
- Links open in external browser (`target="_blank"`)

Reference implementation in research doc lines 159-207.

#### 4. Create `src/renderer/components/Markdown/styles.css`
**Purpose**: Shared markdown styles

Includes:
- Typography (headings, paragraphs, lists)
- Blockquotes
- Tables (GFM)
- Inline code
- Code block wrapper, header, content, fade, toggle
- Task list checkboxes

Reference implementation in research doc lines 474-621.

#### 5. Create `src/renderer/components/Markdown/index.ts`
**Purpose**: Module exports
```typescript
export { MarkdownRenderer } from './MarkdownRenderer';
export { CodeBlock } from './CodeBlock';
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] TypeScript compilation succeeds with no errors
- [ ] No unused imports warnings

#### Manual Verification
- [ ] Components can be imported from `../Markdown`
- [ ] No runtime errors when rendering test markdown

---

## Phase 2: Agent Panel Integration

### Overview
Update ChatMessage to use the shared MarkdownRenderer for both user and assistant messages.

### Changes Required

#### 1. Update `src/renderer/components/Agent/ChatMessage.tsx`
**Changes**:
- Import `MarkdownRenderer` from `../Markdown`
- Import the markdown styles
- Replace `<Text>` rendering with `<MarkdownRenderer>` for:
  - User messages
  - Assistant text blocks
  - Fallback content
- Keep ThinkingBlock and tool_use rendering as-is
- Add `markdown-content` class to message content containers

Reference implementation in research doc lines 318-395.

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] No TypeScript errors

#### Manual Verification
- [ ] User messages render markdown (bold, italic, code, links)
- [ ] Assistant messages render markdown
- [ ] Code blocks show syntax highlighting
- [ ] Long code blocks (>15 lines) auto-collapse
- [ ] Copy button works on code blocks
- [ ] Expand/collapse toggle works
- [ ] ThinkingBlock still renders correctly
- [ ] Tool use badges still render correctly

---

## Phase 3: Add File Reading API

### Overview
Expose a `readFile` method in the preload script so the renderer can read .md files from disk.

### Changes Required

#### 1. Update `src/shared/constants.ts`
Add new IPC channel:
```typescript
// File operations
FILE_READ: 'file:read',  // Read file contents
```

#### 2. Update `src/preload/preload.ts`
Add `fileAPI` to contextBridge:
```typescript
contextBridge.exposeInMainWorld('fileAPI', {
  readFile: (filePath: string): Promise<string> => {
    return ipcRenderer.invoke(IPC_CHANNELS.FILE_READ, filePath);
  },
});
```

#### 3. Update `src/main/index.ts` (or create file handler)
Add IPC handler:
```typescript
import { readFile } from 'fs/promises';

ipcMain.handle(IPC_CHANNELS.FILE_READ, async (_event, filePath: string) => {
  // Security: validate path is within allowed directories
  const content = await readFile(filePath, 'utf-8');
  return content;
});
```

#### 4. Add TypeScript declaration
Update or create `src/renderer/types/global.d.ts`:
```typescript
interface Window {
  fileAPI: {
    readFile: (filePath: string) => Promise<string>;
  };
}
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] TypeScript recognizes `window.fileAPI`

#### Manual Verification
- [ ] Can read a .md file from disk via `window.fileAPI.readFile()`
- [ ] Errors are properly thrown for non-existent files

---

## Phase 4: Create MarkdownFileView Component

### Overview
Create the file viewer component that uses the shared MarkdownRenderer to display .md files in the content area.

### Changes Required

#### 1. Create `src/renderer/components/Views/MarkdownFileView.tsx`
**Purpose**: Component to view .md files

Key features:
- File header with icon and filename
- Loading state
- Error state
- ScrollArea for content
- Uses shared MarkdownRenderer

Reference implementation in research doc lines 401-468.

#### 2. Create `src/renderer/services/fileBridge.ts`
**Purpose**: Isolate window.fileAPI access (following agentBridge pattern)
```typescript
export const fileBridge = {
  isAvailable: (): boolean => {
    return typeof window !== 'undefined' && !!window.fileAPI;
  },

  readFile: async (filePath: string): Promise<string> => {
    if (!window.fileAPI) throw new Error('File API not available');
    return window.fileAPI.readFile(filePath);
  },
};
```

#### 3. Update MarkdownFileView to use fileBridge
Replace direct `window.fileAPI` calls with `fileBridge.readFile()`.

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] No TypeScript errors

#### Manual Verification
- [ ] MarkdownFileView renders a .md file correctly
- [ ] Loading state shows while fetching
- [ ] Error state shows for invalid files
- [ ] All markdown features work (code blocks, tables, etc.)

---

## Phase 5: Integrate File Viewer into Content Area

### Overview
Update ContentView and ContextPlaceholder to route .md files to the MarkdownFileView.

### Changes Required

#### 1. Update `src/renderer/components/Views/ContextPlaceholder.tsx`
Transform into a more capable context panel that can:
- Show file list or tree (future)
- Display selected file using appropriate viewer
- For now: accept an optional `selectedFile` prop

#### 2. Create file routing logic
Add logic to determine viewer based on file extension:
```typescript
function getViewerForFile(filePath: string) {
  if (filePath.endsWith('.md')) {
    return <MarkdownFileView filePath={filePath} />;
  }
  // Future: add more viewers
  return <PlainTextView filePath={filePath} />;
}
```

#### 3. Add styles for MarkdownFileView
Add to `src/renderer/components/Views/styles.css`:
```css
.markdown-file-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.file-header {
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
}

.file-content {
  flex: 1;
  overflow: auto;
}
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] No TypeScript errors

#### Manual Verification
- [ ] Can view .md files in the content area
- [ ] research/*.md files render correctly with all formatting
- [ ] Code blocks in viewed files are collapsible
- [ ] Scrolling works for long files

---

## Phase 6: Polish & Edge Cases

### Overview
Test thoroughly and handle edge cases.

### Testing Checklist

#### Markdown Rendering
- [ ] Headers (h1-h6)
- [ ] Bold, italic, strikethrough
- [ ] Inline code
- [ ] Code blocks with various languages (js, ts, python, bash, json)
- [ ] Code blocks without language specification
- [ ] Links (internal and external)
- [ ] Images (if applicable)
- [ ] Ordered and unordered lists
- [ ] Nested lists
- [ ] Task lists (GFM)
- [ ] Tables (GFM)
- [ ] Blockquotes
- [ ] Horizontal rules

#### Code Block Features
- [ ] Syntax highlighting for all supported languages
- [ ] Copy button copies full code (even when collapsed)
- [ ] Line count threshold (15 lines) works correctly
- [ ] Expand shows all code
- [ ] Collapse returns to preview
- [ ] Gradient fade visible when collapsed
- [ ] Language label shows correctly
- [ ] "Show X more lines" shows correct count

#### Integration
- [ ] Agent panel messages render correctly
- [ ] File viewer renders correctly
- [ ] Styles don't conflict between contexts
- [ ] Performance acceptable with large markdown files
- [ ] No memory leaks on component unmount

### Optional Optimizations (if needed)
- Use PrismLight build with only needed languages to reduce bundle size
- Memoize MarkdownRenderer for large documents
- Virtualize very long code blocks

---

## Testing Strategy

### Unit Tests
- CodeBlock component renders with/without collapse
- Copy functionality works
- MarkdownRenderer handles edge cases (empty content, malformed markdown)

### Integration Tests
- ChatMessage renders markdown correctly
- MarkdownFileView loads and displays files

### Manual Testing Steps
1. Send a message with markdown in agent chat
2. Verify formatting renders correctly
3. Send a message with a long code block (>15 lines)
4. Verify it auto-collapses with correct line count
5. Click expand/collapse and verify behavior
6. Click copy and verify clipboard content
7. Open a .md file in content area
8. Verify same rendering quality as chat

---

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `package.json` | UPDATE | Add react-markdown, react-syntax-highlighter, remark-gfm |
| `src/renderer/components/Markdown/MarkdownRenderer.tsx` | CREATE | Shared markdown rendering component |
| `src/renderer/components/Markdown/CodeBlock.tsx` | CREATE | Collapsible code block with syntax highlighting |
| `src/renderer/components/Markdown/styles.css` | CREATE | Shared markdown styles |
| `src/renderer/components/Markdown/index.ts` | CREATE | Module exports |
| `src/renderer/components/Agent/ChatMessage.tsx` | UPDATE | Use MarkdownRenderer |
| `src/shared/constants.ts` | UPDATE | Add FILE_READ channel |
| `src/preload/preload.ts` | UPDATE | Add fileAPI |
| `src/main/index.ts` | UPDATE | Add FILE_READ handler |
| `src/renderer/types/global.d.ts` | CREATE/UPDATE | Add fileAPI types |
| `src/renderer/services/fileBridge.ts` | CREATE | File API bridge |
| `src/renderer/components/Views/MarkdownFileView.tsx` | CREATE | .md file viewer |
| `src/renderer/components/Views/ContextPlaceholder.tsx` | UPDATE | Support file viewing |
| `src/renderer/components/Views/styles.css` | UPDATE | Add file viewer styles |

---

## References

- Research document: `research/2026-02-04-markdown-support-agent-panel.md`
- Existing collapsible pattern: `src/renderer/components/Agent/ThinkingBlock.tsx`
- IPC pattern: `src/preload/preload.ts`
- Bridge pattern: `src/renderer/services/agentBridge.ts`

---

## Future Phase 7: Streaming & Tool Execution Display (NOT IN CURRENT SCOPE)

> **Note**: This phase is documented for future reference. It should be implemented AFTER Phases 1-6 are complete and working.

### Overview
Add real-time streaming display and rich tool execution blocks to follow Claude's process as it happens.

### Why Separate Phase?
- Phases 1-6 provide immediate value with static rendering
- Streaming adds complexity (partial markdown handling, state management)
- Tool execution display requires careful UX design
- Can validate basic markdown rendering first

### Changes Required

#### 1. Update `agentStore.ts` to accumulate streaming text
```typescript
interface InstanceState {
  // ... existing fields
  streamingText: string;  // Accumulated partial text
  streamingMessageId: string | null;
}

_handleStream: (data) => {
  // Accumulate text from stream events
  // Clear when new message starts
}
```

#### 2. Create `src/renderer/components/Markdown/StreamingMarkdown.tsx`
Options:
- **Option A**: Use Streamdown library for robust partial markdown handling
- **Option B**: Custom accumulator with react-markdown (simpler, may have edge cases)

Key features:
- Accept streaming text + isComplete flag
- Handle incomplete code blocks gracefully
- Show cursor/typing indicator

#### 3. Create `src/renderer/components/Agent/ToolExecutionBlock.tsx`
Display tool executions inline in the chat flow:

```tsx
interface ToolExecutionBlockProps {
  toolName: string;
  toolInput: unknown;
  toolResponse?: unknown;
  status: 'pending' | 'complete' | 'error';
}
```

Key features:
- Header with tool icon + name + status badge
- Command/input display (syntax highlighted for Bash)
- Collapsible output section (auto-collapse if >15 lines)
- Copy buttons for command and output
- Duration/timing info

#### 4. Update `ChatMessage.tsx` to render tool blocks inline
Currently `tool_use` blocks show minimal "Used {name}" text. Update to:
- Render `ToolExecutionBlock` for each tool_use
- Match tool_use with corresponding tool_complete from toolHistory
- Show pending state while tool runs

#### 5. Update message rendering flow
```tsx
{contentBlocks.map((block, idx) => {
  if (block.type === 'thinking') return <ThinkingBlock ... />;
  if (block.type === 'text') return <MarkdownRenderer ... />;
  if (block.type === 'tool_use') {
    const result = findToolResult(block.id);
    return <ToolExecutionBlock
      toolName={block.name}
      toolInput={block.input}
      toolResponse={result?.toolResponse}
      status={result ? 'complete' : 'pending'}
    />;
  }
})}
```

### Success Criteria
- [ ] Partial text shows as Claude types
- [ ] Tool commands show with syntax highlighting
- [ ] Tool outputs are collapsible
- [ ] Can follow entire agent process in real-time
- [ ] No performance issues with rapid updates

### Decision Point: Streamdown vs Custom

**When to use Streamdown:**
- If partial markdown causes visual glitches
- If we need features like math rendering
- If bundle size isn't a concern

**When to use custom solution:**
- If we want minimal dependencies
- If partial markdown handling is simple enough
- If we need maximum control over rendering
