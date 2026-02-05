# Implementation Plan: File Explorer Pane with Code Viewer

**Date**: 2026-02-04
**Status**: Ready for Implementation

## Overview

Add a toggleable file explorer pane on the left side of ContentView that displays the project directory structure. Users can show/hide the explorer via a button in the header. Clicking files opens them in the context panel with syntax highlighting. Rename `TruncatedPath` to `PathDisplay` with the toggle button integrated.

## Current State Analysis

### Key Discoveries:
- `@radix-ui/react-collapsible` already installed and used in `WorkspaceNavItem.tsx:1,39-78`
- `react-resizable-panels` used for Agent/Context split in `ContentView.tsx:68-80`
- `CodeBlock` component with `react-syntax-highlighter` + oneDark theme at `Markdown/CodeBlock.tsx`
- File reading via IPC exists: `FILE_READ` channel in `constants.ts:44`, handler in `ipc-handlers.ts:225-233`
- `TruncatedPath` component at `Views/TruncatedPath.tsx:36-52`
- No directory listing IPC channel exists yet

### Design Decisions:
- **File Tree**: Custom implementation using Radix Collapsible (already in project, zero new deps)
- **File Icons**: `material-file-icons` npm package (~475KB, 377 VSCode-style icons)
- **Code Viewer**: Reuse existing `CodeBlock` component (read-only)
- **Explorer Toggle**: Button in header to show/hide file explorer as leftmost pane

## Desired End State

1. Header has a toggle button (next to PathDisplay) to show/hide file explorer
2. When visible, file explorer appears as leftmost pane: `[FileExplorer | Agent | Context]`
3. File explorer shows collapsible tree of the project directory
4. File icons match VSCode Material Icon Theme
5. Clicking a file opens it in the Context panel (right side)
6. `PathDisplay` component (renamed from `TruncatedPath`) integrates the toggle button

## What We're NOT Doing

- File editing (read-only viewer only)
- File operations (create, delete, rename)
- Drag and drop
- File watching / auto-reload
- Search within file tree
- Git status indicators

## Implementation Approach

Use Radix Collapsible for the tree (already in project), `material-file-icons` for VSCode-style icons, and the existing `CodeBlock` for syntax highlighting. The file explorer is a toggleable leftmost pane controlled by a button in the header. State management is kept simple with React state in ContentView.

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

## Phase 4: Toggleable File Explorer Pane

### Overview
Add a toggle button in the header to show/hide the file explorer as a new leftmost pane in ContentView.

### Changes Required:

#### 1. Update ContentView with Three-Panel Layout
**File**: `src/renderer/components/Views/ContentView.tsx`
**Changes**: Add file explorer state and conditional third panel

```typescript
import { useState } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { AgentPanel } from '../Agent/AgentPanel';
import { ContextPlaceholder } from './ContextPlaceholder';
import { PathDisplay } from './PathDisplay';
import { FileExplorer } from '../FileExplorer';
import './styles.css';

interface ContentViewProps {
  workspaceId: string;
  projectId?: string;
}

export function ContentView({ workspaceId, projectId }: ContentViewProps) {
  const [isExplorerVisible, setIsExplorerVisible] = useState(false);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

  const getWorkspace = useWorkspaceStore((state) => state.getWorkspace);
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
    setSelectedFilePath(path);
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
                  selectedPath={selectedFilePath}
                  onSelectFile={handleSelectFile}
                />
              </Panel>
              <Separator className="resize-handle" />
            </>
          )}
          <Panel id="agent" defaultSize={isExplorerVisible ? "45%" : "60%"} minSize="20%">
            <AgentPanel instanceId={instanceId} cwd={cwd} />
          </Panel>
          <Separator className="resize-handle" />
          <Panel id="context" minSize="20%">
            <ContextPlaceholder
              contextId={contextId}
              selectedFile={selectedFilePath}
            />
          </Panel>
        </Group>
      </div>
    </div>
  );
}
```

