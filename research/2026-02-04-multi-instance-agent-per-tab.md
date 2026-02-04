---
date: 2026-02-04T09:45:00-08:00
git_commit: f272f393b9a67ab7adabc91206969d5cee3c2713
branch: master
repository: console-1
topic: "Multi-Instance Claude Agent Architecture Per Tab"
tags: [research, codebase, agent, tabs, multi-instance]
status: complete
---

# Research: Multi-Instance Claude Agent Architecture Per Tab

**Date**: 2026-02-04T09:45:00-08:00
**Git Commit**: f272f393b9a67ab7adabc91206969d5cee3c2713
**Branch**: master
**Repository**: console-1

## Research Question

Figure out how to add independent Claude agent instances per tab (workspace/project), so conversations between tabs are isolated. This should also apply to the ContextPlaceholder in the future.

## Summary

The current architecture uses a **single global ClaudeAgentService** in the main process and a **single global Zustand store (agentStore)** in the renderer. All tabs share the same agent state and conversation. To achieve independent conversations per tab, the architecture needs to support multiple agent instances keyed by tab/workspace/project ID.

## Current Architecture

### 1. Tab System

**Location**: `src/renderer/stores/tabStore.ts`

Each tab has:
```typescript
interface Tab {
  id: string;              // 'home', 'workspace-{id}', 'project-{id}'
  type: TabType;           // 'home' | 'workspace' | 'project'
  targetId: string;        // ID of the workspace or project
  workspaceId?: string;    // Only for 'project' type tabs
}
```

Tab ID generation (lines 24-27):
- Home: `'home'`
- Workspace: `'workspace-{workspaceId}'`
- Project: `'project-{projectId}'`

### 2. Content Rendering Flow

**Location**: `src/renderer/components/Layout/TabContent.tsx`

```
TabContent reads activeTabId
  → Routes to ContentView with workspaceId/projectId
    → ContentView renders AgentPanel
      → AgentPanel uses useAgent() hook (GLOBAL state)
```

The `ContentView` receives `workspaceId` and optional `projectId` as props (lines 7-10), but these are NOT passed to `AgentPanel` - they're only used for header display.

### 3. Agent State (GLOBAL - Single Instance)

**Location**: `src/renderer/stores/agentStore.ts`

The current agent state is a **global singleton**:

```typescript
// Line 144 - Single Zustand store
export const useAgentStore = create<AgentState>()((set, get) => ({
  // All components share this single state
  messages: Message[];
  sessionId: string | null;
  activeTools: ToolExecution[];
  // ... etc
}));
```

The `useAgent()` hook (lines 9-76 in `useAgent.ts`) accesses this global store directly.

### 4. Main Process Agent Service (GLOBAL - Single Instance)

**Location**: `src/main/ipc-handlers.ts`

```typescript
// Line 21 - Single ClaudeAgentService
let agentService: ClaudeAgentService | null = null;
agentService = new ClaudeAgentService(process.cwd());
```

All IPC events go to/from this single service instance.

### 5. IPC Communication (No Instance Routing)

**Location**: `src/shared/constants.ts`

Current channels have no instance/session identifiers:
- `agent:start` - No target instance
- `agent:assistant-message` - No source instance
- etc.

## Key Components for Multi-Instance Support

### A. What Needs to Change

| Component | Current | Required for Multi-Instance |
|-----------|---------|----------------------------|
| `agentStore.ts` | Single global state | State partitioned by tabId/instanceId |
| `ClaudeAgentService` | Single instance | Map of instances keyed by instanceId |
| `ipc-handlers.ts` | Single service reference | Map of services, route by instanceId |
| IPC Channels | No instance routing | Include instanceId in all messages |
| `AgentPanel.tsx` | Uses global hook | Receives instanceId prop, uses scoped state |
| `ContentView.tsx` | No instance context | Passes instanceId to AgentPanel |
| `useAgent.ts` | Reads global state | Accepts instanceId parameter |

### B. Existing Multi-Instance Pattern (Terminal Services)

