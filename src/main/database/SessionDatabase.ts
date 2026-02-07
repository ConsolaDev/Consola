import Database from 'better-sqlite3';
import { app } from 'electron';
import * as path from 'path';

const DB_PATH = path.join(app.getPath('userData'), 'consola.db');

interface MessageRow {
  id: string;
  session_id: string;
  type: string;
  subtype: string | null;
  content: string | null;
  content_blocks: string | null;
  timestamp: number;
}

interface ToolExecutionRow {
  id: string;
  session_id: string;
  tool_use_id: string | null;
  tool_name: string;
  tool_input: string | null;
  tool_response: string | null;
  status: string;
  timestamp: number;
}

export interface StoredMessage {
  id: string;
  type: string;
  subtype?: string;
  content?: string;
  contentBlocks?: unknown[];
  timestamp: number;
}

export interface StoredToolExecution {
  id: string;
  toolUseId?: string;
  toolName: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  status: string;
  timestamp: number;
}

export class SessionDatabase {
  private db: Database.Database;

  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.initSchema();
  }

  private initSchema(): void {
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
        subtype TEXT,
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

  // Ensure session exists
  ensureSession(sessionId: string): void {
    const existing = this.db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
    if (!existing) {
      const now = Date.now();
      this.db.prepare(`
        INSERT INTO sessions (id, created_at, updated_at)
        VALUES (?, ?, ?)
      `).run(sessionId, now, now);
    }
  }

  // Update session timestamp
  touchSession(sessionId: string): void {
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), sessionId);
  }

  // Insert or update a message
  upsertMessage(sessionId: string, message: StoredMessage): void {
    this.ensureSession(sessionId);

    const stmt = this.db.prepare(`
      INSERT INTO messages (id, session_id, type, subtype, content, content_blocks, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        content_blocks = excluded.content_blocks,
        timestamp = excluded.timestamp
    `);

    stmt.run(
      message.id,
      sessionId,
      message.type,
      message.subtype || null,
      message.content || null,
      message.contentBlocks ? JSON.stringify(message.contentBlocks) : null,
      message.timestamp
    );
  }

  // Insert or update a tool execution
  upsertToolExecution(sessionId: string, tool: StoredToolExecution): void {
    this.ensureSession(sessionId);

    const stmt = this.db.prepare(`
      INSERT INTO tool_executions (id, session_id, tool_use_id, tool_name, tool_input, tool_response, status, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        tool_response = excluded.tool_response,
        status = excluded.status
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

  // Bulk save messages and tools (for full session save)
  saveSession(sessionId: string, messages: StoredMessage[], toolHistory: StoredToolExecution[]): void {
    this.ensureSession(sessionId);

    // Clear existing data for this session (full replace)
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM tool_executions WHERE session_id = ?').run(sessionId);

    // Insert all messages
    const msgStmt = this.db.prepare(`
      INSERT INTO messages (id, session_id, type, subtype, content, content_blocks, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const msg of messages) {
      msgStmt.run(
        msg.id,
        sessionId,
        msg.type,
        msg.subtype || null,
        msg.content || null,
        msg.contentBlocks ? JSON.stringify(msg.contentBlocks) : null,
        msg.timestamp
      );
    }

    // Insert all tool executions
    const toolStmt = this.db.prepare(`
      INSERT INTO tool_executions (id, session_id, tool_use_id, tool_name, tool_input, tool_response, status, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const tool of toolHistory) {
      toolStmt.run(
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

    this.touchSession(sessionId);
  }

  // Get all messages for a session
  getMessages(sessionId: string, limit = 1000, offset = 0): StoredMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE session_id = ?
      ORDER BY timestamp ASC
      LIMIT ? OFFSET ?
    `);

    const rows = stmt.all(sessionId, limit, offset) as MessageRow[];

    return rows.map(row => ({
      id: row.id,
      type: row.type,
      subtype: row.subtype || undefined,
      content: row.content || undefined,
      contentBlocks: row.content_blocks ? JSON.parse(row.content_blocks) : undefined,
      timestamp: row.timestamp
    }));
  }

  // Get all tool executions for a session
  getToolExecutions(sessionId: string, limit = 5000, offset = 0): StoredToolExecution[] {
    const stmt = this.db.prepare(`
      SELECT * FROM tool_executions
      WHERE session_id = ?
      ORDER BY timestamp ASC
      LIMIT ? OFFSET ?
    `);

    const rows = stmt.all(sessionId, limit, offset) as ToolExecutionRow[];

    return rows.map(row => ({
      id: row.id,
      toolUseId: row.tool_use_id || undefined,
      toolName: row.tool_name,
      toolInput: row.tool_input ? JSON.parse(row.tool_input) : undefined,
      toolResponse: row.tool_response ? JSON.parse(row.tool_response) : undefined,
      status: row.status,
      timestamp: row.timestamp
    }));
  }

  // Delete a session and all its data
  deleteSession(sessionId: string): void {
    this.db.prepare('DELETE FROM tool_executions WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  // Check if session has any data
  sessionExists(sessionId: string): boolean {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?').get(sessionId) as { count: number };
    return row.count > 0;
  }

  close(): void {
    this.db.close();
  }
}

// Singleton instance
let instance: SessionDatabase | null = null;

export function getSessionDatabase(): SessionDatabase {
  if (!instance) {
    instance = new SessionDatabase();
  }
  return instance;
}

export function closeSessionDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