#### 2. No Additional Styles Needed
The existing resize-handle and panel styles already support multiple panels.

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`

#### Manual Verification:
- [ ] Toggle button in header shows/hides file explorer pane
- [ ] File explorer appears on the left when visible
- [ ] Panels are resizable
- [ ] File selection in explorer updates context panel
- [ ] Explorer toggle is only shown when a project is selected

---

## Phase 5: Code Viewer in Context Panel

### Overview
Display selected files with syntax highlighting in the context panel.

### Changes Required:

#### 1. Create File Utilities
**File**: `src/renderer/utils/fileUtils.ts` (new)

```typescript
/**
 * File type categories for viewer selection
 */
export type FileCategory = 'markdown' | 'code' | 'image' | 'unknown';

/**
 * Map file extensions to Prism language identifiers for syntax highlighting
 */
const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  // JavaScript/TypeScript
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',

  // Web
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',

  // Data formats
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  svg: 'xml',

  // Scripting
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  py: 'python',
  rb: 'ruby',

  // Systems
  rs: 'rust',
  go: 'go',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',

  // Other
  md: 'markdown',
  markdown: 'markdown',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  dockerfile: 'docker',
  makefile: 'makefile',
};

/**
 * Extensions that should be rendered as markdown
 */
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);

/**
 * Extensions that should be rendered as images
 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']);

/**
 * Get the file extension from a path (lowercase)
 */
export function getFileExtension(filePath: string): string {
  return filePath.split('.').pop()?.toLowerCase() || '';
}

/**
 * Determine the category of a file for viewer selection
 */
export function getFileCategory(filePath: string): FileCategory {
  const ext = getFileExtension(filePath);

  if (MARKDOWN_EXTENSIONS.has(ext)) {
    return 'markdown';
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    return 'image';
  }

  if (EXTENSION_TO_LANGUAGE[ext]) {
    return 'code';
  }

  return 'unknown';
}

/**
 * Check if a file can be previewed
 */
export function isPreviewable(filePath: string): boolean {
  return getFileCategory(filePath) !== 'unknown';
}

/**
 * Get the Prism language identifier for syntax highlighting
 */
export function getLanguageFromPath(filePath: string): string {
  const ext = getFileExtension(filePath);
  return EXTENSION_TO_LANGUAGE[ext] || 'text';
}

/**
 * Get a human-readable language name for display
 */
export function getLanguageDisplayName(filePath: string): string {
  const language = getLanguageFromPath(filePath);
  return language.charAt(0).toUpperCase() + language.slice(1);
}
```

#### 2. Create CodeFileView Component
**File**: `src/renderer/components/Views/CodeFileView.tsx` (new)

```typescript
import { useState, useEffect, useMemo } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Flex, Text, Button } from '@radix-ui/themes';
import { Copy, Check, Loader2 } from 'lucide-react';
import { fileBridge } from '../../services/fileBridge';
import { FileIcon } from '../FileExplorer/FileIcon';
import { getLanguageFromPath } from '../../utils/fileUtils';

interface CodeFileViewProps {
  filePath: string;
}

