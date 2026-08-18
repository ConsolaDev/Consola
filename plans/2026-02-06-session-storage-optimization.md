# Implementation Plan: Session Storage Optimization for Long Conversations

**Date**: 2026-02-06
**Status**: Ready for implementation
**Research**: `research/2026-02-05-session-storage-optimization-recommendation.md`

## Overview

Optimize session storage and rendering to handle long conversations (100+ messages, 1000+ tool calls) without performance degradation. The current JSON-based storage rewrites the entire file on every save, causing 500ms+ delays for large sessions.

## Current State Analysis

### Storage
- **File**: `src/main/SessionStorageService.ts`
- Full JSON rewrite on every save (line 19: `JSON.stringify(data, null, 2)`)
- No debouncing - saves triggered on every result/error (`agentStore.ts:562, 573`)
- Data stored at `~/.userData/sessions/{sessionId}.json`

### Data Duplication
- **File**: `src/renderer/stores/agentStore.ts`
- Messages store both `content` (string) and `contentBlocks` (array) - lines 55-68
- `content` is already derivable from `contentBlocks` via `getPlainText()` (lines 268-273)
- Tool responses stored in full, unbounded (`toolResponse?: unknown` at line 85)

### Rendering
- **File**: `src/renderer/components/Agent/AgentPanel.tsx`
- No virtualization - all messages rendered (lines 70-90)
- **File**: `src/renderer/components/Agent/ChatMessage.tsx`
- No `React.memo` - component re-renders on any parent state change

## Desired End State

1. Session saves complete in <50ms regardless of session size
2. Long sessions (500+ messages) load and render smoothly
3. Memory usage remains bounded even with extensive tool history
4. Backward compatibility with existing session files

## What We're NOT Doing

