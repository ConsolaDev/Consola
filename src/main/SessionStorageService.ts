import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';

const SESSIONS_DIR = path.join(app.getPath('userData'), 'sessions');

interface PersistedSessionData {
  messages: unknown[];
  toolHistory: unknown[];
}

export async function ensureSessionsDir(): Promise<void> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
}

export async function saveSessionData(sessionId: string, data: PersistedSessionData): Promise<void> {
  await ensureSessionsDir();
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

export async function loadSessionData(sessionId: string): Promise<PersistedSessionData | null> {
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function deleteSessionData(sessionId: string): Promise<void> {
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  try {
    await fs.unlink(filePath);
  } catch {
    // File may not exist, that's fine
  }
}
