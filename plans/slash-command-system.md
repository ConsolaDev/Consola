# Slash Command System Implementation Plan

## Overview

Implement a slash command suggestion system that displays available commands when the user types `/` in the chat input. Commands are fetched from the Claude Agent SDK, which automatically includes built-in, user, and project commands.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Main Process                                                     │
│  ClaudeAgentService.ts                                          │
│  └─ handleMessage('system', 'init') → emit slash_commands       │
└─────────────────────────────────────────────────────────────────┘
                              │ IPC
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ Renderer Process                                                 │
│                                                                  │
│  agentStore.ts                                                  │
│  └─ _handleInit → store commands in InstanceState               │
│                                                                  │
│  useSlashCommands.ts (new hook)                                 │
│  └─ Filter commands based on input, manage selection state      │
│                                                                  │
│  ChatInput.tsx                                                  │
│  └─ Detect `/` trigger, keyboard navigation                     │
│                                                                  │
│  CommandSuggestions.tsx (new component)                         │
│  └─ Render filtered command list above input                    │
└─────────────────────────────────────────────────────────────────┘
```

## Files to Modify/Create

### 1. Main Process - Expose commands via IPC

**File:** `src/main/ClaudeAgentService.ts`
- Add `slashCommands` and `skills` to the 'init' event emission (line 176-181)
- The SDK system message already includes these fields

**File:** `src/shared/types.ts`
- Add `SlashCommand` type
- Extend `AgentInitEvent` to include `slashCommands`

### 2. Renderer - Store commands

**File:** `src/renderer/stores/agentStore.ts`
- Add `slashCommands: SlashCommand[]` to `InstanceState`
- Update `_handleInit` to store commands

### 3. Renderer - New hook for command logic

**New file:** `src/renderer/hooks/useSlashCommands.ts`
```typescript
interface UseSlashCommandsResult {
  commands: SlashCommand[];          // Filtered commands
  selectedIndex: number;             // Currently selected
  isOpen: boolean;                   // Show suggestions
  filter: string;                    // Current filter text
  selectNext: () => void;            // Navigate down
  selectPrev: () => void;            // Navigate up
  selectCommand: () => SlashCommand | null;  // Get selected
  setFilter: (filter: string) => void;
  close: () => void;
}
```

### 4. Renderer - Command suggestions component

**New file:** `src/renderer/components/Agent/CommandSuggestions.tsx`
- Positioned above input using absolute positioning
- Renders filtered command list
- Highlights selected item
- Shows command name, description, and argument hint
- Keyboard hints footer (Tab to insert, Enter to run)

### 5. Renderer - Extend ChatInput

**File:** `src/renderer/components/Agent/ChatInput.tsx`
- Add `slashCommands` prop
- Detect `/` at start of input or after space
- Handle keyboard events: Arrow Up/Down, Tab, Enter, Escape
- Integrate `CommandSuggestions` component

### 6. Renderer - Styles

**File:** `src/renderer/components/Agent/styles.css`
- Add `.command-suggestions` container styles
- Add `.command-item` and `.command-item.selected` styles
- Use existing design tokens and animation patterns

## Implementation Steps

### Phase 1: Backend - Expose commands (2 files)

**Note on SDK data sources:**
- `SDKSystemMessage.slash_commands` = `string[]` (just names)
- `query.initializationResult().commands` = `SlashCommand[]` (full objects with descriptions)

For initial implementation, we'll use the names from the init message. Enhancement: store Query reference to call `initializationResult()` for full command details.

1. **`src/shared/types.ts`** - Add types:
   ```typescript
   export interface SlashCommand {
     name: string;
     description: string;
     argumentHint: string;
   }
   ```
   Extend `AgentInitEvent` to include `slashCommands: SlashCommand[]`

2. **`src/main/ClaudeAgentService.ts`** - Line ~176-181, extend init emission:
   ```typescript
   this.emit('init', {
     sessionId: message.session_id,
     model: message.model,
     tools: message.tools,
     mcpServers: message.mcp_servers,
     slashCommands: message.slash_commands?.map((name: string) => ({
       name,
       description: '',  // Names only from init message
       argumentHint: ''
     })) || []
   });
   ```

### Phase 2: Store - Cache commands (1 file)

3. **`src/renderer/stores/agentStore.ts`**:
   - Add `slashCommands: SlashCommand[]` to `InstanceState` (line ~57)
   - Initialize as empty array in `createDefaultInstanceState()` (line ~94)
   - Update `_handleInit` to store commands (line ~283-291)

### Phase 3: Hook - Command filtering logic (1 new file)

4. **`src/renderer/hooks/useSlashCommands.ts`** - New file:
   - Accept `commands: SlashCommand[]` from store
   - Manage `filter`, `selectedIndex`, `isOpen` state
   - Filter commands by prefix match on name
   - Provide navigation functions

### Phase 4: UI - Suggestion component (1 new file)

5. **`src/renderer/components/Agent/CommandSuggestions.tsx`** - New file:
   - Accept `commands`, `selectedIndex`, `onSelect`, `onInsert`
   - Render list with scroll container
   - Highlight selected item
   - Footer with keyboard hints

### Phase 5: Integration - ChatInput enhancement (1 file)

6. **`src/renderer/components/Agent/ChatInput.tsx`**:
   - Add `slashCommands` prop (passed from AgentPanel)
   - Detect slash trigger in `handleKeyDown`
   - Handle ArrowUp, ArrowDown, Tab, Enter, Escape
   - Render `CommandSuggestions` component when open

### Phase 6: Styling (1 file)

7. **`src/renderer/components/Agent/styles.css`**:
   - Add command suggestion styles (positioned above input)
   - Match existing dropdown patterns from Sidebar

## Keyboard Behavior

| Key | Action |
|-----|--------|
| `/` (at start or after space) | Open suggestions, set filter to empty |
| Typing after `/` | Filter commands by prefix |
| Arrow Up | Select previous command (wrap) |
| Arrow Down | Select next command (wrap) |
| Enter | Execute selected command (send as message) |
| Tab | Insert `/commandname ` into input, close suggestions |
| Escape | Close suggestions, keep input text |
| Any other key | Close suggestions if not filtering |

## Visual Design

Following existing patterns from `src/renderer/components/Sidebar/styles.css`:

```css
.command-suggestions {
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  max-height: 200px;
  overflow-y: auto;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  animation: dropdown-fade-in 150ms ease-out;
}

.command-item {
  padding: var(--space-2) var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  cursor: pointer;
}

.command-item.selected {
  background: var(--color-bg-active);
}

.command-name {
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
}

.command-description {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

## Verification

1. **Unit test the hook**: Ensure filtering and navigation work correctly
2. **Manual testing**:
   - Type `/` → suggestions appear
   - Type `/he` → only `/help` shown
   - Arrow keys navigate the list
   - Enter sends the command
   - Tab inserts command name
   - Escape closes without action
3. **Edge cases**:
   - No commands available (show empty state)
   - Very long command lists (scroll works)
   - Rapid typing (debounce if needed)

## Dependencies

- No new packages required
- Uses existing Radix UI components (Box, Flex, Text)
- Uses existing design tokens from `tokens.css`
