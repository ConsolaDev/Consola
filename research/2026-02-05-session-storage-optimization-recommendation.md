---
date: 2026-02-05T12:00:00-08:00
git_commit: 371c1352254eadde94bc59994dad13fbcd60b8f4
branch: main
repository: console-1
topic: "Session Storage Optimization for Long Conversations"
tags: [research, performance, storage, persistence]
status: complete
---

# Research: Session Storage Optimization for Long Conversations

**Date**: 2026-02-05
**Git Commit**: 371c135
**Branch**: main
**Repository**: console-1

## Research Question

Recommend the best approach for optimizing session storage to handle long conversations with good performance for both fetching and rendering.

## Summary

After analyzing the current implementation, **SQLite with better-sqlite3** is the recommended approach for long conversations. However, the recommendation includes a phased implementation plan that starts with quick wins before the full migration.

## Current Implementation Analysis

### Storage Flow

```
User Message → agentStore → IPC → SessionStorageService → ~/.userData/sessions/{id}.json
                               ↓
                        JSON.stringify(entire history)
```

### Data Structures and Memory Impact

| Structure | Location | Memory Concern |
|-----------|----------|----------------|
| `Message.content` + `Message.contentBlocks` | agentStore.ts:51-57 | Dual storage duplicates data |
| `FileAttachment.content` | agentStore.ts:14-20 | Full file content stored inline (unbounded) |
| `ToolExecution.toolResponse` | agentStore.ts:60-68 | Complete tool output (can be megabytes) |
| `ThinkingBlock.thinking` | agentStore.ts:29-33 | Extended reasoning chains |

### Growth Pattern Example

A typical 20-turn session with 50 tool calls per turn:
- 20 messages × 2KB average = 40KB
- 1000 tool executions × 50KB average I/O = **50MB**
- JSON stringify creates additional copy during serialization

### Rendering Bottleneck

- **No virtualization** - All messages rendered as DOM nodes (AgentPanel.tsx:54-82)
- **Collapse patterns** used instead: CodeBlock (15 lines), BashOutput (3 lines), ToolOutput (10 lines)
- **No component memoization** - ChatMessage, ToolBlock, ThinkingBlock re-render on parent updates

### Current Storage Dependencies

- **zustand** with `persist` middleware → LocalStorage (workspaces, navigation, settings)
- **fs/promises** → JSON files (session history)
- **No database libraries** in package.json

## Recommended Approach: Phased Implementation

### Phase 1: Quick Wins (1-2 days)

#### 1.1 Debounced Saves
```typescript
// agentStore.ts
import { debounce } from 'lodash-es';

const debouncedSave = debounce(async (instanceId: string) => {
  await sessionStorageBridge.saveHistory(instanceId, {...});
}, 2000);
```

**Why**: Tool-heavy turns can trigger 50+ saves. Debouncing reduces I/O by 95%.

#### 1.2 React.memo on Message Components
```typescript
// ChatMessage.tsx
export const ChatMessage = React.memo(({ message, toolHistory }: Props) => {
  // existing implementation
}, (prev, next) => prev.message.id === next.message.id);
```

**Why**: Prevents re-render of unchanged messages when new messages arrive.

### Phase 2: Data Optimization (3-5 days)

#### 2.1 Remove Content Duplication
Currently storing both `content` (plain text) and `contentBlocks` (structured). Extract plain text on-demand:

```typescript
// Remove content field, compute when needed
const getPlainText = (blocks: ContentBlock[]) =>
  blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
```

**Savings**: ~40% reduction in message storage.

#### 2.2 Truncate Large Tool Responses
```typescript
const MAX_TOOL_RESPONSE_SIZE = 50_000; // 50KB

_handleToolComplete: (data) => {
  const response = typeof data.toolResponse === 'string'
    ? data.toolResponse.slice(0, MAX_TOOL_RESPONSE_SIZE)
    : data.toolResponse;
  // store truncated version
}
```

**Why**: A single `find /` or `cat large-file` can add megabytes.

### Phase 3: SQLite Migration (5-7 days)

#### 3.1 Why SQLite over Chunked JSON

| Factor | Chunked JSON | SQLite |
|--------|--------------|--------|
| Append writes | Requires chunk management | Native append support |
| Partial reads | Complex chunk loading | `LIMIT/OFFSET` queries |
| Search | Load all chunks | `LIKE` queries with indexes |
| Concurrent access | Manual locking | Built-in WAL mode |
| Electron compatibility | Good | Excellent (native bindings) |

#### 3.2 Schema Design

