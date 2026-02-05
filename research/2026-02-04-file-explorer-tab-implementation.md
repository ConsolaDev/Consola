---
date: 2026-02-04T12:00:00+01:00
git_commit: 897a074f9003881b4ad5a469e6cc58b394bfc984
branch: feature/agent-output-rendering
repository: console-1
topic: "Adding a File Explorer Tab with Code Editor Pane"
tags: [research, codebase, file-explorer, tabs, editor, code-highlighting]
status: complete
---

# Research: Adding a File Explorer Tab with Code Editor Pane

**Date**: 2026-02-04
**Git Commit**: 897a074f9003881b4ad5a469e6cc58b394bfc984
**Branch**: feature/agent-output-rendering
**Repository**: console-1

## Research Question

How to add a file explorer on the left side inside the main content as a tab (together with the agent panel and context panel), that loads files from the project path, opens files in closeable editor panes with syntax highlighting and editing support, and adds an "open editor" button to the TruncatedPath component (with a name update).

## Summary

The codebase uses a well-structured tab system at the **application level** (in the TabBar) for workspaces/projects, but the **internal content panels** (AgentPanel and ContextPlaceholder) do not have their own tab system yet. The implementation would require:

1. **Adding internal tabs** within ContentView to switch between Agent Panel, Context Panel, and a new File Explorer
2. **Creating a File Explorer component** that reads directory structure via IPC
3. **Creating a closeable Editor Pane system** with multiple open files
4. **Using react-syntax-highlighter** (already in project) for code display, or adding Monaco/CodeMirror for full editing
5. **Renaming TruncatedPath** to `PathDisplay` and adding an "Open in Editor" button

## Detailed Findings

### 1. Current Tab System Architecture

**Location**: `/src/renderer/stores/tabStore.ts` (lines 1-193)

The current tab system manages **application-level tabs** (Home, Workspace, Project):

```typescript
export type TabType = 'home' | 'workspace' | 'project';

export interface Tab {
  id: string;
  type: TabType;
  targetId: string;
  workspaceId?: string;
}
```

**Key Components**:
- `TabBar` (`/src/renderer/components/TabBar/index.tsx`) - renders tabs with drag-drop reordering via @dnd-kit
- `TabItem` (`/src/renderer/components/TabBar/TabItem.tsx`) - individual tab with close button
- `TabContent` (`/src/renderer/components/Layout/TabContent.tsx`) - routes to correct view based on tab type

**Note**: This tab system is for the top-level navigation. The requested file explorer tabs would be **internal tabs within ContentView**, requiring a new implementation.

### 2. ContentView Split Panel Structure

**Location**: `/src/renderer/components/Views/ContentView.tsx` (lines 68-81)

ContentView already uses `react-resizable-panels` for a horizontal split:

```typescript
<Group orientation="horizontal" onLayoutChanged={handleLayoutChange}>
  <Panel id="agent" defaultSize="60%" minSize="20%">
    <AgentPanel instanceId={instanceId} cwd={cwd} />
  </Panel>
  <Separator className="resize-handle" />
  <Panel id="context" minSize="20%">
    <ContextPlaceholder />
  </Panel>
</Group>
```

**Implementation Approach**: Add a tab bar above this layout to switch the left panel content between:
- Agent Panel (current)
- File Explorer (new)

### 3. Project Path Access

**Storage**: `/src/renderer/stores/workspaceStore.ts` (lines 4-11)

```typescript
export interface Project {
  id: string;
  name: string;
  path: string;           // Absolute folder path
  isGitRepo: boolean;
  createdAt: number;
  lastOpenedAt: number;
}
```

**Access Pattern**: ContentView receives `projectId`, looks up project via `getWorkspace()`, extracts `project.path`:

```typescript
const project = projectId
  ? workspace.projects.find((p) => p.id === projectId)
  : undefined;
const cwd = project?.path || '';
```

### 4. File System Access