**Location**: `src/main/ipc-handlers.ts` (line 10)

The codebase already has a pattern for multi-instance support:

```typescript
// Line 10 - Map structure exists for terminals
const terminalServices: Map<string, TerminalService> = new Map();

// Line 18 - Currently only default instance
terminalServices.set(DEFAULT_INSTANCE_ID, terminalService);
```

Reserved channels for future session management:
```typescript
// src/shared/constants.ts lines 13-16
SESSION_CREATE: 'session:create',
SESSION_DESTROY: 'session:destroy',
SESSION_LIST: 'session:list',
```

### C. Instance ID Strategy

The natural instance ID would be the **tab ID** since it uniquely identifies each workspace/project context:

- `'workspace-abc123'` for workspace tabs
- `'project-def456'` for project tabs
- `'home'` could share a default instance or not have an agent

Alternatively, use `workspaceId` or `projectId` directly to allow conversation persistence when tab is closed and reopened.

## Detailed Component Analysis

### 1. agentStore.ts - State Structure

**Current** (lines 57-102):
```typescript
interface AgentState {
  messages: Message[];
  sessionId: string | null;
  activeTools: ToolExecution[];
  // ... global state
}
```

**For Multi-Instance** (conceptual):
```typescript
interface InstanceState {
  messages: Message[];
  sessionId: string | null;
  activeTools: ToolExecution[];
  // ... per-instance state
}

interface AgentState {
  instances: Map<string, InstanceState>;
  // Global status (isAvailable, etc.)
}
```

### 2. useAgent.ts - Hook Interface

**Current** (lines 9-76):
```typescript
export function useAgent() {
  const store = useAgentStore();
  // Returns global state directly
}
```

**For Multi-Instance**:
```typescript
export function useAgent(instanceId: string) {
  const store = useAgentStore();
  // Returns state scoped to instanceId
  const instanceState = store.getInstance(instanceId);
  const sendMessage = (prompt) => store.sendMessage(instanceId, prompt);
  // ...
}
```

### 3. AgentPanel.tsx - Component Props

**Current** (lines 9-20):
```typescript
export function AgentPanel() {
  const { messages, sendMessage, ... } = useAgent();
  // Uses global state
}
```

**For Multi-Instance**:
```typescript
interface AgentPanelProps {
  instanceId: string;
}

export function AgentPanel({ instanceId }: AgentPanelProps) {
  const { messages, sendMessage, ... } = useAgent(instanceId);
  // Uses instance-scoped state
}
```

### 4. ContentView.tsx - Instance Passing

**Current** (lines 54-56):
```typescript
<Panel id="agent" defaultSize="60%" minSize="20%">
  <AgentPanel />
</Panel>
```

**For Multi-Instance**:
```typescript
const instanceId = projectId
  ? `project-${projectId}`
  : `workspace-${workspaceId}`;

<Panel id="agent" defaultSize="60%" minSize="20%">
  <AgentPanel instanceId={instanceId} />
</Panel>
```

### 5. IPC Handlers - Instance Routing

**Current** (lines 138-148):
```typescript
ipcMain.on(AGENT_START, async (_, options) => {
  agentService.startQuery(options);
});
```

**For Multi-Instance**:
```typescript
ipcMain.on(AGENT_START, async (_, { instanceId, ...options }) => {
  let service = agentServices.get(instanceId);
  if (!service) {
    service = new ClaudeAgentService(getWorkingDir(instanceId));
    agentServices.set(instanceId, service);
    // Wire up event forwarding for this instance
  }
  service.startQuery(options);
});
```

### 6. ClaudeAgentService - Working Directory

**Current** (lines 98-100):
```typescript
constructor(cwd: string) {
  this.cwd = cwd;
}
```

Each instance would need its own `cwd` based on workspace/project path:
- Workspace: Could use a default or workspace-specific directory
- Project: Uses `project.path` from workspaceStore

## ContextPlaceholder Consideration

**Location**: `src/renderer/components/Views/ContextPlaceholder.tsx`

