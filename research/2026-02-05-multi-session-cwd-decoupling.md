---
date: 2026-02-05T18:30:00+01:00
git_commit: 7f7330e
branch: feature/multi-session-management
repository: console-1
topic: "Multi-Session CWD Decoupling - Using additionalDirectories"
tags: [research, codebase, sessions, sdk, directories]
status: complete
---

# Research: Multi-Session CWD Decoupling

**Date**: 2026-02-05T18:30:00+01:00
**Git Commit**: 7f7330e
**Branch**: feature/multi-session-management
**Repository**: console-1

## Research Question

The current multi-session implementation has issues where workspace sessions only identify the first project in the list instead of all projects included in the workspace. This appears to be due to CWD coupling. How can we decouple from physical project locations while still allowing selective project inclusion in workspaces?

## Summary

The Claude Code SDK **does support multi-directory access** through the `additionalDirectories` option (TypeScript) or `add_dirs` (Python). This is the solution to the CWD coupling problem. The current implementation only passes `cwd` (first path) but ignores the additional paths stored in `session.paths`.

**Key Finding**: The SDK allows a primary `cwd` plus multiple `additionalDirectories` that Claude can access without being restricted to a single working directory.

## Current Implementation Analysis

### The Problem

**File**: `src/renderer/components/Views/ContentView.tsx:65`
```typescript
const cwd = activeSession?.paths?.[0] ?? project?.path ?? '';
```

The code correctly stores multiple paths in `session.paths` (line 57-64 in WorkspaceNavItem.tsx):
```typescript
const paths = workspace.projects.map(p => p.path);
const session = createSession(workspace.id, {
  paths,  // Array of all project paths
  // ...
});
```

But only the **first path** (`paths[0]`) is used when starting the agent:

**File**: `src/renderer/components/Agent/AgentPanel.tsx` (inferred from ContentView):
```typescript
<AgentPanel instanceId={instanceId} cwd={cwd} />  // Only passes single cwd
```

**File**: `src/main/ClaudeAgentService.ts:199-200`
```typescript
const sdkOptions: Options = {
  cwd: this.cwd,  // Only single cwd, no additionalDirectories
  // ...
};
```

### Session Data Model

**File**: `src/renderer/stores/workspaceStore.ts:13-22`
```typescript
export interface Session {
  id: string;
  name: string;
  workspaceId: string;
  projectId: string | null;    // null = workspace-wide
  paths: string[];             // Already supports multiple paths!
  instanceId: string;
  createdAt: number;
  lastActiveAt: number;
}
```

The data model already supports multiple paths - the issue is in how they're passed to the SDK.

## SDK Capabilities (From Official Documentation)

### The `additionalDirectories` Option

The Claude Code SDK supports working across multiple directories:

**TypeScript SDK**:
```typescript
interface Options {
  cwd?: string;                    // Primary working directory
  additionalDirectories?: string[] // Additional accessible directories
}
```

**Python SDK**:
```python
@dataclass
class ClaudeAgentOptions:
    cwd: str | Path | None = None
    add_dirs: list[str | Path] = field(default_factory=list)
```

### How It Works

1. **Primary CWD**: The main working directory where Claude starts
2. **Additional Directories**: Extra directories Claude can read/write without prompts
3. **Permissions**: Files in `additionalDirectories` follow the same permission rules as `cwd`
4. **No Parent Traversal**: Claude cannot cd to parent directories of any configured directory

### Example Usage

```typescript
const options: Options = {
  cwd: "/projects/api-gateway",
  additionalDirectories: [
    "/projects/user-service",
    "/projects/notification-service",
    "/projects/shared-lib"
  ]
};

for await (const message of query({
  prompt: "Review code across all microservices",
  options
})) {
  // Claude can access all four directories
}
```

## Proposed Solution

### 1. Update IPC Channel to Accept Additional Directories

**File**: `src/shared/types.ts` - Add to AgentQueryOptions:
```typescript
export interface AgentQueryOptions {
  instanceId: string;
  cwd: string;
  additionalDirectories?: string[];  // NEW
  prompt: string;
  // ... existing fields
}
```

### 2. Update ClaudeAgentService

**File**: `src/main/ClaudeAgentService.ts`

Add instance variable:
```typescript
export class ClaudeAgentService extends EventEmitter {
  private additionalDirectories: string[] = [];

  constructor(private cwd: string, additionalDirs?: string[]) {
    super();
    this.additionalDirectories = additionalDirs ?? [];
  }

  setAdditionalDirectories(dirs: string[]): void {
    this.additionalDirectories = dirs;
  }
}
```