- Full search/analytics features (FTS5 can be added later)
- Session archival/compression policies
- Breaking changes to the session data format
- Virtual scrolling (defer unless Phase 3 doesn't solve rendering issues)

## Implementation Approach

A phased approach allows incremental improvement with measurable results after each phase. Each phase is independently valuable and can be deployed separately.

---

## Phase 1: Quick Wins (Debounced Saves + React.memo)

### Overview
Reduce unnecessary I/O and re-renders with minimal code changes. Expected to provide 80-90% improvement for most use cases.

### Changes Required

#### 1.1 Add Debounced Save Utility

**File**: `src/renderer/stores/agentStore.ts`

Add a debounced save function to batch rapid successive saves:

```typescript
import { debounce } from 'lodash-es';

// Debounce saves - tool-heavy turns can trigger 50+ saves
const debouncedSave = debounce(
  async (instanceId: string, messages: Message[], toolHistory: ToolExecution[]) => {
    await sessionStorageBridge.saveHistory(instanceId, { messages, toolHistory });
  },
  2000,  // 2 second delay
  { maxWait: 10000 }  // Force save after 10 seconds max
);
```

Update `_handleResult` and `_handleError` to use debounced save instead of immediate save.

**Dependency**: Install `lodash-es` if not present, or use a simple debounce implementation.

#### 1.2 Memoize ChatMessage Component

**File**: `src/renderer/components/Agent/ChatMessage.tsx`

Wrap component with `React.memo` and custom comparison:

```typescript
import { memo } from 'react';

export const ChatMessage = memo(function ChatMessage({
  type,
  content,
  contentBlocks,
  timestamp,
  toolHistory = []
}: ChatMessageProps) {
  // ... existing implementation
}, (prev, next) => {
  // Only re-render if message content changed or tool results updated
  if (prev.type !== next.type) return false;
  if (prev.content !== next.content) return false;
  if (prev.timestamp !== next.timestamp) return false;

  // For assistant messages, check if relevant tools changed
  if (prev.contentBlocks !== next.contentBlocks) return false;

  // Check if any tool_use blocks have new results
  const prevToolIds = prev.contentBlocks?.filter(b => b.type === 'tool_use').map(b => b.id) || [];
  for (const id of prevToolIds) {
    const prevResult = prev.toolHistory?.find(t => t.toolUseId === id);
    const nextResult = next.toolHistory?.find(t => t.toolUseId === id);
    if (prevResult?.status !== nextResult?.status) return false;
    if (prevResult?.toolResponse !== nextResult?.toolResponse) return false;
  }

  return true;
});
```

#### 1.3 Memoize Child Components

**Files**:
- `src/renderer/components/Agent/ThinkingBlock.tsx`
- `src/renderer/components/Agent/ToolBlock.tsx`
- `src/renderer/components/Agent/FileContentBlock.tsx`

Wrap each with `React.memo`:

```typescript
export const ThinkingBlock = memo(function ThinkingBlock({ content }: Props) {
  // existing implementation
});
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] TypeScript compiles without errors
- [ ] E2E tests pass: `npm run test:e2e`

#### Manual Verification
- [ ] Send 10 rapid messages - observe network tab shows batched saves (not 10 individual saves)
- [ ] In a session with 50+ messages, sending new message doesn't cause visible re-render of old messages
- [ ] Session data persists correctly after app restart

---

## Phase 2: Data Optimization

### Overview
Reduce storage size by eliminating redundant data and truncating unbounded fields.

### Changes Required

#### 2.1 Remove Content Duplication from Storage

**File**: `src/renderer/stores/agentStore.ts`

Modify `saveInstanceHistory` to exclude redundant `content` field:

```typescript
saveInstanceHistory: async (instanceId) => {
  const instance = get().instances[instanceId];
  if (instance) {
    // Strip redundant content field for assistant messages before saving
    const optimizedMessages = instance.messages.map(msg => {
      if (msg.type === 'assistant' && msg.contentBlocks) {
        const { content, ...rest } = msg;
        return rest;  // content can be derived from contentBlocks
      }
      return msg;
    });

    await sessionStorageBridge.saveHistory(instanceId, {
      messages: optimizedMessages,
      toolHistory: instance.toolHistory,
    });
  }
},
```

Modify `loadInstanceHistory` to reconstruct `content`:

```typescript
loadInstanceHistory: async (instanceId) => {
  const data = await sessionStorageBridge.loadHistory(instanceId);
  if (data) {
    // Reconstruct content field for assistant messages
    const messages = (data.messages as Message[]).map(msg => {
      if (msg.type === 'assistant' && msg.contentBlocks && !msg.content) {
        return { ...msg, content: getPlainText(msg.contentBlocks) };
      }
      return msg;
    });

    set((state) => updateInstance(state, instanceId, () => ({
      messages,
      toolHistory: data.toolHistory as ToolExecution[],
    })));
  }
},
```

#### 2.2 Truncate Large Tool Responses

**File**: `src/renderer/stores/agentStore.ts`

Add constants and truncation logic:

```typescript
const MAX_TOOL_RESPONSE_SIZE = 50_000;  // 50KB limit
const TRUNCATION_MARKER = '\n\n... [truncated for storage] ...';

function truncateToolResponse(response: unknown): unknown {
  if (typeof response === 'string' && response.length > MAX_TOOL_RESPONSE_SIZE) {
    return response.slice(0, MAX_TOOL_RESPONSE_SIZE) + TRUNCATION_MARKER;
  }
  if (typeof response === 'object' && response !== null) {
    const str = JSON.stringify(response);
    if (str.length > MAX_TOOL_RESPONSE_SIZE) {
      return { _truncated: true, preview: str.slice(0, 1000) };
    }
  }
  return response;
}
```

Apply in `_handleToolComplete`:

```typescript
_handleToolComplete: (data: AgentToolEvent) => {
  const { instanceId, ...toolData } = data;
  set(state => {
    // ... existing logic ...

    newToolHistory[pendingIndex] = {
      ...newToolHistory[pendingIndex],
      toolUseId: toolData.toolUseId || newToolHistory[pendingIndex].toolUseId,
      toolResponse: truncateToolResponse(toolData.toolResponse),  // Truncate here
      status: 'complete'
    };

    // ...
  });
},
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] E2E tests pass: `npm run test:e2e`

#### Manual Verification
- [ ] Existing sessions still load correctly (backward compatibility)
- [ ] New sessions have smaller file sizes (check `~/.userData/sessions/`)
- [ ] Large tool outputs (e.g., `cat large-file.txt`) are truncated in stored JSON
- [ ] UI still displays full tool output during live session

---

## Phase 3: SQLite Migration

### Overview
Replace JSON file storage with SQLite for efficient append-only writes and paginated reads.

### Changes Required

#### 3.1 Add Database Dependencies

**File**: `package.json`

```json
{
  "dependencies": {
    "better-sqlite3": "^11.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.8"
  }
}
```

Note: `better-sqlite3` requires native compilation. Electron-rebuild may be needed.

#### 3.2 Create Database Module

**File**: `src/main/database/SessionDatabase.ts` (new file)

