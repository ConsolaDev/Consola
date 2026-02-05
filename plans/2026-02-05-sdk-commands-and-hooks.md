# Implementation Plan: SDK Commands & Hooks Integration

**Date**: 2026-02-05
**Status**: Ready for Implementation
**Based on**: `research/2026-02-05-sdk-commands-and-hooks.md`

## Overview

Add a command palette/autocomplete system that discovers and executes slash commands from the Claude Agent SDK. This enables users to invoke `/clear`, `/compact`, `/model`, and custom `.claude/commands/` commands through a UI overlay.

## Current State Analysis

### Key Discoveries:
- `ClaudeAgentService.ts:329` - SDK `query()` is called but `initializationResult()` and `supportedCommands()` are **not used**
- `agentStore.ts:300-308` - `clearMessages()` only clears local state, doesn't send `/clear` to SDK
- `ChatInput.tsx:67-72` - Simple Enter key handling, no command detection or autocomplete
- No command palette exists in the codebase

### What Exists:
- SDK hooks are partially implemented (PreToolUse, PostToolUse, Notification)
- Permission/question request flow works via `input-request` events
- Message flow: ChatInput → agentStore.sendMessage → agentBridge → IPC → ClaudeAgentService.startQuery

### SDK Command Discovery API:
```typescript
// On a Query instance
supportedCommands(): Promise<SlashCommand[]>;

// SlashCommand type
type SlashCommand = {
    name: string;        // Command name (without leading /)
    description: string; // What the command does
    argumentHint: string; // e.g., "<file>" or ""
};

// Available at init via:
initializationResult(): Promise<{ commands: SlashCommand[]; models: ModelInfo[]; account: AccountInfo }>;
```

## Desired End State

1. Type `/` in ChatInput to see available commands in a dropdown overlay
2. Filter commands by typing (e.g., `/cl` shows `/clear`, `/compact`)
3. Navigate commands with **Up/Down arrow keys**
4. **Tab** inserts the selected command into the input (for editing or adding arguments)
5. **Enter** executes the selected command immediately
6. **Click** on a command inserts it into the input
7. Commands like `/clear` properly clear session via SDK (not just local state)
8. Commands are fetched from SDK's `supportedCommands()` API on session init

### UI Architecture:
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
│              Keyboard Controls               │
│                                             │
│  ↑/↓    Navigate through command list       │
│  Tab    Insert command into input           │
│         (e.g., "/model " for further edit)  │
│  Enter  Execute command immediately         │
│  Esc    Close palette                       │
│  Click  Insert command into input           │
└─────────────────────────────────────────────┘
```

## What We're NOT Doing

- **Not** implementing custom hooks file loading (`.claude/hooks/`)
- **Not** adding SessionStart/SessionEnd hook handlers beyond what's needed for `/clear`
- **Not** creating a full command editor for custom commands
- **Not** adding keyboard shortcuts for individual commands

---

## Phase 1: Fetch & Store Available Commands

### Overview
Add SDK command discovery to ClaudeAgentService and store in agentStore.

### Changes Required:

#### 1. Add SlashCommand type
**File**: `src/shared/types.ts`
**Changes**: Add SlashCommand interface

```typescript
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}
```

#### 2. Update InstanceState with commands
**File**: `src/renderer/stores/agentStore.ts`
**Changes**:
- Add `availableCommands: SlashCommand[]` to InstanceState
- Add `_handleCommands` handler
- Update `createDefaultInstanceState` to include empty commands array

```typescript
// In InstanceState interface
availableCommands: SlashCommand[];

// In createDefaultInstanceState
availableCommands: [],

