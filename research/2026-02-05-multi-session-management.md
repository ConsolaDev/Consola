---
date: 2026-02-05T14:00:00+01:00
git_commit: d1e43a53f58f1d1716b3732d6edbd77c4118b395
branch: main
repository: console-1
topic: "Multi-Session Management (Workspace & Project Scoped)"
tags: [research, codebase, sessions, sidebar, projects, workspaces]
status: complete
---

# Research: Multi-Session Management (Workspace & Project Scoped)

**Date**: 2026-02-05T14:00:00+01:00
**Git Commit**: d1e43a53f58f1d1716b3732d6edbd77c4118b395
**Branch**: main
**Repository**: console-1

## Research Question

How to add multi-session management that supports:
1. **Project-scoped sessions** - Sessions tied to a single project (single cwd)
2. **Workspace-scoped sessions** - Sessions spanning multiple projects (e.g., microservices)

The goal is running multiple agents in parallel with proper scope management.

## Summary

The codebase already has the foundational architecture to support this feature:

1. **Sidebar already has collapsible items** - Workspaces are collapsible with expand/collapse using Radix UI's `Collapsible` component
2. **Agent store supports multi-instance** - Instance IDs follow pattern `{contextId}-{suffix}` and multiple instances can run concurrently
3. **Session IDs exist** - SDK provides `sessionId` which is stored per instance
4. **Reserved IPC channels exist** - `SESSION_CREATE`, `SESSION_DESTROY`, `SESSION_LIST` are defined but not yet implemented

**Key Architecture Decision:** All sessions live at the workspace level with an optional `projectId`. This provides:
- Single source of truth for all sessions
- Natural support for both project-scoped and workspace-spanning sessions
- Cleaner data model without deeply nested structures

## Proposed Hierarchy

```
Workspace (collapsible)
├── Workspace Sessions (projectId: null)
│   ├── "Refactoring auth across services" ●
│   └── [+] New workspace session
└── Projects
    ├── api-gateway (collapsible)
    │   ├── "Fixing rate limiter"
    │   └── [+] New project session
    ├── user-service (collapsible)
    │   ├── "Adding OAuth flow"
    │   └── [+] New project session
    └── notification-service (collapsible)
        └── [+] New project session
```

The `[+]` at workspace level creates workspace-spanning sessions; `[+]` at project level creates project-scoped sessions.

## Detailed Findings

### Current Architecture

#### Sidebar Component Hierarchy

```
Sidebar (index.tsx)
├── WorkspaceNavItem (Collapsible)
│   ├── Chevron toggle
│   ├── Workspace name
│   └── Collapsible.Content
│       └── ProjectNavItem (NOT collapsible currently)
│           └── Project name
```

**Key Files:**
- `src/renderer/components/Sidebar/index.tsx:11-69` - Main sidebar
- `src/renderer/components/Sidebar/WorkspaceNavItem.tsx:13-80` - Collapsible workspace item
- `src/renderer/components/Sidebar/ProjectNavItem.tsx:11-43` - Simple project item (no collapsing)

#### Instance ID Naming Convention

**File:** `src/renderer/components/Views/ContentView.tsx:48-51`

```typescript
const contextId = projectId
  ? `project-${projectId}`
  : `workspace-${workspaceId}`;
const instanceId = `${contextId}-main`;  // Currently always "-main"
```

Currently only one instance per context (`-main`). To support multiple sessions, this needs to become dynamic.

#### Agent Store Multi-Instance Support

**File:** `src/renderer/stores/agentStore.ts`

The store already supports multiple instances:

```typescript
interface AgentState {
  instances: Record<string, InstanceState>;  // Line 142
  // ...
}
```

Each `InstanceState` (lines 85-110) contains:
- `sessionId: string | null` - SDK-assigned session identifier
- `model: string | null` - Model being used
- `messages: Message[]` - Chat history
- `toolHistory: ToolExecution[]` - Tool execution records
- `status: AgentStatus` - Running status

#### Reserved IPC Channels

**File:** `src/shared/constants.ts:13-16`

```typescript
SESSION_CREATE: 'session:create',
SESSION_DESTROY: 'session:destroy',
SESSION_LIST: 'session:list',
```

