---
date: 2026-02-12T12:00:00+01:00
git_commit: 5fd4ad586de7ef1fced45cf558118223cbc0de18
branch: main
repository: console-1
topic: "Plan & Research Management System - Feature Design"
tags: [research, feature-design, collaboration, versioning, task-management, linear, jira, mcp]
status: complete
---

# Research: Plan & Research Management System

**Date**: 2026-02-12
**Git Commit**: 5fd4ad586de7ef1fced45cf558118223cbc0de18
**Branch**: main
**Repository**: console-1

## Research Question

Design a comprehensive feature set that allows:
1. Research and plans to be stored, searchable, and sortable in a structured view (table with ticket numbers)
2. Single or multi-user collaboration with versioning, audit log, and draft/publish workflow
3. Plans to be broken down into tasks and exported to Jira/Linear via MCP servers
4. UX/UI design that integrates naturally into the existing Consola application

## Summary

This document defines the architecture for a **Plan & Research Management System (PRMS)** that transforms Consola from a pure AI-assisted development tool into a structured knowledge management platform. The system introduces document-centric workflows with versioning, collaboration, and external project management integration—all built on top of the existing Electron + React + SQLite + Zustand architecture.

---

## Part 1: Existing Architecture Assessment

### Current State

The application currently has:

| Component | Technology | Location |
|-----------|-----------|----------|
| Database | better-sqlite3 (SQLite) | `{userData}/consola.db` |
| State Management | Zustand 5.0.11 | `src/renderer/stores/` (9 stores) |
| UI Framework | Radix UI + Lucide React | Components with co-located CSS |
| IPC Bridge | Context isolation + bridge pattern | `src/renderer/services/` |
| File Storage | Markdown files on disk | `./research/`, `./plans/` |
| Session Persistence | SQLite (sessions, messages, tool_executions) | `src/main/database/SessionDatabase.ts` |

### Current Research/Plan Storage

Research documents are **flat markdown files** in `./research/` with YAML frontmatter:
```yaml
date, git_commit, branch, repository, topic, tags, status
```

Plans exist in `./plans/` as markdown files but with **no structured metadata, versioning, or searchability**.

### Key Gap Analysis

| Feature | Current State | Needed |
|---------|--------------|--------|
| Structured storage | Flat files, no index | SQLite tables with full-text search |
| Search/sort | None (manual file browsing) | Full-text search, filters, sorting |
| Unique identifiers | None | Ticket numbers (e.g., PLAN-001, RES-042) |
| Versioning | None (git only) | Document-level version history |
| Collaboration | None (single user) | Draft/publish workflow, audit log |
| Task breakdown | None | Hierarchical tasks linked to plans |
| External sync | None | Linear/Jira via MCP or direct API |

---

## Part 2: Data Model Design

### 2.1 Core Entity: `Document`

The central entity that represents both research documents and plans.

```typescript
interface Document {
  id: string;                          // UUID
  ticketNumber: string;                // e.g., "PLAN-001", "RES-042"
  type: 'plan' | 'research';
  title: string;
  summary: string;                     // Brief description for table view
  content: string;                     // Markdown content (current published version)
  status: DocumentStatus;
  priority: 'low' | 'medium' | 'high' | 'critical';
  tags: string[];

  // Authorship
  authorId: string;                    // User who created it
  authorName: string;

  // Workspace context
  workspaceId: string;                 // Parent workspace
  sessionId?: string;                  // Originating session (if created from conversation)

  // Metadata
  gitCommit?: string;                  // Commit at creation time
  gitBranch?: string;

  // Timestamps
  createdAt: number;
  updatedAt: number;
  publishedAt?: number;                // Last published version timestamp

  // Counters
  currentVersion: number;              // Latest published version number
  taskCount: number;                   // Derived: number of linked tasks
  completedTaskCount: number;          // Derived: completed tasks
}

type DocumentStatus =
  | 'draft'           // Initial creation, not shared
  | 'in_review'       // Shared for review
  | 'approved'        // Approved and ready for implementation
  | 'in_progress'     // Being implemented (tasks in progress)
  | 'completed'       // All tasks done
  | 'archived';       // No longer active
```

### 2.2 Document Versions

```typescript
interface DocumentVersion {
  id: string;                          // UUID
  documentId: string;                  // Parent document
  version: number;                     // Sequential version number (1, 2, 3...)
  content: string;                     // Full markdown snapshot
  title: string;                       // Title at this version
  summary: string;                     // Summary at this version
  changeDescription: string;           // What changed in this version

  // Authorship
  authorId: string;
  authorName: string;

  // State
  isDraft: boolean;                    // true = local draft, false = published

  createdAt: number;
}
```

### 2.3 Local Draft

