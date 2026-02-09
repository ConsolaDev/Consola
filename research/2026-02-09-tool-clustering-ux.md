---
date: 2026-02-09T12:00:00+01:00
git_commit: af7180a
branch: main
repository: Consola
topic: "Clustering consecutive tool usages to reduce conversation noise"
tags: [research, codebase, ux, tool-rendering, clustering]
status: complete
---

# Research: Clustering Consecutive Tool Usages to Reduce Conversation Noise

**Date**: 2026-02-09
**Git Commit**: af7180a
**Branch**: main
**Repository**: Consola

## Research Question

How can we cluster/group consecutive similar tool usages (until new text appears) to reduce visual noise in the conversation? Currently, each tool invocation renders as an individual `ToolBlock`, creating long lists of tool calls that bury the actual assistant text.

## Summary

The current architecture renders every `tool_use` content block as an individual `ToolBlock` component inline in the conversation. When the assistant uses 10-30 tools consecutively (common during codebase exploration), the text content users care about gets buried below a wall of monospace tool invocation lines.

The data model already supports grouping — `contentBlocks` is a sequential array of `TextBlock | ThinkingBlock | ToolUseBlock`, so consecutive `ToolUseBlock` runs between text boundaries form natural clusters. **No data model changes are required.** This is a pure rendering-layer concern.

Three UX approaches are proposed, with **Approach A ("Activity Log")** recommended as the primary implementation.

---

## Detailed Findings

### 1. Current Rendering Architecture

#### AgentPanel.tsx (`src/renderer/components/Agent/AgentPanel.tsx`)

The top-level chat container iterates over `messages` and renders each as a `ChatMessage`. It passes the entire `toolHistory` array to every assistant message, which the message uses to look up tool execution results.

```tsx
// Lines 72-92: Message rendering loop
messages.map(msg => {
  if (msg.type === 'system') return <SessionDivider />;
  return <ChatMessage
    type={msg.type}
    content={msg.content}
    contentBlocks={msg.type === 'assistant' ? msg.contentBlocks : undefined}
    toolHistory={toolHistory}
  />;
})
```

**Key observation:** Messages are flat — there is no concept of grouping at the message level.

#### ChatMessage.tsx (`src/renderer/components/Agent/ChatMessage.tsx`)

The critical rendering logic lives in `renderContent()` (lines 31-91). For assistant messages with `contentBlocks`, it maps over the array and renders each block individually:

```tsx
contentBlocks.map((block, idx) => {
  if (block.type === 'thinking') return <ThinkingBlock />;
  if (block.type === 'text') {
    if (block.file) return <FileContentBlock />;
    return <MarkdownRenderer />;
  }
  if (block.type === 'tool_use') {
    const toolResult = findToolResult(block.id);
    return <ToolBlock name={block.name} input={block.input} status={status} output={toolResult?.toolResponse} />;
  }
})
```

**This is where grouping logic needs to be inserted.** Instead of mapping `contentBlocks` directly, a grouping function would pre-process the array into `GroupedBlock[]` segments.

#### ToolBlock.tsx (`src/renderer/components/Agent/ToolBlock.tsx`)

Each tool block renders a header line with:
- A colored bullet (yellow=pending, green=complete, red=error)
- Tool name (bold)
- Primary argument (truncated file path, command, pattern, etc.)
- Secondary info (optional)

Plus conditional output below:
- `DiffView` for Edit tools
- `BashOutput` for Bash tools
- `FileContentBlock` for Read tools with file content
- `ToolOutput` for generic responses

**Visual footprint:** Each ToolBlock takes ~32-40px of vertical space minimum (just the header), plus potentially much more when output is shown.

### 2. Data Model

#### Content Blocks (`src/renderer/stores/agentStore.ts`)

```typescript
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock;

interface ToolUseBlock {
  type: 'tool_use';
  id: string;       // Unique ID — correlates with ToolExecution.toolUseId
  name: string;     // Tool name: "Read", "Edit", "Bash", "Grep", etc.
  input: unknown;   // Tool-specific input
}
```

