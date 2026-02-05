# Implementation Plan: Preview Panel with Tabs

**Date**: 2026-02-05
**Status**: Ready for Implementation
**Based on**: Phases 4-5 from `2026-02-04-file-explorer-implementation.md`

## Overview

Add a tabbed Preview Panel that replaces the current `ContextPlaceholder`. Users can open multiple files as tabs and switch between them. The Preview Panel auto-shows when the first file is opened and auto-hides when the last tab is closed.

## Current State Analysis

### Already Implemented:
- **FileExplorer** component with tree navigation (`src/renderer/components/FileExplorer/`)
- **ContextPlaceholder** with single-file viewing (`src/renderer/components/Views/ContextPlaceholder.tsx`)
- **CodeFileView** and **MarkdownFileView** for file rendering
- **PathDisplay** with explorer toggle button
- **fileUtils.ts** with `getFileCategory`, `isPreviewable`, `getLanguageFromPath` functions
- **fileBridge** with `readFile` and `listDirectory` methods

### Not Yet Implemented:
- `previewTabStore.ts` - Tab state management
- `PreviewPanel` component with tab bar
- Auto-show/hide behavior based on open tabs

### Key Existing Code to Leverage:
- `ContextPlaceholder.tsx:14-31` has the `FileViewer` routing logic we'll reuse
- `fileUtils.ts` has all file categorization we need
- `tabStore.ts` pattern can be followed for the new store

## Desired End State

1. Multiple files can be opened as tabs in the Preview Panel
2. Clicking a file in the explorer opens it as a new tab (or focuses existing tab)
3. Tab bar shows all open files with close buttons
4. Panel auto-shows when first file is opened
5. Panel auto-hides when last tab is closed
6. Agent Panel expands to fill space when Preview Panel is hidden

### Layout States:
```
No files open:     [FileExplorer | Agent Panel        ]
Files open:        [FileExplorer | Agent Panel | Preview Panel]
Explorer hidden:   [Agent Panel] or [Agent Panel | Preview Panel]
```

## What We're NOT Doing

- Pinned/unpinned tab behavior (all tabs are equal)
- Tab reordering via drag and drop
- Tab persistence across sessions
- Split view within Preview Panel

---

## Phase 1: Preview Tab Store

### Overview
Create a Zustand store to manage open file tabs in the Preview Panel, following the pattern of the existing `tabStore.ts`.

### Changes Required:

#### 1. Create Preview Tab Store
**File**: `src/renderer/stores/previewTabStore.ts` (new)

```typescript
import { create } from 'zustand';

export interface PreviewTab {
  id: string;        // File path serves as unique ID
  filePath: string;
  filename: string;
}

interface PreviewTabState {
  tabs: PreviewTab[];
  activeTabId: string | null;

  openFile: (filePath: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  closeAllTabs: () => void;
}

function getFilename(filePath: string): string {
  return filePath.split('/').pop() || filePath;
}

export const usePreviewTabStore = create<PreviewTabState>((set, get) => ({
  tabs: [],
  activeTabId: null,

  openFile: (filePath: string) => {
    const { tabs } = get();
    const existingTab = tabs.find((t) => t.filePath === filePath);

    if (existingTab) {
      // File already open, just focus it
      set({ activeTabId: existingTab.id });
      return;
    }

    // Create new tab
    const newTab: PreviewTab = {
      id: filePath,
      filePath,
      filename: getFilename(filePath),
    };

    set({
      tabs: [...tabs, newTab],
      activeTabId: newTab.id,
    });
  },

  closeTab: (tabId: string) => {
    const { tabs, activeTabId } = get();
    const tabIndex = tabs.findIndex((t) => t.id === tabId);
    if (tabIndex === -1) return;

    const newTabs = tabs.filter((t) => t.id !== tabId);

    // Determine new active tab
    let newActiveTabId: string | null = activeTabId;
    if (activeTabId === tabId) {
      if (newTabs.length === 0) {
        newActiveTabId = null;
      } else if (tabIndex > 0) {
        newActiveTabId = newTabs[tabIndex - 1].id;
      } else {
        newActiveTabId = newTabs[0].id;
      }
    }

    set({
      tabs: newTabs,
      activeTabId: newActiveTabId,
    });
  },

  setActiveTab: (tabId: string) => {
    const { tabs } = get();
    if (tabs.some((t) => t.id === tabId)) {
      set({ activeTabId: tabId });
    }
  },

  closeAllTabs: () => {
    set({ tabs: [], activeTabId: null });
  },
}));
```

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] Type check passes: `npm run typecheck`