```typescript
import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';

const DB_PATH = path.join(app.getPath('userData'), 'consola.db');

export class SessionDatabase {
  private db: Database.Database;

  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.initSchema();
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT,
        content_blocks TEXT,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS tool_executions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        tool_use_id TEXT,
        tool_name TEXT NOT NULL,
        tool_input TEXT,
        tool_response TEXT,
        status TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_tools_session ON tool_executions(session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_tools_use_id ON tool_executions(tool_use_id);
    `);
  }

  // Append-only operations
  insertMessage(sessionId: string, message: any) {
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, session_id, type, content, content_blocks, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      message.id,
      sessionId,
      message.type,
      message.content || null,
      message.contentBlocks ? JSON.stringify(message.contentBlocks) : null,
      message.timestamp
    );
  }

  insertToolExecution(sessionId: string, tool: any) {
    const stmt = this.db.prepare(`
      INSERT INTO tool_executions (id, session_id, tool_use_id, tool_name, tool_input, tool_response, status, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      tool.id,
      sessionId,
      tool.toolUseId || null,
      tool.toolName,
      tool.toolInput ? JSON.stringify(tool.toolInput) : null,
      tool.toolResponse ? JSON.stringify(tool.toolResponse) : null,
      tool.status,
      tool.timestamp
    );
  }

  updateToolExecution(toolId: string, updates: { toolResponse?: unknown; status?: string }) {
    const stmt = this.db.prepare(`
      UPDATE tool_executions
      SET tool_response = COALESCE(?, tool_response), status = COALESCE(?, status)
      WHERE id = ?
    `);
    stmt.run(
      updates.toolResponse ? JSON.stringify(updates.toolResponse) : null,
      updates.status || null,
      toolId
    );
  }

  // Paginated reads
  getMessages(sessionId: string, limit = 50, offset = 0) {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE session_id = ?
      ORDER BY timestamp ASC
      LIMIT ? OFFSET ?
    `);
    return stmt.all(sessionId, limit, offset).map(row => ({
      id: row.id,
      type: row.type,
      content: row.content || '',
      contentBlocks: row.content_blocks ? JSON.parse(row.content_blocks) : undefined,
      timestamp: row.timestamp
    }));
  }

  getToolExecutions(sessionId: string, limit = 100, offset = 0) {
    const stmt = this.db.prepare(`
      SELECT * FROM tool_executions
      WHERE session_id = ?
      ORDER BY timestamp ASC
      LIMIT ? OFFSET ?
    `);
    return stmt.all(sessionId, limit, offset).map(row => ({
      id: row.id,
      toolUseId: row.tool_use_id,
      toolName: row.tool_name,
      toolInput: row.tool_input ? JSON.parse(row.tool_input) : undefined,
      toolResponse: row.tool_response ? JSON.parse(row.tool_response) : undefined,
      status: row.status,
      timestamp: row.timestamp
    }));
  }

  close() {
    this.db.close();
  }
}

let instance: SessionDatabase | null = null;

export function getSessionDatabase(): SessionDatabase {
  if (!instance) {
    instance = new SessionDatabase();
  }
  return instance;
}
```

#### 3.3 Update SessionStorageService

**File**: `src/main/SessionStorageService.ts`

Replace JSON operations with database calls:

```typescript
import { getSessionDatabase } from './database/SessionDatabase';

// Keep JSON functions for migration, but mark as deprecated
export async function saveSessionData(sessionId: string, data: PersistedSessionData): Promise<void> {
  const db = getSessionDatabase();

  // Upsert session record
  // Insert/update messages (only new ones)
  // Insert/update tool executions
}

export async function loadSessionData(sessionId: string): Promise<PersistedSessionData | null> {
  const db = getSessionDatabase();

  const messages = db.getMessages(sessionId);
  const toolHistory = db.getToolExecutions(sessionId);

  if (messages.length === 0 && toolHistory.length === 0) {
    return null;
  }

  return { messages, toolHistory };
}
```

#### 3.4 Migration Script

**File**: `src/main/database/migrate-json-to-sqlite.ts` (new file)

```typescript
import * as fs from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import { getSessionDatabase } from './SessionDatabase';

export async function migrateJsonSessionsToSqlite(): Promise<void> {
  const sessionsDir = path.join(app.getPath('userData'), 'sessions');
  const db = getSessionDatabase();

  try {
    const files = await fs.readdir(sessionsDir);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const sessionId = file.replace('.json', '');
      const filePath = path.join(sessionsDir, file);

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const data = JSON.parse(content);

        // Import messages
        for (const msg of data.messages || []) {
          db.insertMessage(sessionId, msg);
        }

        // Import tool history
        for (const tool of data.toolHistory || []) {
          db.insertToolExecution(sessionId, tool);
        }

        // Archive the JSON file (don't delete immediately)
        await fs.rename(filePath, `${filePath}.migrated`);

      } catch (err) {
        console.error(`Failed to migrate session ${sessionId}:`, err);
      }
    }
  } catch (err) {
    // sessions directory may not exist
  }
}
```

#### 3.5 Initialize Migration on App Start

**File**: `src/main/index.ts`

Add migration call during app initialization:

```typescript
import { migrateJsonSessionsToSqlite } from './database/migrate-json-to-sqlite';

