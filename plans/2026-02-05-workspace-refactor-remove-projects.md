# Implementation Plan: Workspace Refactor - Remove Projects Concept

**Date**: 2026-02-05
**Branch**: feature/workspace-refactor
**Status**: Draft

## Overview

Refactor the workspace architecture to remove the "project" concept entirely. Workspaces will have a 1:1 relationship with a folder path (cwd). This simplifies the data model and improves UX by:
- Using native folder selector for workspace creation
- Removing the tab system in favor of sidebar-driven navigation
- Introducing a centered input view for empty workspaces (similar to Claude.ai)
- Making sessions appear only after the first message is sent

## Current State Analysis

### Existing Data Model (to be removed)
```typescript
// Current - workspaceStore.ts
Workspace
├── projects: Project[]      // REMOVE
├── sessions: Session[]      // sessions have projectId: string | null

Project
├── path: string            // MOVE to Workspace
├── isGitRepo: boolean      // MOVE to Workspace
```

### Key Files Affected
- `src/renderer/stores/workspaceStore.ts:4-259` - Data model & persistence
- `src/renderer/stores/tabStore.ts` - REMOVE entirely
- `src/renderer/stores/navigationStore.ts:1-100` - Simplify
- `src/renderer/components/Sidebar/*` - Remove ProjectNavItem, simplify
- `src/renderer/components/Views/*` - Remove TabContent, add new views
- `src/main/ipc-handlers.ts` - Add folder dialog handler
- `src/preload/preload.ts` - Expose folder dialog

## Desired End State

### New Data Model
```typescript
interface Workspace {
  id: string;
  name: string;           // Derived from last folder segment
  path: string;           // Absolute folder path (1:1 relationship)
  isGitRepo: boolean;     // For git integration
  sessions: Session[];
  createdAt: number;
  updatedAt: number;
}

interface Session {
  id: string;
  name: string;           // Auto-generated from first message
  workspaceId: string;
  instanceId: string;     // Agent instance ID
  createdAt: number;
  lastActiveAt: number;
}
```

### New Navigation Flow
1. User opens app → Sees sidebar with workspaces + empty state OR centered input for active workspace
2. User clicks "New Workspace" → Native folder dialog opens → Workspace created with folder name
3. User selects workspace → Centered input view appears (no tabs)
4. User types message and sends → Session created, name auto-generated, session appears in sidebar
5. User clicks session in sidebar → Agent conversation view loads
6. File explorer and preview always reflect the active workspace's cwd

### New UI Components
```
┌─────────────────────────────────────────────────────────────────┐
│ Sidebar                │  Main Content Area                     │
│ ───────────────────── │  ────────────────────────────────────── │
│ ▼ console-1           │                                         │
│   • Session A ●       │    Start new conversation in console-1  │
│   • Session B         │                    ↓ [dropdown]         │
│   [+ New Session]     │    ┌────────────────────────────────┐   │
│                       │    │ Ask anything, @ for context    │   │
│ ▶ other-workspace     │    │ + ∨ Fast ∨ Model              →│   │
│                       │    └────────────────────────────────┘   │
│ [+ New Workspace]     │                                         │
└─────────────────────────────────────────────────────────────────┘
```

## What We're NOT Doing

- Multi-workspace tabs (one workspace at a time)
- Multi-directory sessions (each workspace = single cwd)
- Project concept within workspaces
- Manual session naming before first message

---

## Phase 1: Update Data Model & Store

### Overview
Simplify the workspaceStore by removing the Project concept and adding `path` directly to Workspace.

### Changes Required

#### 1. Update workspaceStore.ts
**File**: `src/renderer/stores/workspaceStore.ts`

**Remove:**
- `Project` interface (lines 4-11)
- `addProjectToWorkspace` action
- `removeProjectFromWorkspace` action
- `updateProjectLastOpened` action
- `getProjectSessions` action
- `projectId` field from Session

**Modify:**
- `Workspace` interface - add `path: string` and `isGitRepo: boolean`
- `createWorkspace` - accept `name` and `path` parameters
- `Session` interface - remove `projectId`, remove `paths` array (cwd comes from workspace)
- Migration to v3 - remove projects, migrate any existing sessions

**New Workspace interface:**
```typescript
export interface Workspace {
  id: string;
  name: string;           // From folder name
  path: string;           // Absolute path
  isGitRepo: boolean;
  sessions: Session[];
  createdAt: number;
  updatedAt: number;
}

export interface Session {
  id: string;
  name: string;
  workspaceId: string;
  instanceId: string;
  createdAt: number;
  lastActiveAt: number;
}
```

#### 2. Add Native Folder Dialog IPC
**File**: `src/main/ipc-handlers.ts`

