# Implementation Plan: Multi-Session Management

**Date**: 2026-02-05
**Based on**: research/2026-02-05-multi-session-management.md
**Status**: Ready for Implementation

## Overview

Implement multi-session management supporting project-scoped and workspace-spanning sessions with full persistence, lazy session creation, and automatic AI-generated session names.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Persistence | Full (metadata + history) | User preference for complete session restoration |
| Multi-CWD handling | First project as primary | Simple, predictable; other paths as context |
| Session naming | AI-generated from first query | Avoids empty sessions, meaningful names |
| Session creation | Lazy (on first message) | No empty sessions cluttering the UI |

## Current State Analysis

### Existing Infrastructure (Ready to Use)
- Agent store multi-instance support: `instances: Record<string, InstanceState>` (`agentStore.ts:142`)
- Collapsible UI pattern: `WorkspaceNavItem.tsx` with Radix UI
- Reserved IPC channels: `SESSION_CREATE`, `SESSION_DESTROY`, `SESSION_LIST` (`constants.ts:13-16`)
- Instance cleanup pattern: `destroyInstancesForContext()` (`tabStore.ts:30-37`)
- ID generation pattern: `generateId()` (`workspaceStore.ts:32-34`)

### What Needs to Be Built
- Session data model and persistence
- Collapsible ProjectNavItem with session list
- Workspace-level sessions section
- Session creation flow with lazy creation
- AI-powered session name generation
- Session state indicators (idle/running/error)

## Desired End State

```
Workspace (collapsible)
├── Workspace Sessions (projectId: null)
│   ├── "Refactoring auth across services" ●
│   └── [+] New workspace session
└── Projects
    ├── api-gateway (collapsible)
    │   ├── "Fixing rate limiter" ●
    │   ├── "Adding pagination"
    │   └── [+] New project session
    └── user-service (collapsible)
        ├── "Implementing OAuth"
        └── [+] New project session
```

- Sessions persist across app restarts (metadata + chat history)
- Blue dot indicates running agent
- Sessions created lazily on first message
- Session names auto-generated via AI summary of first query
- Clicking a session switches the content view to that session's agent instance

## What We're NOT Doing

- Session sharing between users (single-user app)
- Session branching/forking
- Session templates
- Maximum session limits
- Session archiving/hiding (delete only)

---

## Phase 1: Data Model & Persistence

### Overview
Establish the Session type and extend the workspace store to support sessions with full persistence.

### Changes Required

#### 1. Session Type Definition
**File**: `src/renderer/stores/workspaceStore.ts`

Add new interface after existing types:

```typescript
interface Session {
  id: string;
  name: string;                    // AI-generated or user-provided
  workspaceId: string;             // Parent workspace
  projectId: string | null;        // null = workspace-wide, string = project-scoped
  paths: string[];                 // Working directories (first is primary CWD)
  instanceId: string;              // Agent instance ID
  createdAt: number;
  lastActiveAt: number;
}
```

#### 2. Workspace Type Extension
**File**: `src/renderer/stores/workspaceStore.ts`

Update Workspace interface:

```typescript
interface Workspace {
  id: string;
  name: string;
  projects: Project[];
  sessions: Session[];             // NEW: All sessions live here
  createdAt: number;
  updatedAt: number;
}
```

#### 3. Session CRUD Actions
**File**: `src/renderer/stores/workspaceStore.ts`

Add to WorkspaceStore interface and implement:

```typescript
// Session management
createSession: (workspaceId: string, session: Omit<Session, 'id' | 'createdAt' | 'lastActiveAt'>) => Session;
updateSession: (workspaceId: string, sessionId: string, updates: Partial<Session>) => void;
deleteSession: (workspaceId: string, sessionId: string) => void;
getWorkspaceSessions: (workspaceId: string) => Session[];
getProjectSessions: (workspaceId: string, projectId: string) => Session[];
updateSessionActivity: (workspaceId: string, sessionId: string) => void;
```

#### 4. Migration for Existing Workspaces
**File**: `src/renderer/stores/workspaceStore.ts`

Update persist middleware to handle workspaces without sessions:

```typescript
// In persist configuration
migrate: (persistedState: any, version: number) => {
  if (version < 2) {
    // Add empty sessions array to existing workspaces
    persistedState.workspaces = persistedState.workspaces.map((ws: any) => ({
      ...ws,
      sessions: ws.sessions || []
    }));
  }
  return persistedState;
},
version: 2,
```

