import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrganizationStore } from '../../application/ports.js';
import { type Database, migrateDatabase, openDatabase } from './database.js';
import { schema } from './schema.js';
import { createOrganizationStore } from './organizationStore.js';

let db: Database;
let close: () => Promise<void>;
let organizations: OrganizationStore;

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  organizations = createOrganizationStore(db);
});

afterEach(async () => {
  await close();
});

const sprocket = { name: 'Sprocket', slug: 'sprocket', region: 'eu' as const };

describe('the organisation store', () => {
  it('creates the organisation when it is missing', async () => {
    const org = await organizations.ensure(sprocket);
    expect(org).toEqual({
      id: expect.any(String),
      name: 'Sprocket',
      slug: 'sprocket',
      region: 'eu',
    });
    expect(await db.select().from(schema.organization)).toHaveLength(1);
  });

  it('is idempotent', async () => {
    const first = await organizations.ensure(sprocket);
    const second = await organizations.ensure(sprocket);
    expect(second.id).toBe(first.id);
    expect(await db.select().from(schema.organization)).toHaveLength(1);
  });

  it('renames in place', async () => {
    const first = await organizations.ensure(sprocket);
    const renamed = await organizations.ensure({ ...sprocket, name: 'Sprocket Labs' });
    expect(renamed).toEqual({
      id: first.id,
      name: 'Sprocket Labs',
      slug: 'sprocket',
      region: 'eu',
    });
  });

  it('makes a new organisation in the region asked for', async () => {
    const org = await organizations.ensure({ ...sprocket, region: 'us' });
    expect(org.region).toBe('us');
  });

  it('never moves an organisation that exists to another region', async () => {
    const first = await organizations.ensure(sprocket);
    const again = await organizations.ensure({ ...sprocket, region: 'us' });
    expect(again).toEqual(first);
    const [row] = await db.select().from(schema.organization);
    expect(row?.region).toBe('eu');
  });

  it('refuses an organisation stored in an unknown region', async () => {
    await organizations.ensure(sprocket);
    await db
      .update(schema.organization)
      .set({ region: 'ap' })
      .where(eq(schema.organization.slug, 'sprocket'));
    await expect(organizations.ensure(sprocket)).rejects.toThrow(/unknown region, "ap"/);
  });

  it('a new slug makes a new organisation', async () => {
    const first = await organizations.ensure(sprocket);
    const second = await organizations.ensure({ ...sprocket, slug: 'sprocket-2' });
    expect(second.id).not.toBe(first.id);
    expect(await db.select().from(schema.organization)).toHaveLength(2);
  });
});