Add handler:
```typescript
ipcMain.handle('dialog:selectFolder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  const selectedPath = result.filePaths[0];
  const folderName = path.basename(selectedPath);
  const isGitRepo = await checkIsGitRepo(selectedPath);
  return { path: selectedPath, name: folderName, isGitRepo };
});
```

**File**: `src/preload/preload.ts`

Expose to renderer:
```typescript
fileBridge: {
  // ... existing
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
}
```

**File**: `src/renderer/types/electron.d.ts`

Add type:
```typescript
interface FileBridge {
  selectFolder: () => Promise<{ path: string; name: string; isGitRepo: boolean } | null>;
}
```

### Success Criteria

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] TypeScript compiles without errors

#### Manual Verification:
- [ ] Existing workspaces migrate correctly (projects removed, path set if possible)
- [ ] New workspace creation with folder dialog works
- [ ] Session CRUD operations work without projectId

---

## Phase 2: Remove Tab System

### Overview
Remove the entire tab system and replace with workspace-driven navigation.

### Changes Required

#### 1. Delete Tab Store
**File**: `src/renderer/stores/tabStore.ts`

Delete this file entirely.

#### 2. Update Navigation Store
**File**: `src/renderer/stores/navigationStore.ts`

**Remove:**
- `expandedProjects` state
- `toggleProjectExpanded` action
- `isProjectExpanded` selector

**Modify:**
- `activeSessionId` - change from `Record<string, string | null>` to direct `string | null`
- Add `activeWorkspaceId: string | null`

**New interface:**
```typescript
interface NavigationState {
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  isExplorerVisible: boolean;
  expandedWorkspaces: Record<string, boolean>;

  setActiveWorkspace: (id: string | null) => void;
  setActiveSession: (id: string | null) => void;
  toggleExplorerVisibility: () => void;
  toggleWorkspaceExpanded: (id: string) => void;
  isWorkspaceExpanded: (id: string) => boolean;
}
```

#### 3. Remove Tab Components
**Files to delete:**
- `src/renderer/components/Tabs/` directory (if exists)
- References to `TabContent` component

#### 4. Update Main App Layout
**File**: `src/renderer/App.tsx` or equivalent

Remove tab rendering, replace with:
```typescript
<div className="app-layout">
  <Sidebar />
  <MainContent /> {/* New component */}
</div>
```

### Success Criteria

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] No references to tabStore remain

#### Manual Verification:
- [ ] App renders without tabs
- [ ] Sidebar workspace selection works

---

## Phase 3: Update Sidebar Components

### Overview
Remove ProjectNavItem and simplify sidebar to show Workspaces → Sessions hierarchy.

### Changes Required

#### 1. Delete ProjectNavItem
**File**: `src/renderer/components/Sidebar/ProjectNavItem.tsx`

Delete this file.

#### 2. Simplify WorkspaceNavItem
**File**: `src/renderer/components/Sidebar/WorkspaceNavItem.tsx`

**Modify to:**
- Show workspace name (derived from folder)
- List sessions directly under workspace
- Add "New Session" button at bottom of session list
- Handle workspace selection (sets activeWorkspaceId)
- Remove all project-related code

```typescript
export function WorkspaceNavItem({ workspace }: { workspace: Workspace }) {
  const isExpanded = useNavigationStore(s => s.isWorkspaceExpanded(workspace.id));
  const isActive = useNavigationStore(s => s.activeWorkspaceId === workspace.id);
  const setActiveWorkspace = useNavigationStore(s => s.setActiveWorkspace);

  return (
    <Collapsible.Root open={isExpanded}>
      <div
        className={`workspace-item ${isActive ? 'active' : ''}`}
        onClick={() => setActiveWorkspace(workspace.id)}
      >
        <ChevronRight className={isExpanded ? 'rotated' : ''} />
        <span>{workspace.name}</span>
        <WorkspaceActionsMenu workspace={workspace} />
      </div>
      <Collapsible.Content>
        {workspace.sessions.map(session => (
          <SessionNavItem key={session.id} session={session} />
        ))}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
```

#### 3. Update SessionNavItem
**File**: `src/renderer/components/Sidebar/SessionNavItem.tsx`

**Modify:**
- Remove projectId handling
- Simplify to just show session name and status indicator
- Click sets both activeWorkspaceId and activeSessionId

#### 4. Update Sidebar Index
**File**: `src/renderer/components/Sidebar/index.tsx`

**Modify:**
- Remove project-related imports
- Update "New Workspace" button to use folder dialog
- Add "New Session" action

