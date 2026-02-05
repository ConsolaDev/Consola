# Implementation Plan: File Explorer Pane with Preview Panel

**Date**: 2026-02-04
**Status**: Ready for Implementation (Updated)

## Overview

Add a toggleable file explorer pane on the left side of ContentView that displays the project directory structure. Users can show/hide the explorer via a button in the header. Clicking files opens them in a **Preview Panel** with a tab system - multiple files can be open simultaneously. The Preview Panel automatically shows/hides based on whether any file tabs are open. Rename `TruncatedPath` to `PathDisplay` with the toggle button integrated.

## Current State Analysis

### Key Discoveries:
- `@radix-ui/react-collapsible` already installed and used in `WorkspaceNavItem.tsx:1,39-78`
- `react-resizable-panels` used for Agent/Context split in `ContentView.tsx:68-80`
- `CodeBlock` component with `react-syntax-highlighter` + oneDark theme at `Markdown/CodeBlock.tsx`
- File reading via IPC exists: `FILE_READ` channel in `constants.ts:44`, handler in `ipc-handlers.ts:225-233`
- `TruncatedPath` component at `Views/TruncatedPath.tsx:36-52`
- Existing tab system in `tabStore.ts` provides a pattern for file tabs
- No directory listing IPC channel exists yet

### Design Decisions:
- **File Tree**: Custom implementation using Radix Collapsible (already in project, zero new deps)
- **File Icons**: `material-file-icons` npm package (~475KB, 377 VSCode-style icons)
- **Code Viewer**: Reuse existing `CodeBlock` component (read-only)
- **Explorer Toggle**: Button in header to show/hide file explorer as leftmost pane
- **Preview Panel**: Tabbed panel that auto-shows when files are open, auto-hides when empty

## Desired End State

1. Header has a toggle button (next to PathDisplay) to show/hide file explorer
2. When visible, file explorer appears as leftmost pane
3. File explorer shows collapsible tree of the project directory
4. File icons match VSCode Material Icon Theme
5. Clicking a file opens it as a tab in the Preview Panel
6. **Preview Panel with tabs**: Multiple files can be open, users can switch between them
7. **Auto-show/hide**: Panel appears when first file is opened, hides when last tab is closed
8. `PathDisplay` component (renamed from `TruncatedPath`) integrates the toggle button

### Layout States:
```
No files open:     [FileExplorer | Agent Panel]
Files open:        [FileExplorer | Agent Panel | Preview Panel]
Explorer hidden:   [Agent Panel] or [Agent Panel | Preview Panel]
```

## What We're NOT Doing

- File editing (read-only viewer only)
- File operations (create, delete, rename)
- Drag and drop
- File watching / auto-reload
- Search within file tree
- Git status indicators

## Implementation Approach

Use Radix Collapsible for the tree (already in project), `material-file-icons` for VSCode-style icons, and the existing `CodeBlock` for syntax highlighting. The file explorer is a toggleable leftmost pane controlled by a button in the header. A new `previewTabStore` (following the pattern of `tabStore.ts`) manages open file tabs. The Preview Panel renders only when there are open tabs.

---

## Phase 1: IPC Infrastructure for Directory Listing

### Overview
Add the ability to list directory contents from the main process.

### Changes Required:

#### 1. Add IPC Channel Constant
**File**: `src/shared/constants.ts`
**Changes**: Add `FILE_LIST_DIRECTORY` channel

```typescript
// After FILE_READ line 44
FILE_LIST_DIRECTORY: 'file:list-directory',
```

#### 2. Add IPC Handler
**File**: `src/main/ipc-handlers.ts`
**Changes**: Add handler for directory listing