**File Bridge**: `/src/renderer/services/fileBridge.ts` (lines 15-29)

```typescript
export const fileBridge = {
  isAvailable: (): boolean => getAPI() !== null,
  readFile: async (filePath: string): Promise<string> => {
    return api.readFile(filePath);
  },
};
```

**IPC Handler**: `/src/main/ipc-handlers.ts` (lines 225-233)

```typescript
ipcMain.handle(IPC_CHANNELS.FILE_READ, async (_event, filePath: string) => {
  const content = await fs.promises.readFile(filePath, 'utf-8');
  return content;
});
```

**New IPC Needed**: A `FILE_LIST_DIRECTORY` channel to read directory contents:
```typescript
// Would need to add to ipc-handlers.ts
ipcMain.handle('file:list-directory', async (_event, dirPath: string) => {
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  return entries.map(e => ({
    name: e.name,
    isDirectory: e.isDirectory(),
    path: path.join(dirPath, e.name)
  }));
});
```

### 5. Code Highlighting (Existing)

**Library**: `react-syntax-highlighter` v16.1.0 with Prism backend

**Component**: `/src/renderer/components/Markdown/CodeBlock.tsx` (lines 55-67)

```typescript
<SyntaxHighlighter
  style={oneDark}
  language={language}
  PreTag="div"
  showLineNumbers
  customStyle={{ margin: 0, borderRadius: 0, fontSize: '13px' }}
>
  {code}
</SyntaxHighlighter>
```

**For Editing**: The project does not currently have an editor component. Options:
1. **Monaco Editor** (`@monaco-editor/react`) - Full VSCode-like editor, heavyweight
2. **CodeMirror 6** (`@codemirror/view`) - Lighter, modern, extensible
3. **Simple textarea** with syntax-highlighted preview - Minimal approach

### 6. TruncatedPath Component

**Location**: `/src/renderer/components/Views/TruncatedPath.tsx` (lines 36-52)

```typescript
export function TruncatedPath({ path, className }: TruncatedPathProps) {
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span className={className}>{truncatePath(path)}</span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="tooltip-content" sideOffset={5}>
            {path}
            <Tooltip.Arrow className="tooltip-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
```

**Usage**: Only in `/src/renderer/components/Views/ContentView.tsx` (lines 63-65)

**Rename**: `TruncatedPath` → `PathDisplay`

**Add Button**: Include an optional "Open in Editor" icon button that triggers opening the file in the new editor pane.

### 7. Closeable Pane Pattern

**Existing Patterns** in codebase:

1. **Tab Close Button** (`/src/renderer/components/TabBar/TabItem.tsx`, lines 79-87):
   ```typescript
   {tab.type !== 'home' && (
     <button className="tab-item-close" onClick={handleClose}>
       <X size={14} />
     </button>
   )}
   ```

2. **Modal Close** (`/src/renderer/components/Dialogs/SettingsModal.tsx`, lines 65-69):
   ```typescript
   <Dialog.Close asChild>
     <button className="dialog-close">
       <X size={18} />
     </button>
   </Dialog.Close>
   ```

**For Editor Panes**: Create a tab bar within the editor area showing open files, each with a close button.

## Architecture Recommendation

### New Components Structure

```
src/renderer/components/
├── FileExplorer/
│   ├── index.tsx           # Main file explorer component
│   ├── FileTree.tsx        # Recursive directory tree
│   ├── FileTreeItem.tsx    # Individual file/folder item
│   └── styles.css
├── Editor/
│   ├── index.tsx           # Editor container with tabs
│   ├── EditorTabs.tsx      # Tab bar for open files
│   ├── EditorPane.tsx      # Single file editor
│   ├── CodeEditor.tsx      # Syntax-highlighted editor (Monaco/CodeMirror)
│   └── styles.css
└── Views/
    ├── PathDisplay.tsx     # Renamed from TruncatedPath, with open button
    └── ContentView.tsx     # Updated with internal tab switching
```