```typescript
const handleNewWorkspace = async () => {
  const result = await window.fileBridge.selectFolder();
  if (result) {
    createWorkspace(result.name, result.path, result.isGitRepo);
    // Auto-select the new workspace
    setActiveWorkspace(newWorkspace.id);
  }
};
```

### Success Criteria

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] No references to ProjectNavItem remain

#### Manual Verification:
- [ ] Workspaces show in sidebar with correct folder names
- [ ] Sessions appear under their workspace
- [ ] New Workspace opens folder dialog
- [ ] Clicking workspace/session updates navigation state

---

## Phase 4: Create Centered Input View

### Overview
Create a new view that displays when a workspace is selected but no session is active. This is the main entry point for starting conversations.

### Changes Required

#### 1. Create NewSessionView Component
**File**: `src/renderer/components/Views/NewSessionView.tsx`

```typescript
interface NewSessionViewProps {
  workspace: Workspace;
}

export function NewSessionView({ workspace }: NewSessionViewProps) {
  const workspaces = useWorkspaceStore(s => s.workspaces);
  const setActiveWorkspace = useNavigationStore(s => s.setActiveWorkspace);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(workspace.id);

  const handleWorkspaceChange = (id: string) => {
    setSelectedWorkspaceId(id);
    setActiveWorkspace(id);
  };

  const handleSubmit = async (prompt: string) => {
    // 1. Create session with temp name
    // 2. Start agent query
    // 3. On first response, generate session name from prompt
    // 4. Update session name
    // 5. Session now appears in sidebar
  };

  return (
    <div className="new-session-view">
      <div className="new-session-header">
        <span>Start new conversation in</span>
        <WorkspaceDropdown
          workspaces={workspaces}
          selected={selectedWorkspaceId}
          onChange={handleWorkspaceChange}
        />
      </div>
      <PromptInput onSubmit={handleSubmit} />
    </div>
  );
}
```

#### 2. Create WorkspaceDropdown Component
**File**: `src/renderer/components/Views/WorkspaceDropdown.tsx`

Simple dropdown showing all workspaces, allows switching context.

#### 3. Create PromptInput Component
**File**: `src/renderer/components/Views/PromptInput.tsx`

Styled input matching the reference image with:
- Placeholder text "Ask anything, @ for context"
- Model selector
- Submit button

#### 4. Update MainContent Component
**File**: `src/renderer/components/Views/MainContent.tsx`

Route based on navigation state:
```typescript
export function MainContent() {
  const activeWorkspaceId = useNavigationStore(s => s.activeWorkspaceId);
  const activeSessionId = useNavigationStore(s => s.activeSessionId);
  const workspace = useWorkspaceStore(s => s.getWorkspace(activeWorkspaceId));

  // No workspace selected - show home/welcome
  if (!workspace) {
    return <HomeView />;
  }

  // Workspace selected, no session - show centered input
  if (!activeSessionId) {
    return <NewSessionView workspace={workspace} />;
  }

  // Session active - show conversation view
  return <SessionView workspace={workspace} sessionId={activeSessionId} />;
}
```

### Success Criteria

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] Components render without errors

#### Manual Verification:
- [ ] Selecting workspace shows centered input
- [ ] Workspace dropdown lists all workspaces
- [ ] Switching workspace in dropdown updates navigation
- [ ] Input styling matches reference image

---

## Phase 5: Integrate Session Creation & Agent

### Overview
Wire up the centered input to create sessions and start agent conversations. Sessions only become visible in sidebar after first message.

### Changes Required

#### 1. Implement Session Creation Flow
**File**: `src/renderer/components/Views/NewSessionView.tsx`

```typescript
const handleSubmit = async (prompt: string) => {
  const workspaceId = selectedWorkspaceId;
  const workspace = getWorkspace(workspaceId);
  if (!workspace) return;

  // Generate instance ID
  const sessionId = generateId();
  const instanceId = `workspace-${workspaceId}-session-${sessionId}`;

  // Create session with temporary name (won't show in sidebar yet)
  const session = createSession(workspaceId, {
    name: '', // Empty - will be filled after summarization
    workspaceId,
    instanceId,
  });

  if (!session) return;

  // Set as active
  setActiveSession(session.id);

  // Start agent query
  agentStore.sendMessage(instanceId, workspace.path, prompt, {});

  // Generate name from prompt asynchronously
  generateSessionName(prompt).then(name => {
    updateSession(workspaceId, session.id, { name });
  });
};
```

#### 2. Add Session Name Generation
**File**: `src/main/SessionNameGenerator.ts` (update existing)

Use Claude to summarize the first prompt into a short session name (4-6 words).

#### 3. Update Sidebar Session Visibility
**File**: `src/renderer/components/Sidebar/WorkspaceNavItem.tsx`

