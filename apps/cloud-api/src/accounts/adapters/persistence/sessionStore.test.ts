import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionStore } from '../../application/ports.js';
import { openTestDatabase } from './database.test-helpers.js';
import type { Database } from './database.js';
import { schema } from './schema.js';
import { createSessionStore } from './sessionStore.js';

let db: Database;
let close: () => Promise<void>;
let sessions: SessionStore;

async function session(id: string, userId: string, updated: string, active: string | null) {
  await db.insert(schema.session).values({
    id,
    token: `token-${id}`,
    userId,
    expiresAt: new Date('2027-01-01'),
    updatedAt: new Date(updated),
    activeOrganizationId: active,
  });
}

async function activeOf(id: string) {
  const [row] = await db
    .select({ active: schema.session.activeOrganizationId })
    .from(schema.session)
    .where(eq(schema.session.id, id));
  return row?.active;
}

beforeEach(async () => {
  ({ db, close } = await openTestDatabase());
  await db.insert(schema.user).values([
    { id: 'dana', name: 'Dana', email: 'dana@acme.test', emailVerified: true },
    { id: 'lee', name: 'Lee', email: 'lee@sprocket.test', emailVerified: true },
  ]);
  sessions = createSessionStore(db);
});

afterEach(async () => {
  await close();
});

describe('the session store', () => {
  it('sets the active workspace of that session only', async () => {
    await session('s1', 'dana', '2026-11-01', null);
    await session('s2', 'dana', '2026-11-02', 'acme');
    await sessions.setActiveWorkspace({ sessionId: 's1', workspaceId: 'sprocket' });
    expect(await activeOf('s1')).toBe('sprocket');
    expect(await activeOf('s2')).toBe('acme');
  });

  it('marks the session as used when it sets the workspace', async () => {
    await session('s1', 'dana', '2026-11-01', 'acme');
    await session('s2', 'dana', '2026-11-02', 'sprocket');
    await sessions.setActiveWorkspace({ sessionId: 's1', workspaceId: 'elsewhere' });
    expect(await sessions.lastActiveWorkspace('dana')).toBe('elsewhere');
  });

  it('lastActiveWorkspace is the one in the most recently used session that has one', async () => {
    await session('s1', 'dana', '2026-11-01', 'acme');
    await session('s2', 'dana', '2026-11-03', 'sprocket');
    await session('s3', 'dana', '2026-11-04', null);
    await session('s4', 'lee', '2026-11-05', 'elsewhere');
    expect(await sessions.lastActiveWorkspace('dana')).toBe('sprocket');
    expect(await sessions.lastActiveWorkspace('lee')).toBe('elsewhere');
  });

  it('lastActiveWorkspace is null for someone with no session that has one', async () => {
    await session('s1', 'dana', '2026-11-01', null);
    expect(await sessions.lastActiveWorkspace('dana')).toBeNull();
    expect(await sessions.lastActiveWorkspace('lee')).toBeNull();
  });
});
