# Implementation Plan: Multi-Instance Claude Agent Per Tab

**Date**: 2026-02-04
**Based on**: research/2026-02-04-multi-instance-agent-per-tab.md
**Status**: Ready for Implementation

---

## Overview

Convert the single global Claude agent to support independent instances per workspace/project tab, enabling isolated conversations. Each tab will have its own agent with its own conversation history, session, and working directory.

## Design Decisions (Open Questions Resolved)

| Question | Decision | Rationale |
|----------|----------|-----------|
| Instance Lifecycle | Lazy creation on first message, destroy on tab close | Balances resource usage with good UX |
| Instance Key | `workspaceId` or `projectId` (not tabId) | Allows conversation persistence when tab is closed/reopened |
| Memory Management | No hard limits initially | ClaudeAgentService is lightweight; SDK is shared |
| State Persistence | In-memory only | Matches current behavior; structure supports future persistence |
| Home Tab | No agent instance | Home is a landing page, not a coding context |
| Working Directory | Project: `project.path`, Workspace: `process.cwd()` | Projects have clear paths; workspaces are general context |

## What We're NOT Doing

- **No conversation persistence to disk** - staying with in-memory (can add later)
- **No LRU cache for instances** - premature optimization
- **No agent for home tab** - no coding context
- **No changes to terminal multi-instance** - separate concern
- **No multiple agents per tab** - but architecture supports it (see below)

## Future Consideration: Multiple Agents Per Tab

The architecture is designed to support multiple agent instances within a single tab in the future:

| Aspect | Design Choice | Future Compatibility |
|--------|---------------|---------------------|
| Main process | `Map<string, ClaudeAgentService>` | Any string key works |
| Store structure | `Record<string, InstanceState>` | Any string key works |
| IPC routing | instanceId in all events | Any string key works |
| Lazy creation | `getOrCreateAgentService(id, cwd)` | Call with any ID |

**Key principle**: The `instanceId` is an opaque string. Components don't assume they're the only agent for a tab.

**Future multi-agent example**:
```typescript
// Current (one agent per tab):
<AgentPanel instanceId={`${contextId}-main`} cwd={cwd} />

// Future (multiple agents per tab):
<AgentPanel instanceId={`${contextId}-agent-1`} cwd={cwd} />
<AgentPanel instanceId={`${contextId}-agent-2`} cwd={cwd} />
```

**No structural changes needed** when adding multi-agent support - just:
1. Add UI for creating/managing multiple agent panels
2. Generate unique instanceIds per agent panel
3. Add per-agent close buttons (vs. relying only on tab close)

---

## Phase 1: Main Process Multi-Instance Support

### Overview
Convert `ipc-handlers.ts` to manage multiple ClaudeAgentService instances in a Map, and add instanceId routing to all agent IPC channels.

### Changes Required:

#### 1. Update IPC Handlers - Instance Management
**File**: `src/main/ipc-handlers.ts`

**Changes**:
- Replace single `agentService` variable with `agentServices: Map<string, ClaudeAgentService>`
- Add helper function `getOrCreateAgentService(instanceId, cwd)` for lazy creation
- Modify `AGENT_START` handler to route by instanceId
- Modify `AGENT_INTERRUPT` handler to accept instanceId
- Modify `AGENT_GET_STATUS` handler to accept instanceId
- Add `AGENT_DESTROY_INSTANCE` handler for cleanup on tab close
- Update event forwarding to include instanceId in all outbound events
- Update `cleanupIpcHandlers()` to destroy all instances

#### 2. Update IPC Channel Constants
**File**: `src/shared/constants.ts`

**Changes**:
- Add `AGENT_DESTROY_INSTANCE: 'agent:destroy-instance'` channel

#### 3. Update AgentQueryOptions Type
**File**: `src/shared/types.ts`

**Changes**:
- Add `instanceId: string` to `AgentQueryOptions` interface
- Add `cwd?: string` to allow renderer to specify working directory

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] TypeScript compiles without errors

#### Manual Verification:
- [ ] Can create multiple agent services via IPC
- [ ] Events include instanceId for routing

---

## Phase 2: Renderer State Partitioning

### Overview
Refactor `agentStore.ts` to partition state by instanceId, and update `useAgent.ts` hook to accept instanceId parameter.

### Changes Required:

#### 1. Refactor Agent Store State Structure
**File**: `src/renderer/stores/agentStore.ts`

