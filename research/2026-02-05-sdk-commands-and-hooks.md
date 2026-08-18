---
date: 2026-02-05T10:00:00-08:00
git_commit: a649c6ed1a7c6f35b1dafb87b52d04d8a63c7d44
branch: main
repository: consola
topic: "Claude Agent SDK Commands and Hooks - How to Invoke /clear and .claude Commands"
tags: [research, codebase, claude-sdk, commands, hooks, slash-commands]
status: complete
---

# Research: Claude Agent SDK Commands and Hooks

**Date**: 2026-02-05
**Git Commit**: a649c6ed1a7c6f35b1dafb87b52d04d8a63c7d44
**Branch**: main
**Repository**: consola

## Research Question

How does the Claude Agent SDK expose commands (particularly `/clear`) and how can we invoke all commands/hooks from the `.claude` folder? Goal is to show a small view over the input for command invocation.

## Summary

The Claude Agent SDK (v0.2.30) does **not expose a direct `executeCommand()` API**. Instead:

1. **Commands are invoked by sending them as prompts** - `/clear` is sent as a user message through `query()`
2. **Commands are discovered via `supportedCommands()`** - Returns all available slash commands (built-in + user + project)
3. **Hooks are registered via the `hooks` option** - Callback functions that respond to 13 different events
4. **The `.claude/commands/` folder** - Markdown files that define custom commands (loaded automatically by SDK)

## Detailed Findings

### 1. The `/clear` Command

**How it works:**
- `/clear` is a built-in command recognized by the SDK
- It triggers a session end with `ExitReason = 'clear'`
- A new session starts with `source = 'clear'`

**Type definitions** (`sdk.d.ts` line 248-250):
```typescript
export declare const EXIT_REASONS: readonly ["clear", "logout", "prompt_input_exit", "other", "bypass_permissions_disabled"];
export declare type ExitReason = 'clear' | 'logout' | 'prompt_input_exit' | 'other' | 'bypass_permissions_disabled';
```

**How to invoke programmatically:**
```typescript
// Option 1: Send as a prompt (recommended)
import { query } from '@anthropic-ai/claude-agent-sdk';

const q = query({ prompt: '/clear', options: { cwd: '/path/to/project' } });
for await (const message of q) {
  // Handle session end messages
}

// Option 2: In this app via agentStore
useAgentStore.getState().sendMessage(instanceId, cwd, '/clear');
```

**What happens after /clear:**
1. SDK emits `SessionEnd` hook with `reason: 'clear'`
2. SDK starts new session with `SessionStart` hook where `source: 'clear'`
3. Conversation history is cleared but session context is preserved

### 2. Discovering Available Commands

**API Method** (`sdk.d.ts` lines 989-993):
```typescript
// On a Query instance
supportedCommands(): Promise<SlashCommand[]>;
```

**SlashCommand Type** (`sdk.d.ts` lines 1624-1637):
```typescript
export declare type SlashCommand = {
    name: string;        // Command name (without leading /)
    description: string; // What the command does
    argumentHint: string; // e.g., "<file>" or ""
};
```

**When commands are available:**
- At initialization via `initializationResult()` which returns `SDKControlInitializeResponse`:
  ```typescript
  type SDKControlInitializeResponse = {
      commands: SlashCommand[];
      models: ModelInfo[];
      account: AccountInfo;
  };
  ```
- Via system message which includes `slash_commands: string[]` and `skills: string[]`

**Command Sources (automatically merged by SDK):**
| Source | Location | Example |
|--------|----------|---------|
| Built-in | SDK internal | `/help`, `/clear`, `/compact`, `/model`, `/resume` |
| User | `~/.claude/commands/*.md` | Custom user commands |
| Project | `.claude/commands/*.md` | Project-specific commands |
| Skills | `.claude/skills/` | Reusable skill definitions |

### 3. Hook System

**13 Available Hook Events** (`sdk.d.ts` line 252):
```typescript
["PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification",
 "UserPromptSubmit", "SessionStart", "SessionEnd", "Stop",
 "SubagentStart", "SubagentStop", "PreCompact", "PermissionRequest", "Setup"]
```

**How to Register Hooks:**
```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

const q = query({
  prompt: 'Do something',
  options: {
    hooks: {
      SessionEnd: [{
        hooks: [async (input, toolUseId, { signal }) => {
          if (input.reason === 'clear') {
            console.log('User cleared the conversation');
          }
          return { continue: true };
        }]
      }],
      PreToolUse: [{
        matcher: 'Bash',  // Only match Bash tool
        hooks: [async (input, toolUseId, { signal }) => {
          console.log('About to run bash:', input.tool_input);
          return { continue: true };  // or { decision: 'block' }
        }]
      }]
    }
  }
});
```

**Hook Input Structure:**
```typescript
// Base input (all hooks receive this)
type BaseHookInput = {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
};

// SessionStart specific
type SessionStartHookInput = BaseHookInput & {
  hook_event_name: 'SessionStart';
  source: 'startup' | 'resume' | 'clear' | 'compact';
  agent_type?: string;
  model?: string;
};

// SessionEnd specific
type SessionEndHookInput = BaseHookInput & {
  hook_event_name: 'SessionEnd';
  reason: ExitReason;  // 'clear' | 'logout' | ...
};

// PreToolUse specific
type PreToolUseHookInput = BaseHookInput & {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
};
```

**Hook Return Values:**
```typescript
// Continue execution
{ continue: true }

// Block tool execution
{ decision: 'block', reason: 'Not allowed' }

// Suppress output
{ suppressOutput: true }

// Stop the session
{ stopReason: 'User requested stop' }

// Async execution
{ async: true, asyncTimeout: 30 }
```