```typescript
interface DocumentDraft {
  id: string;
  documentId: string;                  // Parent document
  userId: string;                      // Draft owner
  content: string;                     // Working content
  title: string;
  summary: string;
  changeDescription: string;           // Notes about what's being changed

  // Auto-save
  lastSavedAt: number;
  autoSaveIntervalMs: number;          // Default 30s

  createdAt: number;
  updatedAt: number;
}
```

### 2.4 Tasks (Breakdown)

```typescript
interface Task {
  id: string;                          // UUID
  ticketNumber: string;                // e.g., "TASK-001"
  documentId: string;                  // Parent plan/research
  parentTaskId?: string;               // For sub-tasks

  title: string;
  description: string;                 // Markdown
  status: TaskStatus;
  priority: 'low' | 'medium' | 'high' | 'critical';

  // Assignment
  assigneeId?: string;
  assigneeName?: string;

  // Estimation
  estimate?: string;                   // e.g., "2h", "1d", "3sp" (story points)

  // External sync
  externalProvider?: 'linear' | 'jira';
  externalId?: string;                 // Linear/Jira issue ID
  externalUrl?: string;                // Deep link to external issue
  externalStatus?: string;             // Cached status from provider
  lastSyncedAt?: number;

  // Ordering
  sortOrder: number;

  createdAt: number;
  updatedAt: number;
}

type TaskStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'cancelled';
```

### 2.5 Audit Log

```typescript
interface AuditLogEntry {
  id: string;
  entityType: 'document' | 'task' | 'version';
  entityId: string;
  action: AuditAction;
  userId: string;
  userName: string;
  details: Record<string, unknown>;    // Action-specific payload
  timestamp: number;
}

type AuditAction =
  | 'created'
  | 'updated'
  | 'status_changed'
  | 'version_published'
  | 'draft_created'
  | 'draft_discarded'
  | 'task_added'
  | 'task_updated'
  | 'task_completed'
  | 'task_synced_to_external'
  | 'comment_added'
  | 'tag_added'
  | 'tag_removed'
  | 'archived'
  | 'unarchived';
```

### 2.6 Comments (for Collaboration)

```typescript
interface Comment {
  id: string;
  documentId: string;
  taskId?: string;                     // Optional: comment on specific task
  versionNumber?: number;              // Optional: comment on specific version
  parentCommentId?: string;            // For threaded replies

  content: string;                     // Markdown
  authorId: string;
  authorName: string;

  // Inline annotation
  selectionStart?: number;             // Character offset in document
  selectionEnd?: number;

  isResolved: boolean;
  resolvedBy?: string;
  resolvedAt?: number;

  createdAt: number;
  updatedAt: number;
}
```

### 2.7 User Identity

For collaboration, we need a lightweight user concept:

```typescript
interface UserProfile {
  id: string;                          // UUID, generated on first launch
  name: string;                        // User-provided or system username
  email?: string;                      // Optional
  avatarColor: string;                 // Auto-generated unique color
  createdAt: number;
}
```

**Note**: In single-user mode (default), the profile is auto-created. Multi-user requires a shared database location (network drive, cloud sync, or future server mode).

---

## Part 3: Database Schema Extension

### New Tables for `consola.db`

