// The HTTP suites' helpers: the app built as `main.ts` builds it, on a migrated in-memory
// database, with people signed in without Google through Better Auth's `testUtils`. For tests
// only: nothing but a test imports this (`src/boundary.test.ts`), and the build leaves it out.

import { randomUUID } from 'node:crypto';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { testUtils } from 'better-auth/plugins';
import type { TestHelpers } from 'better-auth/plugins';
import { and, eq } from 'drizzle-orm';
import type { CloudAuth } from '../accounts/adapters/auth/betterAuth.js';
import { schema } from '../accounts/adapters/persistence/schema.js';
import { WORKSPACE_HEADER } from '../company/adapters/http/caller.js';
import { composeApi } from '../compose.js';
import type { Api } from '../compose.js';
import { loadConfig } from '../config.js';
import type { CloudConfig } from '../config.js';
import { migrateDatabase, openDatabase } from '../persistence/database.js';
import type { OpenDatabase } from '../persistence/database.js';
import type { WorkspaceRole } from '../shared/workspaceRole.js';

/** Stand-ins, never real credentials: the least a configuration needs. */
const TEST_ENVIRONMENT = {
  DATABASE_URL: 'pglite:memory',
  BETTER_AUTH_SECRET: 'sprocket-test-secret-that-is-long-enough-to-sign-with',
  PUBLIC_URL: 'http://localhost:5175',
  GOOGLE_CLIENT_ID: 'sprocket-test-client-id',
  GOOGLE_CLIENT_SECRET: 'sprocket-test-client-secret',
};

/** A person signed in: their id, and the session cookie a browser would send. */
export type SignedInAs = { personId: string; cookie: string };

/** A member of a workspace, signed in with it active, and the headers its page sends. */
export type Member = {
  personId: string;
  workspaceId: string;
  /** The session cookie, the web app's origin, JSON and `x-consola-workspace`. */
  headers: Headers;
};

/** The app composed again on the harness's database, with a configuration of its own. */
export type Restarted = {
  app: OpenAPIHono;
  /** The rest of what `composeApi` built: the runner socket's hooks. */
  api: Api;
  config: CloudConfig;
};

export type Harness = {
  app: OpenAPIHono;
  auth: CloudAuth;
  /** The one database the app runs on, migrated, for a test that reads or writes it directly. */
  db: OpenDatabase;
  config: CloudConfig;
  /** The rest of what `composeApi` built: the runner socket's hooks. */
  api: Api;
  /** Makes a person with a verified email and signs them in. */
  signIn(email: string, name: string): Promise<SignedInAs>;
  /**
   * A new person who is `role` in a workspace, with it active in their session. With no
   * `workspace`, they make one through `POST /api/workspaces` (so it is born whole, with them in
   * its first team) and, for any role but `owner`, their role there is then set to `role`. With
   * one, they are put in it with `role` through `member` (no route adds a member yet, so they are
   * in none of its teams), and make it active through `PUT /api/me/workspace`.
   */
  member(role: WorkspaceRole, options?: { workspace?: string }): Promise<Member>;
  /** Takes the person out of the workspace, in `member` itself. */
  removeMember(personId: string, workspaceId: string): Promise<void>;
  /** Gives the person `role` in the workspace, in `member` itself. */
  setRole(personId: string, workspaceId: string, role: WorkspaceRole): Promise<void>;
  /**
   * The app composed again on the same database, as a restart with `environment` added to the
   * configuration would compose it: for a setting that names something a test makes first (the
   * workspace a runner serves, say). Everyone signed in and every workspace made so far are still
   * there, their cookies still sign them in, and `app` keeps answering too.
   */
  restart(environment: Record<string, string | undefined>): Promise<Restarted>;
  /**
   * Closes every runner's socket of every app composed, then the database. Closing again does
   * nothing, so a test that closed the database itself (to see what a route answers without one)
   * leaves nothing for the next to trip on.
   */
  close(): Promise<void>;
};

/**
 * The app, built through `composeApi` with Better Auth's `testUtils`, on a fresh in-memory
 * database migrated with the one chain. `environment` overrides the stand-in configuration.
 */
