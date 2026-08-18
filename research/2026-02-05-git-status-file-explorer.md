---
date: 2026-02-05T12:00:00+01:00
git_commit: d1e43a53f58f1d1716b3732d6edbd77c4118b395
branch: main
repository: console-1
topic: "Git Status Integration in File Explorer and PathDisplay"
tags: [research, codebase, file-explorer, git-status, theming]
status: complete
---

# Research: Git Status Integration in File Explorer and PathDisplay

**Date**: 2026-02-05
**Git Commit**: d1e43a53f58f1d1716b3732d6edbd77c4118b395
**Branch**: main
**Repository**: console-1

## Research Question

How to add a git status feature to the file explorer that:
1. Shows staged and unstaged file changes with visual indicators (color-coded filenames)
2. Displays total modified file count and +/- line statistics in PathDisplay
3. Keeps git integration decoupled from the file tree

## Summary

The codebase uses Zustand for state management, a CSS variable-based theming system with existing green/red status colors, and a lazy-loading file explorer. Currently, only basic git detection exists (checking for `.git` folder). No git command execution or status parsing is implemented. The architecture is well-suited for adding a decoupled git status store that provides status data to both FileExplorer and PathDisplay components.

---

## Detailed Findings

### 1. File Explorer Architecture

**Main Components:**

| Component | Path | Lines |
|-----------|------|-------|
| FileExplorer | `src/renderer/components/FileExplorer/FileExplorer.tsx` | 1-79 |
| FileTreeItem | `src/renderer/components/FileExplorer/FileTreeItem.tsx` | 1-85 |
| FileIcon | `src/renderer/components/FileExplorer/FileIcon.tsx` | 1-16 |
| FolderIcon | `src/renderer/components/FileExplorer/FolderIcon.tsx` | 1-11 |
| Styles | `src/renderer/components/FileExplorer/styles.css` | 1-97 |

**Data Structure (`TreeNode`):**
```typescript
interface TreeNode {
  name: string;           // Filename or folder name
  path: string;           // Absolute file path
  isDirectory: boolean;
}
```

**File Name Rendering:**
- File names use `<span className="file-tree-name">{node.name}</span>` (FileTreeItem.tsx:82)
- Currently styled with `color: var(--color-text-secondary)` (styles.css:43)
- Selected state uses `color: var(--color-text-primary)` (styles.css:53)

**Key Insight:** The `FileTreeItem` component receives the full `path` for each file, which can be used to look up git status from a separate store.

---

### 2. PathDisplay Component

**Location:** `src/renderer/components/Views/PathDisplay.tsx` (lines 1-94)

**Current Structure:**
- Truncates long paths to `~/.../last-two-segments`
- Has a container div with `display: flex` and `gap: var(--space-2)`
- Currently has an optional explorer toggle button on the right side

**Props Interface:**
```typescript
interface PathDisplayProps {
  path: string;
  className?: string;
  showExplorerToggle?: boolean;
  isExplorerVisible?: boolean;
  onToggleExplorer?: () => void;
}
```

**Styling (styles.css:263-268):**
```css
.path-display-container {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1;
}
```

**Key Insight:** The flex container can easily accommodate additional elements (git stats badge) between the path text and the explorer toggle.

---

### 3. Theming System

**Theme Files:**
- `src/renderer/styles/themes/tokens.css` - Design tokens (spacing, typography)
- `src/renderer/styles/themes/dark.css` - Dark theme colors
- `src/renderer/styles/themes/light.css` - Light theme colors

**Existing Status Colors:**

| Status | Dark Theme | Light Theme | CSS Variable |
|--------|-----------|-------------|--------------|
| Success (Green) | `rgb(77, 171, 117)` | `rgb(68, 131, 97)` | `--color-success` |
| Error (Red) | `rgb(235, 87, 87)` | `rgb(212, 76, 71)` | `--color-error` |
| Warning (Yellow) | `rgb(223, 171, 77)` | `rgb(203, 145, 47)` | `--color-warning` |

**Radix UI Colors Also Available:**
- `--green-9`, `--green-11`, `--green-a3` (green scale)
- `--red-9`, `--red-11`, `--red-a3` (red scale)
- Used in diff views: `.diff-line.added { background: var(--green-a3); }` (Agent/styles.css:483)

**Pattern for New Colors:**
1. Add to `dark.css` under `[data-theme='dark']`
2. Add matching value to `light.css` under `[data-theme='light']`
3. Use via `var(--color-name)` in component CSS

