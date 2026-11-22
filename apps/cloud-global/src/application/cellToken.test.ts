import { generateKeyPairSync } from 'node:crypto';
import {
  CELL_TOKEN_ALGORITHM,
  CELL_TOKEN_AUDIENCE,
  CELL_TOKEN_LIFETIME_SECONDS,
  readCellTokenClaims,
} from '@consola/cloud-contract';
import { and, eq } from 'drizzle-orm';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCellTokenSigner } from '../adapters/cellToken/cellTokenSigner.js';
import { type Database, migrateDatabase, openDatabase } from '../adapters/persistence/database.js';
import { schema } from '../adapters/persistence/schema.js';
import { createDrizzleStores } from '../adapters/persistence/stores.js';
import type { Ed25519PrivateJwk } from '../config.js';
import type { Person, SignedIn } from '../domain/person.js';
import type { Workspace } from '../domain/workspace.js';
import { cellTokenKeys, mintCellToken } from './cellToken.js';
import type { CellTokenSigner } from './ports.js';

let db: Database;
let close: () => Promise<void>;
let stores: ReturnType<typeof createDrizzleStores>;
let signer: CellTokenSigner;
let acme: Workspace;

const dana: Person = { id: 'dana', name: 'Dana', email: 'dana@sprocket.test', image: null };
const lee: Person = { id: 'lee', name: 'Lee', email: 'lee@sprocket.test', image: null };

const issuedAt = 1_795_000_000;

const session = (person: Person, activeWorkspaceId: string | null): SignedIn => ({
  sessionId: `s-${person.id}`,
  person,
  activeWorkspaceId,
});

async function makeWorkspace(name: string, slug: string, region: 'eu' | 'us') {
  const made = await stores.workspaces.create(
    { name, slug, region },
    { userId: dana.id, role: 'owner' },
  );
  if (made.kind !== 'created') throw new Error('not created');
  return made.workspace;
}

/** The claims of a token, once its signature checks against the published keys. */
async function claimsOf(token: string) {
  const { payload } = await jwtVerify(token, createLocalJWKSet(cellTokenKeys(signer)), {
    algorithms: [CELL_TOKEN_ALGORITHM],
    audience: CELL_TOKEN_AUDIENCE,
    currentDate: new Date(issuedAt * 1000),
  });
  return payload;
}

beforeEach(async () => {
  ({ db, close } = openDatabase('pglite:memory'));
  await migrateDatabase(db);
  await db.insert(schema.user).values([
    { id: dana.id, name: dana.name, email: dana.email, emailVerified: true },
    { id: lee.id, name: lee.name, email: lee.email, emailVerified: true },
  ]);
  stores = createDrizzleStores(db);
  // A key made for this run only, never one written down.
  const key = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  signer = await createCellTokenSigner(key as Ed25519PrivateJwk);
  acme = await makeWorkspace('Acme', 'acme', 'us');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await close();
});

describe('mintCellToken', () => {
  it('mints a token for the active workspace, with the role and region stored', async () => {
    const minted = await mintCellToken(
      { memberships: stores.memberships, signer },
      session(dana, acme.id),
      issuedAt,
    );
    if (minted.kind !== 'minted') throw new Error(`not minted: ${minted.kind}`);

    const claims = {
      aud: CELL_TOKEN_AUDIENCE,
      sub: dana.id,
      ws: acme.id,
      role: 'owner',
      region: 'us',
      iat: issuedAt,
      exp: issuedAt + CELL_TOKEN_LIFETIME_SECONDS,
    };
    expect(await claimsOf(minted.token)).toEqual(claims);
    expect(readCellTokenClaims(await claimsOf(minted.token), issuedAt)).toEqual({
      ok: true,
      value: claims,
    });
    expect(minted.expiresAt).toBe(issuedAt + CELL_TOKEN_LIFETIME_SECONDS);
  });

  it("names the workspace's own region", async () => {
    const labs = await makeWorkspace('Acme Labs', 'acme-labs', 'eu');
    for (const [workspace, region] of [
      [acme, 'us'],
      [labs, 'eu'],
    ] as const) {
      const minted = await mintCellToken(
        { memberships: stores.memberships, signer },
        session(dana, workspace.id),
        issuedAt,
      );
      if (minted.kind !== 'minted') throw new Error(`not minted: ${minted.kind}`);
      expect(await claimsOf(minted.token)).toMatchObject({ ws: workspace.id, region });
    }
  });

  it('reads the role as it is stored when it mints', async () => {
    await db.insert(schema.member).values({
      id: 'm-lee',
      organizationId: acme.id,
      userId: lee.id,
      role: 'member',
      createdAt: new Date(),
    });
    const mint = () =>
      mintCellToken({ memberships: stores.memberships, signer }, session(lee, acme.id), issuedAt);

    const first = await mint();
    if (first.kind !== 'minted') throw new Error(`not minted: ${first.kind}`);
    expect(await claimsOf(first.token)).toMatchObject({ sub: lee.id, role: 'member' });

    await db.update(schema.member).set({ role: 'admin' }).where(eq(schema.member.id, 'm-lee'));
    const second = await mint();
    if (second.kind !== 'minted') throw new Error(`not minted: ${second.kind}`);
    expect(await claimsOf(second.token)).toMatchObject({ sub: lee.id, role: 'admin' });
  });

  it('mints nothing for a session with no active workspace', async () => {
    const sign = vi.spyOn(signer, 'sign');
    expect(
      await mintCellToken(
        { memberships: stores.memberships, signer },
        session(dana, null),
        issuedAt,
      ),
    ).toEqual({ kind: 'no-workspace' });
    expect(sign).not.toHaveBeenCalled();
  });

  it('mints nothing for a workspace the person is not in, or that is not there', async () => {
    const sign = vi.spyOn(signer, 'sign');
    for (const workspaceId of [acme.id, 'gone']) {
      expect(
        await mintCellToken(
          { memberships: stores.memberships, signer },
          session(lee, workspaceId),
          issuedAt,
        ),
      ).toEqual({ kind: 'not-a-member' });
    }
    expect(sign).not.toHaveBeenCalled();
  });

  it('mints nothing once the person has left the workspace', async () => {
    await db
      .delete(schema.member)
      .where(and(eq(schema.member.organizationId, acme.id), eq(schema.member.userId, dana.id)));
    expect(
      await mintCellToken(
        { memberships: stores.memberships, signer },
        session(dana, acme.id),
        issuedAt,
      ),
    ).toEqual({ kind: 'not-a-member' });
  });

  it('mints nothing for a stored role that is not exactly one role', async () => {
    // Better Auth can keep several roles in one `member.role`; a cell takes exactly one.
    await db.update(schema.member).set({ role: 'admin,member' });
    const sign = vi.spyOn(signer, 'sign');
    await expect(
      mintCellToken({ memberships: stores.memberships, signer }, session(dana, acme.id), issuedAt),
    ).rejects.toThrow('unknown role');
    expect(sign).not.toHaveBeenCalled();
  });
});

describe('cellTokenKeys', () => {
  it("is the signer's public keys, with no private part", () => {
    const keys = cellTokenKeys(signer);
    expect(keys).toEqual(signer.publicKeys());
    expect(keys.keys).toHaveLength(1);
    expect(keys.keys[0]).not.toHaveProperty('d');
  });
});
