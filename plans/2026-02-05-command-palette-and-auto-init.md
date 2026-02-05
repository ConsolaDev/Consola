# Plan: Fix Command Palette Issues & Add Auto-Init Welcome UI

**Date**: 2026-02-05
**Status**: draft
**Priority**: high
**Tracking**: PLAN-001

## Summary

Fix two critical command palette issues and add automatic SDK session initialization with a welcome UI when a project opens.

## Current Issues (from research)

### Issue 1: Local Skills Not Loading
**Root Cause**: `supportedCommands()` is called immediately after creating the query object but **before** iterating over messages. The SDK only discovers local skills after the `init` system message is received during iteration.

**Location**: `src/main/ClaudeAgentService.ts:367-378`

### Issue 2: Commands Not Executing
**Root Cause**: When a user executes a command (e.g., `/compact`), it's sent as a new query prompt. However, commands like `/compact` and `/clear` don't emit assistant messages—they only emit internal events (`session-clear`) or silent `result` events. The UI appears stuck because no visible response arrives.

## Proposed Solution

### Part 1: Auto-Init Session on Project Open (New Feature)

Instead of waiting for user input to initialize the SDK session, proactively start a lightweight "init" query when the project opens. This ensures:
- SDK session is ready before user interaction
- Local skills/commands are discovered immediately
- User sees a welcome UI (similar to Claude CLI)

**Implementation:**

1. **Add `initSession()` method to ClaudeAgentService**
   - New method that starts a minimal query just to trigger SDK initialization
   - Use an empty/minimal prompt that won't generate a full response
   - Capture the `init` message with skills/commands

2. **Add `initSession` IPC handler**
   - New IPC channel to trigger session initialization from renderer
   - Returns when init message is received (or timeout)

3. **Add `initSession` to agentBridge**
   - Expose the IPC call to renderer

4. **Add `initializeSession()` to agentStore**
   - New action to request session initialization
   - Track `isInitializing` state

5. **Update AgentPanel with Welcome UI**
   - Show welcome screen when session not initialized
   - Auto-trigger initialization on mount
   - Display: project name, model info, available tools count, skills count
   - Similar aesthetic to Claude CLI welcome message

### Part 2: Fix supportedCommands() Timing

**Option A (Preferred): Move to post-init**
- Don't call `supportedCommands()` at query start
- Rely solely on the `init` message for commands/skills
- The `init` message already contains `message.skills[]` and `message.slash_commands[]`

**Option B (Alternative): Call after first iteration**
- Defer `supportedCommands()` call until after receiving the first message
- More complex, requires async coordination

**Recommendation**: Option A—the init message already provides the data we need.

### Part 3: Fix Command Execution Feedback

Commands like `/compact`, `/clear` produce no visible assistant message. The UI needs to handle these cases:

1. **Add command-specific feedback messages**
   - When `/compact` completes → show "Session compacted" system message
   - When `/clear` completes → show "Session cleared" system message

2. **Handle `session-clear` and `session-restart` events**
   - Already emitted by SDK hooks (SessionEnd, SessionStart)
   - Add UI feedback when these events fire

3. **Detect silent command completion**
   - If `result` event arrives with no assistant message, check if prompt was a slash command
   - Generate appropriate UI feedback

## Implementation Tasks

### Task 1: Create Welcome UI Component
**File**: `src/renderer/components/Agent/WelcomeScreen.tsx` (new)

```tsx
interface WelcomeScreenProps {
  projectPath: string;
  model: string | null;
  toolCount: number;
  skillCount: number;
  isInitializing: boolean;
  onStartChat: () => void;
}
```

Display:
- Claude logo/icon
- "Welcome to Claude" heading
- Project path (truncated)
- Model name (once initialized)
- "X tools available" (once initialized)
- "X skills available" (once initialized)
- Input field ready for first message

### Task 2: Add Session Initialization to ClaudeAgentService
**File**: `src/main/ClaudeAgentService.ts`

```typescript
async initSession(): Promise<void> {
  // Start minimal query to trigger SDK init
  // Use continue: false to start fresh
  // Capture init message
}
```

Key points:
- Use a minimal prompt (e.g., empty string or special init marker)
- Don't add to message history
- Emit `init` event with skills/commands
- Handle gracefully if session already initialized

### Task 3: Add IPC Handlers
**File**: `src/main/ipc-handlers.ts`

- Add `AGENT_INIT_SESSION` constant
- Add handler that calls `service.initSession()`
- Return session info (model, tools, skills)

### Task 4: Update agentBridge
**File**: `src/renderer/services/agentBridge.ts`

- Add `initSession(instanceId, cwd)` method
- Return promise that resolves with session info

### Task 5: Update agentStore
**File**: `src/renderer/stores/agentStore.ts`

- Add `isInitializing` to InstanceState
- Add `initializeSession(instanceId, cwd)` action
- Update `_handleInit` to clear `isInitializing`

### Task 6: Update AgentPanel
**File**: `src/renderer/components/Agent/AgentPanel.tsx`

- Check if session is initialized on mount
- If not, trigger `initializeSession()`
- Show WelcomeScreen during initialization and when no messages
- Replace empty state with welcome UI

### Task 7: Fix Command Execution Feedback
**File**: `src/renderer/stores/agentStore.ts`

- Track last sent message in store
- In `_handleResult`, check if last message was a slash command
- If so, and no assistant message was received, generate system feedback message
- Handle `/clear` specially (it already clears messages via `_handleSessionClear`)

### Task 8: Remove Early supportedCommands() Call
**File**: `src/main/ClaudeAgentService.ts`

- Remove or defer the `supportedCommands()` call at lines 367-378
- Commands will come through the `init` message instead

## File Changes Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `src/renderer/components/Agent/WelcomeScreen.tsx` | New | Welcome UI component |
| `src/main/ClaudeAgentService.ts` | Modify | Add `initSession()`, remove early `supportedCommands()` |
| `src/main/ipc-handlers.ts` | Modify | Add `AGENT_INIT_SESSION` handler |
| `src/preload/preload.ts` | Modify | Expose `initSession` method |
| `src/renderer/services/agentBridge.ts` | Modify | Add `initSession()` method |
| `src/renderer/stores/agentStore.ts` | Modify | Add `isInitializing`, `initializeSession()`, fix command feedback |
| `src/renderer/components/Agent/AgentPanel.tsx` | Modify | Use WelcomeScreen, auto-init |
| `src/shared/constants.ts` | Modify | Add `AGENT_INIT_SESSION` constant |
| `src/shared/types.ts` | Modify | Update types if needed |

## Success Criteria

1. **Auto-init works**: When opening a project, session initializes automatically without user input
2. **Welcome UI displays**: Shows Claude welcome similar to CLI with model/tools info
3. **Local skills appear**: All `.claude/skills/` commands show in command palette
4. **Commands execute with feedback**: Running `/compact` shows "Session compacted" message
5. **No stuck UI**: After any command execution, UI returns to ready state

## Testing Plan

1. Open a project → verify welcome UI appears
2. Wait for init → verify model/tools/skills shown
3. Type `/` → verify all local skills appear in palette
4. Execute `/compact` → verify feedback message appears
5. Execute `/clear` → verify messages cleared and feedback shown
6. Type regular message → verify conversation works normally

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Empty prompt might confuse SDK | Test with minimal prompts, consider using SDK's internal init mechanism if available |
| Double init if user types quickly | Track init state, prevent duplicate init calls |
| Init failure | Show error state, allow retry, fallback to init-on-first-message |
