---
date: 2026-02-05T14:30:00+01:00
git_commit: eb4c06c9c70d6440296672e80e17312d7c73fbe7
branch: main
repository: console-1
topic: "Implementation Plan: Skills, Commands, and Settings Loading"
tags: [plan, implementation, skills, commands, settings, sdk]
status: ready
---

# Implementation Plan: Skills, Commands, and Settings Loading

**Date**: 2026-02-05
**Git Commit**: eb4c06c9c70d6440296672e80e17312d7c73fbe7
**Branch**: main

## Overview

This plan addresses two main issues from previous research:
1. **Local skills not loading** - Skills from `.claude/skills/` not appearing in command palette
2. **Commands not executing** - Input becomes disabled but nothing renders

The solution leverages SDK options that were not being used: `settingSources` and `plugins`.

## Key SDK Concepts

### Setting Sources (`settingSources`)
Controls which filesystem-based configuration the SDK loads:

| Value | Description | Location |
|-------|-------------|----------|
| `'user'` | Global user settings | `~/.claude/settings.json` |
| `'project'` | Shared project settings (version controlled) | `.claude/settings.json` |
| `'local'` | Local project settings (gitignored) | `.claude/settings.local.json` |

**Critical**: Must include `'project'` to load CLAUDE.md files and `.claude/skills/` and `.claude/commands/`.

### Plugins (`plugins`)
Load additional capabilities from local directories:

```typescript
type SdkPluginConfig = {
  type: 'local';
  path: string;  // Absolute or relative path to plugin directory
};
```

### SDK Init Message
When a query starts, the SDK emits an `init` system message containing:
- `skills: string[]` - Available skill names
- `slash_commands: string[]` - Available command names
- `plugins: { name: string; path: string }[]` - Loaded plugins

### Query Methods
- `supportedCommands(): Promise<SlashCommand[]>` - Get available commands
- `initializationResult(): Promise<SDKControlInitializeResponse>` - Get full init data including commands

## Architecture Decision

**Each workspace maps 1:1 to a `cwd`**, so:
- Workspace path = SDK `cwd` option
- Workspace determines which `.claude/` folder is loaded
- Settings sources should include `['user', 'project', 'local']` to load:
  - User's global skills from `~/.claude/commands/` and `~/.claude/skills/`
  - Project skills from `{workspace.path}/.claude/skills/`
  - Project commands from `{workspace.path}/.claude/commands/`

## Implementation Tasks

### Task 1: Update ClaudeAgentService to Pass Settings Sources

**File**: `src/main/ClaudeAgentService.ts`

**Changes**:
1. Add `settingSources` to `Options` in `startQuery()`:
   ```typescript
   const sdkOptions: Options = {
     cwd: this.cwd,
     settingSources: ['user', 'project', 'local'],  // ADD THIS
     // ... rest of options
   };
   ```

2. This enables the SDK to:
   - Read `~/.claude/settings.json` (user commands/skills)
   - Read `{cwd}/.claude/settings.json` (project commands/skills)
   - Read `{cwd}/.claude/settings.local.json` (local overrides)
   - Load CLAUDE.md files
   - Auto-discover `.claude/skills/` and `.claude/commands/` folders

**Why**: Currently the SDK runs in "isolation mode" (no settingSources) which prevents it from discovering local skills.

### Task 2: Emit Skills and Commands from Init Message

**File**: `src/main/ClaudeAgentService.ts`

**Changes**:
Update `handleMessage` to emit skills and commands from the init message:

```typescript
case 'system':
  if (message.subtype === 'init') {
    this.status.sessionId = message.session_id;
    this.status.model = message.model;
    this.status.permissionMode = message.permissionMode;
    this.emit('init', {
      sessionId: message.session_id,
      model: message.model,
      tools: message.tools,
      mcpServers: message.mcp_servers,
      skills: message.skills || [],           // ADD
      slashCommands: message.slash_commands || [],  // ADD
      plugins: message.plugins || []          // ADD
    });
  }
  break;
```

**Update shared types** (`src/shared/types.ts`):
```typescript
export interface AgentInitEvent {
  sessionId: string;
  model: string;
  tools: string[];
  mcpServers: { name: string; status: string }[];
  skills: string[];           // ADD
  slashCommands: string[];    // ADD
  plugins: { name: string; path: string }[];  // ADD
}
```

### Task 3: Use initializationResult() After Query Iteration Starts

**File**: `src/main/ClaudeAgentService.ts`

**Problem**: The previous implementation called `supportedCommands()` immediately after creating the query but BEFORE iterating. The SDK hasn't loaded local skills at that point.

**Solution**: Call `initializationResult()` after the first message is received (inside the for-await loop or via a flag).