```sql
-- User profiles
CREATE TABLE IF NOT EXISTS user_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  avatar_color TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Sequence counters for ticket numbers
CREATE TABLE IF NOT EXISTS sequences (
  prefix TEXT PRIMARY KEY,              -- 'PLAN', 'RES', 'TASK'
  current_value INTEGER NOT NULL DEFAULT 0
);

-- Documents (plans + research)
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  ticket_number TEXT UNIQUE NOT NULL,   -- e.g., 'PLAN-001'
  type TEXT NOT NULL CHECK(type IN ('plan', 'research')),
  title TEXT NOT NULL,
  summary TEXT DEFAULT '',
  content TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  priority TEXT NOT NULL DEFAULT 'medium',
  tags TEXT DEFAULT '[]',               -- JSON array

  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  session_id TEXT,
  git_commit TEXT,
  git_branch TEXT,

  current_version INTEGER NOT NULL DEFAULT 1,
  task_count INTEGER NOT NULL DEFAULT 0,
  completed_task_count INTEGER NOT NULL DEFAULT 0,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER
);

CREATE INDEX idx_documents_workspace ON documents(workspace_id);
CREATE INDEX idx_documents_type ON documents(type);
CREATE INDEX idx_documents_status ON documents(status);
CREATE INDEX idx_documents_ticket ON documents(ticket_number);

-- Full-text search index
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title, summary, content, tags,
  content=documents,
  content_rowid=rowid
);

-- Triggers to keep FTS index in sync
CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, summary, content, tags)
  VALUES (new.rowid, new.title, new.summary, new.content, new.tags);
END;

CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, summary, content, tags)
  VALUES ('delete', old.rowid, old.title, old.summary, old.content, old.tags);
END;

CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, summary, content, tags)
  VALUES ('delete', old.rowid, old.title, old.summary, old.content, old.tags);
  INSERT INTO documents_fts(rowid, title, summary, content, tags)
  VALUES (new.rowid, new.title, new.summary, new.content, new.tags);
END;

-- Document versions
CREATE TABLE IF NOT EXISTS document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT DEFAULT '',
  change_description TEXT DEFAULT '',
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  is_draft INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  UNIQUE(document_id, version)
);

CREATE INDEX idx_versions_document ON document_versions(document_id, version);

-- Local drafts (one per user per document)
CREATE TABLE IF NOT EXISTS document_drafts (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT DEFAULT '',
  change_description TEXT DEFAULT '',
  last_saved_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  UNIQUE(document_id, user_id)
);

-- Tasks
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  ticket_number TEXT UNIQUE NOT NULL,
  document_id TEXT NOT NULL,
  parent_task_id TEXT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'backlog',
  priority TEXT NOT NULL DEFAULT 'medium',

  assignee_id TEXT,
  assignee_name TEXT,
  estimate TEXT,

  external_provider TEXT,
  external_id TEXT,
  external_url TEXT,
  external_status TEXT,
  last_synced_at INTEGER,

  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE INDEX idx_tasks_document ON tasks(document_id, sort_order);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_external ON tasks(external_provider, external_id);

-- Comments
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  task_id TEXT,
  version_number INTEGER,
  parent_comment_id TEXT,
  content TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  selection_start INTEGER,
  selection_end INTEGER,
  is_resolved INTEGER NOT NULL DEFAULT 0,
  resolved_by TEXT,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_comment_id) REFERENCES comments(id) ON DELETE CASCADE
);

CREATE INDEX idx_comments_document ON comments(document_id, created_at);
CREATE INDEX idx_comments_task ON comments(task_id, created_at);

-- Audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  details TEXT DEFAULT '{}',            -- JSON
  timestamp INTEGER NOT NULL
);

CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id, timestamp);
CREATE INDEX idx_audit_user ON audit_log(user_id, timestamp);
CREATE INDEX idx_audit_timestamp ON audit_log(timestamp);
```

### Ticket Number Generation

```typescript
// In DocumentDatabase service
function getNextTicketNumber(prefix: 'PLAN' | 'RES' | 'TASK'): string {
  const stmt = db.prepare(`
    INSERT INTO sequences (prefix, current_value) VALUES (?, 1)
    ON CONFLICT(prefix) DO UPDATE SET current_value = current_value + 1
    RETURNING current_value
  `);
  const row = stmt.get(prefix) as { current_value: number };
  return `${prefix}-${String(row.current_value).padStart(3, '0')}`;
}
// Result: PLAN-001, PLAN-002, RES-001, TASK-001, etc.
```

---

## Part 4: Service Architecture

### 4.1 Main Process Services (new files in `src/main/`)

```
src/main/
├── database/
│   ├── SessionDatabase.ts           (existing)
│   ├── DocumentDatabase.ts          (NEW - documents CRUD + FTS)
│   ├── TaskDatabase.ts              (NEW - tasks CRUD)
│   ├── VersionDatabase.ts           (NEW - versioning + drafts)
│   ├── AuditDatabase.ts             (NEW - audit log)
│   └── CommentDatabase.ts           (NEW - comments)
├── DocumentService.ts               (NEW - orchestrates document operations)
├── TaskSyncService.ts               (NEW - Linear/Jira sync via MCP)
├── CollaborationService.ts          (NEW - draft/publish workflow)
└── UserProfileService.ts            (NEW - user identity management)
```

### 4.2 New IPC Channels

```typescript
// In src/shared/constants.ts - additions
export const IPC_CHANNELS = {
  // ... existing channels ...

  // Document Management
  DOCUMENT_CREATE: 'document:create',
  DOCUMENT_UPDATE: 'document:update',
  DOCUMENT_DELETE: 'document:delete',
  DOCUMENT_GET: 'document:get',
  DOCUMENT_LIST: 'document:list',
  DOCUMENT_SEARCH: 'document:search',
  DOCUMENT_CHANGE_STATUS: 'document:change-status',

  // Versioning
  VERSION_PUBLISH: 'version:publish',
  VERSION_LIST: 'version:list',
  VERSION_GET: 'version:get',
  VERSION_DIFF: 'version:diff',

  // Drafts
  DRAFT_SAVE: 'draft:save',
  DRAFT_LOAD: 'draft:load',
  DRAFT_DISCARD: 'draft:discard',
  DRAFT_AUTO_SAVE: 'draft:auto-save',

  // Tasks
  TASK_CREATE: 'task:create',
  TASK_UPDATE: 'task:update',
  TASK_DELETE: 'task:delete',
  TASK_LIST: 'task:list',
  TASK_REORDER: 'task:reorder',
  TASK_SYNC_EXTERNAL: 'task:sync-external',
  TASK_BULK_SYNC: 'task:bulk-sync',

  // Comments
  COMMENT_CREATE: 'comment:create',
  COMMENT_UPDATE: 'comment:update',
  COMMENT_DELETE: 'comment:delete',
  COMMENT_LIST: 'comment:list',
  COMMENT_RESOLVE: 'comment:resolve',

  // Audit
  AUDIT_LOG_LIST: 'audit:list',

  // User Profile
  USER_GET_PROFILE: 'user:get-profile',
  USER_UPDATE_PROFILE: 'user:update-profile',

  // External Integrations
  INTEGRATION_LINEAR_SYNC: 'integration:linear:sync',
  INTEGRATION_JIRA_SYNC: 'integration:jira:sync',
  INTEGRATION_GET_PROJECTS: 'integration:get-projects',
} as const;
```