Currently a placeholder (lines 1-10). When implemented, it should:
1. Receive the same `instanceId` prop as AgentPanel
2. Access context files specific to that workspace/project
3. Share relevant context with the corresponding agent instance

The split panel layout in `ContentView.tsx` (lines 49-61) already keeps them as siblings:
```typescript
<Group orientation="horizontal">
  <Panel id="agent">
    <AgentPanel instanceId={instanceId} />  // Future
  </Panel>
  <Separator />
  <Panel id="context">
    <ContextPlaceholder instanceId={instanceId} />  // Future
  </Panel>
</Group>
```

## Code References

### Core Files to Modify

- `src/renderer/stores/agentStore.ts:144-303` - Partition state by instanceId
- `src/renderer/hooks/useAgent.ts:9-76` - Accept instanceId parameter
- `src/renderer/components/Agent/AgentPanel.tsx:9-87` - Accept instanceId prop
- `src/renderer/components/Views/ContentView.tsx:54-56` - Pass instanceId to AgentPanel
- `src/main/ipc-handlers.ts:21,138-163` - Manage Map of services
- `src/main/ClaudeAgentService.ts:98-100` - Per-instance working directory
- `src/shared/types.ts:87-93` - Add instanceId to AgentQueryOptions
- `src/preload/preload.ts:130-204` - Include instanceId in IPC calls

### Supporting Files

- `src/renderer/stores/tabStore.ts:24-27` - Tab ID generation (can reuse pattern)
- `src/renderer/stores/workspaceStore.ts:4-11` - Project path for working directory
- `src/shared/constants.ts:13-16` - Reserved session channels

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      RENDERER PROCESS                        │
├─────────────────────────────────────────────────────────────┤
│  TabContent                                                  │
│    └── ContentView (workspaceId, projectId)                 │
│          ├── AgentPanel (instanceId="project-abc")          │
│          │     └── useAgent("project-abc")                  │
│          │           └── agentStore.instances["project-abc"]│
│          └── ContextPlaceholder (instanceId="project-abc")  │
│                                                              │
│  TabContent (another tab)                                    │
│    └── ContentView (workspaceId2, projectId2)               │
│          ├── AgentPanel (instanceId="workspace-xyz")        │
│          │     └── useAgent("workspace-xyz")                │
│          │           └── agentStore.instances["workspace-xyz"]│
│          └── ContextPlaceholder (instanceId="workspace-xyz")│
├─────────────────────────────────────────────────────────────┤
│                       agentBridge                            │
│  startQuery({ instanceId, prompt, ... })                    │
│  Events include instanceId for routing                      │
└────────────────────────┬────────────────────────────────────┘
                         │ IPC (with instanceId)
┌────────────────────────┴────────────────────────────────────┐
│                      MAIN PROCESS                            │
├─────────────────────────────────────────────────────────────┤
│  ipc-handlers.ts                                            │
│    agentServices: Map<string, ClaudeAgentService>           │
│      ├── "project-abc" → ClaudeAgentService(projectPath)    │
│      └── "workspace-xyz" → ClaudeAgentService(workspacePath)│
│                                                              │
│  Each service has its own:                                  │
│    - Claude SDK session                                     │
│    - Working directory (cwd)                                │
│    - Event emitters (prefixed with instanceId)              │
└─────────────────────────────────────────────────────────────┘
```

## Open Questions

1. **Instance Lifecycle**: When should instances be created/destroyed?
   - On tab open/close?
   - On first message sent?
   - Persist across tab close/reopen?

2. **Memory Management**: How to limit concurrent instances?
   - LRU cache for inactive instances?
   - Hard limit on active services?

3. **State Persistence**: Should conversation history persist?
   - In memory only (current behavior)?
   - LocalStorage per instance?
   - File-based storage?

4. **Home Tab**: Should home tab have an agent instance?
   - No agent (current implicit behavior)?
   - Shared default instance?

5. **Working Directory Resolution**:
   - Workspace: Use first project path? Custom setting?
   - Project: Use `project.path` (clear choice)
