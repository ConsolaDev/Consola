# ContentView Split Panel Implementation Plan

**Date**: 2026-02-04
**Status**: Ready for implementation

## Overview

Add a resizable horizontal split view to ContentView with AgentPanel on the left and a placeholder panel on the right. Panel sizes persist to localStorage.

## Current State Analysis

- `ContentView` (`src/renderer/components/Views/ContentView.tsx:1-61`) - Shows workspace/project info with placeholder content
- `AgentPanel` (`src/renderer/components/Agent/AgentPanel.tsx:1-87`) - Complete chat UI with messages, input, tool status
- Project uses flexbox layouts with CSS variables for theming

### Key Discoveries:
- Layout uses `flex: 1` and `overflow: hidden` patterns (`src/renderer/components/Layout/styles.css:67-73`)
- CSS variables defined in `src/renderer/styles/themes/tokens.css` for spacing, colors, transitions
- AgentPanel already handles its own scrolling and layout (`src/renderer/components/Agent/styles.css:1-7`)

## Desired End State

ContentView displays a horizontally split view:
- **Left panel**: AgentPanel (chat conversation)
- **Right panel**: Placeholder (for future context/files panel)
- **Divider**: Draggable to resize panels
- **Persistence**: Panel width saved to localStorage and restored on load

## What We're NOT Doing

- Collapsible panels (can add later)
- Multiple split directions (vertical option)
- Nested splits
- The right panel content (just a placeholder for now)

## Implementation Approach

Use `react-resizable-panels` library:
- Lightweight (~7.5KB gzipped), well-maintained
- Handles edge cases (touch, keyboard, SSR, iframes) out of the box
- Built-in localStorage persistence via `autoSaveId` prop
- Declarative API, easy to extend later

---

## Phase 1: Install and Setup

### Overview
Install react-resizable-panels and create base styles for the resize handle.

### Changes Required:

#### 1. Install Dependency
**Command**: `npm install react-resizable-panels`

#### 2. Create Panel Styles
**File**: `src/renderer/components/Views/styles.css`
**Changes**: Add styles for the resize handle to match app theme

```css
/* Resize handle for split panels */
.resize-handle {
  width: 1px;
  background: var(--color-border);
  transition: background var(--transition-fast);
}

.resize-handle:hover,
.resize-handle[data-resize-handle-active] {
  background: var(--color-accent);
}

.resize-handle::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: -4px;
  right: -4px;
}
```

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] No TypeScript errors

---

## Phase 2: Integrate Split Panel into ContentView

### Overview
Replace ContentView's placeholder with PanelGroup containing AgentPanel and a placeholder.

### Changes Required:

#### 1. Update ContentView
**File**: `src/renderer/components/Views/ContentView.tsx`
**Changes**:

```tsx
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { AgentPanel } from '../Agent/AgentPanel';

// Replace the placeholder content with:
<div className="workspace-view-content">
  <PanelGroup direction="horizontal" autoSaveId="content-view-split">
    <Panel defaultSize={60} minSize={20}>
      <AgentPanel />
    </Panel>
    <PanelResizeHandle className="resize-handle" />
    <Panel minSize={20}>
      <ContextPlaceholder />
    </Panel>
  </PanelGroup>
</div>
```

#### 2. Create ContextPlaceholder Component
**File**: `src/renderer/components/Views/ContextPlaceholder.tsx`
**Changes**: Simple placeholder for the right panel

```tsx
import './styles.css';

export function ContextPlaceholder() {
  return (
    <div className="context-placeholder">
      <p>Context panel</p>
      <p className="context-placeholder-hint">Files and context coming soon</p>
    </div>
  );
}
```

#### 3. Update Views Styles
**File**: `src/renderer/components/Views/styles.css`
**Changes**:
- Remove centering from `.workspace-view-content` (let PanelGroup fill the space)
- Add `.context-placeholder` styles matching existing placeholder pattern

```css
.workspace-view-content {
  flex: 1;
  display: flex;
  overflow: hidden;
  /* Remove: align-items: center; justify-content: center; */
}

.context-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-text-tertiary);
  text-align: center;
  padding: var(--space-4);
}

.context-placeholder-hint {
  font-size: var(--font-size-sm);
  margin-top: var(--space-2);
}
```

#### 4. Export ContextPlaceholder
**File**: `src/renderer/components/Views/index.ts`
**Changes**: Add export for ContextPlaceholder

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] No TypeScript errors

#### Manual Verification:
- [ ] ContentView shows split panel with AgentPanel on left
- [ ] Right panel shows placeholder text
- [ ] Dragging divider resizes panels smoothly
- [ ] Divider highlights on hover
- [ ] Panel size persists across page refreshes
- [ ] Keyboard accessible (Tab to divider, arrow keys to resize)

---

## Testing Strategy

### Manual Testing Steps:
1. Open a workspace tab
2. Verify split panel appears with AgentPanel on left, placeholder on right
3. Drag divider to resize - should be smooth
4. Hover divider - should highlight with accent color
5. Refresh page - panel size should persist
6. Use keyboard: Tab to divider, use arrow keys to resize
7. Navigate to different workspace - split should work there too
8. Resize browser window - panels should maintain proportions

## File Summary

### New Files:
- `src/renderer/components/Views/ContextPlaceholder.tsx`

### Modified Files:
- `package.json` (add react-resizable-panels)
- `src/renderer/components/Views/ContentView.tsx`
- `src/renderer/components/Views/styles.css`
- `src/renderer/components/Views/index.ts`

## References

- react-resizable-panels docs: https://github.com/bvaughn/react-resizable-panels
- Current ContentView: `src/renderer/components/Views/ContentView.tsx`
- AgentPanel: `src/renderer/components/Agent/AgentPanel.tsx`
- Layout patterns: `src/renderer/components/Layout/styles.css`
- CSS tokens: `src/renderer/styles/themes/tokens.css`
