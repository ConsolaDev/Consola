---
date: 2026-02-09T14:00:00+01:00
git_commit: af7180a
branch: main
repository: Consola
topic: "Implementation plan: Tool clustering UX"
tags: [plan, implementation, ux, tool-rendering, clustering]
status: ready
research: research/2026-02-09-tool-clustering-ux.md
---

# Implementation Plan: Tool Clustering UX

**Date**: 2026-02-09
**Research**: `research/2026-02-09-tool-clustering-ux.md`
**Status**: Ready for implementation

## Overview

Cluster 2+ consecutive `tool_use` content blocks into a single collapsible summary line to reduce visual noise in the conversation. Clusters are **collapsed by default** — the user expands on demand. The only exception is **error auto-expand**: if any tool in a cluster errors, the cluster auto-expands to surface the problem immediately.

This is a **pure rendering-layer change**. No modifications to `agentStore`, IPC handlers, session persistence, or the data model are required.

## Current State Analysis

### What exists now:
- `ChatMessage.tsx` maps `contentBlocks` 1:1 to components — no grouping concept
- `ToolBlock.tsx` renders each tool as a header line (bullet + name + args) with conditional output below
- `ThinkingBlock.tsx` already implements the exact collapse pattern we need (chevron toggle, `useState(false)`, conditional render)
- `toolInputParser.ts` extracts display-friendly info (displayName, primaryArg) — reusable for cluster summaries
- `ChatMessage` uses `React.memo` with a custom comparator that checks tool result status changes

### Key Discoveries:
- `ChatMessage.tsx:31-99` — `renderContent()` maps `contentBlocks` directly, this is the insertion point for grouping
- `ChatMessage.tsx:116-133` — Custom memoization comparator iterates tool_use block IDs to check status changes
- `ThinkingBlock.tsx:8-32` — Collapsible pattern: `useState(false)`, chevron toggle `▶`/`▼`, conditional render
- `toolInputParser.ts:58-161` — Per-tool display name/arg extraction, reusable for cluster summary
- `toolHistory` is a global array passed to every `ChatMessage` — lookup via `toolUseId` matching stays unchanged
- CSS uses Radix UI theme variables (`--space-*`, `--color-*`, `--font-*`)

## Desired End State

When an assistant message contains 2+ consecutive `tool_use` blocks (not interrupted by text or thinking blocks), they render as a single collapsed summary line:

**Collapsed (default):**
```
▶  8 actions  ·  Read(4)  Grep(2)  Edit(2)
```

**In-progress (still collapsed, live-updating summary):**
```
▶  5 of 8 actions  ·  Read(3) ✓  Grep(1) ✓  Bash ⏳
```

**Expanded (user clicked):**
Full list of individual `ToolBlock` components, identical to current rendering.

**Error (auto-expanded):**
If any tool errors, the cluster forces expansion so the error is visible.

Single tool calls (groups of 1) render exactly as they do today — no clustering applied.

## What We're NOT Doing

- No changes to `agentStore.ts`, IPC handlers, or data model
- No user preference/settings toggle (nice-to-have, not MVP)
- No Approach B sub-grouping (same-type clusters within a cluster)
- No Approach C timeline rail
- No auto-expand while in-progress (clusters stay collapsed by default)
- No auto-collapse transitions

## Implementation Approach

Insert a pure grouping function between `contentBlocks` and the rendering loop in `ChatMessage.tsx`. The function segments the array into `single` and `cluster` groups. Clusters render via a new `ToolCluster` component that follows the existing `ThinkingBlock` disclosure pattern. All existing components (`ToolBlock`, `DiffView`, `BashOutput`, etc.) remain unchanged.

---

## Phase 1: Grouping Function

### Overview
Create the pure function that segments `contentBlocks` into singles and clusters.

### Changes Required:

#### 1. New file: `src/renderer/components/Agent/groupContentBlocks.ts`

**Exports:**

```typescript
type GroupedBlock =
  | { kind: 'single'; block: ContentBlock; index: number }
  | { kind: 'cluster'; blocks: ToolUseBlock[]; indices: number[] };

function groupContentBlocks(blocks: ContentBlock[]): GroupedBlock[];

function getClusterSummary(blocks: ToolUseBlock[]): {
  total: number;
  typeCounts: Map<string, number>;
};
```

**Algorithm:** Iterate blocks, accumulate consecutive `tool_use` runs, flush as `cluster` (≥2 blocks) or `single` (1 block) when a non-tool block appears.

**Edge cases:** Empty array, all tools, all text, single tool, alternating tool/text, trailing tool cluster.

### Success Criteria:
- [ ] Pure function with no side effects
- [ ] Handles all edge cases correctly
- [ ] `getClusterSummary` returns accurate per-type counts

---

## Phase 2: ToolCluster Component

### Overview
Build the collapsible cluster component that wraps multiple ToolBlocks.

### Changes Required:

#### 1. New file: `src/renderer/components/Agent/ToolCluster.tsx`

**Props:**
```typescript
interface ToolClusterProps {
  blocks: ToolUseBlock[];
  toolHistory: ToolExecution[];
}
```

**Behavior:**
- `useState(false)` for expanded — **collapsed by default**
- Compute cluster status from `toolHistory`: count pending/complete/error per tool
- If **any tool has `status === 'error'`**, force `expanded = true` (error auto-expand)
- **Collapsed:** render clickable summary line with chevron, count, and per-type breakdown
- **Expanded:** render full list of `ToolBlock` components (reusing existing component unchanged)