```typescript
try {
  this.currentQuery = sdk.query({ prompt: options.prompt, options: sdkOptions });

  let hasInitialized = false;

  for await (const message of this.currentQuery) {
    this.handleMessage(message);

    // Fetch commands after first message (SDK is now initialized)
    if (!hasInitialized && this.currentQuery.initializationResult) {
      hasInitialized = true;
      try {
        const initResult = await this.currentQuery.initializationResult();
        this.emit('commands', {
          commands: initResult.commands,
          models: initResult.models,
          account: initResult.account
        });
      } catch (e) {
        console.warn('Failed to get initialization result:', e);
      }
    }
  }
}
```

### Task 4: Update IPC Handlers and Preload

**File**: `src/main/ipc-handlers.ts`

Ensure the `init` event forwards skills/commands:
```typescript
service.on('init', (data) => {
  mainWindow.webContents.send(AGENT_INIT, {
    instanceId,
    ...data  // Now includes skills, slashCommands, plugins
  });
});
```

**File**: `src/preload/preload.ts`

Already handles `AGENT_INIT` generically, but verify the type definition includes new fields.

### Task 5: Update agentStore to Process Skills from Init

**File**: `src/renderer/stores/agentStore.ts`

The store already has `_handleInit` that processes skills/slashCommands. Verify it works with the new data:

```typescript
_handleInit: (data: AgentInitEvent) => {
  const { instanceId, skills, slashCommands, ...rest } = data;

  // Convert skills to SlashCommand format
  const skillCommands: SlashCommand[] = skills.map(name => ({
    name,
    description: `Invoke ${name} skill`,
    argumentHint: ''
  }));

  // Convert slash_commands strings to SlashCommand format
  const builtinCommands: SlashCommand[] = slashCommands.map(name => ({
    name,
    description: '',
    argumentHint: ''
  }));

  // Merge with existing commands
  set((state) => updateInstance(state, instanceId, (instance) => ({
    availableCommands: mergeCommands(
      instance.availableCommands,
      [...skillCommands, ...builtinCommands]
    )
  })));
}
```

### Task 6: Handle Command Execution Feedback

**Problem**: When executing `/compact` or `/clear`, the SDK may not emit an assistant message, leaving the UI in a waiting state.

**Solution**: Listen for `result` messages and handle commands that don't produce visible output:

**File**: `src/renderer/stores/agentStore.ts`

```typescript
_handleResult: (data: AgentResultEvent) => {
  const { instanceId, subtype, result } = data;

  set((state) => updateInstance(state, instanceId, () => ({
    isRunning: false,
    // If this was a command with no output, add a system message
    ...(result === null && subtype === 'success' ? {
      // Command executed silently - could add feedback here
    } : {})
  })));
}
```

### Task 7: Pre-populate Commands on Session/Workspace Creation

To show commands in the palette before the user sends any message, perform a lightweight initialization query when:
- A new session is created within a workspace
- An existing session is opened
- A new workspace is added

**File**: `src/main/ClaudeAgentService.ts`

Add a new method for initialization-only queries:

```typescript
async initializeSession(): Promise<{
  commands: SlashCommand[];
  models: ModelInfo[];
  skills: string[];
  slashCommands: string[];
}> {
  const sdk = await getSDK();

  const query = sdk.query({
    prompt: '',
    options: {
      cwd: this.cwd,
      settingSources: ['user', 'project', 'local'],
      maxTurns: 0
    }
  });

  // Get initialization data
  const initResult = await query.initializationResult();

  // Also iterate to get the init message with skills
  let skills: string[] = [];
  let slashCommands: string[] = [];

  for await (const message of query) {
    if (message.type === 'system' && message.subtype === 'init') {
      skills = message.skills || [];
      slashCommands = message.slash_commands || [];
      break;
    }
  }

  // Clean up
  await query.interrupt();

  return {
    commands: initResult.commands,
    models: initResult.models,
    skills,
    slashCommands
  };
}
```

**File**: `src/main/ipc-handlers.ts`

Add IPC handler for initialization:

```typescript
ipcMain.handle('agent:initialize', async (_event, { instanceId, cwd }) => {
  const service = getOrCreateService(instanceId, cwd);
  return service.initializeSession();
});
```

**File**: `src/renderer/stores/agentStore.ts` or create session hook

Call initialization when session is created/opened.

### Task 8: Handle SessionEnd/SessionStart Hooks for /clear

**File**: `src/main/ClaudeAgentService.ts`

Add hooks for session lifecycle events:

```typescript
const sdkOptions: Options = {
  // ... existing options
  hooks: {
    // ... existing hooks (PreToolUse, PostToolUse, Notification)

    SessionEnd: [{
      hooks: [async (input) => {
        if (input.hook_event_name !== 'SessionEnd') return { continue: true };

        this.emit('session-end', {
          reason: input.reason,  // 'clear', 'logout', etc.
          sessionId: input.session_id
        });

        return { continue: true };
      }]
    }],

    SessionStart: [{
      hooks: [async (input) => {
        if (input.hook_event_name !== 'SessionStart') return { continue: true };

        this.emit('session-start', {
          source: input.source,  // 'startup', 'resume', 'clear', 'compact'
          sessionId: input.session_id,
          model: input.model
        });

        return { continue: true };
      }]
    }]
  }
};
```