### Success Criteria

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] Type checking passes: `npm run typecheck`
- [ ] Tests pass: `npm test`

#### Manual Verification:
- [ ] Existing workspaces load without errors
- [ ] New workspaces created with empty sessions array
- [ ] Console shows no persistence errors

---

## Phase 2: Navigation State Extension

### Overview
Extend the navigation store to track expanded projects for the collapsible UI.

### Changes Required

#### 1. Expanded Projects State
**File**: `src/renderer/stores/navigationStore.ts`

Add to NavigationState interface:

```typescript
interface NavigationState {
  // ... existing
  expandedProjects: Record<string, boolean>;
  toggleProjectExpanded: (projectId: string) => void;
  setProjectExpanded: (projectId: string, expanded: boolean) => void;
  isProjectExpanded: (projectId: string) => boolean;
}
```

Implement the actions (similar pattern to `expandedWorkspaces`):

```typescript
expandedProjects: {},
toggleProjectExpanded: (projectId) =>
  set((state) => ({
    expandedProjects: {
      ...state.expandedProjects,
      [projectId]: !state.isProjectExpanded(projectId),
    },
  })),
setProjectExpanded: (projectId, expanded) =>
  set((state) => ({
    expandedProjects: {
      ...state.expandedProjects,
      [projectId]: expanded,
    },
  })),
isProjectExpanded: (projectId) => {
  const state = get();
  return state.expandedProjects[projectId] ?? true; // Default expanded
},
```

#### 2. Active Session Tracking
**File**: `src/renderer/stores/navigationStore.ts`

Add active session state:

```typescript
// Track active session per context
activeSessionId: Record<string, string | null>;  // contextId -> sessionId
setActiveSession: (contextId: string, sessionId: string | null) => void;
getActiveSession: (contextId: string) => string | null;
```

### Success Criteria

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] Type checking passes: `npm run typecheck`

#### Manual Verification:
- [ ] Navigation state persists correctly
- [ ] No console errors on load

---

## Phase 3: SessionNavItem Component

### Overview
Create the new SessionNavItem component for displaying sessions in the sidebar.

### Changes Required

#### 1. SessionNavItem Component
**File**: `src/renderer/components/Sidebar/SessionNavItem.tsx` (NEW)

```typescript
interface SessionNavItemProps {
  session: Session;
  workspaceId: string;
  isActive: boolean;
  indentLevel: 1 | 2;  // 1 for workspace sessions, 2 for project sessions
}
```

Features:
- Session name (truncated with ellipsis)
- Status indicator dot (idle: none, running: blue, error: red)
- Click to activate session
- Context menu: Rename, Delete
- Proper indentation based on level

#### 2. Session Status Integration
**File**: `src/renderer/components/Sidebar/SessionNavItem.tsx`

Get agent status from agentStore:

```typescript
const instanceStatus = useAgentStore(
  (state) => state.instances[session.instanceId]?.status ?? 'idle'
);
```

Render indicator:
- No dot: idle
- Blue animated dot: running
- Red dot: error

#### 3. Styles
**File**: `src/renderer/components/Sidebar/styles.css`

Add session-specific styles:
- `.session-nav-item` - Base styling
- `.session-nav-item--active` - Selected state
- `.session-status-indicator` - Status dot
- `.session-status-indicator--running` - Blue with pulse animation
- `.session-status-indicator--error` - Red dot
- `.session-nav-item--indent-1` - Workspace session indent
- `.session-nav-item--indent-2` - Project session indent

### Success Criteria

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] Type checking passes: `npm run typecheck`

#### Manual Verification:
- [ ] Component renders correctly in Storybook or test harness
- [ ] Status indicators animate correctly

---

## Phase 4: Collapsible ProjectNavItem

### Overview
Transform ProjectNavItem from a simple button to a collapsible container with session list.

### Changes Required

#### 1. ProjectNavItem Refactor
**File**: `src/renderer/components/Sidebar/ProjectNavItem.tsx`

Wrap with Collapsible (pattern from WorkspaceNavItem):

```typescript
import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronRight, Plus } from 'lucide-react';

interface ProjectNavItemProps {
  project: Project;
  workspaceId: string;
  sessions: Session[];  // NEW: filtered sessions for this project
  isSelected: boolean;
  onClick: () => void;
}
```

