# Git Review Panel Implementation Plan

## Overview

Create a dedicated Git Review Panel accessible from the app header that provides a GitHub-style interface for reviewing all file changes in the workspace. The panel features a collapsible left sidebar showing files grouped by "Add to commit" (staged) and "Not added" (unstaged), a main area with expandable file diffs using sticky headers, and a bottom commit bar with AI-powered message generation via Claude SDK.

## Current State Analysis

### Existing Infrastructure:
- **GitChangesPanel** (`src/renderer/components/FileExplorer/GitChangesPanel.tsx:1-124`) - Shows staged/changes with Collapsible.Root
- **DiffView** (`src/renderer/components/Views/DiffView.tsx:1-204`) - Unified diff with syntax highlighting
- **gitBridge** (`src/renderer/services/gitBridge.ts:1-40`) - Git operations via IPC (getStatus, getDiff)
- **gitStatusStore** (`src/renderer/stores/gitStatusStore.ts:1-126`) - Zustand store for git state
- **ClaudeAgentService** (`src/main/ClaudeAgentService.ts`) - Claude SDK wrapper
- **IPC handlers** (`src/main/ipc-handlers.ts:332-557`) - Git status and diff handlers

### Key Discoveries:
- Git status parsing at `ipc-handlers.ts:357-369` handles staged/modified/untracked/deleted
- Diff parsing at `ipc-handlers.ts:559-637` produces structured hunks with line numbers
- The app uses `@radix-ui/react-collapsible` for expandable sections
- Color scheme defined in theme CSS with `--color-git-*` variables
- Bridge pattern required for all Electron API access

## Desired End State

A new view mode where:
1. User clicks a git icon in the header → Git Review Panel opens (full width, replacing main content)
2. Left collapsible sidebar shows files in two groups: "Add to commit" / "Not added"
3. Main area shows all changed files with expandable diff sections and sticky headers
4. Each file has: +/- line counts (color coded), stage/unstage button, diff/file toggle
5. Clicking a file in sidebar scrolls to that file in the main area
6. Bottom commit bar has message input and "Generate" button (uses Claude SDK)
7. Color coding: Green = added, Blue = changed/modified, Red = deleted

## What We're NOT Doing

- No split diff view (side-by-side) - unified diff only
- No partial staging (hunk-level) - file-level only
- No branch switching or merge conflict resolution
- No commit history viewing
- No push/pull operations

## Implementation Approach

Build incrementally: backend first, then UI components, then integrate AI. Reuse existing diff utilities and styling patterns from the current git implementation.

---

## Phase 1: Backend & State Foundation

### Overview
Add IPC handlers for git staging operations and create the Zustand store for the review panel state.

### Changes Required:

#### 1. IPC Channels
**File**: `src/shared/constants.ts`
**Changes**: Add new channel constants

```typescript
// Add after line 58
GIT_STAGE_FILE: 'git:stage-file',
GIT_UNSTAGE_FILE: 'git:unstage-file',
GIT_COMMIT: 'git:commit',
GIT_GET_STAGED_DIFF: 'git:get-staged-diff',
AGENT_GENERATE_COMMIT_MESSAGE: 'agent:generate-commit-message',
```

#### 2. Git Staging IPC Handlers
**File**: `src/main/ipc-handlers.ts`
**Changes**: Add handlers for staging, unstaging, and committing

```typescript
// git:stage-file - runs `git add <filepath>`
// git:unstage-file - runs `git reset HEAD <filepath>`
// git:commit - runs `git commit -m "<message>"`
// git:get-staged-diff - returns unified diff of all staged files for AI context
```

#### 3. Commit Message Generation Handler
**File**: `src/main/ipc-handlers.ts`
**Changes**: Add handler that uses ClaudeAgentService to generate commit message

```typescript
// agent:generate-commit-message
// Input: { rootPath: string, stagedFiles: string[] }
// Process: Get staged diff, send to Claude with commit message prompt
// Output: { message: string }
```

#### 4. Preload Script Updates
**File**: `src/preload/preload.ts`
**Changes**: Expose new git and agent APIs to renderer

```typescript
// Add to gitAPI:
stageFile: (rootPath: string, filePath: string) => Promise<void>
unstageFile: (rootPath: string, filePath: string) => Promise<void>
commit: (rootPath: string, message: string) => Promise<{ success: boolean; error?: string }>

// Add to agentAPI:
generateCommitMessage: (rootPath: string) => Promise<{ message: string }>
```

#### 5. Bridge Services
**File**: `src/renderer/services/gitBridge.ts`
**Changes**: Add staging and commit methods

```typescript
stageFile: async (rootPath: string, filePath: string): Promise<void>
unstageFile: async (rootPath: string, filePath: string): Promise<void>
commit: async (rootPath: string, message: string): Promise<{ success: boolean; error?: string }>
```

