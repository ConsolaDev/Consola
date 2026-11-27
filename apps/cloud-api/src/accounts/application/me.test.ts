import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openTestDatabase } from '../adapters/persistence/database.test-helpers.js';
import type { Database } from '../adapters/persistence/database.js';
import { schema } from '../adapters/persistence/schema.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import type { Person, SignedIn } from '../domain/person.js';
import type { MyWorkspace } from '../domain/workspace.js';
import { describeMe } from './me.js';

let db: Database;
let close: () => Promise<void>;
let stores: ReturnType<typeof createDrizzleStores>;
let acme: MyWorkspace;

const dana: Person = { id: 'dana', name: 'Dana', email: 'dana@acme.test', image: null };

beforeEach(async () => {
  ({ db, close } = await openTestDatabase());
  await db
    .insert(schema.user)
    .values({ id: dana.id, name: dana.name, email: dana.email, emailVerified: true });
  stores = createDrizzleStores(db);
  const made = await stores.workspaces.create(
    { name: 'Acme', slug: 'acme', region: 'eu' },
    { userId: dana.id, role: 'owner' },
  );
  if (made.kind !== 'created') throw new Error('not created');
  acme = { ...made.workspace, role: 'owner', icon: null };
});

afterEach(async () => {
  await close();
});

const session = (activeWorkspaceId: string | null): SignedIn => ({
  sessionId: 's-dana',
  person: dana,
  activeWorkspaceId,
});

describe('describeMe', () => {
  it('is signed-out with nobody signed in', async () => {
    expect(await describeMe(stores.memberships, null)).toEqual({ kind: 'signed-out' });
  });

  it('is the person and their active workspace, with their role in it', async () => {
    expect(await describeMe(stores.memberships, session(acme.id))).toEqual({
      kind: 'signed-in',
      me: {
        user: { id: 'dana', name: 'Dana', email: 'dana@acme.test', image: null },
        workspace: {
          id: acme.id,
          name: 'Acme',
          slug: 'acme',
          region: 'eu',
          role: 'owner',
          icon: null,
        },
      },
    });
  });

  it('has no workspace when the session names none', async () => {
    expect(await describeMe(stores.memberships, session(null))).toEqual({
      kind: 'signed-in',
      me: { user: dana, workspace: null },
    });
  });

  it('has no workspace when the person is no longer in the active one', async () => {
    await db.delete(schema.member).where(eq(schema.member.userId, dana.id));
    expect(await describeMe(stores.memberships, session(acme.id))).toEqual({
      kind: 'signed-in',
      me: { user: dana, workspace: null },
    });
  });
});