**File**: `src/shared/types.ts`

Add event types:

```typescript
export interface SessionEndEvent {
  instanceId: string;
  reason: 'clear' | 'logout' | 'prompt_input_exit' | 'other';
  sessionId: string;
}

export interface SessionStartEvent {
  instanceId: string;
  source: 'startup' | 'resume' | 'clear' | 'compact';
  sessionId: string;
  model?: string;
}
```

**File**: `src/renderer/stores/agentStore.ts`

Handle session events in the store:

```typescript
// Add to Message type
export interface SystemMessage {
  type: 'system';
  subtype: 'session-cleared' | 'session-compacted';
  timestamp: number;
}

// Handler for session-end
_handleSessionEnd: (data: SessionEndEvent) => {
  const { instanceId, reason } = data;

  if (reason === 'clear') {
    // Insert a visual divider - DON'T clear messages
    set(state => updateInstance(state, instanceId, (instance) => ({
      messages: [
        ...instance.messages,
        {
          type: 'system',
          subtype: 'session-cleared',
          timestamp: Date.now()
        }
      ]
    })));
  }
},

// Handler for session-start
_handleSessionStart: (data: SessionStartEvent) => {
  const { instanceId, sessionId, source } = data;

  // Update session ID for the new session
  set(state => updateInstance(state, instanceId, () => ({
    sessionId
  })));
}
```

**File**: `src/renderer/components/Agent/MessageList.tsx` (or similar)

Render the session divider:

```tsx
{message.type === 'system' && message.subtype === 'session-cleared' && (
  <div className="session-divider">
    <span>Session cleared</span>
    <span className="timestamp">{formatTime(message.timestamp)}</span>
  </div>
)}

## Implementation Order

**Phase 1: Core SDK Integration** (Tasks 1-3)
1. Task 1: Add `settingSources` to SDK options
2. Task 2: Emit skills/commands from init message
3. Task 3: Move `initializationResult()` call to after iteration starts

**Phase 2: IPC & Store Updates** (Tasks 4-5)
4. Task 4: Update IPC handlers and preload
5. Task 5: Update agentStore to process skills from init

**Phase 3: Session Lifecycle** (Tasks 6, 8)
6. Task 6: Handle command execution feedback (result messages)
7. Task 8: Add SessionEnd/SessionStart hooks for `/clear` UX

**Phase 4: Pre-loading Commands** (Task 7)
8. Task 7: Add `initializeSession()` method and call on session creation

## File Changes Summary

| File | Changes |
|------|---------|
| `src/main/ClaudeAgentService.ts` | Add settingSources, emit skills/commands from init, add `initializeSession()`, add SessionEnd/SessionStart hooks |
| `src/shared/types.ts` | Add skills, slashCommands, plugins to AgentInitEvent; Add SessionEndEvent, SessionStartEvent |
| `src/main/ipc-handlers.ts` | Add init event forwarding, add `agent:initialize` handler, add session event forwarding |
| `src/preload/preload.ts` | Add session event listeners, add `initialize` method to API |
| `src/renderer/stores/agentStore.ts` | Add `_handleSessionEnd`, `_handleSessionStart`, add SystemMessage type |
| `src/renderer/components/Agent/MessageList.tsx` | Render session-cleared divider |
| `src/renderer/components/Agent/styles.css` | Add session-divider styles |

## Testing Checklist

1. [ ] Start app with a workspace that has `.claude/skills/` folder
2. [ ] Type `/` in chat input - verify local skills appear BEFORE sending any message
3. [ ] Execute `/compact` and verify UI doesn't freeze
4. [ ] Execute `/clear`:
   - [ ] Verify chat history is NOT removed
   - [ ] Verify "Session cleared" divider appears
   - [ ] Verify can continue chatting below the divider
5. [ ] Execute a skill command and verify it works
6. [ ] Verify user-level commands from `~/.claude/commands/` also appear
7. [ ] Create a new workspace and verify commands are available immediately
8. [ ] Create a new session and verify commands are populated

## Design Decisions (Confirmed)

### 1. Pre-load commands on session creation
Commands should be loaded when:
- A new session is created within a workspace
- When opening an existing session
- When a new workspace is added

This ensures the command palette is populated before the user sends their first message.

### 2. Plugin configuration
Plugins will be auto-discovered via `settingSources` from `.claude/settings.json` files. No UI configuration needed for now - the SDK handles this automatically when we pass `settingSources: ['user', 'project', 'local']`.

### 3. `/clear` command UX
When `/clear` is executed:
- The chat history should **NOT disappear** from the UI
- Instead, show a visual divider/indicator that the session was cleared
- The conversation can continue below the divider
- This preserves context for the user while respecting the SDK's session reset

Implementation approach:
- Listen for `SessionEnd` hook with `reason: 'clear'`
- Listen for `SessionStart` hook with `source: 'clear'`
- Insert a "Session Cleared" divider message in the UI
- Do NOT call `clearMessages()` - keep history visible