These are defined but not implemented - ready for use.

### Existing Patterns to Reuse

#### Collapsible Pattern (from WorkspaceNavItem)

**File:** `src/renderer/components/Sidebar/WorkspaceNavItem.tsx`

```typescript
// State tracking in navigationStore
const isExpanded = useNavigationStore((state) => state.isWorkspaceExpanded(workspace.id));

// Radix UI Collapsible
<Collapsible.Root open={isExpanded} onOpenChange={() => toggleExpanded(workspace.id)}>
  <Collapsible.Content className="workspace-collapsible-content">
    {/* Children */}
  </Collapsible.Content>
</Collapsible.Root>
```

**CSS Animation:** `src/renderer/components/Sidebar/styles.css:253-286`

```css
.workspace-collapsible-content[data-state='open'] {
  animation: collapsible-slide-down 150ms ease-out;
}
.workspace-collapsible-content[data-state='closed'] {
  animation: collapsible-slide-up 150ms ease-out;
}
```

#### Tab Cleanup Pattern

**File:** `src/renderer/stores/tabStore.ts:30-37`

```typescript
function destroyInstancesForContext(contextId: string): void {
  const agentStore = useAgentStore.getState();
  Object.keys(agentStore.instances)
    .filter(id => id.startsWith(contextId))
    .forEach(id => agentStore.destroyInstance(id));
}
```

This pattern should be extended for session cleanup.

## Proposed Data Model

### Session Type (NEW)

All sessions live at the workspace level with an optional `projectId` to indicate scope:

```typescript
// Add to workspaceStore.ts
interface Session {
  id: string;
  name: string;                    // User-editable, e.g., "Investigating Terminal Files"
  workspaceId: string;             // Always present - parent workspace
  projectId: string | null;        // null = workspace-wide, string = project-scoped
  paths: string[];                 // Working directories (single for project, multiple for workspace)
  instanceId: string;              // Agent instance ID
  createdAt: number;
  lastActiveAt: number;
}
```

**Key insight:** `projectId: null` indicates a workspace-spanning session, while `projectId: "abc123"` indicates a project-scoped session.

### Updated Workspace Type

```typescript
interface Workspace {
  id: string;
  name: string;
  projects: Project[];
  sessions: Session[];             // NEW: ALL sessions live here
  createdAt: number;
  updatedAt: number;
}
```

### Project Type (UNCHANGED)

```typescript
interface Project {
  id: string;
  name: string;
  path: string;
  isGitRepo: boolean;
  createdAt: number;
  lastOpenedAt: number;
  // NOTE: No sessions array - sessions are stored at workspace level
}
```

### Helper Functions for Filtering

```typescript
// Get workspace-level sessions (span multiple projects)
const getWorkspaceSessions = (workspace: Workspace): Session[] =>
  workspace.sessions.filter(s => s.projectId === null);

// Get sessions for a specific project
const getProjectSessions = (workspace: Workspace, projectId: string): Session[] =>
  workspace.sessions.filter(s => s.projectId === projectId);
```

### New Navigation State

```typescript
// Add to navigationStore.ts
interface NavigationState {
  // ... existing
  expandedProjects: Record<string, boolean>;  // NEW: Track expanded projects
  toggleProjectExpanded: (projectId: string) => void;
  setProjectExpanded: (projectId: string, expanded: boolean) => void;
  isProjectExpanded: (projectId: string) => boolean;
}
```

## Instance ID Strategy

Different patterns for project vs workspace sessions:

```
Project session:   workspace-{wsId}-project-{projId}-session-{sessionId}
Workspace session: workspace-{wsId}-session-{sessionId}
```

This maintains uniqueness and allows:
- Easy identification of session scope
- Pattern matching for cleanup (`workspace-{wsId}-*` cleans all workspace sessions)
- Clear identification in main process

## CWD Handling

### Project-Scoped Sessions

Simple - single working directory:

```typescript
// Project session
const session: Session = {
  projectId: "proj-123",
  paths: ["/Users/dev/api-gateway"],  // Single path
  // ...
};
```

### Workspace-Spanning Sessions

Multiple options for handling multi-project scope:

**Option 1: Multiple paths array**
```typescript
// Workspace session spanning 3 microservices
const session: Session = {
  projectId: null,
  paths: [
    "/Users/dev/api-gateway",
    "/Users/dev/user-service",
    "/Users/dev/notification-service"
  ],
  // ...
};
```

**Option 2: Common ancestor as primary CWD**
```typescript
// Find common root and pass project paths as context
const commonRoot = findCommonAncestor(workspace.projects.map(p => p.path));
// cwd = "/Users/dev"
// Agent receives project paths as additional context
```

**Option 3: User selects primary project**
```typescript
// User picks one project as "home base", others are accessible
const session: Session = {
  projectId: null,
  primaryPath: "/Users/dev/api-gateway",  // Main cwd
  additionalPaths: ["/Users/dev/user-service"],  // Accessible paths
  // ...
};
```

**Recommendation:** Start with Option 1 (multiple paths array). The agent service can use the first path as primary CWD and provide the full list as context.

## UI Component Changes Required

### 1. SessionNavItem (New Component)

```typescript
// src/renderer/components/Sidebar/SessionNavItem.tsx
interface SessionNavItemProps {
  session: Session;
  workspaceId: string;
}

// Features:
// - Session name (truncated with ellipsis)
// - Blue dot indicator when agent is running
// - Context menu: Rename, Delete
// - Click to switch to session
// - Indentation based on whether it's under workspace or project
```

### 2. WorkspaceNavItem Modifications

Add workspace-level sessions section:

```typescript
// Changes needed:
// 1. Add workspace sessions section after workspace header
// 2. Add "+" button for new workspace session
// 3. Render SessionNavItem for each workspace session (projectId === null)
// 4. Show "No sessions" placeholder when empty
```

### 3. ProjectNavItem Modifications

Transform from simple button to collapsible container:

```typescript
// Changes needed:
// 1. Add Collapsible.Root wrapper
// 2. Add chevron toggle button
// 3. Add "+" button for new project session
// 4. Add Collapsible.Content with session list
// 5. Filter sessions by projectId
// 6. Show "No sessions" placeholder when empty
```

### 4. CreateSessionDialog (New Component)

```typescript
// src/renderer/components/Dialogs/CreateSessionDialog.tsx
interface CreateSessionDialogProps {
  workspaceId: string;
  projectId: string | null;  // null for workspace session
  onClose: () => void;
}

// Features:
// - Optional session name input (auto-generate if empty)
// - For workspace sessions: optionally select which projects to include
// - Create button
// - Auto-focus on creation
```

## Tab System Considerations

**Recommendation:** Keep current tab types, track active session in state.

- Keep `TabType = 'home' | 'workspace' | 'project'`
- Add `activeSessionId` to workspace/project tab state or a separate store
- Session switching happens within the content area
- This avoids tab explosion when many sessions exist

```typescript
// Option: Add to a sessionStore or extend tabStore
interface SessionNavigation {
  activeSessionId: Record<string, string>;  // contextId -> sessionId
  setActiveSession: (contextId: string, sessionId: string) => void;
  getActiveSession: (contextId: string) => string | null;
}
```

## Code References

### Sidebar Components
- `src/renderer/components/Sidebar/index.tsx:11-69` - Main sidebar
- `src/renderer/components/Sidebar/WorkspaceNavItem.tsx:13-80` - Collapsible pattern reference
- `src/renderer/components/Sidebar/ProjectNavItem.tsx:11-43` - Needs modification
- `src/renderer/components/Sidebar/styles.css:253-286` - Collapsible animations

### State Management
- `src/renderer/stores/workspaceStore.ts:4-145` - Project/Workspace types and store
- `src/renderer/stores/navigationStore.ts:6-59` - Navigation state (add expandedProjects)
- `src/renderer/stores/agentStore.ts:84-110` - InstanceState structure
- `src/renderer/stores/tabStore.ts:30-37` - Cleanup pattern

### Instance Management
- `src/renderer/components/Views/ContentView.tsx:48-51` - Instance ID generation
- `src/main/ipc-handlers.ts:13` - Agent services map
- `src/shared/constants.ts:13-16` - Reserved session IPC channels