#### Manual Verification:
- [ ] Store correctly manages tab state (test via React DevTools or console)
- [ ] Opening same file twice focuses existing tab
- [ ] Closing active tab selects adjacent tab correctly

---

## Phase 2: Preview Panel Component with Tabs

### Overview
Create the Preview Panel with a tab bar for switching between open files. This will replace `ContextPlaceholder` in the layout.

### Changes Required:

#### 1. Create PreviewTabBar Component
**File**: `src/renderer/components/PreviewPanel/PreviewTabBar.tsx` (new)

```typescript
import { X } from 'lucide-react';
import { usePreviewTabStore } from '../../stores/previewTabStore';
import { FileIcon } from '../FileExplorer/FileIcon';

export function PreviewTabBar() {
  const tabs = usePreviewTabStore((state) => state.tabs);
  const activeTabId = usePreviewTabStore((state) => state.activeTabId);
  const setActiveTab = usePreviewTabStore((state) => state.setActiveTab);
  const closeTab = usePreviewTabStore((state) => state.closeTab);

  if (tabs.length === 0) return null;

  return (
    <div className="preview-tab-bar">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`preview-tab ${activeTabId === tab.id ? 'active' : ''}`}
          onClick={() => setActiveTab(tab.id)}
        >
          <FileIcon filename={tab.filename} className="preview-tab-icon" />
          <span className="preview-tab-name">{tab.filename}</span>
          <button
            className="preview-tab-close"
            onClick={(e) => {
              e.stopPropagation();
              closeTab(tab.id);
            }}
            aria-label={`Close ${tab.filename}`}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
```

#### 2. Create PreviewPanel Component
**File**: `src/renderer/components/PreviewPanel/PreviewPanel.tsx` (new)

This reuses the existing `FileViewer` logic from `ContextPlaceholder.tsx`:

```typescript
import { usePreviewTabStore } from '../../stores/previewTabStore';
import { PreviewTabBar } from './PreviewTabBar';
import { CodeFileView } from '../Views/CodeFileView';
import { MarkdownFileView } from '../Views/MarkdownFileView';
import { getFileCategory } from '../../utils/fileUtils';
import { FileText } from 'lucide-react';
import './styles.css';

function FileViewer({ filePath }: { filePath: string }) {
  const category = getFileCategory(filePath);

  switch (category) {
    case 'markdown':
      return <MarkdownFileView filePath={filePath} />;
    case 'code':
      return <CodeFileView filePath={filePath} />;
    case 'image':
      return (
        <div className="preview-panel-placeholder">
          <FileText size={32} />
          <p>Image preview coming soon</p>
        </div>
      );
    default:
      return (
        <div className="preview-panel-placeholder">
          <FileText size={32} />
          <p>Preview not available for this file type</p>
        </div>
      );
  }
}

export function PreviewPanel() {
  const tabs = usePreviewTabStore((state) => state.tabs);
  const activeTabId = usePreviewTabStore((state) => state.activeTabId);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  // Don't render anything if no tabs
  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className="preview-panel">
      <PreviewTabBar />
      <div className="preview-panel-content">
        {activeTab ? (
          <FileViewer filePath={activeTab.filePath} />
        ) : (
          <div className="preview-panel-placeholder">
            <p>Select a tab to view</p>
          </div>
        )}
      </div>
    </div>
  );
}
```

#### 3. Create PreviewPanel Styles
**File**: `src/renderer/components/PreviewPanel/styles.css` (new)

```css
.preview-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-bg-primary);
}

.preview-tab-bar {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 0 var(--space-2);
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
  overflow-x: auto;
  min-height: 36px;
}

.preview-tab-bar::-webkit-scrollbar {
  height: 4px;
}

.preview-tab-bar::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: 2px;
}

.preview-tab {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
  white-space: nowrap;
}

.preview-tab:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.preview-tab.active {
  color: var(--color-text-primary);
  border-bottom-color: var(--color-accent);
  background: var(--color-bg-primary);
}

.preview-tab-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.preview-tab-icon svg {
  width: 14px;
  height: 14px;
}

.preview-tab-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.preview-tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  margin-left: var(--space-1);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
  opacity: 0;
  transition: all var(--transition-fast);
}

.preview-tab:hover .preview-tab-close,
.preview-tab.active .preview-tab-close {
  opacity: 1;
}

.preview-tab-close:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.preview-panel-content {
  flex: 1;
  overflow: hidden;
}

.preview-panel-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-text-tertiary);
  text-align: center;
  padding: var(--space-4);
}
```