### 4.3 New Bridge Services

```
src/renderer/services/
├── documentBridge.ts                (NEW)
├── taskBridge.ts                    (NEW)
├── versionBridge.ts                 (NEW)
├── commentBridge.ts                 (NEW)
├── auditBridge.ts                   (NEW)
├── userBridge.ts                    (NEW)
└── integrationBridge.ts             (NEW)
```

### 4.4 New Zustand Stores

```
src/renderer/stores/
├── documentStore.ts                 (NEW - document list, filters, search)
├── documentEditorStore.ts           (NEW - active document editing state)
├── taskStore.ts                     (NEW - task list and management)
├── commentStore.ts                  (NEW - comments per document)
├── auditStore.ts                    (NEW - audit log display)
└── userStore.ts                     (NEW - current user profile)
```

---

## Part 5: Collaboration Design

### 5.1 Draft/Publish Workflow

The workflow is designed for **offline-first, eventual sharing**:

```
┌──────────────────────────────────────────────────────────────┐
│                     DOCUMENT LIFECYCLE                        │
│                                                              │
│  [Create] → DRAFT → [Publish v1] → PUBLISHED                │
│                                        │                     │
│                                   [Edit] → LOCAL DRAFT       │
│                                        │                     │
│                              [Auto-save every 30s]           │
│                                        │                     │
│                              [Publish v2] → PUBLISHED        │
│                                        │                     │
│                              [Discard] → Revert to v1        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Key Principles:**

1. **Every document starts as a draft** - No accidental sharing
2. **Auto-save drafts locally** - Never lose work (30-second interval)
3. **Explicit publish action** - User decides when to share a new version
4. **Diff before publish** - Show what changed since last published version
5. **Only one active draft per user per document** - Prevents confusion
6. **Drafts are invisible to other users** - Until published

### 5.2 Version Comparison

When publishing, users see:
- Side-by-side diff of previous version vs. current draft
- Change description field (required)
- Affected sections highlighted
- Option to view full document

### 5.3 Multi-User Considerations

For the **initial single-user implementation**, collaboration is simple:
- One user profile auto-created
- Versions track changes over time
- Audit log shows personal history

For **future multi-user support**, two strategies:

#### Strategy A: Shared Database (Recommended for Small Teams)
- Place `consola.db` on shared network drive or synced folder (Dropbox, OneDrive)
- SQLite WAL mode supports concurrent reads
- Write conflicts resolved by optimistic locking (version check before write)
- Each user has their own `UserProfile`

#### Strategy B: Server Mode (Future)
- REST/WebSocket API server wrapping the database
- Real-time collaboration via CRDT or OT
- Authentication via OAuth/SAML
- This is a significant architecture change and should be Phase 3+

### 5.4 Optimistic Locking for Shared DB

```typescript
// Before publishing
const doc = await documentDb.get(documentId);
if (doc.currentVersion !== expectedVersion) {
  throw new ConflictError(
    `Document was updated to v${doc.currentVersion} while you were editing. ` +
    `Please review the latest version and re-apply your changes.`
  );
}
// Proceed with publish
```

---

## Part 6: Task Breakdown & External Integration

### 6.1 Task Breakdown Flow

```
┌─────────────────────────────────────────────────────────┐
│                   PLAN DOCUMENT                          │
│  "Implement Authentication System"                       │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │ TASKS                                             │   │
│  │                                                   │   │
│  │  ☐ TASK-001: Set up auth middleware              │   │
│  │    ├── TASK-002: Install passport.js              │   │
│  │    └── TASK-003: Configure JWT strategy           │   │
│  │  ☐ TASK-004: Create login endpoint               │   │
│  │  ☐ TASK-005: Create registration endpoint        │   │
│  │  ☐ TASK-006: Add tests                           │   │
│  │                                                   │   │
│  │  [+ Add Task] [AI: Generate Tasks from Plan]     │   │
│  │  [Sync to Linear ↗] [Sync to Jira ↗]            │   │
│  │                                                   │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 6.2 AI-Assisted Task Generation