Structure:
```jsx
<Collapsible.Root open={isExpanded} onOpenChange={() => toggleExpanded(project.id)}>
  <div className="project-nav-item">
    <Collapsible.Trigger>
      <ChevronRight className={`chevron ${isExpanded ? 'expanded' : ''}`} />
    </Collapsible.Trigger>
    <button onClick={onClick}>{project.name}</button>
    <button onClick={handleAddSession}><Plus size={14} /></button>
  </div>
  <Collapsible.Content className="project-collapsible-content">
    {sessions.map(session => (
      <SessionNavItem key={session.id} session={session} ... />
    ))}
    {sessions.length === 0 && <EmptySessionPlaceholder />}
  </Collapsible.Content>
</Collapsible.Root>
```

#### 2. Styles Update
**File**: `src/renderer/components/Sidebar/styles.css`

Add project collapsible styles (copy pattern from workspace):
- `.project-collapsible-content` - Animation container
- `.project-nav-item` - Flex layout for chevron, name, add button
- `.project-chevron` - Rotation animation

#### 3. Update Sidebar
**File**: `src/renderer/components/Sidebar/index.tsx` or `WorkspaceNavItem.tsx`

Pass filtered sessions to ProjectNavItem:

```typescript
const projectSessions = workspace.sessions.filter(s => s.projectId === project.id);
<ProjectNavItem
  project={project}
  sessions={projectSessions}
  ...
/>
```

### Success Criteria

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] Type checking passes: `npm run typecheck`

#### Manual Verification:
- [ ] Projects expand/collapse smoothly
- [ ] Sessions appear under correct projects
- [ ] Add button appears on hover
- [ ] Empty state shows placeholder

---

## Phase 5: Workspace Sessions Section

### Overview
Add a section in WorkspaceNavItem for workspace-level sessions.

### Changes Required

#### 1. WorkspaceNavItem Update
**File**: `src/renderer/components/Sidebar/WorkspaceNavItem.tsx`

Add workspace sessions section after workspace header, before projects:

```jsx
<Collapsible.Content className="workspace-collapsible-content">
  {/* Workspace Sessions Section */}
  <div className="workspace-sessions-section">
    <div className="section-header">
      <span>Sessions</span>
      <button onClick={handleAddWorkspaceSession}><Plus size={14} /></button>
    </div>
    {workspaceSessions.map(session => (
      <SessionNavItem key={session.id} session={session} indentLevel={1} ... />
    ))}
    {workspaceSessions.length === 0 && <EmptySessionPlaceholder text="No workspace sessions" />}
  </div>

  {/* Projects Section */}
  <div className="projects-section">
    ...existing project rendering...
  </div>
</Collapsible.Content>
```

Filter workspace sessions:
```typescript
const workspaceSessions = workspace.sessions.filter(s => s.projectId === null);
```

#### 2. Styles
**File**: `src/renderer/components/Sidebar/styles.css`

Add workspace sessions section styling:
- `.workspace-sessions-section` - Container
- `.section-header` - Label + add button layout
- Appropriate spacing between sections

### Success Criteria

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] Type checking passes: `npm run typecheck`

#### Manual Verification:
- [ ] Workspace sessions appear above projects
- [ ] Add button creates workspace session (projectId: null)
- [ ] Visual separation between sections

---

## Phase 6: Draft Session State (Lazy Creation)

### Overview
Implement lazy session creation - track a "draft" session state until first message is sent.

### Changes Required

#### 1. Draft Session State
**File**: `src/renderer/stores/navigationStore.ts`

Add draft session tracking:

```typescript
interface DraftSession {
  workspaceId: string;
  projectId: string | null;
  paths: string[];
  instanceId: string;  // Pre-generated for the agent panel
}

// In NavigationState
draftSession: DraftSession | null;
createDraftSession: (workspaceId: string, projectId: string | null, paths: string[]) => string; // Returns instanceId
commitDraftSession: (name: string) => Session | null;  // Creates real session
discardDraftSession: () => void;
```

#### 2. Instance ID Generation
**File**: `src/renderer/stores/navigationStore.ts`

```typescript
function generateSessionInstanceId(workspaceId: string, projectId: string | null): string {
  const sessionId = generateId();
  if (projectId) {
    return `workspace-${workspaceId}-project-${projectId}-session-${sessionId}`;
  }
  return `workspace-${workspaceId}-session-${sessionId}`;
}
```

#### 3. ContentView Integration
**File**: `src/renderer/components/Views/ContentView.tsx`