**File**: `src/renderer/services/agentBridge.ts`
**Changes**: Add commit message generation method

```typescript
generateCommitMessage: async (rootPath: string): Promise<{ message: string }>
```

#### 6. Review Panel Store
**File**: `src/renderer/stores/gitReviewStore.ts` (new)
**Changes**: Create Zustand store for review panel state

```typescript
interface GitReviewState {
  isOpen: boolean;
  expandedFiles: Set<string>;  // Which file sections are expanded
  viewMode: Map<string, 'diff' | 'file'>;  // Per-file view mode toggle
  commitMessage: string;
  isGeneratingMessage: boolean;
  isCommitting: boolean;

  // Actions
  open: () => void;
  close: () => void;
  toggleFileExpanded: (filePath: string) => void;
  setViewMode: (filePath: string, mode: 'diff' | 'file') => void;
  setCommitMessage: (message: string) => void;
  setGeneratingMessage: (loading: boolean) => void;
  setCommitting: (loading: boolean) => void;
  reset: () => void;
}
```

#### 7. Type Definitions
**File**: `src/renderer/types/electron.d.ts`
**Changes**: Add types for new IPC methods

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] TypeScript compiles without errors

#### Manual Verification:
- [ ] Can call gitBridge.stageFile() and see file move to staged in terminal `git status`
- [ ] Can call gitBridge.unstageFile() and see file move back to unstaged
- [ ] Can call gitBridge.commit() and see commit created in `git log`

---

## Phase 2: Git Review Panel UI

### Overview
Build the main Git Review Panel component with collapsible file sidebar and unified diff viewer.

### Changes Required:

#### 1. Workspace Header Button
**File**: `src/renderer/components/Views/PathDisplay.tsx`
**Changes**: Add git review button next to the file explorer toggle

```typescript
// Add button with GitPullRequestDraft icon
// onClick calls gitReviewStore.toggle()
// Only shows when isGitRepo is true
// Active state when review panel is open
```

#### 2. Main Panel Component
**File**: `src/renderer/components/GitReviewPanel/GitReviewPanel.tsx` (new)
**Changes**: Create the main panel container

Structure:
```
<div className="git-review-panel">
  <div className="git-review-sidebar">  {/* Collapsible left panel */}
    <GitReviewFileList />
  </div>
  <div className="git-review-main">
    <GitReviewDiffList />
    <GitReviewCommitBar />
  </div>
</div>
```

#### 3. File List Sidebar
**File**: `src/renderer/components/GitReviewPanel/GitReviewFileList.tsx` (new)
**Changes**: Collapsible sidebar with staged/unstaged file groups

Features:
- Collapsible sidebar (toggle button in header)
- "Add to commit" section (staged files)
- "Not added" section (modified, untracked, deleted)
- File items show: icon, filename, parent path, status badge
- Color coding: Green (added/new), Blue (modified), Red (deleted)
- Click file → scroll to that file in diff list
- Compact styling (smaller than current git panel)

#### 4. Diff List Component
**File**: `src/renderer/components/GitReviewPanel/GitReviewDiffList.tsx` (new)
**Changes**: Scrollable list of all file diffs with expandable sections

Features:
- Each file in its own expandable section
- Sticky header per file (position: sticky)
- Header shows: filename, +N / -N line counts (color coded), stage/unstage button, diff/file toggle
- Expanded by default for first 3 files
- Scroll container with IntersectionObserver for sticky behavior

#### 5. File Diff Section
**File**: `src/renderer/components/GitReviewPanel/GitReviewFileSection.tsx` (new)
**Changes**: Individual file section with header and content

Header (sticky):
```
[▼] filename.tsx  (+45 / -12)  [Add to commit]  [Diff | File]
```

Content:
- If diff mode: Show unified diff (reuse DiffView logic)
- If file mode: Show full file content with syntax highlighting

#### 6. Styling
**File**: `src/renderer/components/GitReviewPanel/styles.css` (new)
**Changes**: Compact styling matching existing git panel aesthetic

Key styles:
- Panel takes full width/height of main content area
- Sidebar: 240px width, collapsible to 0
- Sticky headers with z-index layering
- Color variables for status:
  - `--color-review-added: #4dab75` (green)
  - `--color-review-modified: #4d9de0` (blue)
  - `--color-review-deleted: #eb5757` (red)
- Compact file items (smaller padding, font-size)
- Smooth collapse/expand transitions

#### 7. App Layout Integration
**File**: `src/renderer/App.tsx` or main layout component
**Changes**: Conditionally render GitReviewPanel when store.isOpen is true