Only show sessions with non-empty names:
```typescript
const visibleSessions = workspace.sessions.filter(s => s.name.length > 0);
```

#### 4. Update SessionView Component
**File**: `src/renderer/components/Views/SessionView.tsx`

Ensure it:
- Uses workspace.path as cwd
- Renders FileExplorer with workspace.path
- Passes correct instanceId to AgentPanel

### Success Criteria

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] Agent communication works

#### Manual Verification:
- [ ] Typing in centered input and submitting creates session
- [ ] Session appears in sidebar after name is generated
- [ ] Clicking session shows conversation
- [ ] File explorer shows workspace folder contents

---

## Phase 6: Workspace-Scoped File Explorer & Preview

### Overview
Ensure file explorer and preview are always scoped to the active workspace's cwd.

### Changes Required

#### 1. Update FileExplorer Integration
**File**: `src/renderer/components/Views/SessionView.tsx`

```typescript
export function SessionView({ workspace, sessionId }: Props) {
  const session = useWorkspaceStore(s => s.getSession(workspace.id, sessionId));

  // Always use workspace.path as the root
  const cwd = workspace.path;

  return (
    <PanelGroup direction="horizontal">
      <Panel id="explorer">
        <FileExplorer
          rootPath={cwd}
          selectedPath={activePreviewPath}
          onSelectFile={handleSelectFile}
        />
      </Panel>
      <Panel id="agent">
        <AgentPanel
          instanceId={session?.instanceId ?? ''}
          cwd={cwd}
        />
      </Panel>
      <Panel id="preview">
        <PreviewPanel
          filePath={activePreviewPath}
          rootPath={cwd}
        />
      </Panel>
    </PanelGroup>
  );
}
```

#### 2. Update Preview Panel
**File**: `src/renderer/components/Preview/PreviewPanel.tsx`

Ensure file paths are resolved relative to workspace.path.

#### 3. Verify Git Integration
**File**: `src/renderer/components/FileExplorer/FileExplorer.tsx`

Git status should work when workspace.isGitRepo is true:
```typescript
useEffect(() => {
  if (workspace.isGitRepo && rootPath) {
    refreshGitStatus(rootPath);
  }
}, [workspace.isGitRepo, rootPath]);
```

### Success Criteria

#### Automated Verification:
- [ ] Build passes: `npm run build`

#### Manual Verification:
- [ ] File explorer shows correct folder contents for active workspace
- [ ] Switching sessions between workspaces updates file explorer
- [ ] Git status indicators work for git workspaces
- [ ] Preview panel loads files correctly

---

## Phase 7: Cleanup & Polish

### Overview
Remove unused code, update styles, and ensure smooth UX.

### Changes Required

#### 1. Remove Unused Code
- Delete any remaining project-related code
- Remove tab-related CSS
- Clean up unused imports

#### 2. Update Styles
**File**: `src/renderer/components/Views/styles.css`

Add styles for:
- `.new-session-view` - centered layout
- `.workspace-dropdown` - dropdown styling
- `.prompt-input` - input matching reference

#### 3. Add Loading States
- Show loading indicator while session name generates
- Handle edge cases (no workspaces, deleted workspace, etc.)

#### 4. Update Keyboard Shortcuts
- `⌘+N` - New workspace (open folder dialog)
- `⌘+Shift+N` - New session in current workspace
- Remove tab-related shortcuts

### Success Criteria

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] No console warnings/errors

#### Manual Verification:
- [ ] UI is responsive and styled correctly
- [ ] Keyboard shortcuts work
- [ ] No visual glitches when navigating

---

## Testing Strategy

### Unit Tests
- workspaceStore CRUD operations
- navigationStore state changes
- Session name generation

### Integration Tests
- Full flow: create workspace → create session → conversation
- Workspace switching
- Session persistence

### Manual Testing Steps
1. Clear localStorage, open app fresh
2. Click "New Workspace" → folder dialog opens
3. Select a git repository folder
4. Workspace appears in sidebar with folder name
5. Centered input view shows with workspace name
6. Type a message and press enter
7. Session starts, conversation appears
8. After ~2 seconds, session appears in sidebar with generated name
9. Click session in sidebar → conversation loads
10. File explorer shows folder contents
11. Click another workspace → centered input for that workspace
12. Return to first workspace → previous session still there

## References

- Current architecture: `research/2026-02-05-multi-session-management.md`
- Reference UI: Screenshot with "Start new conversation in console-1"
- workspaceStore: `src/renderer/stores/workspaceStore.ts`
- navigationStore: `src/renderer/stores/navigationStore.ts`