app.whenReady().then(async () => {
  // Run migration in background (don't block startup)
  migrateJsonSessionsToSqlite().catch(console.error);

  // ... rest of initialization
});
```

### Success Criteria

#### Automated Verification
- [ ] Build passes: `npm run build`
- [ ] Native module compiles: `npm run postinstall` (electron-rebuild)
- [ ] E2E tests pass: `npm run test:e2e`

#### Manual Verification
- [ ] Fresh install creates `consola.db` in userData
- [ ] Existing JSON sessions are migrated on first launch
- [ ] `.json.migrated` files created as backup
- [ ] New sessions write to SQLite (no new `.json` files created)
- [ ] Session loads in <50ms regardless of message count
- [ ] App startup is not blocked by migration

---

## Phase 4: Virtual Scrolling (If Needed)

### Overview
Only implement if Phase 3 doesn't resolve rendering performance for very long sessions (500+ messages).

### Changes Required

#### 4.1 Add react-window Dependency

```json
{
  "dependencies": {
    "react-window": "^1.8.10"
  },
  "devDependencies": {
    "@types/react-window": "^1.8.8"
  }
}
```

#### 4.2 Create Virtualized Message List

**File**: `src/renderer/components/Agent/VirtualizedMessageList.tsx` (new file)

```typescript
import { useRef, useCallback } from 'react';
import { VariableSizeList, ListChildComponentProps } from 'react-window';
import { ChatMessage } from './ChatMessage';
import type { Message, ToolExecution } from '../../stores/agentStore';

interface Props {
  messages: Message[];
  toolHistory: ToolExecution[];
  height: number;
}

// Rough height estimates (will be refined dynamically)
function estimateMessageHeight(message: Message): number {
  if (message.type === 'system') return 40;
  if (message.type === 'user') return Math.max(60, message.content.length / 2);

  // Assistant messages with content blocks
  if (message.type === 'assistant' && message.contentBlocks) {
    let height = 40; // Base padding
    for (const block of message.contentBlocks) {
      if (block.type === 'text') height += Math.max(40, block.text.length / 3);
      if (block.type === 'thinking') height += 60; // Collapsed by default
      if (block.type === 'tool_use') height += 80;
    }
    return height;
  }

  return 100;
}

export function VirtualizedMessageList({ messages, toolHistory, height }: Props) {
  const listRef = useRef<VariableSizeList>(null);
  const sizeMap = useRef<Record<number, number>>({});

  const getItemSize = useCallback((index: number) => {
    return sizeMap.current[index] || estimateMessageHeight(messages[index]);
  }, [messages]);

  const setItemSize = useCallback((index: number, size: number) => {
    if (sizeMap.current[index] !== size) {
      sizeMap.current[index] = size;
      listRef.current?.resetAfterIndex(index);
    }
  }, []);

  const Row = useCallback(({ index, style }: ListChildComponentProps) => {
    const msg = messages[index];

    return (
      <div style={style}>
        <MessageRow
          message={msg}
          toolHistory={toolHistory}
          onHeightChange={(h) => setItemSize(index, h)}
        />
      </div>
    );
  }, [messages, toolHistory, setItemSize]);

  return (
    <VariableSizeList
      ref={listRef}
      height={height}
      itemCount={messages.length}
      itemSize={getItemSize}
      width="100%"
      initialScrollOffset={messages.length * 100} // Scroll to bottom
    >
      {Row}
    </VariableSizeList>
  );
}
```

### Success Criteria

#### Automated Verification
- [ ] Build passes
- [ ] E2E tests pass

#### Manual Verification
- [ ] Scrolling is smooth with 500+ messages
- [ ] Auto-scroll to bottom works on new messages
- [ ] Message selection (Cmd+A) still works

---

## Testing Strategy

### Unit Tests
- Debounce function batches saves correctly
- Truncation respects size limits
- SQLite operations handle edge cases (empty sessions, concurrent writes)

### Integration Tests
- Session persistence round-trip (save → quit → relaunch → load)
- Migration from JSON to SQLite preserves all data
- Backward compatibility with existing session format

### Manual Testing Steps
1. Create session with 10+ messages and various tool calls
2. Quit and relaunch app
3. Verify all messages and tool history restored
4. Send additional messages
5. Verify new data persists correctly

## References

- Research: `research/2026-02-05-session-storage-optimization-recommendation.md`
- Storage service: `src/main/SessionStorageService.ts`
- Agent store: `src/renderer/stores/agentStore.ts:389-406`
- Message rendering: `src/renderer/components/Agent/AgentPanel.tsx:70-90`
- Chat message component: `src/renderer/components/Agent/ChatMessage.tsx`

## Open Questions (Resolved)

1. ~~Should old tool responses be archived/compressed?~~ → Truncation at 50KB is sufficient for now
2. ~~Session size warning?~~ → Defer to future work
3. ~~Search across sessions?~~ → SQLite enables FTS5 later if needed
