---
date: 2026-02-04T12:00:00-08:00
git_commit: dbcbbc3408334c8a7e6378495913f3767b8b8841
branch: feature/unified-markdown-support
repository: console-1
topic: "Slash Command System Implementation Research"
tags: [research, codebase, input-system, commands, ux]
status: complete
---

# Research: Slash Command System Implementation

**Date**: 2026-02-04
**Git Commit**: dbcbbc3408334c8a7e6378495913f3767b8b8841
**Branch**: feature/unified-markdown-support
**Repository**: console-1

## Research Question

How to implement a slash command system (like Claude Code's `/` commands) that:
1. Shows suggestions when user types `/`
2. Filters suggestions as user types
3. Supports keyboard navigation (up/down arrows)
4. Enter to invoke command, Tab to insert command name and continue typing
5. Includes both global commands and project-specific commands

## Summary

The codebase currently has:
- A basic `ChatInput` component with textarea and Enter-to-send functionality
- Radix UI primitives for dropdowns, tooltips, and dialogs
- A CSS variable-based design system with design tokens
- Global keyboard shortcuts via `useKeyboardShortcuts` hook
- Zustand stores for state management
- **No existing autocomplete, suggestion, or command system**

**Key Discovery**: The Claude Agent SDK provides APIs to fetch available commands dynamically:
- `query.supportedCommands()` returns all available slash commands
- Commands include built-in, user (`~/.claude/commands/`), and project (`.claude/commands/`) commands
- No need to hardcode command lists - the SDK handles discovery and merging

## Detailed Findings

### 1. Current Input Component

**File:** `src/renderer/components/Agent/ChatInput.tsx`

The ChatInput component is simple:
- Local state for input text (`useState`)
- `handleKeyDown` for Enter (send) and Shift+Enter (newline)
- Callbacks: `onSend`, `onInterrupt`
- No autocomplete or suggestion functionality

```typescript
// Current props interface (lines 4-9)
interface ChatInputProps {
  onSend: (message: string) => void;
  onInterrupt: () => void;
  isRunning: boolean;
  disabled: boolean;
}
```

**Key integration point:** Lines 21-26 handle keyboard events - this is where slash command detection would be added.

### 2. Available UI Primitives

**Radix UI packages already installed:**
- `@radix-ui/react-dropdown-menu` v2.1.16
- `@radix-ui/react-dialog` v1.1.15
- `@radix-ui/react-tooltip` v1.2.8
- `@radix-ui/react-collapsible` v1.1.12
- `@radix-ui/themes` v3.3.0 (Box, Flex, Text, Button, ScrollArea)

**Existing dropdown patterns:**
- `WorkspaceActionsMenu` (`src/renderer/components/Sidebar/WorkspaceActionsMenu.tsx`)
- `ProjectActionsMenu` (`src/renderer/components/Sidebar/ProjectActionsMenu.tsx`)
- Both use portal-based rendering with animations

**Existing keyboard navigation:**
- `useKeyboardShortcuts` hook (`src/renderer/hooks/useKeyboardShortcuts.ts`)
- TabBar has `@dnd-kit` keyboard navigation for reordering

### 3. Design System

**Design tokens:** `src/renderer/styles/themes/tokens.css`
- Spacing: `--space-1` through `--space-8` (4px to 32px)
- Typography: `--font-sans`, `--font-mono`, sizes xs through xl
- Radii: `--radius-sm` (3px), `--radius-md` (6px), `--radius-lg` (8px)
- Transitions: `--transition-fast` (0.1s), `--transition-normal` (0.2s)
- Z-index: `--z-sidebar` (100), `--z-tooltip` (200), `--z-modal` (300)

**Theme colors:** Dark and light themes with:
- Background layers: primary, secondary, tertiary
- Text layers: primary, secondary, tertiary, disabled
- Interactive states: hover, active, selected
- Accent color: `--color-accent` (cyan/blue)

### 4. Existing Animations

**From Sidebar styles (`src/renderer/components/Sidebar/styles.css`):**
```css
/* Dropdown fade-in (lines 396-402) */
@keyframes dropdown-fade-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Collapsible slide (lines 235-254) */
@keyframes collapsible-slide-down {
  from { height: 0; }
  to { height: var(--radix-collapsible-content-height); }
}
```

### 5. State Management Pattern

**Zustand stores pattern:**
- `workspaceStore.ts` - workspace CRUD
- `tabStore.ts` - tab management
- `navigationStore.ts` - sidebar state
- `agentStore.ts` - agent communication
- `settingsStore.ts` - theme preferences

Commands will be fetched from the SDK and cached in the agent store or a dedicated hook.

### 6. Claude Agent SDK Command APIs

**File:** `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`

The SDK provides built-in APIs for command discovery:

```typescript
// SlashCommand type (lines 1624-1637)
type SlashCommand = {
  name: string;        // Command name (without leading /)
  description: string; // What the command does
  argumentHint: string; // e.g., "<file>" or ""
};

// Query interface method (lines 989-993)
supportedCommands(): Promise<SlashCommand[]>;

// Initialization response (lines 1181-1190)
type SDKControlInitializeResponse = {
  commands: SlashCommand[];
  models: ModelInfo[];
  account: AccountInfo;
  // ...
};
```

**Command sources** (automatically merged by SDK):
- **Built-in**: `/help`, `/clear`, `/compact`, `/model`, `/resume`, `/usage`, etc.
- **User commands**: `~/.claude/commands/*.md`
- **Project commands**: `.claude/commands/*.md`

**System message** also includes command lists:
```typescript
type SDKSystemMessage = {
  slash_commands: string[];  // Command names
  skills: string[];          // Skill names
  // ...
};
```

## Architecture Documentation

### Current Data Flow for Chat Input

```
User types → ChatInput (local state)
           ↓
User presses Enter → handleSend()
           ↓
onSend callback → AgentPanel
           ↓
useAgent hook → sendMessage()
           ↓
agentStore.sendMessage() → agentBridge.startQuery()
           ↓
IPC to main process
```

### Proposed Extension Points

1. **ChatInput.tsx** - Add slash detection in `handleKeyDown`
2. **New hook** - `useSlashCommands` for fetching commands from SDK and filtering
3. **New component** - `CommandSuggestions` for the suggestion list overlay
4. **agentStore.ts** - Cache commands from SDK initialization response

### SDK Integration Flow

```
Session Init → SDK returns commands in initializationResult()
            ↓
agentStore caches commands per instance
            ↓
User types "/" → useSlashCommands hook filters cached commands
            ↓
CommandSuggestions renders filtered list
            ↓
User selects command → Either execute (Enter) or insert (Tab)
```

## Code References

- `src/renderer/components/Agent/ChatInput.tsx` - Main input component
- `src/renderer/components/Agent/styles.css:120-147` - Input styling
- `src/renderer/hooks/useKeyboardShortcuts.ts` - Global shortcut pattern
- `src/renderer/components/Sidebar/WorkspaceActionsMenu.tsx` - Dropdown pattern
- `src/renderer/components/Sidebar/styles.css:383-403` - Dropdown content styling
- `src/renderer/styles/themes/tokens.css` - Design tokens
- `src/renderer/styles/themes/dark.css` - Dark theme colors

## UX Recommendations

Based on the frontend-design skill guidelines and existing patterns:

### 1. Trigger Behavior

- **Slash trigger**: Show suggestions when `/` is typed at start of input or after whitespace
- **Filtering**: As user continues typing after `/`, filter the list in real-time
- **Keyboard shortcut**: `Cmd/Ctrl + K` to open command palette directly (common pattern)

### 2. Suggestion List Design

Following the frontend-design skill's emphasis on distinctive, non-generic aesthetics:

- **Position**: Above the input (like Discord/Slack), not below
- **Max height**: ~200px with scroll for overflow
- **Animation**: Slide up + fade in (150ms, matching existing patterns)
- **Visual hierarchy**:
  - Command name in medium weight
  - Description in secondary text color
  - Category/source badge for global vs project commands
  - Keyboard hint (Tab/Enter) in tertiary color

### 3. Keyboard Navigation

- **Up/Down arrows**: Navigate list (wrap around)
- **Enter**: Execute the selected command immediately
- **Tab**: Insert command name into input, keep cursor after it for additional args
- **Escape**: Close suggestions, keep input text
- **Continued typing**: Filter list, reset selection to first match

### 4. Command Sources (from SDK)

Commands are fetched dynamically from the SDK via `supportedCommands()`. The SDK automatically merges:

- **Built-in commands**: `/help`, `/clear`, `/compact`, `/model`, `/resume`, `/usage`, `/stats`, `/rewind`, `/rename`, `/exit`, `/kill`
- **User commands**: Custom `.md` files in `~/.claude/commands/`
- **Project commands**: Custom `.md` files in `.claude/commands/`
- **Skills**: Loaded from `.claude/skills/` directories

No hardcoding required - the SDK handles all discovery.

### 5. Visual Design

Matching existing design system:
- Use `--color-bg-secondary` for suggestion background
- Use `--color-border` for subtle border
- Use `--shadow-md` for elevation
- Use `--radius-md` (6px) for rounded corners
- Selected item: `--color-bg-active` background
- Use `lucide-react` icons for command categories

## Component Structure Recommendation

```
src/renderer/
├── components/Agent/
│   ├── ChatInput.tsx           # Extended with slash detection
│   ├── CommandSuggestions.tsx  # New: suggestion list overlay
│   └── styles.css              # Extended with suggestion styles
├── hooks/
│   └── useSlashCommands.ts     # New: command filtering hook
└── stores/
    └── agentStore.ts           # Extended: cache commands from SDK
```

**Types** (use SDK's `SlashCommand` type directly from `@anthropic-ai/claude-agent-sdk`):
```typescript
import type { SlashCommand } from '@anthropic-ai/claude-agent-sdk';
```

## Open Questions (Resolved)

1. ~~**Command execution context**~~: Enter executes immediately, Tab inserts for editing
2. ~~**Project command discovery**~~: SDK handles this via `supportedCommands()`
3. **Command arguments**: SDK provides `argumentHint` field - display in UI
4. **History**: Nice-to-have for v2, not required for initial implementation
5. **Fuzzy matching**: Start with prefix matching, can add fuzzy later