Content blocks arrive in order from the SDK. A typical assistant turn's `contentBlocks` array looks like:

```
[thinking, tool_use, tool_use, tool_use, tool_use, text, tool_use, tool_use, text]
```

The natural cluster boundaries are: thinking/text blocks break the sequence.

#### Tool Execution History

```typescript
interface ToolExecution {
  id: string;
  toolUseId?: string;    // Correlates with ToolUseBlock.id
  toolName: string;
  toolInput: unknown;
  toolResponse?: unknown; // Capped at 50KB
  status: 'pending' | 'complete' | 'error';
  timestamp: number;
}
```

The `toolHistory` array stores execution results separately. The renderer joins them via `toolUseId` matching. This separation means **grouping logic only needs to operate on `contentBlocks`** — the `toolHistory` lookup remains unchanged.

### 3. Tool Input Parsing (`src/renderer/components/Agent/toolInputParser.ts`)

The `parseToolInput()` function extracts display-friendly information from each tool's raw input:

| Tool | displayName | primaryArg | secondaryInfo |
|------|-------------|------------|---------------|
| Bash | "Bash" | First line of command | — |
| Read | "Read" | file_path | offset/limit |
| Edit | "Edit" | file_path | — |
| Write | "Write" | file_path | — |
| Grep | "Grep" | pattern | path or glob |
| Glob | "Glob" | pattern | path |
| Task | "Task" | subagent_type | description |