Users can ask Claude to analyze a plan and generate a task breakdown:

```typescript
// When user clicks "AI: Generate Tasks from Plan"
const prompt = `
Analyze this plan and generate a structured task breakdown.
Return JSON with title, description, priority, estimate, and parent relationships.

Plan content:
${document.content}
`;
```

### 6.3 External Integration Architecture

#### Option A: MCP Server Integration (Recommended)

The existing Consola architecture already supports MCP servers via the Claude Agent SDK. We can leverage this:

```
User clicks "Sync to Linear"
    ↓
Renderer sends IPC: TASK_SYNC_EXTERNAL
    ↓
Main process: TaskSyncService
    ↓
Option 1: Use Claude Agent SDK with MCP
  - Start a one-shot agent query with the Linear MCP server
  - Prompt: "Create a Linear issue with title: X, description: Y in project Z"
  - SDK handles MCP tool calls automatically
    ↓
Option 2: Direct MCP protocol
  - Connect to MCP server directly (without Claude in the loop)
  - Call tools like: mcp__linear__create_issue({ title, description, ... })
  - More efficient, no LLM token cost
    ↓
Task updated with externalId + externalUrl
```

**Recommended: Option 2 (Direct MCP)**

The MCP servers expose tools as JSON-RPC endpoints. We can call them directly without routing through Claude, saving tokens and latency.

```typescript
// TaskSyncService.ts
class TaskSyncService {
  async syncToLinear(task: Task, project: LinearProject): Promise<SyncResult> {
    const mcpClient = await getMcpClient('linear');

    const result = await mcpClient.callTool('create_issue', {
      title: task.title,
      description: task.description,
      priority: mapPriority(task.priority),
      projectId: project.id,
      labels: ['from-consola'],
    });

    return {
      externalId: result.id,
      externalUrl: result.url,
      externalStatus: result.status,
    };
  }

  async syncToJira(task: Task, project: JiraProject): Promise<SyncResult> {
    const mcpClient = await getMcpClient('jira');

    const result = await mcpClient.callTool('create_issue', {
      summary: task.title,
      description: task.description,
      project: project.key,
      issuetype: 'Task',
      priority: { name: mapJiraPriority(task.priority) },
    });

    return {
      externalId: result.key,
      externalUrl: result.self,
      externalStatus: result.fields.status.name,
    };
  }
}
```

#### MCP Server Configuration

Users configure MCP servers in their Claude settings (already supported by the SDK). The PRMS detects available integrations:

```typescript
// Check available MCP servers from session init
const { mcpServers } = agentStore.getInstance(instanceId);
const hasLinear = mcpServers.some(s => s.name.includes('linear'));
const hasJira = mcpServers.some(s => s.name.includes('jira'));
```

### 6.4 Sync Status Tracking

```typescript
interface SyncStatus {
  lastSyncedAt: number;
  direction: 'push' | 'pull' | 'bidirectional';
  status: 'synced' | 'pending' | 'conflict' | 'error';
  errorMessage?: string;
}
```

Tasks show sync badges:
- ✅ Synced (green) - External issue up to date
- 🔄 Pending (yellow) - Local changes not yet pushed
- ⚠️ Conflict (orange) - External and local diverged
- ❌ Error (red) - Sync failed

---

## Part 7: UX/UI Design

### 7.1 Navigation Integration

The PRMS integrates into the existing sidebar as a **new top-level navigation item**:

```
Sidebar
├── 🏠 Home
├── 📋 Plans & Research    ← NEW
│   ├── All Documents
│   ├── My Drafts
│   └── Recently Updated
├── Workspaces
│   ├── Workspace A
│   │   ├── Session 1
│   │   └── Session 2
│   └── Workspace B
└── ⚙️ Settings
```

### 7.2 Main View: Document Table

When "Plans & Research" is selected, the main content area shows a **sortable, filterable table**:

```
┌──────────────────────────────────────────────────────────────────┐
│ Plans & Research                              [+ New] [🔍 Search]│
├──────────────────────────────────────────────────────────────────┤
│ Filters: [All Types ▾] [All Status ▾] [All Priority ▾] [Tags ▾]│
├──────────────────────────────────────────────────────────────────┤
│ #         │ Title              │ Type  │ Status  │ Tasks │ Updated│
│───────────┼────────────────────┼───────┼─────────┼───────┼────────│
│ PLAN-003  │ Auth System Design │ Plan  │ Active  │ 4/12  │ 2m ago │
│ RES-042   │ SDK Interop Study  │ Res.  │ Done    │  —    │ 1d ago │
│ PLAN-002  │ Git Integration    │ Plan  │ Draft   │ 0/8   │ 3d ago │
│ RES-041   │ Tab System Design  │ Res.  │ Done    │  —    │ 5d ago │
│ PLAN-001  │ Multi-Session Arch │ Plan  │ Approved│ 6/6   │ 1w ago │
└──────────────────────────────────────────────────────────────────┘
```

