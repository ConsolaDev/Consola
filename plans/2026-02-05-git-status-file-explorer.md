# Git Status Integration in File Explorer and PathDisplay

**Date**: 2026-02-05
**Status**: Ready for Implementation
**Based on**: research/2026-02-05-git-status-file-explorer.md

## Overview

Add git status visualization to the file explorer showing staged/unstaged file changes with color-coded filenames, and display aggregated statistics (+/- lines, modified count) in the PathDisplay component. The git integration will be decoupled from the file tree via a dedicated Zustand store.

## Current State Analysis

- File explorer exists with lazy-loading tree structure (`FileExplorer.tsx`, `FileTreeItem.tsx`)
- PathDisplay shows truncated path with optional explorer toggle
- Theming system has existing status colors (success/warning/error)
- Only basic git detection exists (checking for `.git` folder)
- No git command execution or status parsing implemented

### Key Files:
- `src/renderer/components/FileExplorer/FileTreeItem.tsx:82` - File name rendering
- `src/renderer/components/FileExplorer/styles.css:43` - File name styling
- `src/renderer/components/Views/PathDisplay.tsx` - Path display component
- `src/renderer/styles/themes/dark.css` / `light.css` - Theme colors

## Desired End State

1. **File Explorer**: Files show color-coded names based on git status
   - Staged files: Green (`--color-git-staged`)
   - Unstaged modified: Yellow (`--color-git-modified`)
   - Untracked: Subtle green/teal (`--color-git-untracked`)
   - Deleted: Red (`--color-git-deleted`)
   - Folders do NOT propagate child status

2. **PathDisplay**: Shows git stats badge with:
   - Modified file count
   - Added/removed line counts (+/-)
   - Refresh button with subtle loading indicator

3. **Architecture**: Decoupled `useGitStatusStore` provides status data to both components

## What We're NOT Doing

- Folder status propagation (decided against)
- Global loading indicator (subtle per-refresh is sufficient)
- Staging/commit operations from UI
- Branch management
- File diff viewing from explorer

---

## Phase 1: Git Status Store & IPC Handler

### Overview
Create the backend git status fetching and the Zustand store to manage git status state.

### Changes Required:

#### 1. IPC Handler for Git Status
**File**: `src/main/ipc-handlers.ts`
**Changes**: Add new IPC handler to execute `git status --porcelain` and `git diff --numstat`

```typescript
// New handler: 'git:getStatus'
// Input: { rootPath: string }
// Output: {
//   files: Array<{ path: string, status: 'staged' | 'modified' | 'untracked' | 'deleted' }>,
//   stats: { modifiedCount: number, addedLines: number, removedLines: number }
// }
```

#### 2. Preload Bridge
**File**: `src/preload/index.ts`
**Changes**: Expose `gitBridge` with `getStatus(rootPath: string)` method

#### 3. Git Status Store
**File**: `src/renderer/stores/gitStatusStore.ts` (NEW)
**Changes**: Create Zustand store with:
- `fileStatuses: Map<string, GitFileStatus>` - per-file status
- `stats: { modifiedCount, addedLines, removedLines }` - aggregated stats
- `isLoading: boolean` - loading state for subtle indicator
- `refresh(rootPath: string)` - fetch and update status
- `getFileStatus(filePath: string)` - selector helper

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] TypeScript compiles without errors

#### Manual Verification:
- [ ] Can call `window.gitBridge.getStatus('/path/to/repo')` from console
- [ ] Store correctly parses git status output

---

## Phase 2: Theme Colors for Git Status

### Overview
Add git-specific color variables to the theming system.

### Changes Required:

#### 1. Dark Theme Colors
**File**: `src/renderer/styles/themes/dark.css`
**Changes**: Add git status color variables
```css
--color-git-staged: var(--green-11);      /* Green for staged */
--color-git-modified: var(--color-warning); /* Yellow for unstaged modified */
--color-git-untracked: var(--cyan-11);    /* Teal for untracked */
--color-git-deleted: var(--color-error);  /* Red for deleted */
```