export function CodeFileView({ filePath }: CodeFileViewProps) {
  const [content, setContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const filename = useMemo(() => filePath.split('/').pop() || '', [filePath]);
  const language = useMemo(() => getLanguageFromPath(filePath), [filePath]);

  useEffect(() => {
    setIsLoading(true);
    setError(null);

    fileBridge.readFile(filePath)
      .then(setContent)
      .catch(err => setError(err.message))
      .finally(() => setIsLoading(false));
  }, [filePath]);

  const handleCopy = async () => {
    if (content) {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (isLoading) {
    return (
      <div className="code-file-view loading">
        <Loader2 size={24} className="spinner" />
        <p>Loading file...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="code-file-view error">
        <p>Error loading file</p>
        <p className="code-file-error-detail">{error}</p>
      </div>
    );
  }

  return (
    <div className="code-file-view">
      <Flex className="code-file-header" justify="between" align="center">
        <Flex align="center" gap="2">
          <FileIcon filename={filename} className="code-file-icon" />
          <Text size="2" weight="medium">{filename}</Text>
          <Text size="1" color="gray">{language}</Text>
        </Flex>
        <Button size="1" variant="ghost" onClick={handleCopy}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
          <Text size="1">{copied ? 'Copied!' : 'Copy'}</Text>
        </Button>
      </Flex>
      <div className="code-file-content">
        <SyntaxHighlighter
          style={oneDark}
          language={language}
          showLineNumbers
          customStyle={{
            margin: 0,
            borderRadius: 0,
            fontSize: '13px',
            height: '100%',
          }}
        >
          {content || ''}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}
```

#### 2. Add CodeFileView Styles
**File**: `src/renderer/components/Views/styles.css`
**Changes**: Add styles for code file view

```css
/* Code File View */
.code-file-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-bg-primary);
}

.code-file-view.loading,
.code-file-view.error {
  align-items: center;
  justify-content: center;
  color: var(--color-text-tertiary);
}

.code-file-error-detail {
  font-size: var(--font-size-xs);
  margin-top: var(--space-2);
}

.code-file-header {
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
}

.code-file-icon {
  width: 16px;
  height: 16px;
}

.code-file-icon svg {
  width: 16px;
  height: 16px;
}

.code-file-content {
  flex: 1;
  overflow: auto;
}

.code-file-content pre {
  height: 100%;
  margin: 0 !important;
}
```

#### 3. Update ContextPlaceholder
**File**: `src/renderer/components/Views/ContextPlaceholder.tsx`
**Changes**: Use file utilities for viewer selection

```typescript
import { MarkdownFileView } from './MarkdownFileView';
import { CodeFileView } from './CodeFileView';
import { FileText } from 'lucide-react';
import { getFileCategory } from '../../utils/fileUtils';
import './styles.css';

interface ContextPlaceholderProps {
  contextId: string;
  selectedFile?: string | null;
}

function FileViewer({ filePath }: { filePath: string }) {
  const category = getFileCategory(filePath);

  switch (category) {
    case 'markdown':
      return <MarkdownFileView filePath={filePath} />;
    case 'code':
      return <CodeFileView filePath={filePath} />;
    case 'image':
      // Future: Add ImageFileView component
      return (
        <div className="context-placeholder">
          <FileText size={32} />
          <p>Image preview coming soon</p>
          <p className="context-placeholder-hint">{filePath}</p>
        </div>
      );
    default:
      return (
        <div className="context-placeholder">
          <FileText size={32} />
          <p>Preview not available for this file type</p>
          <p className="context-placeholder-hint">{filePath}</p>
        </div>
      );
  }
}

export function ContextPlaceholder({ contextId, selectedFile }: ContextPlaceholderProps) {
  if (selectedFile) {
    return <FileViewer filePath={selectedFile} />;
  }

  return (
    <div className="context-placeholder">
      <FileText size={32} />
      <p>Context panel</p>
      <p className="context-placeholder-hint">Select a file to preview</p>
    </div>
  );
}
```

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`

#### Manual Verification:
- [ ] Clicking a file in explorer shows it in context panel
- [ ] Code files display with syntax highlighting
- [ ] Line numbers are visible
- [ ] Copy button works
- [ ] Large files scroll properly

---

## Phase 6: Rename TruncatedPath to PathDisplay with Explorer Toggle

### Overview
Rename the component and add the file explorer toggle button.

### Changes Required:

#### 1. Rename and Update Component
**File**: `src/renderer/components/Views/PathDisplay.tsx` (renamed from TruncatedPath.tsx)

```typescript
import * as Tooltip from '@radix-ui/react-tooltip';
import { FolderTree } from 'lucide-react';

interface PathDisplayProps {
  path: string;
  className?: string;
  showExplorerToggle?: boolean;
  isExplorerVisible?: boolean;
  onToggleExplorer?: () => void;
}

function truncatePath(fullPath: string): string {
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

3. **File Selection**
   - Click a file in the tree
   - Verify it appears in context panel
   - Verify syntax highlighting is correct

4. **Panel Resizing**
   - Resize explorer panel
   - Resize agent panel
   - Verify all panels resize correctly

5. **PathDisplay**
   - Hover over project path
   - Verify tooltip shows full path
   - Hover over toggle button
   - Verify tooltip shows "Show/Hide file explorer"

## References

- Existing Collapsible usage: `src/renderer/components/Sidebar/WorkspaceNavItem.tsx:1,39-78`
- IPC patterns: `src/main/ipc-handlers.ts:225-233`
- CodeBlock component: `src/renderer/components/Markdown/CodeBlock.tsx`
- TruncatedPath component: `src/renderer/components/Views/TruncatedPath.tsx:36-52`
- ContentView layout: `src/renderer/components/Views/ContentView.tsx:68-80`
