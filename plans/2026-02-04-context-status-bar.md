# Implementation Plan: Context Status Bar Above Input

**Created**: 2026-02-04
**Status**: Ready for Implementation
**Research**: [research/2026-02-04-context-status-bar-above-input.md](../research/2026-02-04-context-status-bar-above-input.md)

## Overview

Add a subtle status bar between the messages area and the chat input displaying: current model name, cumulative token usage, and context window percentage. Visual style modeled after VS Code status bar (subtle gray, minimal).

## Current State Analysis

### What Exists
- `useAgent` hook exposes `model` and `lastResult` (with basic `usage` field) - `useAgent.ts:120,134`
- Token data flows: SDK → ClaudeAgentService → IPC → agentStore → useAgent → Components
- `AgentPanel.tsx` has clear insertion point between error banner and ChatInput (lines 90-92)
- SDK provides rich `ModelUsage` data but we're only capturing basic `input_tokens`/`output_tokens`

### Key Discovery: SDK Provides Everything We Need

The SDK's result event includes `modelUsage: Record<string, ModelUsage>` with:

```typescript
type ModelUsage = {
  inputTokens: number;           // Cumulative input tokens
  outputTokens: number;          // Cumulative output tokens
  cacheReadInputTokens: number;  // Cache hits
  cacheCreationInputTokens: number;
  contextWindow: number;         // The context window size!
  maxOutputTokens: number;
  costUSD: number;
};
```

**We don't need to:**
- Track cumulative tokens ourselves (SDK provides cumulative totals)
- Maintain a hardcoded model limits lookup (SDK provides `contextWindow`)

**We just need to:**
- Forward the full `modelUsage` data from ClaudeAgentService
- Use it directly in the status bar

### What's Missing
- Forwarding `modelUsage` from SDK result event
- Types for ModelUsage
- ContextStatusBar component
- Integration into AgentPanel

## Desired End State

After implementation:
1. A subtle gray status bar appears above the chat input
2. Shows: `Sonnet 4 | 15,234 / 200,000 tokens (7.6%)`
3. Updates after each agent turn with cumulative totals from SDK
4. Uses SDK-provided `contextWindow` for percentage calculation
5. Visual style is minimal - doesn't distract from conversation

## What We're NOT Doing

- Real-time streaming token updates (updates after turn completes)
- Cost display (`costUSD` available but not shown)
- Dismissible/collapsible status bar
- Context compaction warnings (future enhancement)
- Cache token breakdown display (data available for future use)

---

## Implementation Approach

1. Forward full `modelUsage` from SDK through the event chain
2. Update types and store to hold ModelUsage data
3. Build ContextStatusBar component using SDK data directly
4. Integrate into AgentPanel

---

## Phase 1: Forward ModelUsage from SDK

### Overview
Update the event chain to pass through the full `modelUsage` data from SDK result events.

### Changes Required

#### 1. Update `src/shared/types.ts`
**Changes**: Add ModelUsage type and update AgentResultEvent

```typescript
// Add new type
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  contextWindow: number;
  maxOutputTokens: number;
  costUSD: number;
}

// Update AgentResultEvent
export interface AgentResultEvent {
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
  modelUsage?: Record<string, ModelUsage>;  // ADD: Full usage per model
}
```

#### 2. Update `src/main/ClaudeAgentService.ts`
**Changes**: Forward modelUsage in result event emission

Find where the 'result' event is emitted and add modelUsage:

```typescript
// In the result handler (around line 366-376)
this.emit('result', {
  subtype: data.subtype,
  sessionId: data.session_id,
  result: data.result,
  isError: data.is_error,
  numTurns: data.num_turns,
  totalCostUsd: data.total_cost_usd,
  usage: data.usage,
  modelUsage: data.modelUsage  // ADD: Forward the full modelUsage
});
```

#### 3. Update IPC handlers if needed
**File**: `src/main/ipc-handlers.ts`
**Changes**: Ensure modelUsage passes through IPC (should work automatically if types are correct)

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] TypeScript compilation succeeds

#### Manual Verification
- [ ] Console.log in renderer shows modelUsage data after agent response
- [ ] modelUsage contains contextWindow value
- [ ] Token counts are cumulative (increase with each turn)

---

## Phase 2: Update Store and Hook

### Overview
Update agentStore to persist modelUsage and expose it via useAgent hook.