```typescript
{gitReviewStore.isOpen ? (
  <GitReviewPanel />
) : (
  <DefaultLayout />  // existing conversation + preview panels
)}
```

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] No TypeScript errors

#### Manual Verification:
- [ ] Header button shows with file count badge
- [ ] Clicking button opens Git Review Panel
- [ ] Sidebar shows files in correct groups (staged vs not staged)
- [ ] Clicking file in sidebar scrolls to that file in diff list
- [ ] File sections expand/collapse
- [ ] Sticky headers work when scrolling
- [ ] Stage/unstage buttons move files between groups
- [ ] Diff/File toggle switches view mode

---

## Phase 3: Commit Flow & AI Integration

### Overview
Implement the commit bar with message input and Claude SDK integration for generating commit messages.

### Changes Required:

#### 1. Commit Bar Component
**File**: `src/renderer/components/GitReviewPanel/GitReviewCommitBar.tsx` (new)
**Changes**: Bottom bar with commit message input and actions

Layout:
```
[Commit message input (textarea)]  [Generate ✨]  [Commit]
```

Features:
- Textarea for commit message (auto-resize, max 4 lines visible)
- "Generate" button calls agentBridge.generateCommitMessage()
- Shows loading spinner during generation
- "Commit" button calls gitBridge.commit()
- Disabled states when no staged files or empty message
- Success/error toast after commit

#### 2. Message Generation Logic
**File**: `src/renderer/components/GitReviewPanel/GitReviewCommitBar.tsx`
**Changes**: Integrate with agentBridge

```typescript
const handleGenerate = async () => {
  setGenerating(true);
  try {
    const { message } = await agentBridge.generateCommitMessage(rootPath);
    setCommitMessage(message);
  } catch (error) {
    // Show error toast
  } finally {
    setGenerating(false);
  }
};
```

#### 3. Backend Generation Handler
**File**: `src/main/ipc-handlers.ts`
**Changes**: Implement the commit message generation

```typescript
// Handler for 'agent:generate-commit-message'
ipcMain.handle(IPC_CHANNELS.AGENT_GENERATE_COMMIT_MESSAGE, async (_, { rootPath }) => {
  // 1. Get staged diff: git diff --cached
  // 2. Get list of staged files
  // 3. Build prompt for Claude
  // 4. Call ClaudeAgentService with prompt
  // 5. Parse response and return message
});
```

Prompt template:
```
Generate a concise git commit message for the following changes.
Follow conventional commits format (feat:, fix:, refactor:, etc.).
Keep the first line under 72 characters.

Staged files:
- file1.ts
- file2.tsx

Diff:
<staged diff content>
```

#### 4. Commit Execution
**File**: `src/renderer/components/GitReviewPanel/GitReviewCommitBar.tsx`
**Changes**: Handle commit action

```typescript
const handleCommit = async () => {
  if (!commitMessage.trim()) return;
  setCommitting(true);
  try {
    const result = await gitBridge.commit(rootPath, commitMessage);
    if (result.success) {
      // Show success toast
      // Refresh git status
      // Clear commit message
      // Optionally close panel
    } else {
      // Show error toast with result.error
    }
  } finally {
    setCommitting(false);
  }
};
```

#### 5. Post-Commit Refresh
**File**: `src/renderer/stores/gitStatusStore.ts`
**Changes**: Ensure refresh is called after commit

The commit bar should call `gitStatusStore.refresh()` after successful commit to update the file list.

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] No TypeScript errors

#### Manual Verification:
- [ ] "Generate" button shows loading state
- [ ] Generated message appears in textarea
- [ ] Generated message follows conventional commits format
- [ ] "Commit" button creates actual git commit
- [ ] File list updates after commit (staged files disappear)
- [ ] Error handling works (e.g., empty message, git errors)

---

## Phase 4: Polish & Scroll Behavior

### Overview
Implement scroll-to-file functionality, sticky header improvements, and final styling polish.

### Changes Required:

#### 1. Scroll to File
**File**: `src/renderer/components/GitReviewPanel/GitReviewDiffList.tsx`
**Changes**: Add ref-based scrolling when file clicked in sidebar

```typescript
// Create refs map for each file section
const fileRefs = useRef<Map<string, HTMLDivElement>>(new Map());

// Expose scroll function via store or context
const scrollToFile = (filePath: string) => {
  const element = fileRefs.current.get(filePath);
  if (element) {
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Highlight briefly
    element.classList.add('highlight');
    setTimeout(() => element.classList.remove('highlight'), 1000);
  }
};
```

#### 2. Sticky Header Improvements
**File**: `src/renderer/components/GitReviewPanel/styles.css`
**Changes**: Refine sticky header behavior

