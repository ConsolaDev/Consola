import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrganizationStore } from '../../application/ports.js';
import { type Database, migrateDatabase, openDatabase } from './database.js';
import { schema } from './schema.js';
import { createOrganizationStore } from './stores.js';

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

const sprocket = { name: 'Sprocket', slug: 'sprocket' };

describe('the organisation store', () => {
  it('creates the organisation when it is missing', async () => {
    const org = await organizations.ensure(sprocket);
    expect(org).toEqual({ id: expect.any(String), name: 'Sprocket', slug: 'sprocket' });
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
    const renamed = await organizations.ensure({ name: 'Sprocket Labs', slug: 'sprocket' });
    expect(renamed).toEqual({ id: first.id, name: 'Sprocket Labs', slug: 'sprocket' });
  });

  it('a new slug makes a new organisation', async () => {
    const first = await organizations.ensure(sprocket);
    const second = await organizations.ensure({ name: 'Sprocket', slug: 'sprocket-2' });
    expect(second.id).not.toBe(first.id);
    expect(await db.select().from(schema.organization)).toHaveLength(2);
  });
});