### Changes Required

#### 1. Update `src/renderer/stores/agentStore.ts`
**Changes**: Store modelUsage in instance state

```typescript
// InstanceState interface already has lastResult which will now include modelUsage
// No changes needed if lastResult type is updated

// Optionally, add convenience getter for current model's usage:
// The modelUsage is keyed by model ID, so we need to extract it

// In _handleResult, the lastResult will automatically include modelUsage
// since we updated the AgentResultEvent type
```

#### 2. Update `src/renderer/hooks/useAgent.ts`
**Changes**: Expose modelUsage with a convenient accessor

```typescript
// Add to the returned object (~line 140)
// Extract usage for the current model from lastResult.modelUsage
const currentModelUsage = useMemo(() => {
  if (!instanceState?.lastResult?.modelUsage || !instanceState?.model) {
    return null;
  }
  // modelUsage is keyed by model ID
  return instanceState.lastResult.modelUsage[instanceState.model] ?? null;
}, [instanceState?.lastResult?.modelUsage, instanceState?.model]);

// Return in hook
return {
  // ... existing fields
  modelUsage: currentModelUsage,  // ADD
};
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] TypeScript compilation succeeds

#### Manual Verification
- [ ] useAgent returns modelUsage with correct data
- [ ] modelUsage.contextWindow has expected value (e.g., 200000)
- [ ] modelUsage.inputTokens increases with each turn

---

## Phase 3: ContextStatusBar Component

### Overview
Create the status bar component with VS Code-inspired styling, using SDK data directly.

### Changes Required

#### 1. Create `src/renderer/components/Agent/ContextStatusBar.tsx`
**Purpose**: Display model, tokens, and percentage using SDK modelUsage

```tsx
import { Box, Text } from '@radix-ui/themes';
import { ModelUsage } from '../../../shared/types';

interface ContextStatusBarProps {
  model: string | null;
  modelUsage: ModelUsage | null;
}

function formatModelName(modelId: string | null): string {
  if (!modelId) return 'Unknown';

  // Extract friendly name: "claude-sonnet-4-20250514" → "Sonnet 4"
  // Try pattern: claude-{variant}-{version}-{date}
  const match = modelId.match(/claude-(\w+)-(\d+)/);
  if (match) {
    const [, variant, version] = match;
    return `${variant.charAt(0).toUpperCase() + variant.slice(1)} ${version}`;
  }

  return modelId;
}

export function ContextStatusBar({ model, modelUsage }: ContextStatusBarProps) {
  // Don't render if no data yet
  if (!model && !modelUsage) {
    return null;
  }

  const totalTokens = modelUsage
    ? modelUsage.inputTokens + modelUsage.outputTokens
    : 0;
  const contextWindow = modelUsage?.contextWindow ?? 200_000;
  const percentage = contextWindow > 0 ? (totalTokens / contextWindow) * 100 : 0;

  const formatNumber = (n: number) => n.toLocaleString();

  // Determine warning state
  const statusClass = percentage >= 85 ? 'critical' : percentage >= 70 ? 'warning' : '';

  return (
    <Box className={`context-status-bar ${statusClass}`}>
      <Text size="1" className="context-status-text">
        {model && (
          <span className="context-status-model">{formatModelName(model)}</span>
        )}
        {modelUsage && (
          <>
            <span className="context-status-separator">|</span>
            <span className="context-status-tokens">
              {formatNumber(totalTokens)} / {formatNumber(contextWindow)}
            </span>
            <span className="context-status-percentage">
              ({percentage.toFixed(1)}%)
            </span>
          </>
        )}
      </Text>
    </Box>
  );
}
```

#### 2. Update `src/renderer/components/Agent/styles.css`
**Changes**: Add status bar styles (VS Code-inspired)

```css
/* Context Status Bar - VS Code style */
.context-status-bar {
  padding: var(--space-1) var(--space-3);
  background: var(--gray-2);
  border-top: 1px solid var(--gray-4);
  display: flex;
  align-items: center;
  min-height: 22px;
}