**Table Features:**
- Column sorting (click header)
- Persistent column widths (resize handles)
- Row click → opens document detail view
- Keyboard navigation (↑↓ to select, Enter to open)
- Bulk selection for batch operations
- Status badges with color coding
- Task progress as fraction + mini progress bar

### 7.3 Document Detail View

Opens as a **new panel replacing the agent panel** (or as a split view):

```
┌──────────────────────────────────────────────────────────────────┐
│ ← Back to List    PLAN-003: Auth System Design     [Edit] [···] │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│ Status: [In Progress ▾]   Priority: [High ▾]   v3 (published)  │
│ Tags: [authentication] [security] [+]                           │
│ Author: Javier Taraza   Created: Feb 10, 2026                   │
│                                                                  │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ 📄 Content │ ☑️ Tasks (4/12) │ 💬 Comments (3) │ 📜 History │ │
│ ├──────────────────────────────────────────────────────────────┤ │
│ │                                                              │ │
│ │  ## Overview                                                 │ │
│ │  This plan outlines the authentication system...             │ │
│ │                                                              │ │
│ │  ## Architecture                                             │ │
│ │  We'll use JWT tokens with refresh rotation...               │ │
│ │                                                              │ │
│ │  ## Implementation Steps                                     │ │
│ │  1. Set up middleware layer                                  │ │
│ │  2. Create auth endpoints                                   │ │
│ │  ...                                                         │ │
│ │                                                              │ │
│ └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

### 7.4 Document Editor (Draft Mode)

When editing, the view transforms:

```
┌──────────────────────────────────────────────────────────────────┐
│ ← Back    PLAN-003: Auth System Design    [Discard] [Publish v4]│
│ Draft · Auto-saved 5s ago · Editing since 10:30 AM              │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│ Title: [Auth System Design                              ]       │
│ Summary: [JWT-based authentication with refresh tokens  ]       │
│                                                                  │
│ ┌──────────────┐ ┌──────────────────────────────────────────┐   │
│ │   Editor     │ │            Preview                        │   │
│ │ (Markdown)   │ │         (Rendered)                        │   │
│ │              │ │                                           │   │
│ │ ## Overview  │ │  Overview                                 │   │
│ │ This plan... │ │  This plan outlines...                    │   │
│ │              │ │                                           │   │
│ │              │ │                                           │   │
│ └──────────────┘ └──────────────────────────────────────────┘   │
│                                                                  │
│ Change description: [Added rate limiting section        ]       │
└──────────────────────────────────────────────────────────────────┘
```

### 7.5 Task Breakdown Tab

```
┌──────────────────────────────────────────────────────────────────┐
│ Tasks (4/12 completed)                [+ Add] [🤖 AI Generate]  │
│ [Sync All to Linear ↗]                                          │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│ ≡ TASK-001  Set up auth middleware          [In Progress] [High]│
│   ├── TASK-002  Install passport.js         [Done]      [Medium]│
│   │   └── ↗ LIN-234 (synced 2m ago)                            │
│   └── TASK-003  Configure JWT strategy      [Done]      [Medium]│
│       └── ↗ LIN-235 (synced 2m ago)                            │
│                                                                  │
│ ≡ TASK-004  Create login endpoint           [Todo]       [High] │
│   └── Description: POST /auth/login with email/password...      │
│                                                                  │
│ ≡ TASK-005  Create registration endpoint    [Backlog]  [Medium] │
│                                                                  │
│ ≡ TASK-006  Add integration tests           [Backlog]    [Low]  │
│                                                                  │
│ ──── Completed ────                                              │
│ ✓ TASK-007  Research JWT libraries          [Done]               │
│ ✓ TASK-008  Design database schema          [Done]               │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

**Task Features:**
- Drag-to-reorder (using existing @dnd-kit library)
- Inline editing (click to edit title/description)
- Status dropdown with color coding
- Sub-task indentation
- External sync badge with link
- Collapsible completed section
- AI generation button

### 7.6 Version History Tab