export async function startApi(
  options: { environment?: Record<string, string | undefined> } = {},
): Promise<Harness> {
  const config = loadConfig({ ...TEST_ENVIRONMENT, ...options.environment });
  const db = openDatabase(config.databaseUrl);
  await migrateDatabase(db);
  const api = await composeApi({ db, config }, [testUtils()]);
  const { app, auth } = api;
  /** Every app composed on `db`, whose runner sockets `close` closes. */
  const composed: Api[] = [api];
  // The plugin is passed in at runtime, so the type of `$context` does not know about it.
  const test = ((await auth.$context) as unknown as { test: TestHelpers }).test;

  let people = 0;

  async function signIn(email: string, name: string): Promise<SignedInAs> {
    const user = await test.saveUser(test.createUser({ email, name, emailVerified: true }));
    const login = await test.login({ userId: user.id });
    return { personId: user.id, cookie: login.headers.get('cookie') ?? '' };
  }

  const fromPage = (cookie: string, workspaceId?: string): Headers => {
    const headers = new Headers({
      cookie,
      origin: config.publicUrl,
      'content-type': 'application/json',
    });
    if (workspaceId !== undefined) headers.set(WORKSPACE_HEADER, workspaceId);
    return headers;
  };

  async function setRole(personId: string, workspaceId: string, role: WorkspaceRole) {
    await db.accounts
      .update(schema.member)
      .set({ role })
      .where(
        and(eq(schema.member.userId, personId), eq(schema.member.organizationId, workspaceId)),
      );
  }

  async function removeMember(personId: string, workspaceId: string) {
    await db.accounts
      .delete(schema.member)
      .where(
        and(eq(schema.member.userId, personId), eq(schema.member.organizationId, workspaceId)),
      );
  }

  async function member(
    role: WorkspaceRole,
    memberOptions: { workspace?: string } = {},
  ): Promise<Member> {
    people += 1;
    const person = await signIn(`person-${people}@sprocket.test`, `Person ${people}`);

    if (memberOptions.workspace === undefined) {
      const made = await app.request('/api/workspaces', {
        method: 'POST',
        headers: fromPage(person.cookie),
        body: JSON.stringify({ name: `Sprocket ${people}`, slug: `sprocket-${people}` }),
      });
      if (made.status !== 201) {
        throw new Error(`POST /api/workspaces answered ${made.status}: ${await made.text()}`);
      }
      const { id: workspaceId } = (await made.json()) as { id: string };
      if (role !== 'owner') await setRole(person.personId, workspaceId, role);
      return {
        personId: person.personId,
        workspaceId,
        headers: fromPage(person.cookie, workspaceId),
      };
    }

    const workspaceId = memberOptions.workspace;
    await db.accounts.insert(schema.member).values({
      id: randomUUID(),
      organizationId: workspaceId,
      userId: person.personId,
      role,
      createdAt: new Date(),
    });
    const opened = await app.request('/api/me/workspace', {
      method: 'PUT',
      headers: fromPage(person.cookie),
      body: JSON.stringify({ workspaceId }),
    });
    if (opened.status !== 200) {
      throw new Error(`PUT /api/me/workspace answered ${opened.status}: ${await opened.text()}`);
    }
    return {
      personId: person.personId,
      workspaceId,
      headers: fromPage(person.cookie, workspaceId),
    };
  }

  async function restart(environment: Record<string, string | undefined>): Promise<Restarted> {
    const restartedConfig = loadConfig({
      ...TEST_ENVIRONMENT,
      ...options.environment,
      ...environment,
    });
    const restarted = await composeApi({ db, config: restartedConfig }, [testUtils()]);
    composed.push(restarted);
    return { app: restarted.app, api: restarted, config: restartedConfig };
  }

  let closing: Promise<void> | null = null;
  function close(): Promise<void> {
    closing ??= (async () => {
      for (const each of composed) each.closeRunnerSockets();
      await db.close();
    })();
    return closing;
  }

  return {
    app,
    auth,
    db,
    config,
    api,
    signIn,
    member,
    removeMember,
    setRole,
    restart,
    close,
  };
}