This parser can be reused in summary lines for clusters (e.g., showing the first item's primary arg in the collapsed header).

### 4. CSS Styling (`src/renderer/components/Agent/styles.css`)

Current tool block styling:

```css
.tool-block {
  margin: var(--space-2) 0;      /* 8px vertical margin */
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
```

Tool outputs all share a common left-border indentation pattern:

```css
.tool-output-container,
.diff-view,
.bash-output {
  margin-left: var(--space-4);    /* 16px indent */
  padding-left: var(--space-3);   /* 12px padding */
  border-left: 1px solid var(--color-border);
}
```

**Existing precedent for collapse:** The `ThinkingBlock` already implements a collapsible disclosure pattern with chevron toggle. The `FileContentBlock` has collapsed/expanded states with fade overlays. These patterns can be reused for tool clusters.

### 5. Memoization (`ChatMessage.tsx` lines 116-133)

The `ChatMessage` component uses `React.memo` with a custom comparator that checks:
1. Basic props equality (type, content, timestamp, contentBlocks)
2. Tool result status changes for any `tool_use` blocks

**Any grouping implementation must preserve this memoization.** The `groupContentBlocks()` function should be memoized with `useMemo` keyed on `contentBlocks` to avoid breaking the existing optimization.

---

## Proposed UX Approaches

### Approach A: "Activity Log" — Single Collapsible Region (Recommended)

**Trigger:** 2+ consecutive `tool_use` blocks with no intervening `text` or `thinking` blocks.

**Collapsed state:**
```
┌─────────────────────────────────────────────────────────┐
│  ▶  8 actions  ·  Read(4)  Grep(2)  Edit(2)            │
└─────────────────────────────────────────────────────────┘
```

**In-progress state:**
```
┌─────────────────────────────────────────────────────────┐
│  ◉  5 of ~8 actions  ·  Read(3) ✓  Grep(1) ✓  Bash ⏳ │
└─────────────────────────────────────────────────────────┘
```

**Expanded state:** Full list of individual ToolBlock components, each with their own output collapse.

**Key behaviors:**
- **Collapsed by default** — clusters always start collapsed, keeping the conversation clean and focused on the assistant's text. Users expand on demand if they want to inspect tool details
- **Live summary updates while in-progress** — the collapsed header updates in real-time to show progress (e.g., "5 of ~8 actions · Read(3) ✓ Grep(1) ✓ Bash ⏳") so users can track activity without expanding
- **Single tool exceptions** — groups of exactly 1 tool render as normal (no clustering)
- **Error auto-expand** — if any tool in a cluster errors, the cluster auto-expands to surface the error immediately

**Pros:** Maximum space savings (N tools → 1 line), simple grouping logic, matches existing ThinkingBlock disclosure pattern, keeps conversation focused on assistant text by default, simpler state management (no auto-expand/auto-collapse transitions).

**Cons:** Users must click to see tool details (mitigated by the live summary providing key info at a glance).

**Complexity:** Medium.

### Approach B: "Stacked Cards" — Same-Type Sub-Groups

**Trigger:** 2+ consecutive `tool_use` blocks of the **same name**.

**Collapsed state:**
```
  [4]  Read   src/foo.ts  +3 more
  [2]  Grep   "pattern" in src/  +1 more
  [2]  Edit   src/foo.ts  +1 more
```

**Expanded state:** Each sub-group expands independently to show its items.

**Pros:** More granular type-level visibility, count badges provide quick signal.

**Cons:** Less space savings, mixed sequences (Read→Grep→Read→Edit) produce many 1-item "groups" with no benefit. Higher implementation complexity with two levels of expand/collapse.

**Complexity:** Medium-High.

### Approach C: "Timeline Rail" — Compressed Vertical Rail

**Concept:** Continuous vertical rail with tiny shape-coded nodes for each tool call. Same-type runs condense into horizontal dot rows.

```
  │
  ├── ● ● ● ●      4 Reads
  ├── ◆ ◆           2 Searches
  ├── ■ ■           2 Edits
  │
  Then the assistant says something meaningful here...
```

**Pros:** Information-dense, visually distinctive, always-visible (no hidden state).

**Cons:** Highest implementation complexity, hover-dependent (accessibility challenges), requires new visual paradigm.

**Complexity:** High.

---

## Recommended Implementation

### Approach A with Approach B's Summary Line

The recommended approach combines:
- **Approach A's single-region grouping** (all consecutive tools, regardless of type)
- **Approach B's type breakdown in the summary** (show per-type counts in the collapsed header)

### Grouping Algorithm

```typescript
type GroupedBlock =
  | { kind: 'single'; block: ContentBlock; index: number }
  | { kind: 'cluster'; blocks: ToolUseBlock[]; indices: number[] };

function groupContentBlocks(blocks: ContentBlock[]): GroupedBlock[] {
  const result: GroupedBlock[] = [];
  let currentCluster: ToolUseBlock[] = [];
  let clusterIndices: number[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type === 'tool_use') {
      currentCluster.push(block);
      clusterIndices.push(i);
    } else {
      // Flush accumulated tool cluster
      if (currentCluster.length >= 2) {
        result.push({ kind: 'cluster', blocks: [...currentCluster], indices: [...clusterIndices] });
      } else if (currentCluster.length === 1) {
        result.push({ kind: 'single', block: currentCluster[0], index: clusterIndices[0] });
      }
      currentCluster = [];
      clusterIndices = [];
      result.push({ kind: 'single', block, index: i });
    }
  }

  // Flush remaining
  if (currentCluster.length >= 2) {
    result.push({ kind: 'cluster', blocks: [...currentCluster], indices: [...clusterIndices] });
  } else if (currentCluster.length === 1) {
    result.push({ kind: 'single', block: currentCluster[0], index: clusterIndices[0] });
  }

  return result;
}
```

### Component Structure

```
ChatMessage.tsx
  └── renderContent()  ← modify to use groupContentBlocks()
        ├── ThinkingBlock (unchanged)
        ├── MarkdownRenderer (unchanged)
        ├── FileContentBlock (unchanged)
        ├── ToolBlock (unchanged, for single tools)
        └── ToolCluster (NEW)
              ├── ToolClusterHeader  (collapsed summary line)
              │     "▶ 8 actions · Read(4) Grep(2) Edit(2)"
              └── [expanded: ToolBlock, ToolBlock, ToolBlock, ...]
```

### New Files Needed

1. **`src/renderer/components/Agent/ToolCluster.tsx`** — Main cluster component
2. **`src/renderer/components/Agent/groupContentBlocks.ts`** — Pure grouping function
3. CSS additions to `styles.css` for cluster header, expand/collapse, animations

### Key Implementation Details

- **Memoize grouping:** `useMemo(() => groupContentBlocks(contentBlocks), [contentBlocks])` in ChatMessage
- **Default collapsed:** Clusters initialize with `expanded = false`. No auto-expand/auto-collapse logic needed — the user controls expand/collapse via click. This dramatically simplifies state management
- **Live summary while collapsed:** The collapsed header reactively updates as tool statuses change in `toolHistory` (e.g., pending count decrements, complete count increments, spinner shows for in-progress tools). Users get progress visibility without expanding
- **Error auto-expand:** If any tool in the cluster transitions to `error` status, force `expanded = true` so the error is immediately visible
- **Configurable threshold:** Default minimum cluster size = 2 (could be a user preference)
- **Preserve tool output access:** Expanded state renders full `ToolBlock` components unchanged
- **Accessibility:** Use `<details>`/`<summary>` or `button` + `aria-expanded`. Collapsed summary gets descriptive `aria-label`

---

## Code References

- `src/renderer/components/Agent/ChatMessage.tsx:31-91` — Content block rendering (where grouping inserts)
- `src/renderer/components/Agent/ChatMessage.tsx:116-133` — Memoization comparator (must be updated)
- `src/renderer/components/Agent/ToolBlock.tsx:53-107` — Individual tool block rendering
- `src/renderer/components/Agent/toolInputParser.ts:58-161` — Tool display name/arg extraction
- `src/renderer/stores/agentStore.ts:27-47` — ContentBlock type definitions
- `src/renderer/stores/agentStore.ts:80-89` — ToolExecution type (for status lookup)
- `src/renderer/stores/agentStore.ts:540-557` — Assistant message handler (contentBlocks extraction)
- `src/renderer/components/Agent/AgentPanel.tsx:72-92` — Message rendering loop
- `src/renderer/components/Agent/styles.css:260-314` — Tool block CSS
- `src/renderer/components/Agent/ThinkingBlock.tsx` — Existing disclosure pattern to follow

## Industry Precedents

| Product | Strategy | Grouping | Default State |
|---------|----------|----------|---------------|
| Claude.ai | Disclosure triangle per tool | None | Collapsed |
| ChatGPT | "Searched N sites" summary | By operation type | Collapsed |
| Cursor | Compact mode toggle | None (reduces per-item weight) | Configurable |
| Claude Code CLI | Single compact line per tool | None | Expanded |
| GitHub Copilot | Bordered sections | None | Expanded |

**No product currently does sophisticated grouping of mixed consecutive tool calls.** This is a differentiation opportunity for Consola.

## Architecture Considerations

1. **Pure rendering concern** — No changes needed to agentStore, IPC, or data model
2. **Backward compatible** — Single tool calls render identically to today
3. **Session persistence** — Grouping is computed at render time from `contentBlocks`, so saved/loaded sessions automatically get grouping
4. **Memoization-safe** — groupContentBlocks is a pure function; useMemo prevents recomputation
5. **Composable** — The ToolCluster component wraps existing ToolBlock components, not replacing them

## Open Questions

1. **Threshold:** Should the minimum cluster size be 2 or 3? (2 recommended — even 2 consecutive reads benefit from grouping)
2. ~~**Auto-collapse timing:** How long after all-complete before auto-collapse?~~ **RESOLVED:** Not applicable — clusters are collapsed by default at all times. No auto-expand/auto-collapse transitions needed.
3. **Nested clusters:** Can a single assistant message have multiple clusters? (Yes — e.g., `[tool, tool, text, tool, tool, tool, text]` produces two clusters)
4. ~~**Error handling:** If one tool in a cluster errors, should the cluster auto-expand to show the error?~~ **RESOLVED:** Yes — errors auto-expand the cluster so the user sees the problem immediately.
5. **User preference:** Should there be a global setting to disable clustering? (Nice to have, not MVP)