### 4. .claude Folder Structure

The SDK automatically loads from these locations:

```
~/.claude/                    # User-level config
├── settings.json            # User settings
├── commands/                # User custom commands
│   └── my-command.md        # Custom command definition
└── CLAUDE.md                # User memory file

.claude/                      # Project-level config
├── settings.json            # Project settings
├── settings.local.json      # Local overrides (gitignored)
├── commands/                # Project custom commands
│   └── deploy.md            # e.g., /deploy command
├── skills/                  # Skill definitions
│   └── my-skill/
│       └── skill.md
└── CLAUDE.md                # Project memory file
```

**Settings Sources** (loaded in order, later overrides earlier):
```typescript
type SettingSource = 'defaults' | 'enterprise' | 'user' | 'project' | 'project-local';
```

### 5. Key Query Interface Methods

```typescript
export interface Query extends AsyncGenerator<SDKMessage, void> {
  // Lifecycle
  interrupt(): Promise<void>;
  close(): void;

  // Information
  initializationResult(): Promise<SDKControlInitializeResponse>;
  supportedCommands(): Promise<SlashCommand[]>;
  supportedModels(): Promise<ModelInfo[]>;
  accountInfo(): Promise<AccountInfo>;
  mcpServerStatus(): Promise<McpServerStatus[]>;

  // Control
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>;

  // Multi-turn
  streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>;

  // MCP
  reconnectMcpServer(serverName: string): Promise<void>;
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>;

  // File operations
  rewindFiles(userMessageId: string, options?: {dryRun?: boolean}): Promise<RewindFilesResult>;
}
```

### 6. Implementation for UI Command Palette

**Step 1: Fetch commands on session init**
```typescript
// In agentStore or a hook
const q = query({ prompt: initialPrompt, options });
const initResult = await q.initializationResult();
const commands = initResult.commands;  // SlashCommand[]

// Or explicitly
const commands = await q.supportedCommands();
```

**Step 2: Display in UI**
```typescript
// CommandSuggestions component
commands.map(cmd => ({
  name: `/${cmd.name}`,
  description: cmd.description,
  hint: cmd.argumentHint || undefined
}));
```

**Step 3: Execute command**
```typescript
// User selects /clear from UI
const selectedCommand = '/clear';

// Send as a message (SDK recognizes and handles it)
agentStore.sendMessage(instanceId, cwd, selectedCommand);
```

### 7. Built-in Commands Reference

| Command | Description | Arguments |
|---------|-------------|-----------|
| `/help` | Show help information | - |
| `/clear` | Clear conversation history | - |
| `/compact` | Compact context to save tokens | `[instructions]` |
| `/model` | Change the model | `<model-name>` |
| `/resume` | Resume a previous session | `[session-id]` |
| `/usage` | Show token usage stats | - |
| `/stats` | Show session statistics | - |
| `/rewind` | Undo to a previous state | - |
| `/rename` | Rename the session | `<name>` |
| `/exit` | Exit the session | - |
| `/kill` | Force kill the session | - |
| `/config` | View/edit configuration | `[key] [value]` |
| `/permissions` | View/edit permissions | - |
| `/mcp` | MCP server management | `[subcommand]` |
| `/memory` | Edit CLAUDE.md | - |
| `/plan` | Enter/exit plan mode | - |

## Code References

- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` - Main type definitions
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts` - Tool input schemas
- `node_modules/@anthropic-ai/claude-agent-sdk/manifest.json` - Version info (0.2.30)
- `src/renderer/stores/agentStore.ts:300-308` - Current `clearMessages()` implementation

## Architecture for Command Invocation UI

```
┌─────────────────────────────────────────────┐
│              Command Palette UI              │
│  ┌─────────────────────────────────────────┐│
│  │ /clear    Clear conversation history    ││
│  │ /compact  Compact context               ││
│  │ /model    Change model                  ││
│  │ /deploy   [Project] Deploy to prod      ││
│  └─────────────────────────────────────────┘│
└─────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────┐
│           On Command Selection               │
│                                             │
│  1. If command needs args: Insert in input  │
│     "/model " + keep cursor                 │
│                                             │
│  2. If no args needed: Execute immediately  │
│     sendMessage(instanceId, cwd, '/clear')  │
└─────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────┐
│              SDK Processing                  │
│                                             │
│  query({ prompt: '/clear' })                │
│       │                                     │
│       ▼                                     │
│  SDK recognizes slash command               │
│       │                                     │
│       ▼                                     │
│  Emits SessionEnd { reason: 'clear' }       │
│       │                                     │
│       ▼                                     │
│  Emits SessionStart { source: 'clear' }     │
└─────────────────────────────────────────────┘
```

## Key Takeaways

1. **No `executeCommand()` API** - Commands are sent as prompts through `query()`
2. **Use `supportedCommands()`** - To get the list of available commands for UI
3. **Hooks are callbacks** - Not file-based, registered via the `hooks` option in SDK
4. **`.claude/commands/` files** - Are loaded automatically by SDK as custom slash commands
5. **`/clear` flow** - Send as prompt → SDK handles → SessionEnd/SessionStart hooks fire

## Open Questions

1. **Custom command arguments** - How are arguments parsed for custom `.claude/commands/*.md` files?
2. **Hook file format** - Can hooks be defined in `.claude/hooks/` files (like in CLI) or only programmatically in SDK?
3. **Command execution feedback** - How to know when a command like `/clear` has completed?
