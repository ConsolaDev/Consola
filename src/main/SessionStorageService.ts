import { getSessionDatabase, StoredMessage, StoredToolExecution } from './database/SessionDatabase';

export interface PersistedSessionData {
  messages: unknown[];
  toolHistory: unknown[];
}

// Save session data to SQLite
export async function saveSessionData(sessionId: string, data: PersistedSessionData): Promise<void> {
  const db = getSessionDatabase();

  const messages = (data.messages || []).map((msg: any) => ({
    id: msg.id,
    type: msg.type,
    subtype: msg.subtype,
    content: msg.content,
    contentBlocks: msg.contentBlocks,
    timestamp: msg.timestamp
  } as StoredMessage));

  const toolHistory = (data.toolHistory || []).map((tool: any) => ({
    id: tool.id,
    toolUseId: tool.toolUseId,
    toolName: tool.toolName,
    toolInput: tool.toolInput,
    toolResponse: tool.toolResponse,
    status: tool.status,
    timestamp: tool.timestamp
  } as StoredToolExecution));

  db.saveSession(sessionId, messages, toolHistory);
}

// Load session data from SQLite
export async function loadSessionData(sessionId: string): Promise<PersistedSessionData | null> {
  const db = getSessionDatabase();

  if (!db.sessionExists(sessionId)) {
    return null;
  }

  const messages = db.getMessages(sessionId);
  const toolHistory = db.getToolExecutions(sessionId);
  return { messages, toolHistory };
}

// Delete session data from SQLite
export async function deleteSessionData(sessionId: string): Promise<void> {
  const db = getSessionDatabase();
  db.deleteSession(sessionId);
}