```typescript
// After FILE_READ handler (line 233)
ipcMain.handle(IPC_CHANNELS.FILE_LIST_DIRECTORY, async (_event, dirPath: string) => {
    try {
        const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
        return entries
            .sort((a, b) => {
                // Directories first, then alphabetical
                if (a.isDirectory() && !b.isDirectory()) return -1;
                if (!a.isDirectory() && b.isDirectory()) return 1;
                return a.name.localeCompare(b.name);
            })
            .map(entry => ({
                name: entry.name,
                path: path.join(dirPath, entry.name),
                isDirectory: entry.isDirectory()
            }));
    } catch (error) {
        throw new Error(`Failed to list directory: ${error instanceof Error ? error.message : String(error)}`);
    }
});
```

#### 3. Update Cleanup
**File**: `src/main/ipc-handlers.ts`
**Changes**: Add cleanup for new handler in `cleanupIpcHandlers()`

```typescript
ipcMain.removeHandler(IPC_CHANNELS.FILE_LIST_DIRECTORY);
```

#### 4. Expose in Preload
**File**: `src/preload/preload.ts`
**Changes**: Add `listDirectory` to fileAPI

```typescript
// In fileAPI object (after readFile)
listDirectory: (dirPath: string): Promise<Array<{ name: string; path: string; isDirectory: boolean }>> => {
    return ipcRenderer.invoke(IPC_CHANNELS.FILE_LIST_DIRECTORY, dirPath);
},
```

#### 5. Update File Bridge
**File**: `src/renderer/services/fileBridge.ts`
**Changes**: Add `listDirectory` method

```typescript
listDirectory: async (dirPath: string): Promise<Array<{ name: string; path: string; isDirectory: boolean }>> => {
    const api = getAPI();
    if (!api) {
        throw new Error('File API not available');
    }
    return api.listDirectory(dirPath);
},
```

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] App starts without errors: `npm run dev`

#### Manual Verification:
- [ ] Console log `fileBridge.listDirectory('/some/path')` returns array of entries

---

## Phase 2: Install material-file-icons

### Overview
Add the material-file-icons package for VSCode-style file type icons.

### Changes Required:

#### 1. Install Package
**Command**: `npm install material-file-icons`

#### 2. Create FileIcon Component
**File**: `src/renderer/components/FileExplorer/FileIcon.tsx` (new)

```typescript
import { getIcon } from 'material-file-icons';

interface FileIconProps {
  filename: string;
  className?: string;
}

export function FileIcon({ filename, className }: FileIconProps) {
  const icon = getIcon(filename);
  return (
    <span
      className={className}
      dangerouslySetInnerHTML={{ __html: icon.svg }}
    />
  );
}
```

#### 3. Create FolderIcon Component
**File**: `src/renderer/components/FileExplorer/FolderIcon.tsx` (new)

```typescript
import { Folder, FolderOpen } from 'lucide-react';

interface FolderIconProps {
  isOpen: boolean;
  className?: string;
}

export function FolderIcon({ isOpen, className }: FolderIconProps) {
  const Icon = isOpen ? FolderOpen : Folder;
  return <Icon size={16} className={className} />;
}
```

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`

#### Manual Verification:
- [ ] FileIcon renders correct icon for `package.json`, `App.tsx`, `.gitignore`

---

## Phase 3: File Tree Components

### Overview
Build the recursive file tree using Radix Collapsible.

### Changes Required:

#### 1. Create FileTreeItem Component
**File**: `src/renderer/components/FileExplorer/FileTreeItem.tsx` (new)

```typescript
import { useState, useEffect } from 'react';
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronRight } from 'lucide-react';
import { FileIcon } from './FileIcon';
import { FolderIcon } from './FolderIcon';
import { fileBridge } from '../../services/fileBridge';

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface FileTreeItemProps {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
}