```css
.git-review-file-section {
  /* Ensure proper stacking */
}

.git-review-file-header {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--color-border);
}

/* When header is stuck */
.git-review-file-header.stuck {
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}
```

#### 3. IntersectionObserver for Stuck State
**File**: `src/renderer/components/GitReviewPanel/GitReviewFileSection.tsx`
**Changes**: Detect when header becomes sticky

```typescript
// Use IntersectionObserver to detect when header is stuck
useEffect(() => {
  const observer = new IntersectionObserver(
    ([entry]) => {
      headerRef.current?.classList.toggle('stuck', !entry.isIntersecting);
    },
    { threshold: [1], rootMargin: '-1px 0px 0px 0px' }
  );
  // Observe sentinel element above header
}, []);
```

#### 4. Compact Styling Polish
**File**: `src/renderer/components/GitReviewPanel/styles.css`
**Changes**: Final styling adjustments

- Smaller font sizes (12px base, 11px for metadata)
- Tighter padding (4px, 8px)
- Subtle hover states
- Smooth transitions for expand/collapse
- Focus styles for accessibility
- Loading states with skeleton or spinner

#### 5. Keyboard Shortcuts
**File**: `src/renderer/components/GitReviewPanel/GitReviewPanel.tsx`
**Changes**: Add keyboard navigation

- `Escape` - Close panel
- `Cmd/Ctrl + Enter` - Commit (when focused in message input)
- `Cmd/Ctrl + G` - Generate commit message

#### 6. Empty States
**File**: `src/renderer/components/GitReviewPanel/GitReviewPanel.tsx`
**Changes**: Handle empty states gracefully

- No changes: "No changes to review" message
- All staged: Encourage committing
- Nothing staged: Prompt to stage files

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] No TypeScript errors

#### Manual Verification:
- [ ] Clicking file in sidebar smoothly scrolls to that file
- [ ] Sticky headers show shadow when stuck
- [ ] Keyboard shortcuts work
- [ ] Transitions are smooth
- [ ] Empty states display correctly
- [ ] Overall look is compact and polished

---

## Testing Strategy

### Unit Tests:
- Git staging IPC handlers (mock git commands)
- Review store state transitions
- Scroll-to-file logic

### Integration Tests:
- Full flow: stage file → generate message → commit
- Panel open/close state persistence
- Git status refresh after operations

### Manual Testing Steps:
1. Open app with uncommitted changes
2. Click header git button → panel opens
3. Verify files grouped correctly (staged vs not staged)
4. Click "Add to commit" on a file → moves to staged group
5. Click file in sidebar → scrolls to that file
6. Toggle diff/file view → content switches
7. Scroll down → headers become sticky
8. Click "Generate" → AI message appears
9. Click "Commit" → commit created, files clear
10. Verify commit in terminal with `git log`

---

## File Summary

### New Files:
| File | Purpose |
|------|---------|
| `src/renderer/components/GitReviewPanel/GitReviewPanel.tsx` | Main panel container |
| `src/renderer/components/GitReviewPanel/GitReviewFileList.tsx` | Collapsible file sidebar |
| `src/renderer/components/GitReviewPanel/GitReviewDiffList.tsx` | Scrollable diff list |
| `src/renderer/components/GitReviewPanel/GitReviewFileSection.tsx` | Individual file section |
| `src/renderer/components/GitReviewPanel/GitReviewCommitBar.tsx` | Bottom commit bar |
| `src/renderer/components/GitReviewPanel/styles.css` | Component styles |
| `src/renderer/stores/gitReviewStore.ts` | Zustand store |

### Modified Files:
| File | Changes |
|------|---------|
| `src/shared/constants.ts` | Add IPC channels |
| `src/main/ipc-handlers.ts` | Add git staging + commit handlers |
| `src/main/ClaudeAgentService.ts` | Add generateCommitMessage method |
| `src/preload/preload.ts` | Expose new APIs |
| `src/renderer/services/gitBridge.ts` | Add staging/commit methods |
| `src/renderer/types/electron.d.ts` | Add type definitions |
| `src/renderer/components/Views/PathDisplay.tsx` | Add review panel button next to file explorer toggle |
| `src/renderer/components/Layout/index.tsx` | Conditional panel rendering |

---

## References

- Existing git panel: `src/renderer/components/FileExplorer/GitChangesPanel.tsx:1-124`
- Diff view patterns: `src/renderer/components/Views/DiffView.tsx:1-204`
- Git IPC handlers: `src/main/ipc-handlers.ts:332-557`
- Diff utilities: `src/renderer/utils/diffUtils.ts:1-82`
- Claude SDK integration: `src/main/ClaudeAgentService.ts`
- Bridge pattern example: `src/renderer/services/gitBridge.ts:1-40`
