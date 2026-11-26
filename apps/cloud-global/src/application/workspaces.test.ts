import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase, openDatabase } from '../adapters/persistence/database.js';
import type { Database } from '../adapters/persistence/database.js';
import { schema } from '../adapters/persistence/schema.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import type { Person, SignedIn } from '../domain/person.js';
import {
  createWorkspace,
  listMyWorkspaces,
  setActiveWorkspace,
  setWorkspaceIcon,
  workspaceForNewSession,
} from './workspaces.js';

let db: Database;
let close: () => Promise<void>;
let stores: ReturnType<typeof createDrizzleStores>;

const dana: Person = { id: 'dana', name: 'Dana', email: 'dana@acme.test', image: null };
const lee: Person = { id: 'lee', name: 'Lee', email: 'lee@sprocket.test', image: null };

async function signedIn(person: Person, sessionId: string): Promise<SignedIn> {
  await db.insert(schema.session).values({
    id: sessionId,
    token: `token-${sessionId}`,
    userId: person.id,
    expiresAt: new Date('2027-01-01'),
    updatedAt: new Date(),
  });
  return { sessionId, person, activeWorkspaceId: null };
}

async function activeOf(sessionId: string) {
  const [row] = await db
    .select({ active: schema.session.activeOrganizationId })
    .from(schema.session)
    .where(eq(schema.session.id, sessionId));
  return row?.active ?? null;
}

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  await db.insert(schema.user).values([
    { id: dana.id, name: dana.name, email: dana.email, emailVerified: true },
    { id: lee.id, name: lee.name, email: lee.email, emailVerified: true },
  ]);
  stores = createDrizzleStores(db);
});

afterEach(async () => {
  await close();
});

const acme = { name: 'Acme', slug: 'acme', region: 'eu' };

describe('createWorkspace', () => {
  it('makes the workspace with its creator as owner, and makes it active', async () => {
    const session = await signedIn(dana, 's-dana');
    const made = await createWorkspace(stores, session, acme);
    expect(made).toEqual({
      kind: 'created',
      workspace: {
        id: expect.any(String),
        name: 'Acme',
        slug: 'acme',
        region: 'eu',
        role: 'owner',
        icon: null,
      },
    });
    if (made.kind !== 'created') throw new Error('not created');
    expect(await activeOf('s-dana')).toBe(made.workspace.id);
    expect(await listMyWorkspaces(stores.memberships, dana)).toEqual([made.workspace]);
  });

  it('refuses a request the domain refuses, writing nothing', async () => {
    const session = await signedIn(dana, 's-dana');
    expect(await createWorkspace(stores, session, { ...acme, slug: 'Acme', region: 'ap' })).toEqual(
      { kind: 'invalid', problems: ['slug_invalid', 'region_unknown'] },
    );
    expect(await db.select().from(schema.organization)).toEqual([]);
    expect(await activeOf('s-dana')).toBeNull();
  });

  it('refuses a slug taken in another region, leaving the session as it was', async () => {
    await createWorkspace(stores, await signedIn(dana, 's-dana'), acme);
    const session = await signedIn(lee, 's-lee');
    expect(await createWorkspace(stores, session, { ...acme, region: 'us' })).toEqual({
      kind: 'slug-taken',
    });
    expect(await activeOf('s-lee')).toBeNull();
    expect(await listMyWorkspaces(stores.memberships, lee)).toEqual([]);
  });
});

describe('listMyWorkspaces', () => {
  it('lists only the person’s own workspaces', async () => {
    const danas = await createWorkspace(stores, await signedIn(dana, 's-dana'), acme);
    const lees = await createWorkspace(stores, await signedIn(lee, 's-lee'), {
      name: 'Sprocket',
      slug: 'sprocket',
      region: 'us',
    });
    if (danas.kind !== 'created' || lees.kind !== 'created') throw new Error('not created');
    expect(await listMyWorkspaces(stores.memberships, dana)).toEqual([danas.workspace]);
    expect(await listMyWorkspaces(stores.memberships, lee)).toEqual([lees.workspace]);
  });
});