// New handler
_handleCommands: (data: { instanceId: string; commands: SlashCommand[] }) => void;
```

#### 3. Add IPC channel for commands
**File**: `src/shared/constants.ts`
**Changes**: Add `AGENT_COMMANDS` channel

```typescript
AGENT_COMMANDS: 'agent:commands',
```

#### 4. Update agentBridge with commands listener
**File**: `src/renderer/services/agentBridge.ts`
**Changes**: Add `onCommands` listener method

```typescript
onCommands: (callback: (data: { instanceId: string; commands: SlashCommand[] }) => void) => {
  window.claudeAgentAPI.onCommands(callback);
},
```

#### 5. Fetch commands from SDK on init
**File**: `src/main/ClaudeAgentService.ts`
**Changes**:
- Call `supportedCommands()` after query starts
- Emit `commands` event with the result

```typescript
// After currentQuery is created, fetch commands
const commands = await this.currentQuery.supportedCommands?.();
if (commands) {
  this.emit('commands', { commands });
}
```

#### 6. Wire up IPC handler
**File**: `src/main/ipc-handlers.ts`
**Changes**: Forward `commands` event to renderer

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`
- [ ] TypeScript compiles without errors

#### Manual Verification:
- [ ] Start a session, check that `availableCommands` is populated in store
- [ ] Console log shows commands array from SDK

---

## Phase 2: Command Palette UI Component

### Overview
Create CommandPalette component that displays filtered commands above ChatInput.

### Changes Required:

#### 1. Create CommandPalette component
**File**: `src/renderer/components/Agent/CommandPalette.tsx` (new)

```typescript
import { useCallback, useEffect, useRef } from 'react';
import { SlashCommand } from '../../../shared/types';

interface CommandPaletteProps {
  commands: SlashCommand[];
  filter: string;
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
  onHover: (index: number) => void;
  visible: boolean;
}

export function CommandPalette({
  commands,
  filter,
  selectedIndex,
  onSelect,
  onHover,
  visible
}: CommandPaletteProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Filter commands based on input
  const filteredCommands = commands.filter(cmd =>
    cmd.name.toLowerCase().startsWith(filter.toLowerCase())
  );

  // Scroll selected item into view
  useEffect(() => {
    if (listRef.current && selectedIndex >= 0) {
      const items = listRef.current.querySelectorAll('.command-item');
      items[selectedIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (!visible || filteredCommands.length === 0) {
    return null;
  }

  return (
    <div className="command-palette" ref={listRef}>
      {filteredCommands.map((cmd, index) => (
        <div
          key={cmd.name}
          className={`command-item ${index === selectedIndex ? 'selected' : ''}`}
          onClick={() => onSelect(cmd)}
          onMouseEnter={() => onHover(index)}
        >
          <span className="command-name">/{cmd.name}</span>
          {cmd.argumentHint && (
            <span className="command-hint">{cmd.argumentHint}</span>
          )}
          <span className="command-description">{cmd.description}</span>
        </div>
      ))}
    </div>
  );
}
```

#### 2. Add CSS styles
**File**: `src/renderer/styles/agent.css`
**Changes**: Add command palette styles

```css
/* Command Palette */
.command-palette {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  max-height: 240px;
  overflow-y: auto;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-2);
  box-shadow: var(--shadow-lg);
  z-index: 100;
}

.command-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
  transition: background var(--transition-fast);
}

.command-item:hover,
.command-item.selected {
  background: var(--color-bg-hover);
}

.command-name {
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  color: var(--color-accent);
  font-weight: 500;
}

.command-hint {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.command-description {
  flex: 1;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`

#### Manual Verification:
- [ ] Component renders when passed mock commands data
- [ ] Selected state highlights correct item
- [ ] Click triggers onSelect callback

---

## Phase 3: Integrate with ChatInput

### Overview
Detect `/` prefix in ChatInput, show CommandPalette, handle selection.

### Changes Required:

#### 1. Update ChatInput to manage command state
**File**: `src/renderer/components/Agent/ChatInput.tsx`
**Changes**:
- Add `commands` prop (from parent via agentStore)
- Detect when input starts with `/`
- Filter commands based on text after `/`
- Show/hide CommandPalette overlay
- Handle command selection with distinct behaviors:
  - **Tab**: Insert command into input for editing
  - **Enter**: Execute command immediately
  - **Click**: Insert command into input