export function FileTreeItem({ node, depth, selectedPath, onSelectFile }: FileTreeItemProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [children, setChildren] = useState<TreeNode[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const isSelected = selectedPath === node.path;
  const indent = depth * 12;

  // Load children when folder is opened
  useEffect(() => {
    if (isOpen && node.isDirectory && children.length === 0) {
      setIsLoading(true);
      fileBridge.listDirectory(node.path)
        .then(setChildren)
        .catch(console.error)
        .finally(() => setIsLoading(false));
    }
  }, [isOpen, node.isDirectory, node.path, children.length]);

  if (node.isDirectory) {
    return (
      <Collapsible.Root open={isOpen} onOpenChange={setIsOpen}>
        <Collapsible.Trigger
          className="file-tree-item file-tree-folder"
          style={{ paddingLeft: indent }}
        >
          <ChevronRight
            size={14}
            className={`file-tree-chevron ${isOpen ? 'open' : ''}`}
          />
          <FolderIcon isOpen={isOpen} className="file-tree-icon" />
          <span className="file-tree-name">{node.name}</span>
        </Collapsible.Trigger>
        <Collapsible.Content>
          {isLoading ? (
            <div className="file-tree-loading" style={{ paddingLeft: indent + 24 }}>
              Loading...
            </div>
          ) : (
            children.map(child => (
              <FileTreeItem
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelectFile={onSelectFile}
              />
            ))
          )}
        </Collapsible.Content>
      </Collapsible.Root>
    );
  }

  return (
    <button
      className={`file-tree-item file-tree-file ${isSelected ? 'selected' : ''}`}
      style={{ paddingLeft: indent + 18 }}
      onClick={() => onSelectFile(node.path)}
    >
      <FileIcon filename={node.name} className="file-tree-icon" />
      <span className="file-tree-name">{node.name}</span>
    </button>
  );
}
```

#### 2. Create FileExplorer Component
**File**: `src/renderer/components/FileExplorer/index.tsx` (new)

```typescript
import { useState, useEffect } from 'react';
import { FileTreeItem } from './FileTreeItem';
import { fileBridge } from '../../services/fileBridge';
import './styles.css';

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface FileExplorerProps {
  rootPath: string;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
}

export function FileExplorer({ rootPath, selectedPath, onSelectFile }: FileExplorerProps) {
  const [rootChildren, setRootChildren] = useState<TreeNode[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rootPath) {
      setRootChildren([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    fileBridge.listDirectory(rootPath)
      .then(setRootChildren)
      .catch(err => setError(err.message))
      .finally(() => setIsLoading(false));
  }, [rootPath]);

  if (!rootPath) {
    return (
      <div className="file-explorer-empty">
        <p>No project selected</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="file-explorer-loading">
        <p>Loading files...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="file-explorer-error">
        <p>Error loading files</p>
        <p className="file-explorer-error-detail">{error}</p>
      </div>
    );
  }

  return (
    <div className="file-explorer">
      <div className="file-tree">
        {rootChildren.map(node => (
          <FileTreeItem
            key={node.path}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            onSelectFile={onSelectFile}
          />
        ))}
      </div>
    </div>
  );
}
```

#### 3. Create FileExplorer Styles
**File**: `src/renderer/components/FileExplorer/styles.css` (new)

```css
.file-explorer {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-bg-primary);
}

.file-explorer-empty,
.file-explorer-loading,
.file-explorer-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-text-tertiary);
  text-align: center;
  padding: var(--space-4);
}

.file-explorer-error-detail {
  font-size: var(--font-size-xs);
  margin-top: var(--space-2);
}

.file-tree {
  flex: 1;
  overflow: auto;
  padding: var(--space-2) 0;
}