Update SDK options in `startQuery()`:
```typescript
const sdkOptions: Options = {
  cwd: this.cwd,
  additionalDirectories: this.additionalDirectories,  // NEW
  // ... rest
};
```

### 3. Update IPC Handler

**File**: `src/main/ipc-handlers.ts:155-172`

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
    // ...
  }
});
```

### 4. Update ContentView to Pass All Paths

**File**: `src/renderer/components/Views/ContentView.tsx`

```typescript
// Current: only passes first path
const cwd = activeSession?.paths?.[0] ?? project?.path ?? '';

// Proposed: pass primary cwd + additional directories
const primaryCwd = activeSession?.paths?.[0] ?? project?.path ?? '';
const additionalDirectories = activeSession?.paths?.slice(1) ?? [];
```

Update AgentPanel props:
```typescript
<AgentPanel
  instanceId={instanceId}
  cwd={primaryCwd}
  additionalDirectories={additionalDirectories}  // NEW
/>
```

### 5. Update AgentPanel and useAgent Hook

Pass additionalDirectories through to the agent start call.

## Selective Project Inclusion

The current implementation already supports selective project inclusion because:

1. **Session stores specific paths**: `session.paths` is an array that can contain any subset of project paths
2. **Workspace stores projects separately**: The workspace's `projects` array is independent of session paths

To allow users to select specific projects for a workspace session:

### Option A: Selection at Session Creation

When clicking "+" to create workspace session, show a dialog:

```typescript
// CreateWorkspaceSessionDialog.tsx
interface Props {
  workspace: Workspace;
  onCreateSession: (selectedProjectIds: string[]) => void;
}

// User selects which projects to include in this session
// Only selected project paths are stored in session.paths
```

### Option B: All Projects by Default, Explicit Exclusion

```typescript
// Current behavior - include all
const paths = workspace.projects.map(p => p.path);

// Alternative - include selected
const selectedProjects = workspace.projects.filter(p =>
  selectedProjectIds.includes(p.id)
);
const paths = selectedProjects.map(p => p.path);
```

## Architecture After Changes

```
┌─────────────────────────────────────────────────────────────────┐
│                    Session (workspaceStore)                      │
│  paths: ["/dev/api", "/dev/users", "/dev/notif"]                │
│           ↓ first     ↓ rest (additionalDirectories)            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   AgentPanel (renderer)                          │
│  cwd="/dev/api"                                                  │
│  additionalDirectories=["/dev/users", "/dev/notif"]             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (IPC)
┌─────────────────────────────────────────────────────────────────┐
│               ClaudeAgentService (main process)                  │
│  this.cwd = "/dev/api"                                          │
│  this.additionalDirectories = ["/dev/users", "/dev/notif"]      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (SDK call)
┌─────────────────────────────────────────────────────────────────┐
│                 Claude Code SDK query()                          │
│  options: {                                                      │
│    cwd: "/dev/api",                                             │
│    additionalDirectories: ["/dev/users", "/dev/notif"]          │
│  }                                                              │
│                                                                  │
│  Claude can now access ALL three directories!                    │
└─────────────────────────────────────────────────────────────────┘
```

## Code References

### Current Implementation
- `src/renderer/stores/workspaceStore.ts:13-22` - Session interface with paths array
- `src/renderer/components/Views/ContentView.tsx:65` - Only uses paths[0]
- `src/renderer/components/Sidebar/WorkspaceNavItem.tsx:57-64` - Creates session with all paths
- `src/main/ClaudeAgentService.ts:199-200` - Only passes cwd to SDK
- `src/main/ipc-handlers.ts:155-172` - Agent start handler

### SDK Documentation Sources
- Agent SDK overview: https://platform.claude.com/docs/en/agent-sdk/overview
- TypeScript SDK reference: https://platform.claude.com/docs/en/agent-sdk/typescript
- Python SDK reference: https://platform.claude.com/docs/en/agent-sdk/python

## Implementation Priority

1. **High Priority**: Update ClaudeAgentService to accept and pass `additionalDirectories` to SDK
2. **High Priority**: Update IPC handler to receive additional directories
3. **Medium Priority**: Update ContentView and AgentPanel to pass all paths
4. **Low Priority**: Add UI for selective project inclusion at session creation

## Open Questions

1. **First path selection**: Should the user choose which project is the "primary" cwd, or always use the first project alphabetically?

2. **Path validation**: Should we validate that all paths still exist before starting the agent?

3. **UI feedback**: How should we indicate to the user which directories are active in a session?

4. **Performance**: Any concerns with passing many additional directories to the SDK?
