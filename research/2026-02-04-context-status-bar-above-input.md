---
date: 2026-02-04T12:00:00-08:00
git_commit: 28bf072f9bf3545aaf46da305c609d7869c1c4e7
branch: feature/agent-output-rendering
repository: console-1
topic: "Context status bar above input - model and token usage display"
tags: [research, codebase, ui, context, tokens, model]
status: complete
---

# Research: Context Status Bar Above Input

**Date**: 2026-02-04
**Git Commit**: 28bf072f9bf3545aaf46da305c609d7869c1c4e7
**Branch**: feature/agent-output-rendering
**Repository**: console-1

## Research Question

Figure out if we could get information from the context command to display summary information about the current context right above the input where the user types. The information to show should be very simple: current model and tokens usage (and %).

## Summary

Yes, this is feasible. The codebase already tracks all the necessary data (model name, token usage) in the agent state. The data flows from the SDK through the main process to the renderer and is stored in Zustand. A new `ContextStatusBar` component can be added between the messages container and the input area in `AgentPanel.tsx` to display this information.

**Key finding**: There is NO `/context` command implemented yet. However, all the data that such a command would display is already available in the component state via the `useAgent` hook.

## Detailed Findings

### 1. Data Already Available in State

The `useAgent` hook (`src/renderer/hooks/useAgent.ts:108-155`) already exposes:

| Field | Type | Source | Description |
|-------|------|--------|-------------|
| `model` | `string \| null` | `instanceState.model` | Current model name (e.g., "claude-3-opus") |
| `lastResult` | `AgentResultEvent \| null` | `instanceState.lastResult` | Contains token usage after each turn |

The `lastResult` object (`src/shared/types.ts:71-83`) contains:
```typescript
interface AgentResultEvent {
  instanceId: string;
  subtype: string;
  sessionId: string;
  result: string | null;
  isError: boolean;
  numTurns: number;
  totalCostUsd: number;
  usage: {
    input_tokens: number | null;
    output_tokens: number | null;
  };
}
```

### 2. Current UI Structure

The `AgentPanel` component (`src/renderer/components/Agent/AgentPanel.tsx:47-99`) has this structure:

```
<Flex direction="column" className="agent-panel">
  {/* Messages area */}
  <Box className="messages-container">
    ...messages, approvals, processing indicator...
  </Box>

  {/* Error display (conditional) */}
  {error && <Box className="error-banner">...</Box>}

  {/* Input */}
  <ChatInput ... />
</Flex>
```

**Where to insert the status bar**: Between the error banner and the ChatInput (lines 90-92).

### 3. Data NOT Currently Displayed

The `AgentPanel` component destructures from `useAgent()` but does NOT include `model` or `lastResult`:

```typescript
// Current (AgentPanel.tsx:15-28)
const {
  isAvailable,
  isRunning,
  messages,
  toolHistory,
  pendingInputs,
  error,
  isProcessing,
  sendMessage,
  interrupt,
  clearError,
  respondToInput
} = useAgent(instanceId, cwd);
```

These need to be added to access model and token data.

### 4. How Token Data Flows

1. **SDK emits result** → `ClaudeAgentService.ts:366-376` handles 'result' message type
2. **IPC forwards to renderer** → `ipc-handlers.ts:64-67` sends via `AGENT_RESULT` channel
3. **Preload receives** → `preload.ts:60` invokes callback
4. **Store updates** → `agentStore.ts:429-434` `_handleResult()` stores in `lastResult`
5. **Hook exposes** → `useAgent.ts:134` returns `lastResult` property

### 5. Implementation Approach

#### Option A: Simple Status Text (Recommended)

Add a minimal status bar directly in `AgentPanel.tsx`:

```typescript
// Add to destructuring:
const { model, lastResult, ... } = useAgent(instanceId, cwd);

// Insert between error-banner and ChatInput:
{(model || lastResult) && (
  <Box className="context-status-bar">
    <Text size="1" color="gray">
      {model && <span>{model}</span>}
      {lastResult?.usage && (
        <span>
          {lastResult.usage.input_tokens?.toLocaleString()} in /
          {lastResult.usage.output_tokens?.toLocaleString()} out
        </span>
      )}
    </Text>
  </Box>
)}
```

#### Option B: Separate Component

Create `ContextStatusBar.tsx` for better separation:

```typescript
interface ContextStatusBarProps {
  model: string | null;
  lastResult: AgentResultEvent | null;
  contextWindow?: number; // Optional: for percentage calculation
}
```

### 6. Context Window Percentage

To show percentage, you need the model's context window size. This is NOT currently tracked in the codebase. Options:

1. **Hardcode model limits** - Create a lookup table for known models
2. **Get from SDK** - The SDK may provide this in init data (not currently captured)
3. **Skip percentage** - Just show raw token counts initially

### 7. CSS Styling Location

Add styles to `src/renderer/components/Agent/styles.css`. Suggested placement: after `.error-banner` styles (line 62), before `.chat-input-container` (line 65).

## Code References

- `src/renderer/components/Agent/AgentPanel.tsx:15-28` - useAgent destructuring (needs model, lastResult)
- `src/renderer/components/Agent/AgentPanel.tsx:90-92` - Where to insert status bar
- `src/renderer/hooks/useAgent.ts:120` - model property exposed
- `src/renderer/hooks/useAgent.ts:134` - lastResult property exposed
- `src/renderer/stores/agentStore.ts:91` - model stored per instance
- `src/renderer/stores/agentStore.ts:105` - lastResult stored per instance
- `src/renderer/stores/agentStore.ts:429-434` - Result handler updates lastResult
- `src/shared/types.ts:71-83` - AgentResultEvent with usage field
- `src/renderer/components/Agent/styles.css:65-69` - Nearby CSS location

## Architecture Documentation

### State Management Pattern

The codebase uses Zustand for state management with a per-instance pattern:

```
instances: Record<string, InstanceState>
```

Each workspace/tab has its own `instanceId`, and all agent state (messages, tools, results) is scoped to that instance.

### Data Flow Pattern

```
SDK → ClaudeAgentService (main) → IPC → agentStore (renderer) → useAgent hook → Components
```

Events are emitted from the main process and handled by the store, which updates state that components subscribe to via hooks.

## Open Questions

1. **Context window limits**: Where to get the max context window for each model to calculate percentage?
2. **Cumulative vs per-turn**: Should tokens show cumulative session usage or just last turn?
3. **Cost display**: Should `totalCostUsd` also be shown?
4. **Refresh timing**: The data only updates after each agent turn completes - is that sufficient?