- Handle keyboard navigation (Up/Down arrows, Tab, Enter, Escape)

```typescript
interface ChatInputProps {
  onSend: (message: string) => void;
  onInterrupt: () => void;
  isRunning: boolean;
  disabled: boolean;
  model: string | null;
  modelUsage: ModelUsage | null;
  commands: SlashCommand[];  // NEW
}

// Inside component:
const [showCommandPalette, setShowCommandPalette] = useState(false);
const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);

// Detect slash command input
const isCommandInput = input.startsWith('/');
const commandFilter = isCommandInput ? input.slice(1) : '';

// Filter commands
const filteredCommands = commands.filter(cmd =>
  cmd.name.toLowerCase().startsWith(commandFilter.toLowerCase())
);

// Show palette when typing commands
useEffect(() => {
  setShowCommandPalette(isCommandInput && filteredCommands.length > 0);
  setSelectedCommandIndex(0);
}, [input, isCommandInput, filteredCommands.length]);

// Insert command into input (for Tab key and Click)
const handleInsertCommand = useCallback((command: SlashCommand) => {
  // Insert command with trailing space for arguments
  setInput(`/${command.name} `);
  setShowCommandPalette(false);
  // Focus remains in input for user to continue typing
}, []);

// Execute command immediately (for Enter key)
const handleExecuteCommand = useCallback((command: SlashCommand) => {
  onSend(`/${command.name}`);
  setInput('');
  setShowCommandPalette(false);
}, [onSend]);

// Update keyboard handler for palette navigation
const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
  if (showCommandPalette && filteredCommands.length > 0) {
    const selectedCommand = filteredCommands[selectedCommandIndex];

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedCommandIndex(i => Math.min(i + 1, filteredCommands.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedCommandIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Tab') {
      // Tab: Insert command into input for editing
      e.preventDefault();
      if (selectedCommand) {
        handleInsertCommand(selectedCommand);
      }
    } else if (e.key === 'Enter') {
      // Enter: Execute command immediately
      e.preventDefault();
      if (selectedCommand) {
        handleExecuteCommand(selectedCommand);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setShowCommandPalette(false);
    }
    return;
  }

  // Normal enter handling (when palette is closed)
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
}, [showCommandPalette, filteredCommands, selectedCommandIndex, handleInsertCommand, handleExecuteCommand, handleSend]);
```

#### 2. Update ChatInput JSX
**File**: `src/renderer/components/Agent/ChatInput.tsx`
**Changes**: Add CommandPalette to render, wrap in relative container

```tsx
return (
  <div className="chat-input-wrapper">  {/* NEW wrapper for positioning */}
    <CommandPalette
      commands={filteredCommands}
      filter={commandFilter}
      selectedIndex={selectedCommandIndex}
      onSelect={handleInsertCommand}  // Click inserts command into input
      onHover={setSelectedCommandIndex}
      visible={showCommandPalette}
    />
    <div className="chat-input-card">
      {/* existing content */}
    </div>
  </div>
);
```

#### 3. Add wrapper styles
**File**: `src/renderer/styles/agent.css`
**Changes**: Add wrapper for command palette positioning

```css
.chat-input-wrapper {
  position: relative;
}
```

#### 4. Pass commands from AgentPanel
**File**: `src/renderer/components/Agent/AgentPanel.tsx`
**Changes**: Get `availableCommands` from store, pass to ChatInput