Update to use session instanceId or draft:

```typescript
// Determine instanceId
let instanceId: string;
const activeSessionId = getActiveSession(contextId);
const draftSession = getDraftSession();

if (draftSession && draftSession.workspaceId === workspaceId && draftSession.projectId === projectId) {
  instanceId = draftSession.instanceId;
} else if (activeSessionId) {
  const session = findSession(workspaceId, activeSessionId);
  instanceId = session?.instanceId ?? `${contextId}-main`;
} else {
  // Legacy fallback or first load
  instanceId = `${contextId}-main`;
}
```

### Success Criteria

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] Type checking passes: `npm run typecheck`

#### Manual Verification:
- [ ] Clicking "+" creates draft without persisting
- [ ] Draft session shows in UI but not saved
- [ ] Navigating away discards draft (with confirmation?)

---

## Phase 7: AI Session Name Generation

### Overview
When user sends first message in a draft session, generate session name via AI and commit session.

### Changes Required

#### 1. Session Name Generation Service
**File**: `src/main/services/sessionNameGenerator.ts` (NEW)

```typescript
import Anthropic from '@anthropic-ai/sdk';

export async function generateSessionName(query: string): Promise<string> {
  const client = new Anthropic();

  const response = await client.messages.create({
    model: 'claude-haiku-3-5-20241022',
    max_tokens: 50,
    messages: [{
      role: 'user',
      content: `Summarize this query into a short session title (3-5 words, no quotes, no punctuation at end):\n\n"${query}"`
    }]
  });

  const name = response.content[0].type === 'text'
    ? response.content[0].text.trim()
    : 'New Session';

  return name.slice(0, 50); // Enforce max length
}
```

#### 2. IPC Handler
**File**: `src/main/ipc-handlers.ts`

Add handler for session name generation:

```typescript
ipcMain.handle(IPC_CHANNELS.SESSION_CREATE, async (event, { query }) => {
  const name = await generateSessionName(query);
  return { name };
});
```

#### 3. Commit Draft on First Message
**File**: `src/renderer/components/Agent/AgentPanel.tsx` or hook

When sending first message in a draft session:

```typescript
const sendMessage = async (prompt: string) => {
  // Check if this is a draft session
  const draftSession = getDraftSession();
  if (draftSession && draftSession.instanceId === instanceId) {
    // Generate name in background, don't block sending
    window.electronAPI.createSession({ query: prompt }).then(({ name }) => {
      commitDraftSession(name);
    });
  }

  // Send message as normal
  await originalSendMessage(prompt);
};
```

### Success Criteria

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

#### Manual Verification:
- [ ] First message triggers name generation
- [ ] Session persists after name is generated
- [ ] Name appears in sidebar
- [ ] Works offline with fallback name

---

## Phase 8: Session Persistence (Chat History)

### Overview
Persist chat history per session to restore on app restart.

### Changes Required

#### 1. Session History Storage
**File**: `src/main/services/sessionStorage.ts` (NEW)

```typescript
import { app } from 'electron';
import path from 'path';
import fs from 'fs/promises';

const SESSIONS_DIR = path.join(app.getPath('userData'), 'sessions');

interface PersistedSessionData {
  messages: Message[];
  toolHistory: ToolExecution[];
}

export async function saveSessionData(sessionId: string, data: PersistedSessionData): Promise<void> {
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

export async function loadSessionData(sessionId: string): Promise<PersistedSessionData | null> {
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function deleteSessionData(sessionId: string): Promise<void> {
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  try {
    await fs.unlink(filePath);
  } catch {
    // File may not exist
  }
}
```

#### 2. IPC Handlers
**File**: `src/main/ipc-handlers.ts`

```typescript
ipcMain.handle('session:save-history', async (event, { sessionId, data }) => {
  await saveSessionData(sessionId, data);
});

ipcMain.handle('session:load-history', async (event, { sessionId }) => {
  return await loadSessionData(sessionId);
});

ipcMain.handle('session:delete-history', async (event, { sessionId }) => {
  await deleteSessionData(sessionId);
});
```

#### 3. Preload Exposure
**File**: `src/preload/index.ts`

Expose session storage methods:

```typescript
saveSessionHistory: (sessionId: string, data: any) =>
  ipcRenderer.invoke('session:save-history', { sessionId, data }),
loadSessionHistory: (sessionId: string) =>
  ipcRenderer.invoke('session:load-history', { sessionId }),
deleteSessionHistory: (sessionId: string) =>
  ipcRenderer.invoke('session:delete-history', { sessionId }),
```