**Suggested Git Status Colors:**
```css
/* In dark.css */
--color-git-modified: var(--color-warning);  /* Yellow for modified */
--color-git-added: var(--color-success);     /* Green for added/untracked */
--color-git-deleted: var(--color-error);     /* Red for deleted */

/* In light.css - same pattern with light theme values */
```

---

### 4. State Management

**Library:** Zustand v5.0.11

**Existing Stores:**
| Store | File | Purpose |
|-------|------|---------|
| useSettingsStore | `stores/settingsStore.ts` | Theme preferences |
| useWorkspaceStore | `stores/workspaceStore.ts` | Workspaces and projects |
| useTabStore | `stores/tabStore.ts` | Open tabs |
| useNavigationStore | `stores/navigationStore.ts` | UI state (sidebar, explorer) |
| usePreviewTabStore | `stores/previewTabStore.ts` | File preview tabs |
| useAgentStore | `stores/agentStore.ts` | Agent instances |

**Subscription Pattern:**
```typescript
// Components select specific state slices
const isExplorerVisible = useNavigationStore((state) => state.isExplorerVisible);
```

**Data Fetching Pattern:**
- Components use `useEffect` to fetch data on mount/prop change
- No global caching - each component manages local state
- Services accessed via bridges (`fileBridge`, `agentBridge`)

---

### 5. Existing Git Integration

**Current Implementation:** MINIMAL

Only detects if folder is a git repository:

**IPC Handler (`src/main/ipc-handlers.ts:217-221`):**
```typescript
return result.filePaths.map(folderPath => ({
    path: folderPath,
    name: path.basename(folderPath),
    isGitRepo: fs.existsSync(path.join(folderPath, '.git'))
}));
```

**Project Type (`stores/workspaceStore.ts:8`):**
```typescript
isGitRepo: boolean;  // Whether .git folder exists
```

**UI Usage:**
- Shows `GitBranch` icon for git repos, `Folder` icon for non-git folders
- Used in `CreateWorkspaceDialog.tsx:103` and `ProjectNavItem.tsx:34`

**What Does NOT Exist:**
- Git command execution
- Git status parsing
- File change tracking
- Staging/commit operations
- Branch management

---

## Architecture Recommendation

### Decoupled Git Status Store

Create a new `useGitStatusStore` that:
1. Is independent from the file tree
2. Provides a Map of file paths to their git status
3. Exposes aggregated statistics (modified count, +/- lines)
4. Handles refresh logic (debounced, triggered by file system events or manual refresh)

**Suggested Interface:**
```typescript
type GitFileStatus = 'modified' | 'added' | 'deleted' | 'untracked' | 'staged';

interface GitStatusState {
  // Per-file status map (path -> status)
  fileStatuses: Map<string, GitFileStatus>;

  // Aggregated stats for PathDisplay
  stats: {
    modifiedCount: number;
    addedLines: number;
    removedLines: number;
  };

  // Status
  isLoading: boolean;
  lastUpdated: number | null;

  // Actions
  refresh: (rootPath: string) => Promise<void>;
  getFileStatus: (filePath: string) => GitFileStatus | null;
}
```

### Component Integration Points

**FileTreeItem (for filename coloring):**
```typescript
// In FileTreeItem.tsx
const fileStatus = useGitStatusStore((state) => state.getFileStatus(node.path));
// Add status class to file-tree-name span
<span className={`file-tree-name ${fileStatus ? `git-${fileStatus}` : ''}`}>
```

**PathDisplay (for stats badge):**
```typescript
// In PathDisplay.tsx
const { modifiedCount, addedLines, removedLines } = useGitStatusStore((state) => state.stats);
// Render stats badge between path and toggle button
```

### Refresh Strategy (VSCode/IntelliJ Pattern)

Both VSCode and IntelliJ use:
1. **Initial load** - Full git status on project open
2. **File system watcher** - Refresh on file changes (debounced ~300ms)
3. **Focus events** - Refresh when window regains focus
4. **Manual refresh** - User-triggered via button or keyboard shortcut

---

## Code References

- `src/renderer/components/FileExplorer/FileTreeItem.tsx:82` - File name span element
- `src/renderer/components/FileExplorer/styles.css:43` - Current file name color
- `src/renderer/components/Views/PathDisplay.tsx:67-88` - Right-side toggle button area
- `src/renderer/styles/themes/dark.css:29-33` - Status color definitions
- `src/renderer/stores/` - Existing Zustand store patterns

## Open Questions

1. Should staged and unstaged files be visually distinguished (e.g., different shades)?
2. Should folders show status if they contain modified files?
3. Where should the refresh button/indicator be placed (PathDisplay or elsewhere)?
4. Should there be a global "git status loading" indicator?