```typescript
const availableCommands = useAgentStore(
  (state) => state.instances[instanceId]?.availableCommands || []
);

// In render:
<ChatInput
  // ... existing props
  commands={availableCommands}
/>
```

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`

#### Manual Verification:
- [ ] Type `/` in input → palette appears
- [ ] Type `/cl` → filters to `/clear`, `/compact`
- [ ] Up/Down arrow keys navigate selection
- [ ] Press Tab → command inserted into input (e.g., `/clear `)
- [ ] Press Enter → command executed immediately
- [ ] Press Escape → palette closes
- [ ] Click command → command inserted into input

---

## Phase 4: Proper /clear Command Handling

### Overview
Ensure `/clear` is sent through SDK (not just local clear) and handle session restart.

### Changes Required:

#### 1. Add SessionEnd/SessionStart hook handling
**File**: `src/main/ClaudeAgentService.ts`
**Changes**:
- Add SessionEnd hook to detect `reason: 'clear'`
- Emit `session-clear` event so renderer can clear local state

```typescript
// In hooks option:
hooks: {
  // ... existing hooks
  SessionEnd: [{
    hooks: [async (input: { reason: string }) => {
      if (input.reason === 'clear') {
        this.emit('session-clear', {});
      }
      return {};
    }]
  }],
  SessionStart: [{
    hooks: [async (input: { source: string }) => {
      if (input.source === 'clear') {
        // Session restarted after clear
        this.emit('session-restart', {});
      }
      return {};
    }]
  }]
}
```

#### 2. Add IPC channels for session events
**File**: `src/shared/constants.ts`
**Changes**: Add session event channels

```typescript
AGENT_SESSION_CLEAR: 'agent:session-clear',
AGENT_SESSION_RESTART: 'agent:session-restart',
```

#### 3. Handle session clear in agentStore
**File**: `src/renderer/stores/agentStore.ts`
**Changes**:
- Add `_handleSessionClear` handler that clears messages and resets session state
- Wire up listener in initialization

```typescript
_handleSessionClear: (data: { instanceId: string }) => {
  const { instanceId } = data;
  set(state => updateInstance(state, instanceId, () => ({
    messages: [],
    toolHistory: [],
    pendingInputs: [],
    lastResult: null,
    sessionId: null
  })));
},
```

#### 4. Wire up IPC handler
**File**: `src/main/ipc-handlers.ts`
**Changes**: Forward session events to renderer

### Success Criteria:

#### Automated Verification:
- [ ] Build passes: `npm run build`

#### Manual Verification:
- [ ] Execute `/clear` command from palette
- [ ] Conversation clears
- [ ] Session ID changes (new session starts)
- [ ] Agent is ready for new conversation

---

## Testing Strategy

### Unit Tests (Future):
- CommandPalette renders correct commands
- Filter logic matches expected commands
- Keyboard navigation selects correct item

### Integration Tests (Future):
- Type `/clear` → session resets
- Command palette shows custom project commands

### Manual Testing Steps:
1. Start app, open a project folder
2. Send a message to initialize session
3. Type `/` → verify palette shows with commands
4. Type `/cl` → verify filter shows `/clear`, `/compact`
5. Use Up/Down arrow keys to navigate selection
6. Press **Tab** on `/model` → verify `/model ` is inserted in input
7. Press **Enter** on `/clear` → verify command executes and conversation clears
8. Verify new session starts with fresh context
9. Type `/co`, click on `/compact` → verify `/compact ` is inserted in input

---

## References

- Research doc: `research/2026-02-05-sdk-commands-and-hooks.md`
- SDK types: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:989-993` (supportedCommands)
- Current message handling: `src/renderer/stores/agentStore.ts:268-294`
- Service query: `src/main/ClaudeAgentService.ts:329`
- ChatInput component: `src/renderer/components/Agent/ChatInput.tsx`
- AgentPanel: `src/renderer/components/Agent/AgentPanel.tsx`

## Built-in Commands Reference

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
| `/config` | View/edit configuration | `[key] [value]` |
| `/permissions` | View/edit permissions | - |
| `/mcp` | MCP server management | `[subcommand]` |
| `/memory` | Edit CLAUDE.md | - |
| `/plan` | Enter/exit plan mode | - |