#### 4. Agent Store Integration
**File**: `src/renderer/stores/agentStore.ts`

Add persistence hooks:

```typescript
// Save on message changes (debounced)
saveInstanceHistory: async (instanceId: string) => {
  const instance = get().instances[instanceId];
  if (instance) {
    await window.electronAPI.saveSessionHistory(instanceId, {
      messages: instance.messages,
      toolHistory: instance.toolHistory,
    });
  }
},

// Load on instance creation
loadInstanceHistory: async (instanceId: string) => {
  const data = await window.electronAPI.loadSessionHistory(instanceId);
  if (data) {
    set((state) => ({
      instances: {
        ...state.instances,
        [instanceId]: {
          ...state.instances[instanceId],
          messages: data.messages,
          toolHistory: data.toolHistory,
        },
      },
    }));
  }
},
```

#### 5. Auto-Save Debouncing
**File**: `src/renderer/hooks/useAgent.ts` or similar

Add debounced save when messages change:

```typescript
useEffect(() => {
  const timeoutId = setTimeout(() => {
    if (messages.length > 0) {
      saveInstanceHistory(instanceId);
    }
  }, 2000); // Save after 2s of inactivity

  return () => clearTimeout(timeoutId);
}, [messages, instanceId]);
```

### Success Criteria

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`

#### Manual Verification:
- [ ] Chat history persists across app restart
- [ ] Session loads with previous messages
- [ ] Deleting session removes history file

---

## Phase 9: Session Activation & Switching

### Overview
Wire up session switching in the UI and ensure ContentView displays the correct session.

### Changes Required

#### 1. Session Click Handler
**File**: `src/renderer/components/Sidebar/SessionNavItem.tsx`

```typescript
const handleClick = () => {
  const contextId = session.projectId
    ? `project-${session.projectId}`
    : `workspace-${session.workspaceId}`;

  // Set active session
  setActiveSession(contextId, session.id);

  // Load history if not already loaded
  if (!instances[session.instanceId]) {
    loadInstanceHistory(session.instanceId);
  }

  // If on different tab, switch to appropriate tab
  if (session.projectId) {
    openProjectTab(session.workspaceId, session.projectId);
  } else {
    openWorkspaceTab(session.workspaceId);
  }
};
```

#### 2. ContentView Session Awareness
**File**: `src/renderer/components/Views/ContentView.tsx`

Update to render active session:

```typescript
const activeSessionId = useNavigationStore(
  (state) => state.getActiveSession(contextId)
);

const workspace = useWorkspaceStore(
  (state) => state.workspaces.find(ws => ws.id === workspaceId)
);

const activeSession = workspace?.sessions.find(s => s.id === activeSessionId);

const instanceId = activeSession?.instanceId ?? `${contextId}-main`;
const cwd = activeSession?.paths[0] ?? projectPath ?? workspacePath;
```

#### 3. Session Tab in Header
**File**: `src/renderer/components/Views/ContentView.tsx` or new component

Add session name display at top of content area:

```typescript
{activeSession && (
  <div className="session-header">
    <span>{activeSession.name}</span>
    <button onClick={() => setActiveSession(contextId, null)}>
      Back to sessions
    </button>
  </div>
)}
```

### Success Criteria

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] Type checking passes: `npm run typecheck`

#### Manual Verification:
- [ ] Clicking session switches content view
- [ ] Active session highlighted in sidebar
- [ ] Session name displayed in content header
- [ ] "Back" returns to session list view

---

## Phase 10: Session Management (Rename/Delete)

### Overview
Implement session rename and delete functionality.

### Changes Required

#### 1. Context Menu
**File**: `src/renderer/components/Sidebar/SessionNavItem.tsx`

Add context menu (use existing pattern or Radix ContextMenu):

```typescript
<ContextMenu.Root>
  <ContextMenu.Trigger asChild>
    <button className="session-nav-item">...</button>
  </ContextMenu.Trigger>
  <ContextMenu.Content>
    <ContextMenu.Item onSelect={() => setIsRenaming(true)}>
      Rename
    </ContextMenu.Item>
    <ContextMenu.Item onSelect={handleDelete} className="destructive">
      Delete
    </ContextMenu.Item>
  </ContextMenu.Content>