.context-status-text {
  color: var(--gray-11);
  font-family: var(--font-mono);
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.context-status-model {
  color: var(--gray-12);
}

.context-status-separator {
  color: var(--gray-8);
}

.context-status-tokens {
  color: var(--gray-11);
}

.context-status-percentage {
  color: var(--gray-10);
}

/* Warning state when approaching limit (>70%) */
.context-status-bar.warning .context-status-percentage {
  color: var(--yellow-11);
}

/* Critical state when near limit (>85%) */
.context-status-bar.critical .context-status-percentage {
  color: var(--red-11);
}
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] TypeScript compilation succeeds

#### Manual Verification
- [ ] Status bar renders with correct model name
- [ ] Token count formats with commas (e.g., "15,234")
- [ ] Percentage displays with one decimal place
- [ ] Subtle gray appearance, doesn't distract
- [ ] Warning/critical colors appear at thresholds

---

## Phase 4: Integration into AgentPanel

### Overview
Wire up the ContextStatusBar into AgentPanel and connect to useAgent data.

### Changes Required

#### 1. Update `src/renderer/components/Agent/AgentPanel.tsx`
**Changes**: Add status bar between error banner and ChatInput

```tsx
import { ContextStatusBar } from './ContextStatusBar';

export function AgentPanel({ instanceId, cwd }: AgentPanelProps) {
  const {
    // ... existing destructuring
    model,       // ADD (may already be destructured)
    modelUsage,  // ADD
  } = useAgent(instanceId, cwd);

  return (
    <Flex direction="column" className="agent-panel">
      {/* Messages area */}
      <Box className="messages-container" ref={messagesContainerRef}>
        {/* ... existing content */}
      </Box>

      {/* Error display (conditional) */}
      {error && (
        <Box className="error-banner">
          {/* ... existing error UI */}
        </Box>
      )}

      {/* Context Status Bar - NEW */}
      <ContextStatusBar model={model} modelUsage={modelUsage} />

      {/* Input */}
      <ChatInput
        onSubmit={handleSend}
        onInterrupt={interrupt}
        isProcessing={isProcessing}
        disabled={!isAvailable}
      />
    </Flex>
  );
}
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] TypeScript compilation succeeds
- [ ] No console errors in dev mode

#### Manual Verification
- [ ] Status bar appears above the input field
- [ ] Model name displays after first response
- [ ] Token count updates after each turn (cumulative)
- [ ] Percentage calculated correctly using SDK contextWindow
- [ ] Visual appearance is subtle and non-intrusive

---

## Testing Strategy

### Manual Testing Steps
1. Start fresh conversation - status bar should be hidden (no data yet)
2. Send first message - model name and token count appear after response
3. Send additional messages - token count increases (cumulative from SDK)
4. Verify percentage uses correct contextWindow (check SDK provides ~200K for Sonnet)
5. Verify warning color appears if usage exceeds 70%
6. Verify critical color appears if usage exceeds 85%

### Edge Cases
- Model name is null initially - handle gracefully
- modelUsage is undefined - don't crash, show model name only
- contextWindow is 0 - avoid division by zero

---

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `src/shared/types.ts` | UPDATE | Add ModelUsage type, update AgentResultEvent |
| `src/main/ClaudeAgentService.ts` | UPDATE | Forward modelUsage in result event |
| `src/renderer/hooks/useAgent.ts` | UPDATE | Expose modelUsage for current model |
| `src/renderer/components/Agent/ContextStatusBar.tsx` | CREATE | Status bar component |
| `src/renderer/components/Agent/styles.css` | UPDATE | Add status bar styles |
| `src/renderer/components/Agent/AgentPanel.tsx` | UPDATE | Integrate status bar |

---

## Future Enhancements (Not In Scope)

1. **Context Compaction Warning**: Alert when approaching 70-80% with suggested actions
2. **Cache Token Breakdown**: Show cache_read vs cache_creation tokens (data already available)
3. **Cost Display**: Add optional cost display toggle (costUSD available in modelUsage)
4. **Session Duration**: Show time elapsed in session
5. **Auto-Compact Trigger**: Automatic compaction at threshold
6. **Click to Details**: Click status bar to show full context breakdown

---

## References

- Research document: `research/2026-02-04-context-status-bar-above-input.md`
- SDK types: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (ModelUsage at lines 416-429)
- ClaudeAgentService: `src/main/ClaudeAgentService.ts:366-376` (result event)
- useAgent hook: `src/renderer/hooks/useAgent.ts:108-155`
- AgentPanel structure: `src/renderer/components/Agent/AgentPanel.tsx:47-99`