#### 4. Create index export
**File**: `src/renderer/components/PreviewPanel/index.ts` (new)

```typescript
export { PreviewPanel } from './PreviewPanel';
export { PreviewTabBar } from './PreviewTabBar';
```

#### 5. Update ContentView to use PreviewPanel
**File**: `src/renderer/components/Views/ContentView.tsx`

**Changes**:
- Replace `ContextPlaceholder` with `PreviewPanel`
- Use `usePreviewTabStore` for file selection and tab visibility
- Remove `selectedFilePath` state (now managed by store)

Key changes:
1. Import `usePreviewTabStore` instead of local state
2. Import `PreviewPanel` instead of `ContextPlaceholder`
3. Use `openFile` from store for `onSelectFile` callback
4. Use `tabs.length > 0` to conditionally render Preview Panel
5. Use `activeTabId` for FileExplorer's `selectedPath`

```typescript
// Replace these imports:
// - Remove: import { ContextPlaceholder } from './ContextPlaceholder';
// + Add: import { PreviewPanel } from '../PreviewPanel';
// + Add: import { usePreviewTabStore } from '../../stores/previewTabStore';

// Replace state:
// - Remove: const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
// + Add: const openFile = usePreviewTabStore((state) => state.openFile);
// + Add: const hasOpenTabs = usePreviewTabStore((state) => state.tabs.length > 0);
// + Add: const activeTabId = usePreviewTabStore((state) => state.activeTabId);

// Update handleSelectFile:
const handleSelectFile = (path: string) => {
  openFile(path);
};

// Update FileExplorer selectedPath prop:
<FileExplorer
  rootPath={cwd}
  selectedPath={activeTabId}  // Changed from selectedFilePath
  onSelectFile={handleSelectFile}
/>

// Replace ContextPlaceholder panel with conditional PreviewPanel:
{hasOpenTabs && (
  <>
    <Separator className="resize-handle" />
    <Panel id="preview" defaultSize="40%" minSize="20%">
      <PreviewPanel />
    </Panel>
  </>
)}
```

#### 6. Delete ContextPlaceholder (optional cleanup)
**File**: `src/renderer/components/Views/ContextPlaceholder.tsx`
**Action**: This file can be deleted after ContentView is updated, or kept for reference

#### 7. Update Views index export
**File**: `src/renderer/components/Views/index.ts`
**Changes**: Remove ContextPlaceholder export if deleted

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] Type check passes: `npm run typecheck`
- [ ] App starts: `npm run dev`

#### Manual Verification:
- [ ] Tab bar shows all open files
- [ ] Clicking tab switches to that file
- [ ] Close button removes tab
- [ ] Active tab is visually highlighted
- [ ] Panel content updates when switching tabs
- [ ] Preview Panel hidden when no files open
- [ ] Preview Panel appears when clicking file in explorer
- [ ] Preview Panel hides when closing last tab
- [ ] Agent Panel expands to fill space when Preview Panel is hidden
- [ ] All panels are resizable

---

## Testing Strategy

### Manual Testing Steps:

1. **Preview Panel Auto-Show/Hide**
   - Start with no files open
   - Verify layout is `[Explorer | Agent]` (no Preview Panel)
   - Click a file in explorer
   - Verify Preview Panel appears with the file
   - Layout becomes `[Explorer | Agent | Preview]`

2. **Preview Panel Tabs**
   - Click multiple files in explorer
   - Verify each opens as a new tab
   - Click tabs to switch between files
   - Verify file content updates
   - Click same file again - verify it focuses existing tab (no duplicate)

3. **Tab Close Behavior**
   - Open 3 files
   - Close middle tab
   - Verify adjacent tab becomes active
   - Close all tabs
   - Verify Preview Panel disappears
   - Agent Panel expands to fill space

4. **Panel Resizing**
   - Resize explorer panel
   - Resize agent panel
   - Resize preview panel
   - Verify all panels resize correctly

5. **File Type Support**
   - Open a `.ts` or `.tsx` file - verify code highlighting
   - Open a `.md` file - verify markdown rendering
   - Open an unknown file type - verify placeholder message

---

## References

- Existing tab store pattern: `src/renderer/stores/tabStore.ts`
- File routing logic: `src/renderer/components/Views/ContextPlaceholder.tsx:14-31`
- File utilities: `src/renderer/utils/fileUtils.ts`
- ContentView layout: `src/renderer/components/Views/ContentView.tsx`
- FileExplorer components: `src/renderer/components/FileExplorer/`