```
┌──────────────────────────────────────────────────────────────────┐
│ Version History                                                  │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│ v3 (current)  · Published Feb 12, 2026 at 10:30 AM             │
│   By Javier Taraza                                              │
│   "Added rate limiting section and updated JWT rotation flow"   │
│   [View] [Compare with v2]                                      │
│                                                                  │
│ v2  · Published Feb 11, 2026 at 3:15 PM                        │
│   By Javier Taraza                                              │
│   "Added implementation timeline and task breakdown"            │
│   [View] [Compare with v1]                                      │
│                                                                  │
│ v1  · Published Feb 10, 2026 at 9:00 AM                        │
│   By Javier Taraza                                              │
│   "Initial version"                                             │
│   [View]                                                         │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 7.7 Audit Log Tab

```
┌──────────────────────────────────────────────────────────────────┐
│ Activity Log                                      [Filter ▾]    │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│ Today                                                            │
│ 10:35  Javier published version 3                               │
│ 10:30  Javier synced TASK-002 to Linear (LIN-234)              │
│ 10:25  Javier changed TASK-002 status: Todo → Done              │
│ 10:20  Javier added comment: "Consider rate limiting..."       │
│                                                                  │
│ Yesterday                                                        │
│ 15:20  Javier added 4 tasks from AI generation                  │
│ 15:15  Javier published version 2                               │
│ 14:00  Javier changed status: Draft → In Review                 │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 7.8 Search Interface

Global search accessible via ⌘K (Cmd+K) command palette:

```
┌──────────────────────────────────────────────────────────────────┐
│ 🔍 Search plans and research...                          [×]    │
├──────────────────────────────────────────────────────────────────┤
│ "authentication"                                                 │
│                                                                  │
│ Documents                                                        │
│ ├── PLAN-003  Auth System Design        [In Progress]           │
│ │   "...JWT-based authentication with refresh tokens..."        │
│ ├── RES-012   OAuth Provider Comparison  [Completed]            │
│ │   "...authentication flow comparison for Google, GitHub..."   │
│                                                                  │
│ Tasks                                                            │
│ ├── TASK-001  Set up auth middleware     → PLAN-003             │
│ ├── TASK-004  Create login endpoint      → PLAN-003             │
│                                                                  │
│ Comments                                                         │
│ └── "Consider adding multi-factor authentication..."            │
│     → PLAN-003 by Javier · Feb 12                               │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Part 8: Component Architecture

### 8.1 New Component Tree

```
src/renderer/components/
├── PlanResearch/                       (NEW - top-level feature module)
│   ├── DocumentTable/
│   │   ├── DocumentTable.tsx           (Main table component)
│   │   ├── DocumentTableRow.tsx        (Row component)
│   │   ├── DocumentTableHeader.tsx     (Sortable headers)
│   │   ├── DocumentFilters.tsx         (Filter bar)
│   │   ├── StatusBadge.tsx             (Status pill/badge)
│   │   ├── PriorityIndicator.tsx       (Priority icon)
│   │   ├── TaskProgress.tsx            (Mini progress bar)
│   │   └── styles.css
│   │
│   ├── DocumentDetail/
│   │   ├── DocumentDetail.tsx          (Detail view container)
│   │   ├── DocumentHeader.tsx          (Title, status, meta)
│   │   ├── DocumentContent.tsx         (Rendered markdown)
│   │   ├── DocumentEditor.tsx          (Split editor/preview)
│   │   ├── VersionDiff.tsx             (Side-by-side diff)
│   │   └── styles.css
│   │
│   ├── TaskBreakdown/
│   │   ├── TaskList.tsx                (Draggable task list)
│   │   ├── TaskItem.tsx                (Individual task row)
│   │   ├── TaskEditor.tsx              (Inline task editing)
│   │   ├── TaskSyncBadge.tsx           (External sync status)
│   │   ├── AITaskGenerator.tsx         (AI generation modal)
│   │   └── styles.css
│   │
│   ├── Comments/
│   │   ├── CommentList.tsx
│   │   ├── CommentItem.tsx
│   │   ├── CommentEditor.tsx
│   │   └── styles.css
│   │
│   ├── VersionHistory/
│   │   ├── VersionTimeline.tsx
│   │   ├── VersionItem.tsx
│   │   ├── VersionCompare.tsx
│   │   └── styles.css
│   │
│   ├── AuditLog/
│   │   ├── AuditTimeline.tsx
│   │   ├── AuditEntry.tsx
│   │   └── styles.css
│   │
│   ├── SyncPanel/
│   │   ├── SyncPanel.tsx              (Integration configuration)
│   │   ├── LinearSync.tsx
│   │   ├── JiraSync.tsx
│   │   └── styles.css
│   │
│   └── SearchOverlay/
│       ├── GlobalSearch.tsx            (⌘K modal)
│       ├── SearchResults.tsx
│       └── styles.css
│
├── Views/
│   ├── PlanResearchView.tsx            (NEW - document table view)
│   ├── DocumentDetailView.tsx          (NEW - single document view)
│   └── ... (existing views)
```

### 8.2 View Routing Updates

```typescript
// In MainContent.tsx - updated routing logic
function MainContent() {
  const { activeWorkspaceId, activeSessionId, activeView } = useNavigationStore();

  if (activeView === 'plans-research') {
    return <PlanResearchView />;
  }

  if (activeView === 'document-detail') {
    return <DocumentDetailView />;
  }

  // Existing routing...
  if (!activeWorkspaceId) return <HomeView />;
  if (!activeSessionId) return <NewSessionView />;
  return <ContentView />;
}
```

---

## Part 9: Implementation Phases

### Phase 1: Core Document Management (Week 1-2)
- [ ] Database schema creation + migration
- [ ] DocumentDatabase service (CRUD + FTS)
- [ ] Document IPC channels + handlers
- [ ] documentBridge service
- [ ] documentStore (Zustand)
- [ ] DocumentTable component (list, sort, filter)
- [ ] DocumentDetail component (read-only view)
- [ ] Navigation sidebar update ("Plans & Research" item)
- [ ] Ticket number generation

### Phase 2: Editing & Versioning (Week 3-4)
- [ ] VersionDatabase service
- [ ] DocumentEditor component (markdown split view)
- [ ] Draft auto-save mechanism
- [ ] Draft/publish workflow
- [ ] Version history timeline
- [ ] Version comparison (diff view)
- [ ] Audit log database + display

### Phase 3: Task Breakdown (Week 5-6)
- [ ] TaskDatabase service
- [ ] Task IPC channels + handlers
- [ ] TaskList component with drag-reorder
- [ ] TaskItem inline editing
- [ ] Sub-task hierarchy
- [ ] AI task generation (Claude integration)
- [ ] Task status management

### Phase 4: External Integration (Week 7-8)
- [ ] TaskSyncService (MCP client)
- [ ] Linear MCP integration
- [ ] Jira MCP integration
- [ ] Sync status tracking + badges
- [ ] Bulk sync operations
- [ ] Integration configuration UI

### Phase 5: Collaboration (Week 9-10)
- [ ] UserProfile system
- [ ] Comment system (threads, resolution)
- [ ] Multi-user draft isolation
- [ ] Optimistic locking
- [ ] Global search (⌘K)
- [ ] Keyboard shortcuts

### Phase 6: Polish & UX (Week 11-12)
- [ ] Animations and transitions
- [ ] Empty states and onboarding
- [ ] Batch operations
- [ ] Export (PDF, Markdown)
- [ ] Notifications for document updates
- [ ] Performance optimization

---

## Part 10: Open Questions

1. **Shared Database Location**: For multi-user, should we allow configuring the database path (network drive)? Or require a server component from the start?

2. **MCP Server Discovery**: How should we detect which MCP integrations are available at runtime? Through the agent SDK init event (mcpServers array) or through separate configuration?

3. **Real-time Sync**: Should external integration sync be manual (user-triggered), periodic (background polling), or webhook-based (requires server)?

4. **Document Import**: Should we support importing existing markdown files from `./research/` and `./plans/` directories into the new system? This would be a migration tool.

5. **AI Integration Depth**: Beyond task generation, should Claude be able to:
   - Auto-update document status based on task completion?
   - Suggest document updates based on conversation history?
   - Auto-link documents to relevant sessions?

6. **Offline/Online Modes**: For multi-user, how should the app handle being offline? Queue changes and sync on reconnect?

---

## Code References

- `src/main/database/SessionDatabase.ts` - Existing SQLite patterns to follow
- `src/shared/constants.ts` - IPC channel definitions to extend
- `src/shared/types.ts` - Shared type definitions to extend
- `src/renderer/stores/agentStore.ts` - Complex Zustand store pattern to follow
- `src/renderer/stores/workspaceStore.ts` - Persistence pattern to follow
- `src/renderer/services/agentBridge.ts` - Bridge service pattern to follow
- `src/renderer/components/Views/ContentView.tsx` - Multi-panel layout pattern
- `src/renderer/components/PreviewPanel/PreviewTabBar.tsx` - Tab bar pattern
- `src/renderer/components/GitReviewPanel/` - Review panel pattern with sidebar
- `src/renderer/components/Agent/TodoListPanel.tsx` - Task status display pattern
- `src/renderer/components/Sidebar/WorkspaceNavItem.tsx` - Collapsible nav pattern
- `src/renderer/hooks/useKeyboardShortcuts.ts` - Keyboard shortcut pattern

## Architecture Documentation

The PRMS follows all existing patterns:
- **Bridge isolation**: All new IPC access through dedicated bridge services
- **ESM/CJS interop**: Any new main process SDK usage follows the `dynamicImport` pattern
- **Zustand stores**: Immutable updates, localStorage persistence for UI state, no persistence for transient state
- **Component co-location**: CSS files alongside components
- **Multi-instance**: New stores keyed by workspace/document ID where appropriate
- **Radix UI**: All dropdowns, tooltips, dialogs, collapsibles use Radix primitives