**Header format examples:**
- Completed: `▶ 8 actions · Read(4) Grep(2) Edit(2)`
- In-progress: `▶ 5 of 8 actions · Read(3) ✓ Grep(1) ✓ Bash ⏳`
- Has error: `▼ 8 actions · Read(4) ✓ Edit(1) ✗` (auto-expanded)

**Pattern:** Follow `ThinkingBlock.tsx` disclosure pattern — chevron toggle, `cursor: pointer`, conditional render.

#### 2. CSS additions to `src/renderer/components/Agent/styles.css`

New classes:
- `.tool-cluster` — container with subtle background and left border accent (similar to `.thinking-block`)
- `.tool-cluster-header` — flex row, monospace font, cursor pointer, hover state
- `.tool-cluster-chevron` — chevron icon styling (reuse `.thinking-chevron` pattern)
- `.tool-cluster-count` — primary count text
- `.tool-cluster-summary` — secondary text for per-type breakdown
- `.tool-cluster-items` — wrapper for expanded tool blocks with left-border indent

Status indicators use existing color variables:
- `✓` — `var(--green-9)`
- `⏳` — `var(--yellow-9)`
- `✗` — `var(--red-9)`

### Success Criteria:
- [ ] Clusters render collapsed by default
- [ ] Header updates reactively as tool statuses change in `toolHistory`
- [ ] Click toggles expand/collapse
- [ ] Error in any tool forces expansion
- [ ] Expanded state shows identical `ToolBlock` output to current behavior
- [ ] Styling consistent with existing `ThinkingBlock` and `ToolBlock` patterns

---

## Phase 3: Integration into ChatMessage

### Overview
Wire the grouping function into the existing rendering pipeline.

### Changes Required:

#### 1. Modify: `src/renderer/components/Agent/ChatMessage.tsx`

**Import additions:**
```typescript
import { groupContentBlocks } from './groupContentBlocks';
import { ToolCluster } from './ToolCluster';
```

**renderContent() changes:**
- Wrap `contentBlocks` with memoized grouping:
  ```typescript
  const grouped = useMemo(() => groupContentBlocks(contentBlocks), [contentBlocks]);
  ```
- Replace `contentBlocks.map()` with `grouped.map()`:
  - `kind: 'single'` → render as before (ThinkingBlock, MarkdownRenderer, ToolBlock)
  - `kind: 'cluster'` → render `<ToolCluster blocks={...} toolHistory={toolHistory} />`

**Memoization comparator:**
- No changes needed — the existing custom comparator already checks tool result status changes by iterating `contentBlocks` tool_use IDs
- The `useMemo` for `groupContentBlocks` ensures grouping doesn't recompute on unrelated re-renders

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] E2E tests pass: `npm run test:e2e`

#### Manual Verification:
- [ ] Single tool calls render identically to current behavior (no visual regression)
- [ ] 2+ consecutive tools render as collapsed cluster
- [ ] Multiple clusters per message work (e.g., `[tool, tool, text, tool, tool, tool]` → 2 clusters)
- [ ] Click to expand shows all tool blocks with full output
- [ ] Trigger an error — cluster auto-expands
- [ ] In-progress tools show live-updating summary in collapsed header
- [ ] Loaded sessions from `SessionStorageService` display clusters correctly
- [ ] No memoization regressions (tool status updates still trigger re-renders)

---

## Testing Strategy

### Manual Testing Steps:
1. Start a conversation that triggers multi-tool use (e.g., "explore this codebase")
2. Verify clusters appear collapsed with correct action counts
3. Verify the summary updates in real-time as tools complete
4. Click to expand — verify all tool blocks render with full output
5. Click again to collapse — verify it collapses back
6. Trigger an error (e.g., reference a nonexistent file) — verify cluster auto-expands
7. Load a saved session — verify clusters render correctly from persisted data
8. Single tool call — verify no clustering applied, renders as before
9. Mixed message (text → tools → text → tools) — verify multiple independent clusters

### E2E Tests:
- Run `npm run test:e2e` to verify no regressions in existing functionality

---

## Files Summary

### New Files:
1. `src/renderer/components/Agent/groupContentBlocks.ts` — Pure grouping function + cluster summary
2. `src/renderer/components/Agent/ToolCluster.tsx` — Collapsible cluster component

### Modified Files:
1. `src/renderer/components/Agent/ChatMessage.tsx` — Use grouped blocks in renderContent()
2. `src/renderer/components/Agent/styles.css` — Tool cluster CSS classes

### Unchanged Files (referenced):
- `src/renderer/components/Agent/ToolBlock.tsx` — Reused as-is inside expanded clusters
- `src/renderer/components/Agent/toolInputParser.ts` — Reused for cluster summary display names
- `src/renderer/components/Agent/ThinkingBlock.tsx` — Pattern reference for disclosure UI
- `src/renderer/stores/agentStore.ts` — Types only, no changes

## References

- Research document: `research/2026-02-09-tool-clustering-ux.md`
- `src/renderer/components/Agent/ChatMessage.tsx:31-99` — renderContent() insertion point
- `src/renderer/components/Agent/ChatMessage.tsx:116-133` — Memoization comparator
- `src/renderer/components/Agent/ToolBlock.tsx:53-107` — Individual tool rendering
- `src/renderer/components/Agent/toolInputParser.ts:58-161` — Tool display extraction
- `src/renderer/components/Agent/ThinkingBlock.tsx:8-32` — Disclosure pattern
- `src/renderer/components/Agent/styles.css:218-247` — Thinking block CSS (pattern reference)
- `src/renderer/components/Agent/styles.css:259-314` — Tool block CSS
- `src/renderer/stores/agentStore.ts:27-47` — ContentBlock types
- `src/renderer/stores/agentStore.ts:81-89` — ToolExecution type
