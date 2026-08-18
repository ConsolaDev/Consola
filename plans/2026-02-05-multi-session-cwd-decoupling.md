# Multi-Session CWD Decoupling via additionalDirectories

**Date**: 2026-02-05
**Status**: Ready for Implementation
**Based on**: research/2026-02-05-multi-session-cwd-decoupling.md

## Overview

Decouple workspace sessions from single-directory constraints by leveraging the Claude Code SDK's `additionalDirectories` option. This allows workspace sessions containing multiple projects to give Claude access to all project directories, not just the first one.

## Current State Analysis

The session data model already supports multiple paths (`session.paths` array), but only the first path is used when starting the agent. The SDK supports `additionalDirectories` but we don't pass it.

**The Problem:**
- `ContentView.tsx:65` extracts only `paths[0]` as `cwd`
- `ClaudeAgentService.ts:199` only passes `cwd` to SDK options
- Workspace sessions store all project paths but Claude can only access one

### Key Files:
- `src/renderer/components/Views/ContentView.tsx:65` - Only uses `paths[0]`
- `src/main/ClaudeAgentService.ts:199-200` - SDK options missing `additionalDirectories`
- `src/main/ipc-handlers.ts:155-172` - Agent start handler
- `src/shared/types.ts:143-151` - `AgentQueryOptions` interface
- `src/renderer/stores/workspaceStore.ts:13-22` - Session interface with `paths[]`

## Desired End State

1. **Workspace sessions**: Claude can read/write files in ALL projects included in the workspace
2. **SDK integration**: `additionalDirectories` is passed through the entire stack
3. **Backward compatible**: Single-project sessions work unchanged

### Architecture After Changes:

```
Session (paths: ["/dev/api", "/dev/users", "/dev/notif"])
        ↓ paths[0] = cwd
        ↓ paths.slice(1) = additionalDirectories
AgentPanel → useAgent → agentStore → agentBridge → preload → IPC
        ↓
ClaudeAgentService → SDK.query({
  cwd: "/dev/api",
  additionalDirectories: ["/dev/users", "/dev/notif"]
})
```

## What We're NOT Doing

- Selective project inclusion UI (can be added later)
- User-selectable "primary" project (uses first in list)
- Path validation before agent start
- Visual indicator of which directories are active
- Changes to session creation flow

---

## Phase 1: Update Type Definitions

### Overview
Add `additionalDirectories` to the `AgentQueryOptions` interface that flows through the entire IPC chain.

### Changes Required:

#### 1. Shared Types
**File**: `src/shared/types.ts`
**Changes**: Add optional `additionalDirectories` field to `AgentQueryOptions`

```typescript
export interface AgentQueryOptions {
    instanceId: string;
    cwd?: string;
    additionalDirectories?: string[];  // NEW
    prompt: string;
    allowedTools?: string[];
    maxTurns?: number;
    resume?: string;
    continue?: boolean;
}
```

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] TypeScript compiles without errors

#### Manual Verification:
- [ ] Type is available for import in renderer and main process

---

## Phase 2: Update ClaudeAgentService

### Overview
Update the agent service to accept and pass `additionalDirectories` to the SDK.

### Changes Required:

#### 1. Service Instance Variable
**File**: `src/main/ClaudeAgentService.ts`
**Changes**:
- Add `additionalDirectories` instance variable
- Add setter method `setAdditionalDirectories(dirs: string[])`
- Update constructor (optional, for future use)

```typescript
export class ClaudeAgentService extends EventEmitter {
  private additionalDirectories: string[] = [];

  setAdditionalDirectories(dirs: string[]): void {
    this.additionalDirectories = dirs;
  }
}
```

#### 2. SDK Options in startQuery
**File**: `src/main/ClaudeAgentService.ts`
**Location**: `startQuery()` method, SDK options construction (~line 199)
**Changes**: Include `additionalDirectories` in SDK options

```typescript
const sdkOptions: Options = {
  cwd: this.cwd,
  additionalDirectories: this.additionalDirectories,  // NEW
  abortController: this.abortController,
  // ... rest of options
};
```

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] TypeScript compiles without errors

#### Manual Verification:
- [ ] Service accepts and stores additional directories
- [ ] SDK receives additionalDirectories in options

---

## Phase 3: Update IPC Handler

### Overview
Update the IPC handler to extract and pass `additionalDirectories` from query options to the service.

### Changes Required:

#### 1. Agent Start Handler
**File**: `src/main/ipc-handlers.ts`
**Location**: `AGENT_START` handler (~lines 155-172)
**Changes**: Extract `additionalDirectories` and pass to service