**Changes**:
- Create `InstanceState` interface (messages, sessionId, activeTools, etc.)
- Change `AgentState` to have `instances: Record<string, InstanceState>`
- Keep global fields: `isAvailable`
- Add `getInstance(instanceId)` selector
- Add `getOrCreateInstance(instanceId)` for lazy creation
- Update all actions to accept instanceId: `sendMessage(instanceId, prompt, options)`
- Update event handlers to route by instanceId from event data
- Add `destroyInstance(instanceId)` action for cleanup

#### 2. Refactor useAgent Hook
**File**: `src/renderer/hooks/useAgent.ts`

**Changes**:
- Change signature to `useAgent(instanceId: string | null)`
- Return null/empty state if instanceId is null (for home tab)
- Derive selectors to read from `instances[instanceId]`
- Wrap actions to pass instanceId

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] TypeScript compiles without errors

#### Manual Verification:
- [ ] Store correctly partitions state by instanceId
- [ ] Multiple instances can exist simultaneously

---

## Phase 3: Update Agent Bridge & Preload

### Overview
Update the agentBridge and preload to include instanceId in all API calls and support instance destruction.

### Changes Required:

#### 1. Update Agent Bridge
**File**: `src/renderer/services/agentBridge.ts`

**Changes**:
- Update `startQuery(options)` - options already includes instanceId
- Add `destroyInstance(instanceId)` method
- All event callbacks now receive events with instanceId

#### 2. Update Preload Script
**File**: `src/preload/preload.ts`

**Changes**:
- Add `destroyInstance(instanceId)` to exposed API
- Event listeners already forward all data (no changes needed)

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] Preload exposes new API method

---

## Phase 4: Component Integration

### Overview
Update ContentView and AgentPanel to use instanceId-scoped state and manage instance lifecycle.

### Changes Required:

#### 1. Update ContentView to Generate and Pass instanceId
**File**: `src/renderer/components/Views/ContentView.tsx`

**Changes**:
- Compute `contextId` and `instanceId` (using `-main` suffix for future multi-agent support):
  ```typescript
  const contextId = projectId
    ? `project-${projectId}`
    : `workspace-${workspaceId}`;
  const instanceId = `${contextId}-main`;  // "-main" allows future "-agent-2", etc.
  ```
- Look up `project.path` from workspace store for cwd
- Pass `instanceId` and `cwd` to AgentPanel

#### 2. Update AgentPanel to Accept instanceId
**File**: `src/renderer/components/Agent/AgentPanel.tsx`

**Changes**:
- Add props interface: `{ instanceId: string; cwd: string }`
- Call `useAgent(instanceId)` instead of `useAgent()`
- Pass `instanceId` and `cwd` in sendMessage options

#### 3. Update ContextPlaceholder for Future Integration
**File**: `src/renderer/components/Views/ContextPlaceholder.tsx`

**Changes**:
- Add `instanceId` prop to interface (preparation for future)

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] TypeScript compiles without errors

#### Manual Verification:
- [ ] Each tab shows independent conversation
- [ ] Switching tabs shows correct conversation history

---

## Phase 5: Instance Lifecycle Management

### Overview
Connect tab close events to instance cleanup, ensuring resources are freed.

### Changes Required:

#### 1. Add Cleanup on Tab Close
**File**: `src/renderer/stores/tabStore.ts`

**Changes**:
- Import `useAgentStore`
- Add helper to destroy instances by contextId prefix (handles current `-main` and future multi-agent):
  ```typescript
  function destroyInstancesForContext(contextId: string) {
    const store = useAgentStore.getState();
    // Destroy all instances matching this context (e.g., "project-abc-main", future "project-abc-agent-2")
    Object.keys(store.instances)
      .filter(id => id.startsWith(contextId))
      .forEach(id => store.destroyInstance(id));
  }
  ```
- In `closeTab`: call `destroyInstancesForContext(tabId)` (tabId is the contextId)
- In `closeTabsForWorkspace`: destroy instances for all affected contexts
- In `closeTabsForProject`: destroy instances for project context

#### 2. Add Instance Cleanup to Agent Store
**File**: `src/renderer/stores/agentStore.ts`