### SDK Integration
- `src/main/ClaudeAgentService.ts:348` - Session ID assignment
- `src/shared/types.ts:58-64` - AgentInitEvent with sessionId

## Architecture Documentation

### Current Flow
```
User clicks Project → Tab opens → ContentView renders →
Single agent instance created (project-{id}-main) →
Messages sent/received through that instance
```

### Proposed Flow (Project Session)
```
User clicks Project → Project expands in sidebar →
Shows existing project sessions + "+" button →
User clicks session OR creates new →
ContentView uses session's instanceId →
Messages scoped to that session (cwd = project.path)
```

### Proposed Flow (Workspace Session)
```
User clicks "+" at workspace level →
Dialog asks for name and optionally which projects to include →
Session created with projectId: null, paths: [...] →
ContentView uses session's instanceId →
Agent has access to multiple project paths
```

### Session Lifecycle
1. **Creation**: User clicks "+" → Dialog (name, scope) → Session created in store → Instance ID generated
2. **Activation**: User clicks session → Active session updated → ContentView uses session's instanceId
3. **Running**: Blue dot shows when agent is processing (check `agentStore.instances[instanceId].status`)
4. **Destruction**: User deletes session → Instance destroyed → Store updated → UI refreshes

### Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        workspaceStore                           │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Workspace                                                │   │
│  │  ├── sessions: Session[]  ◄── All sessions live here    │   │
│  │  │    ├── { projectId: null, paths: [...] }  (workspace) │   │
│  │  │    ├── { projectId: "p1", paths: [...] }  (project)   │   │
│  │  │    └── { projectId: "p2", paths: [...] }  (project)   │   │
│  │  └── projects: Project[]                                 │   │
│  │       ├── { id: "p1", path: "/dev/api" }                │   │
│  │       └── { id: "p2", path: "/dev/users" }              │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         agentStore                              │
│  instances: {                                                   │
│    "workspace-ws1-session-s1": InstanceState,      (workspace)  │
│    "workspace-ws1-project-p1-session-s2": InstanceState,        │
│    "workspace-ws1-project-p2-session-s3": InstanceState,        │
│  }                                                              │
└─────────────────────────────────────────────────────────────────┘
```

## Open Questions

1. **Session persistence**: Should sessions persist across app restarts? Currently instances are ephemeral, but session metadata could be persisted. **Recommendation:** Persist session metadata (name, paths), but messages/history can be ephemeral unless explicitly saved.

2. **Session naming**: Auto-generate names from first message, or require user input? **Recommendation:** Optional input with auto-generation fallback (e.g., "Session 1", "Session 2" or timestamp-based).

3. **Maximum sessions**: Should there be a limit per project/workspace for performance? **Recommendation:** No hard limit initially, but consider UI warnings if too many active sessions.

4. **Session state indicators**: The reference image shows a blue dot. Full set of states:
   - No indicator: Idle/inactive
   - Blue dot: Running/processing
   - Red dot: Error state
   - Checkmark: Completed successfully (optional)

5. **Workspace session project selection**: When creating a workspace session, should user explicitly select projects or default to all? **Recommendation:** Default to all projects, with option to exclude some.

## Implementation Order

1. **Phase 1: Data Model**
   - Add `Session` interface to `workspaceStore.ts`
   - Add `sessions: Session[]` to `Workspace` interface
   - Add CRUD actions for sessions
   - Add `expandedProjects` to `navigationStore.ts`

2. **Phase 2: Project Sessions UI**
   - Create `SessionNavItem` component
   - Modify `ProjectNavItem` to be collapsible
   - Add session list under each project
   - Create `CreateSessionDialog`

3. **Phase 3: Instance Integration**
   - Update `ContentView` to use session's instanceId
   - Update instance ID generation logic
   - Add session activation tracking

4. **Phase 4: Workspace Sessions**
   - Add workspace-level sessions section in sidebar
   - Update `CreateSessionDialog` for workspace scope
   - Handle multi-path CWD for workspace sessions

5. **Phase 5: Polish**
   - Session state indicators
   - Session rename functionality
   - Keyboard shortcuts for session switching
   - Session persistence across restarts