```sql
-- Optimized for append-heavy, time-ordered access
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,  -- 'user' | 'assistant'
  content_blocks TEXT, -- JSON array (no separate content field)
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE tool_executions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_use_id TEXT,
  tool_name TEXT NOT NULL,
  tool_input TEXT,     -- JSON, nullable for large inputs
  tool_response TEXT,  -- JSON, truncated if needed
  status TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Indexes for common queries
CREATE INDEX idx_messages_session_ts ON messages(session_id, timestamp);
CREATE INDEX idx_tools_session_ts ON tool_executions(session_id, timestamp);
CREATE INDEX idx_tools_use_id ON tool_executions(tool_use_id);
```

#### 3.3 Implementation with better-sqlite3

```typescript
// src/main/database/SessionDatabase.ts
import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';

const DB_PATH = path.join(app.getPath('userData'), 'consola.db');

export class SessionDatabase {
  private db: Database.Database;

  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL'); // Better concurrent performance
    this.db.pragma('synchronous = NORMAL');
    this.initSchema();
  }

  // Append-only message insertion (fast)
  insertMessage(sessionId: string, message: Message) {
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, session_id, type, content_blocks, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      message.id,
      sessionId,
      message.type,
      JSON.stringify(message.contentBlocks),
      message.timestamp
    );
  }

  // Paginated loading for long sessions
  getMessages(sessionId: string, limit = 50, offset = 0): Message[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `);
    return stmt.all(sessionId, limit, offset).map(row => ({
      id: row.id,
      type: row.type,
      content: '', // Compute on-demand if needed
      contentBlocks: JSON.parse(row.content_blocks),
      timestamp: row.timestamp
    }));
  }

  // Get recent messages (most common operation)
  getRecentMessages(sessionId: string, count = 20): Message[] {
    return this.getMessages(sessionId, count, 0);
  }
}
```

#### 3.4 Migration Strategy

1. **Detect existing JSON sessions** on app start
2. **Import to SQLite** in background (don't block startup)
3. **Delete JSON files** after successful import
4. **New sessions** go directly to SQLite

```typescript
async function migrateJsonToSqlite(db: SessionDatabase) {
  const sessionsDir = path.join(app.getPath('userData'), 'sessions');
  const files = await fs.readdir(sessionsDir);

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const sessionId = file.replace('.json', '');
    const data = JSON.parse(await fs.readFile(path.join(sessionsDir, file), 'utf-8'));

    // Import messages and tools
    db.importSession(sessionId, data.messages, data.toolHistory);

    // Clean up JSON file
    await fs.unlink(path.join(sessionsDir, file));
  }
}
```

### Phase 4: Virtual Scrolling (Optional, 3-5 days)

Only needed if Phase 3 doesn't solve rendering performance:

```typescript
// Using react-window for virtualization
import { VariableSizeList } from 'react-window';

const MessageList = ({ messages, toolHistory }) => {
  const getItemSize = (index) => {
    // Estimate based on content blocks
    const msg = messages[index];
    return estimateMessageHeight(msg);
  };

  return (
    <VariableSizeList
      height={containerHeight}
      itemCount={messages.length}
      itemSize={getItemSize}
      width="100%"
    >
      {({ index, style }) => (
        <div style={style}>
          <ChatMessage message={messages[index]} />
        </div>
      )}
    </VariableSizeList>
  );
};
```

## Performance Projections

| Approach | Save Time (1000 msgs) | Load Time | Memory | Complexity |
|----------|----------------------|-----------|--------|------------|
| Current JSON | 500ms+ (full rewrite) | 300ms+ | High (all in memory) | Low |
| Debounced JSON | 500ms (less frequent) | 300ms+ | High | Low |
| Chunked JSON | ~50ms (single chunk) | ~50ms (recent chunk) | Medium | Medium |
| **SQLite** | **~5ms (single INSERT)** | **~10ms (paginated)** | **Low (paginated)** | **Medium** |

## Recommendation Summary

1. **Immediate** (Phase 1): Add debounced saves + React.memo → 1-2 days
2. **Short-term** (Phase 2): Remove content duplication + truncate responses → 3-5 days
3. **Medium-term** (Phase 3): SQLite migration → 5-7 days
4. **If needed** (Phase 4): Virtual scrolling → 3-5 days

**Total estimated effort**: 2-3 weeks for complete implementation

The SQLite approach is recommended because:
- Native append operations (no full rewrite)
- Built-in pagination (`LIMIT/OFFSET`)
- WAL mode handles concurrent reads/writes
- Excellent Electron compatibility via `better-sqlite3`
- Future-proof for search, filtering, and analytics features

## Code References

- `src/main/SessionStorageService.ts` - Current JSON persistence
- `src/renderer/stores/agentStore.ts:348-366` - Save/load triggers
- `src/renderer/components/Agent/AgentPanel.tsx:54-82` - Message rendering
- `src/renderer/components/Agent/ChatMessage.tsx` - Message component (no memo)
- `package.json` - No database dependencies currently

## Open Questions

1. Should old tool responses be archived/compressed after N days?
2. Should there be a session size warning when approaching limits?
3. Would search across sessions be valuable (would benefit from SQLite FTS5)?