#### 2. Light Theme Colors
**File**: `src/renderer/styles/themes/light.css`
**Changes**: Add matching light theme values

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`

#### Manual Verification:
- [ ] Colors are accessible in both themes
- [ ] Sufficient contrast for readability

---

## Phase 3: File Explorer Integration

### Overview
Connect FileTreeItem to the git status store to show color-coded filenames.

### Changes Required:

#### 1. FileTreeItem Component
**File**: `src/renderer/components/FileExplorer/FileTreeItem.tsx`
**Changes**:
- Import and use `useGitStatusStore`
- Add status-based className to file name span
- Only apply to files, not directories

#### 2. FileTreeItem Styles
**File**: `src/renderer/components/FileExplorer/styles.css`
**Changes**: Add git status classes
```css
.file-tree-name.git-staged { color: var(--color-git-staged); }
.file-tree-name.git-modified { color: var(--color-git-modified); }
.file-tree-name.git-untracked { color: var(--color-git-untracked); }
.file-tree-name.git-deleted { color: var(--color-git-deleted); }
```

#### 3. FileExplorer Root
**File**: `src/renderer/components/FileExplorer/FileExplorer.tsx`
**Changes**: Trigger git status refresh when root path changes

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`

#### Manual Verification:
- [ ] Modified files show yellow color
- [ ] Staged files show green color
- [ ] Untracked files show teal color
- [ ] Colors update after git operations

---

## Phase 4: PathDisplay Stats Badge

### Overview
Add git statistics display and refresh button to PathDisplay.

### Changes Required:

#### 1. PathDisplay Component
**File**: `src/renderer/components/Views/PathDisplay.tsx`
**Changes**:
- Import `useGitStatusStore`
- Add stats badge between path and explorer toggle
- Add refresh button with loading spinner
- Badge shows: `3 files · +45 -12`

#### 2. PathDisplay Styles
**File**: `src/renderer/components/Views/styles.css`
**Changes**: Add styles for git stats badge
```css
.git-stats-badge {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}
.git-stats-added { color: var(--color-git-staged); }
.git-stats-removed { color: var(--color-git-deleted); }
```

#### 3. Refresh Button
**Changes**: Small icon button with `RotateCw` icon from lucide-react
- Shows subtle spin animation when `isLoading` is true
- Triggers `gitStatusStore.refresh(currentPath)`

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`

#### Manual Verification:
- [ ] Stats badge shows correct counts
- [ ] Refresh button triggers status update
- [ ] Loading indicator spins during refresh
- [ ] Stats update after file changes

---

## Phase 5: Auto-Refresh on File Changes

### Overview
Automatically refresh git status when files change or window regains focus.

### Changes Required:

#### 1. File Watcher Integration
**File**: `src/renderer/stores/gitStatusStore.ts`
**Changes**:
- Add debounced refresh (300ms)
- Subscribe to file system events if available
- Add window focus listener for refresh

#### 2. Cleanup
**Changes**: Ensure watchers are cleaned up when project changes

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`

#### Manual Verification:
- [ ] Status updates automatically after saving a file
- [ ] Status refreshes when switching back to app
- [ ] No excessive refresh calls (debouncing works)

---

## Testing Strategy

### Manual Testing Steps:
1. Open a git repository with modified files
2. Verify file colors match their git status
3. Stage a file via terminal, verify color changes to green
4. Check PathDisplay shows correct +/- counts
5. Click refresh, verify spinner and update
6. Modify a file, verify auto-refresh works
7. Test in both dark and light themes

### Edge Cases:
- Non-git repository (should show no colors, hide stats badge)
- Large repository (performance of git status)
- Binary files (should handle gracefully)
- Renamed files (git detects as delete + add)

## References

- Research: `research/2026-02-05-git-status-file-explorer.md`
- FileTreeItem: `src/renderer/components/FileExplorer/FileTreeItem.tsx:82`
- PathDisplay: `src/renderer/components/Views/PathDisplay.tsx`
- Theme colors: `src/renderer/styles/themes/dark.css:29-33`
- Store patterns: `src/renderer/stores/navigationStore.ts`