### New Store

```typescript
// src/renderer/stores/editorStore.ts
interface EditorFile {
  id: string;
  path: string;
  name: string;
  content: string;
  isDirty: boolean;
}

interface EditorState {
  openFiles: EditorFile[];
  activeFileId: string | null;
  openFile: (path: string) => Promise<void>;
  closeFile: (id: string) => void;
  setActiveFile: (id: string) => void;
  updateContent: (id: string, content: string) => void;
  saveFile: (id: string) => Promise<void>;
}
```

### Internal Tabs for ContentView

```typescript
// New internal tab type for ContentView left panel
type ContentPanelTab = 'agent' | 'explorer';

// In ContentView
const [activePanel, setActivePanel] = useState<ContentPanelTab>('agent');

// Tab bar above the split panel
<div className="content-panel-tabs">
  <button onClick={() => setActivePanel('agent')} className={activePanel === 'agent' ? 'active' : ''}>
    Agent
  </button>
  <button onClick={() => setActivePanel('explorer')} className={activePanel === 'explorer' ? 'active' : ''}>
    Files
  </button>
</div>

// Conditional rendering
{activePanel === 'agent' ? (
  <AgentPanel instanceId={instanceId} cwd={cwd} />
) : (
  <FileExplorer rootPath={cwd} />
)}
```

### PathDisplay Update (formerly TruncatedPath)

```typescript
interface PathDisplayProps {
  path: string;
  className?: string;
  showOpenButton?: boolean;
  onOpenInEditor?: (path: string) => void;
}

export function PathDisplay({ path, className, showOpenButton, onOpenInEditor }: PathDisplayProps) {
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span className={className}>
            {truncatePath(path)}
            {showOpenButton && (
              <button
                className="path-open-button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenInEditor?.(path);
                }}
              >
                <ExternalLink size={12} />
              </button>
            )}
          </span>
        </Tooltip.Trigger>
        {/* ... tooltip content ... */}
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
```

## Code References

| File | Lines | Description |
|------|-------|-------------|
| `/src/renderer/stores/tabStore.ts` | 1-193 | Application-level tab state management |
| `/src/renderer/stores/workspaceStore.ts` | 4-11 | Project interface with path field |
| `/src/renderer/components/Views/ContentView.tsx` | 68-81 | Split panel with react-resizable-panels |
| `/src/renderer/components/Views/TruncatedPath.tsx` | 36-52 | Path display component to rename |
| `/src/renderer/components/Markdown/CodeBlock.tsx` | 55-67 | Syntax highlighting implementation |
| `/src/renderer/services/fileBridge.ts` | 15-29 | File reading service |
| `/src/main/ipc-handlers.ts` | 225-233 | Main process file read handler |
| `/src/renderer/components/TabBar/TabItem.tsx` | 79-87 | Close button pattern |

## IPC Channels to Add

```typescript
// In /src/shared/constants.ts
export const IPC_CHANNELS = {
  // ... existing channels ...
  FILE_LIST_DIRECTORY: 'file:list-directory',
  FILE_WRITE: 'file:write',
  FILE_EXISTS: 'file:exists',
} as const;
```

## Dependencies to Consider

For full editor support:
- **Monaco Editor**: `npm install @monaco-editor/react` - Best for full IDE experience
- **CodeMirror 6**: `npm install @codemirror/view @codemirror/state @codemirror/language` - Lighter alternative

## Open Questions

1. **Editor choice**: Monaco (heavyweight, feature-rich) vs CodeMirror (lighter) vs custom (minimal)?
2. **File saving**: Auto-save, manual save, or both?
3. **Dirty indicator**: How to show unsaved changes in tabs?
4. **Large files**: Should there be a file size limit for the editor?
5. **Binary files**: How to handle non-text files?
6. **File watching**: Should the editor reload when files change externally?