.file-tree-item {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  width: 100%;
  padding: var(--space-1) var(--space-2);
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.file-tree-item:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.file-tree-item.selected {
  background: var(--color-bg-active);
  color: var(--color-text-primary);
}

.file-tree-folder {
  font-weight: var(--font-weight-medium);
}

.file-tree-chevron {
  flex-shrink: 0;
  color: var(--color-text-tertiary);
  transition: transform var(--transition-fast);
}

.file-tree-chevron.open {
  transform: rotate(90deg);
}

.file-tree-icon {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.file-tree-icon svg {
  width: 16px;
  height: 16px;
}

.file-tree-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-tree-loading {
  color: var(--color-text-tertiary);
  font-size: var(--font-size-xs);
  padding: var(--space-1) var(--space-2);
}
```

#### 4. Create index export
**File**: `src/renderer/components/FileExplorer/index.ts` (new)

```typescript
export { FileExplorer } from './FileExplorer';
export { FileIcon } from './FileIcon';
export { FolderIcon } from './FolderIcon';
```

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`

#### Manual Verification:
- [ ] File tree renders when given a project path
- [ ] Folders expand/collapse on click
- [ ] Files show correct material icons
- [ ] File click triggers `onSelectFile` callback

---

## Phase 4: Preview Tab Store

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

#### Manual Verification:
- [ ] Store correctly manages tab state
- [ ] Opening same file twice focuses existing tab
- [ ] Closing tabs updates active tab correctly

---

## Phase 5: Preview Panel Component with Tabs

### Overview
Create the Preview Panel with a tab bar for switching between open files. This replaces the old ContextPlaceholder.

### Changes Required:

#### 1. Create PreviewTabBar Component
**File**: `src/renderer/components/PreviewPanel/PreviewTabBar.tsx` (new)

```typescript
import { X } from 'lucide-react';
import { usePreviewTabStore, type PreviewTab } from '../../stores/previewTabStore';
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
**File**: `src/renderer/components/PreviewPanel/index.tsx` (new)

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

// Export for checking if panel should be visible
export function useHasOpenTabs(): boolean {
  return usePreviewTabStore((state) => state.tabs.length > 0);
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

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`

#### Manual Verification:
- [ ] Tab bar shows all open files
- [ ] Clicking tab switches to that file
- [ ] Close button removes tab
- [ ] Active tab is visually highlighted
- [ ] Panel content updates when switching tabs

---

## Phase 6: Integrate Preview Panel into ContentView

### Overview
Update ContentView to use the PreviewPanel with dynamic show/hide behavior.

### Changes Required:

#### 1. Update ContentView with Dynamic Preview Panel
**File**: `src/renderer/components/Views/ContentView.tsx`
**Changes**: Replace ContextPlaceholder with PreviewPanel, add dynamic visibility

```typescript
import { useState } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { usePreviewTabStore } from '../../stores/previewTabStore';
import { AgentPanel } from '../Agent/AgentPanel';
import { PreviewPanel } from '../PreviewPanel';
import { PathDisplay } from './PathDisplay';
import { FileExplorer } from '../FileExplorer';
import './styles.css';

interface ContentViewProps {
  workspaceId: string;
  projectId?: string;
}

export function ContentView({ workspaceId, projectId }: ContentViewProps) {
  const [isExplorerVisible, setIsExplorerVisible] = useState(false);

  const getWorkspace = useWorkspaceStore((state) => state.getWorkspace);
  const openFile = usePreviewTabStore((state) => state.openFile);
  const hasOpenTabs = usePreviewTabStore((state) => state.tabs.length > 0);
  const activeTabId = usePreviewTabStore((state) => state.activeTabId);

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: 'content-view-split',
    storage: localStorage,
  });

  const workspace = getWorkspace(workspaceId);

  if (!workspace) {
    return (
      <div className="workspace-view">
        <div className="workspace-view-content">
          <div className="workspace-placeholder">
            <p>Workspace not found</p>
          </div>
        </div>
      </div>
    );
  }

  const project = projectId
    ? workspace.projects.find((p) => p.id === projectId)
    : undefined;

  const contextId = projectId
    ? `project-${projectId}`
    : `workspace-${workspaceId}`;
  const instanceId = `${contextId}-main`;
  const cwd = project?.path || '';

  const handleSelectFile = (path: string) => {
    openFile(path);
  };

  const handleToggleExplorer = () => {
    setIsExplorerVisible(!isExplorerVisible);
  };

  return (
    <div className="workspace-view">
      <div className="workspace-view-header">
        <h1 className="workspace-view-title">
          {project ? (
            <>
              <span className="workspace-view-breadcrumb">{workspace.name}</span>
              <span className="workspace-view-separator">/</span>
              <span>{project.name}</span>
            </>
          ) : (
            workspace.name
          )}
        </h1>
        {project?.path && (
          <PathDisplay
            path={project.path}
            className="workspace-view-path"
            showExplorerToggle
            isExplorerVisible={isExplorerVisible}
            onToggleExplorer={handleToggleExplorer}
          />
        )}
      </div>
      <div className="workspace-view-content">
        <Group
          orientation="horizontal"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
        >
          {isExplorerVisible && cwd && (
            <>
              <Panel id="explorer" defaultSize="20%" minSize="15%" maxSize="40%">
                <FileExplorer
                  rootPath={cwd}
                  selectedPath={activeTabId}
                  onSelectFile={handleSelectFile}
                />
              </Panel>
              <Separator className="resize-handle" />
            </>
          )}
          <Panel id="agent" minSize="30%">
            <AgentPanel instanceId={instanceId} cwd={cwd} />
          </Panel>
          {hasOpenTabs && (
            <>
              <Separator className="resize-handle" />
              <Panel id="preview" defaultSize="40%" minSize="20%">
                <PreviewPanel />
              </Panel>
            </>
          )}
        </Group>
      </div>
    </div>
  );
}
```

#### 2. Delete ContextPlaceholder
**File**: `src/renderer/components/Views/ContextPlaceholder.tsx`
**Action**: Delete this file (no longer needed)

#### 3. Update Views index export
**File**: `src/renderer/components/Views/index.ts`
**Changes**: Remove ContextPlaceholder export, keep others

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`

#### Manual Verification:
- [ ] Preview Panel hidden when no files open
- [ ] Preview Panel appears when clicking file in explorer
- [ ] Preview Panel hides when closing last tab
- [ ] Agent Panel expands to fill space when Preview Panel is hidden
- [ ] All panels are resizable

---

## Phase 7: Rename TruncatedPath to PathDisplay with Explorer Toggle

### Overview
Rename the component and add the file explorer toggle button. Move the `truncatePath` utility function to `fileUtils.ts`.

### Changes Required:

#### 1. Add truncatePath to File Utilities
**File**: `src/renderer/utils/fileUtils.ts`
**Changes**: Add the `truncatePath` function

```typescript
// Add to existing fileUtils.ts

/**
 * Truncate a file path for display, replacing home directory with ~ and
 * abbreviating long paths with ellipsis
 */
export function truncatePath(fullPath: string): string {
  const homeDir = '/Users/';
  let path = fullPath;

  if (path.startsWith(homeDir)) {
    const afterHome = path.slice(homeDir.length);
    const firstSlash = afterHome.indexOf('/');
    if (firstSlash !== -1) {
      path = '~' + afterHome.slice(firstSlash);
    }
  }

  const segments = path.split('/').filter(Boolean);

  if (segments.length <= 3) {
    return path.startsWith('/') ? '/' + segments.join('/') : segments.join('/');
  }

  const firstPart = path.startsWith('~') ? '~' : '';
  const lastSegments = segments.slice(-2).join('/');

  return `${firstPart}/.../${lastSegments}`;
}
```

#### 2. Rename and Update Component
**File**: `src/renderer/components/Views/PathDisplay.tsx` (renamed from TruncatedPath.tsx)

```typescript
import * as Tooltip from '@radix-ui/react-tooltip';
import { FolderTree } from 'lucide-react';
import { truncatePath } from '../../utils/fileUtils';

interface PathDisplayProps {
  path: string;
  className?: string;
  showExplorerToggle?: boolean;
  isExplorerVisible?: boolean;
  onToggleExplorer?: () => void;
}

export function PathDisplay({
  path,
  className,
  showExplorerToggle = false,
  isExplorerVisible = false,
  onToggleExplorer
}: PathDisplayProps) {
  return (
    <div className="path-display-container">
      <Tooltip.Provider delayDuration={300}>
        <Tooltip.Root>
          <Tooltip.Trigger asChild>
            <span className={`path-display-text ${className || ''}`}>
              {truncatePath(path)}
            </span>
          </Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content className="tooltip-content" sideOffset={5}>
              {path}
              <Tooltip.Arrow className="tooltip-arrow" />
            </Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
      {showExplorerToggle && onToggleExplorer && (
        <Tooltip.Provider delayDuration={300}>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <button
                className={`path-display-toggle ${isExplorerVisible ? 'active' : ''}`}
                onClick={onToggleExplorer}
                aria-label={isExplorerVisible ? 'Hide file explorer' : 'Show file explorer'}
                aria-pressed={isExplorerVisible}
              >
                <FolderTree size={14} />
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content className="tooltip-content" sideOffset={5}>
                {isExplorerVisible ? 'Hide file explorer' : 'Show file explorer'}
                <Tooltip.Arrow className="tooltip-arrow" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        </Tooltip.Provider>
      )}
    </div>
  );
}

// Keep old export for backwards compatibility during migration
export { PathDisplay as TruncatedPath };
```

#### 2. Add PathDisplay Styles
**File**: `src/renderer/components/Views/styles.css`
**Changes**: Add styles for path display with toggle button

```css
/* Path Display */
.path-display-container {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.path-display-text {
  /* Inherits styling from className prop */
}

.path-display-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-tertiary);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.path-display-toggle:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.path-display-toggle.active {
  background: var(--color-bg-active);
  color: var(--color-accent);
}
```

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`

#### Manual Verification:
- [ ] PathDisplay shows truncated path with tooltip
- [ ] Toggle button appears next to path
- [ ] Clicking toggle button shows/hides file explorer pane
- [ ] Toggle button shows active state when explorer is visible

---

## Testing Strategy

### Manual Testing Steps:

1. **File Explorer Toggle**
   - Click toggle button in header
   - Verify file explorer pane appears on left
   - Click toggle again
   - Verify explorer hides

2. **File Explorer Basic**
   - Open a project with files
   - Toggle explorer visible
   - Verify file tree loads
   - Expand/collapse folders
   - Verify correct file icons

3. **Preview Panel Auto-Show/Hide**
   - Start with no files open
   - Verify layout is `[Explorer | Agent]` (no Preview Panel)
   - Click a file in explorer
   - Verify Preview Panel appears with the file
   - Layout becomes `[Explorer | Agent | Preview]`

4. **Preview Panel Tabs**
   - Click multiple files in explorer
   - Verify each opens as a new tab
   - Click tabs to switch between files
   - Verify file content updates

5. **Tab Close Behavior**
   - Open 3 files
   - Close middle tab
   - Verify adjacent tab becomes active
   - Close all tabs
   - Verify Preview Panel disappears
   - Agent Panel expands to fill space

6. **Panel Resizing**
   - Resize explorer panel
   - Resize agent panel
   - Resize preview panel
   - Verify all panels resize correctly

7. **PathDisplay**
   - Hover over project path
   - Verify tooltip shows full path
   - Hover over toggle button
   - Verify tooltip shows "Show/Hide file explorer"

## References

- Existing Collapsible usage: `src/renderer/components/Sidebar/WorkspaceNavItem.tsx:1,39-78`
- Existing tab store pattern: `src/renderer/stores/tabStore.ts`
- IPC patterns: `src/main/ipc-handlers.ts:225-233`
- CodeBlock component: `src/renderer/components/Markdown/CodeBlock.tsx`
- TruncatedPath component: `src/renderer/components/Views/TruncatedPath.tsx:36-52`
- ContentView layout: `src/renderer/components/Views/ContentView.tsx:68-80`