describe('setActiveWorkspace', () => {
  it('makes a workspace the person is in active', async () => {
    const session = await signedIn(dana, 's-dana');
    const first = await createWorkspace(stores, session, acme);
    await createWorkspace(stores, session, { ...acme, slug: 'acme-labs' });
    if (first.kind !== 'created') throw new Error('not created');

    expect(await setActiveWorkspace(stores, session, first.workspace.id)).toEqual({
      kind: 'active',
      workspace: first.workspace,
    });
    expect(await activeOf('s-dana')).toBe(first.workspace.id);
  });

  it('is not-found for a workspace the person is not in, or that is not there', async () => {
    const danas = await createWorkspace(stores, await signedIn(dana, 's-dana'), acme);
    if (danas.kind !== 'created') throw new Error('not created');
    const session = await signedIn(lee, 's-lee');

    expect(await setActiveWorkspace(stores, session, danas.workspace.id)).toEqual({
      kind: 'not-found',
    });
    expect(await setActiveWorkspace(stores, session, 'gone')).toEqual({ kind: 'not-found' });
    expect(await activeOf('s-lee')).toBeNull();
  });
});

describe('workspaceForNewSession', () => {
  it('is none for someone in no workspace', async () => {
    expect(await workspaceForNewSession(stores, dana.id)).toBeNull();
  });

  it('is the workspace the person last had active', async () => {
    const session = await signedIn(dana, 's-dana');
    const first = await createWorkspace(stores, session, acme);
    const second = await createWorkspace(stores, session, { ...acme, slug: 'acme-labs' });
    if (first.kind !== 'created' || second.kind !== 'created') throw new Error('not created');
    expect(await workspaceForNewSession(stores, dana.id)).toBe(second.workspace.id);

    await setActiveWorkspace(stores, session, first.workspace.id);
    expect(await workspaceForNewSession(stores, dana.id)).toBe(first.workspace.id);
  });

  it('is the first workspace joined once the person is no longer in the last active one', async () => {
    const session = await signedIn(dana, 's-dana');
    const first = await createWorkspace(stores, session, acme);
    const second = await createWorkspace(stores, session, { ...acme, slug: 'acme-labs' });
    if (first.kind !== 'created' || second.kind !== 'created') throw new Error('not created');
    await db.delete(schema.member).where(eq(schema.member.organizationId, second.workspace.id));

    expect(await workspaceForNewSession(stores, dana.id)).toBe(first.workspace.id);
  });
});

describe('setWorkspaceIcon', () => {
  async function ownersSession() {
    const session = await signedIn(dana, 's-dana');
    const made = await createWorkspace(stores, session, acme);
    if (made.kind !== 'created') throw new Error('not created');
    return { session: { ...session, activeWorkspaceId: made.workspace.id }, made };
  }

  it("sets the owner's active workspace's icon, and clears it", async () => {
    const { session, made } = await ownersSession();
    expect(await setWorkspaceIcon(stores, session, { icon: 'compass' })).toEqual({
      kind: 'changed',
      workspace: { ...made.workspace, icon: 'compass' },
    });
    expect(await listMyWorkspaces(stores.memberships, dana)).toEqual([
      { ...made.workspace, icon: 'compass' },
    ]);
    expect(await setWorkspaceIcon(stores, session, { icon: null })).toEqual({
      kind: 'changed',
      workspace: made.workspace,
    });
  });

  it('refuses an icon outside the set, and writes nothing', async () => {
    const { session, made } = await ownersSession();
    expect(await setWorkspaceIcon(stores, session, { icon: 'nope' })).toEqual({
      kind: 'invalid',
      problem: 'icon_unknown',
    });
    expect(await listMyWorkspaces(stores.memberships, dana)).toEqual([made.workspace]);
  });

  it('is not-allowed for a member, and not-a-member for someone outside it', async () => {
    const { made } = await ownersSession();
    const leeSession = await signedIn(lee, 's-lee');
    const outside = { ...leeSession, activeWorkspaceId: made.workspace.id };
    expect(await setWorkspaceIcon(stores, outside, { icon: 'moon' })).toEqual({
      kind: 'not-a-member',
    });

    await db.insert(schema.member).values({
      id: 'acme-lee',
      organizationId: made.workspace.id,
      userId: lee.id,
      role: 'member',
      createdAt: new Date(),
    });
    expect(await setWorkspaceIcon(stores, outside, { icon: 'moon' })).toEqual({
      kind: 'not-allowed',
    });
    expect(await listMyWorkspaces(stores.memberships, dana)).toEqual([made.workspace]);
  });

  it('is no-workspace for a session with none open', async () => {
    const session = await signedIn(dana, 's-dana');
    expect(await setWorkspaceIcon(stores, session, { icon: 'moon' })).toEqual({
      kind: 'no-workspace',
    });
  });
});