```typescript
ipcMain.on(IPC_CHANNELS.AGENT_START, async (_event, options: AgentQueryOptions) => {
    const { instanceId, cwd, additionalDirectories, ...queryOptions } = options;
    const workingDir = cwd || process.cwd();

    try {
        const service = getOrCreateAgentService(instanceId, workingDir);
        service.setCwd(workingDir);
        service.setAdditionalDirectories(additionalDirectories ?? []);  // NEW
        await service.startQuery(queryOptions);
    } catch (error) {
        // error handling
    }
});
```

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`

#### Manual Verification:
- [ ] IPC handler correctly extracts additionalDirectories
- [ ] Service receives the directories from IPC

---

## Phase 4: Update Renderer Layer

### Overview
Pass `additionalDirectories` through the renderer layer: AgentPanel → useAgent → agentStore → agentBridge.

### Changes Required:

#### 1. AgentPanel Props
**File**: `src/renderer/components/Agent/AgentPanel.tsx`
**Changes**: Add `additionalDirectories` prop

```typescript
interface AgentPanelProps {
  instanceId: string;
  cwd: string;
  additionalDirectories?: string[];  // NEW
}
```

#### 2. useAgent Hook
**File**: `src/renderer/hooks/useAgent.ts`
**Changes**: Accept and pass `additionalDirectories` in sendMessage

```typescript
const sendMessage = useCallback((prompt: string, options?: {
  allowedTools?: string[];
  maxTurns?: number;
}) => {
  if (instanceId) {
    storeSendMessage(instanceId, cwd, prompt, {
      ...options,
      additionalDirectories,  // NEW
    });
  }
}, [instanceId, cwd, additionalDirectories, storeSendMessage]);
```

#### 3. agentStore
**File**: `src/renderer/stores/agentStore.ts`
**Changes**: Update `sendMessage` action signature and pass through

```typescript
sendMessage: (instanceId, cwd, prompt, options = {}) => {
  // ... existing code
  agentBridge.startQuery({
    instanceId,
    cwd,
    additionalDirectories: options.additionalDirectories,  // NEW
    prompt,
    // ... rest
  });
}
```

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] TypeScript compiles without errors

#### Manual Verification:
- [ ] Props flow from AgentPanel through to agentBridge

---

## Phase 5: Update ContentView to Pass All Paths

### Overview
The final connection: extract all paths from the active session and pass them through.

### Changes Required:

#### 1. ContentView Path Extraction
**File**: `src/renderer/components/Views/ContentView.tsx`
**Location**: Where `cwd` is determined (~line 65)
**Changes**: Calculate both primary cwd and additional directories

```typescript
// Current:
const cwd = activeSession?.paths?.[0] ?? project?.path ?? '';

// Updated:
const primaryCwd = activeSession?.paths?.[0] ?? project?.path ?? '';
const additionalDirectories = activeSession?.paths?.slice(1) ?? [];
```

#### 2. Pass to AgentPanel
**File**: `src/renderer/components/Views/ContentView.tsx`
**Changes**: Pass additionalDirectories prop

```typescript
<AgentPanel
  instanceId={instanceId}
  cwd={primaryCwd}
  additionalDirectories={additionalDirectories}
/>
```

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] TypeScript compiles without errors

#### Manual Verification:
- [ ] Workspace session with 3 projects passes all 3 paths to SDK
- [ ] Single-project session passes empty additionalDirectories array
- [ ] Claude can access files in all workspace projects

---

## Testing Strategy

### Manual Testing Steps:

1. **Create workspace with 2-3 projects**
   - Add multiple project directories to a workspace
   - Create a new workspace session

2. **Verify multi-directory access**
   - Ask Claude to list files in each project directory
   - Ask Claude to read a file from a non-primary project
   - Ask Claude to create a file in a non-primary project

3. **Verify backward compatibility**
   - Open a single-project session
   - Verify agent works normally

4. **Verify SDK receives correct options**
   - Add console.log in ClaudeAgentService.startQuery() to log sdkOptions
   - Verify `cwd` and `additionalDirectories` are set correctly

### Edge Cases:

- Empty paths array (should fallback to project.path)
- Single path in array (additionalDirectories should be empty)
- Non-existent path in array (SDK should handle gracefully)
- Workspace with no projects (edge case, shouldn't create session)

## References

- Research: `research/2026-02-05-multi-session-cwd-decoupling.md`
- Session interface: `src/renderer/stores/workspaceStore.ts:13-22`
- SDK types: `@anthropic-ai/claude-agent-sdk` Options interface
- Agent service: `src/main/ClaudeAgentService.ts`
- IPC handlers: `src/main/ipc-handlers.ts:155-172`
- ContentView: `src/renderer/components/Views/ContentView.tsx:65`