**Changes**:
- `destroyInstance(instanceId)` action:
  - Call `agentBridge.destroyInstance(instanceId)`
  - Delete `instances[instanceId]` from state

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`

#### Manual Verification:
- [ ] Closing a tab cleans up its agent instance
- [ ] Reopening a tab creates a fresh instance
- [ ] No memory leaks on repeated open/close

---

## Testing Strategy

### Unit Tests:
- Agent store instance creation/deletion
- Instance state isolation
- Event routing by instanceId

### Integration Tests:
- Open two project tabs, send messages to each
- Verify conversations are isolated
- Close tab and verify cleanup
- Reopen tab and verify fresh state

### Manual Testing Steps:
1. Open workspace tab, send message, verify response
2. Open project tab within same workspace, send different message
3. Switch between tabs - verify each shows its own conversation
4. Close project tab
5. Reopen same project - verify conversation is cleared (no persistence)
6. Open 5+ tabs with conversations - verify no performance degradation

---

## File Change Summary

| File | Changes |
|------|---------|
| `src/shared/constants.ts` | Add AGENT_DESTROY_INSTANCE channel |
| `src/shared/types.ts` | Add instanceId and cwd to AgentQueryOptions |
| `src/main/ipc-handlers.ts` | Map-based multi-instance + event routing |
| `src/preload/preload.ts` | Add destroyInstance API |
| `src/renderer/services/agentBridge.ts` | Add destroyInstance method |
| `src/renderer/stores/agentStore.ts` | Partition state by instanceId |
| `src/renderer/hooks/useAgent.ts` | Accept instanceId parameter |
| `src/renderer/components/Views/ContentView.tsx` | Compute and pass instanceId |
| `src/renderer/components/Agent/AgentPanel.tsx` | Accept instanceId prop |
| `src/renderer/components/Views/ContextPlaceholder.tsx` | Add instanceId prop |
| `src/renderer/stores/tabStore.ts` | Cleanup instances on tab close |

---

## Architecture Diagram (After Implementation)

```
┌─────────────────────────────────────────────────────────────┐
│                      RENDERER PROCESS                        │
├─────────────────────────────────────────────────────────────┤
│  agentStore.instances                                        │
│    ├── "project-abc-main" → { messages, sessionId, ... }    │
│    └── "workspace-xyz-main" → { messages, sessionId, ... }  │
│    # Future: "project-abc-agent-2", etc.                    │
│                                                              │
│  Tab: project-abc                                            │
│    └── ContentView (workspaceId, projectId="abc")           │
│          ├── AgentPanel (instanceId="project-abc-main")     │
│          │     └── useAgent("project-abc-main")             │
│          └── ContextPlaceholder (contextId="project-abc")   │
│                                                              │
│  Tab: workspace-xyz                                          │
│    └── ContentView (workspaceId="xyz")                      │
│          ├── AgentPanel (instanceId="workspace-xyz-main")   │
│          │     └── useAgent("workspace-xyz-main")           │
│          └── ContextPlaceholder (contextId="workspace-xyz") │
├─────────────────────────────────────────────────────────────┤
│  agentBridge.startQuery({ instanceId, cwd, prompt })        │
│  agentBridge.destroyInstance(instanceId)                    │
│  Events: { instanceId, ...data }                            │
└────────────────────────┬────────────────────────────────────┘
                         │ IPC (with instanceId)
┌────────────────────────┴────────────────────────────────────┐
│                      MAIN PROCESS                            │
├─────────────────────────────────────────────────────────────┤
│  ipc-handlers.ts                                            │
│    agentServices: Map<string, ClaudeAgentService>           │
│      ├── "project-abc-main" → ClaudeAgentService(path)      │
│      └── "workspace-xyz-main" → ClaudeAgentService(cwd)     │
│                                                              │
│  getOrCreateAgentService(instanceId, cwd):                  │
│    - Lazy creation on first query                           │
│    - Wires event forwarding with instanceId prefix          │
│                                                              │
│  AGENT_DESTROY_INSTANCE handler:                            │
│    - Calls service.destroy()                                │
│    - Removes from map                                       │
└─────────────────────────────────────────────────────────────┘
```

---

## References

- Research document: `research/2026-02-04-multi-instance-agent-per-tab.md`
- Existing multi-instance pattern: `src/main/ipc-handlers.ts:10` (terminalServices Map)
- Tab ID generation: `src/renderer/stores/tabStore.ts:24-27`
- Project path storage: `src/renderer/stores/workspaceStore.ts:4-11`