</ContextMenu.Root>
```

#### 2. Inline Rename
**File**: `src/renderer/components/Sidebar/SessionNavItem.tsx`

```typescript
const [isRenaming, setIsRenaming] = useState(false);
const [newName, setNewName] = useState(session.name);

const handleRename = () => {
  if (newName.trim() && newName !== session.name) {
    updateSession(session.workspaceId, session.id, { name: newName.trim() });
  }
  setIsRenaming(false);
};

// In render
{isRenaming ? (
  <input
    value={newName}
    onChange={(e) => setNewName(e.target.value)}
    onBlur={handleRename}
    onKeyDown={(e) => e.key === 'Enter' && handleRename()}
    autoFocus
  />
) : (
  <span>{session.name}</span>
)}
```

#### 3. Delete with Cleanup
**File**: `src/renderer/components/Sidebar/SessionNavItem.tsx`

```typescript
const handleDelete = async () => {
  // Confirm if session has history
  if (session.messages?.length > 0) {
    const confirmed = await confirm('Delete this session and its history?');
    if (!confirmed) return;
  }

  // Clean up agent instance
  destroyInstance(session.instanceId);

  // Delete persisted history
  await window.electronAPI.deleteSessionHistory(session.id);

  // Remove from store
  deleteSession(session.workspaceId, session.id);

  // Clear active session if this was it
  if (getActiveSession(contextId) === session.id) {
    setActiveSession(contextId, null);
  }
};
```

### Success Criteria

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] Type checking passes: `npm run typecheck`

#### Manual Verification:
- [ ] Right-click shows context menu
- [ ] Rename inline editing works
- [ ] Delete removes session from sidebar
- [ ] Delete cleans up agent instance
- [ ] Delete removes persisted history file

---

## Phase 11: Polish & Edge Cases

### Overview
Handle edge cases, add keyboard shortcuts, and polish the UX.

### Changes Required

#### 1. Keyboard Shortcuts
**File**: `src/renderer/hooks/useKeyboardShortcuts.ts` or similar

- `Cmd/Ctrl + N` - New session in current context
- `Cmd/Ctrl + W` - Close/delete current session
- `Cmd/Ctrl + [` / `]` - Switch between sessions

#### 2. Empty States
**File**: Various

- No sessions placeholder with CTA to create first session
- Draft session indicator in sidebar

#### 3. Loading States
**File**: `src/renderer/components/Sidebar/SessionNavItem.tsx`

- Show loading spinner while session history loads
- Show skeleton while waiting for AI name generation

#### 4. Error Handling
**File**: Various

- Handle name generation failure gracefully (use "New Session" fallback)
- Handle persistence failures (show toast, retry option)
- Handle invalid session state on load

#### 5. Migration Path
**File**: `src/renderer/stores/workspaceStore.ts`

For existing users:
- Auto-create a "Main" session for existing project instances
- Migrate existing chat history if any

### Success Criteria

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`
- [ ] No TypeScript errors: `npm run typecheck`
- [ ] No linting errors: `npm run lint`

#### Manual Verification:
- [ ] Keyboard shortcuts work
- [ ] Empty states render correctly
- [ ] Loading states appear appropriately
- [ ] Errors handled gracefully with user feedback
- [ ] Existing users upgraded seamlessly

---

## Testing Strategy

### Unit Tests
- Session CRUD operations in workspaceStore
- Instance ID generation patterns
- Session filtering (workspace vs project)
- Name generation service (mock API)

### Integration Tests
- Session creation flow (draft → commit)
- Session persistence (save → load)
- Session switching and activation
- Session deletion with cleanup

### Manual Testing Steps
1. Create a new workspace with 2 projects
2. Create a project session, send a message, verify name generation
3. Create a workspace session spanning both projects
4. Restart app, verify sessions and history persist
5. Rename a session via context menu
6. Delete a session, verify cleanup
7. Switch between sessions, verify correct content
8. Verify status indicators update correctly

---

## References

- Research document: `research/2026-02-05-multi-session-management.md`
- Collapsible pattern: `src/renderer/components/Sidebar/WorkspaceNavItem.tsx:13-80`
- Agent store multi-instance: `src/renderer/stores/agentStore.ts:142`
- Instance cleanup pattern: `src/renderer/stores/tabStore.ts:30-37`
- ID generation: `src/renderer/stores/workspaceStore.ts:32-34`
- Reserved IPC channels: `src/shared/constants.ts:13-16`
