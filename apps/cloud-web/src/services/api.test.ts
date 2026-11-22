import { describe, expect, it } from 'vitest';
import { createApi, createWorkspace, loadMe, loadWorkspaces, switchWorkspace } from './api';

const acme = { id: 'w1', name: 'Acme', slug: 'acme', region: 'eu', role: 'owner' };
const sprocket = { id: 'w2', name: 'Sprocket', slug: 'sprocket', region: 'us', role: 'member' };

const me = {
  user: { id: 'u1', name: 'Dana', email: 'dana@sprocket.test', image: null },
  workspace: { ...sprocket, role: 'owner' },
};

/** Where the tests' API is: Node has no page to resolve a relative address against. */
const ORIGIN = 'http://cloud.test';

type Call = {
  method: string;
  url: string;
  credentials: RequestCredentials;
  contentType: string | null;
  body: string;
};

/** The API answering every call with one status and body, keeping what it was asked. */
function reply(status: number, body: unknown) {
  const calls: Call[] = [];
  const client = createApi({
    baseUrl: ORIGIN,
    fetch: async (input) => {
      const request = input as Request;
      calls.push({
        method: request.method,
        url: request.url,
        credentials: request.credentials,
        contentType: request.headers.get('content-type'),
        body: await request.text(),
      });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    },
  });
  return Object.assign(client, { calls });
}

/** The API out of reach, as when the network is down. */
const rejects = createApi({
  baseUrl: ORIGIN,
  fetch: async () => {
    throw new TypeError('Failed to fetch');
  },
});

describe('loadMe', () => {
  it('is signed in with the body on 200', async () => {
    expect(await loadMe(reply(200, me))).toEqual({ kind: 'signed-in', me });
  });

  it('is signed out on 401', async () => {
    expect(await loadMe(reply(401, { error: 'signed_out' }))).toEqual({ kind: 'signed-out' });
  });

  it('is signed in with no workspace when the session has none', async () => {
    const inNone = { ...me, workspace: null };
    expect(await loadMe(reply(200, inNone))).toEqual({ kind: 'signed-in', me: inNone });
  });

  it('is unavailable on a server error, a network failure or a body that is not JSON', async () => {
    expect(await loadMe(reply(500, { error: 'boom' }))).toEqual({ kind: 'unavailable' });
    expect(await loadMe(reply(403, { error: 'forbidden' }))).toEqual({ kind: 'unavailable' });
    expect(await loadMe(rejects)).toEqual({ kind: 'unavailable' });
    expect(await loadMe(reply(200, '<html>proxy error</html>'))).toEqual({ kind: 'unavailable' });
  });
});

describe('loadWorkspaces', () => {
  it('asks for the person’s workspaces with their cookie', async () => {
    const api = reply(200, { workspaces: [] });
    await loadWorkspaces(api);
    expect(api.calls).toEqual([
      {
        method: 'GET',
        url: `${ORIGIN}/api/workspaces`,
        credentials: 'same-origin',
        contentType: null,
        body: '',
      },
    ]);
  });

  it('lists them in the order the server sent', async () => {
    expect(await loadWorkspaces(reply(200, { workspaces: [acme, sprocket] }))).toEqual({
      kind: 'listed',
      workspaces: [acme, sprocket],
    });
    expect(await loadWorkspaces(reply(200, { workspaces: [] }))).toEqual({
      kind: 'listed',
      workspaces: [],
    });
  });

  it('is signed out on 401', async () => {
    expect(await loadWorkspaces(reply(401, { error: 'signed_out' }))).toEqual({
      kind: 'signed-out',
    });
  });

  it('is unavailable on another status, a network failure, or a body it cannot read', async () => {
    for (const api of [
      reply(500, { error: 'boom' }),
      reply(404, {}),
      rejects,
      reply(200, '<html>proxy error</html>'),
      reply(200, { workspaces: 'none' }),
      reply(200, [acme]),
    ]) {
      expect(await loadWorkspaces(api)).toEqual({ kind: 'unavailable' });
    }
  });
});

describe('createWorkspace', () => {
  const asked = { name: 'Acme', slug: 'acme', region: 'eu' } as const;

  it('posts the workspace as JSON with the person’s cookie', async () => {
    const api = reply(201, acme);
    await createWorkspace(asked, api);
    expect(api.calls).toEqual([
      {
        method: 'POST',
        url: `${ORIGIN}/api/workspaces`,
        credentials: 'same-origin',
        contentType: 'application/json',
        body: JSON.stringify(asked),
      },
    ]);
  });

  it('is created with the workspace on 201', async () => {
    expect(await createWorkspace(asked, reply(201, acme))).toEqual({
      kind: 'created',
      workspace: acme,
    });
  });

  it('is invalid with the problems the server named, keeping only those it knows', async () => {
    const invalid = (problems: unknown) => reply(400, { error: 'invalid_workspace', problems });
    expect(await createWorkspace(asked, invalid(['slug_invalid', 'region_unknown']))).toEqual({
      kind: 'invalid',
      problems: ['slug_invalid', 'region_unknown'],
    });
    expect(await createWorkspace(asked, invalid(['name_missing', 'name_rude']))).toEqual({
      kind: 'invalid',
      problems: ['name_missing'],
    });
    expect(await createWorkspace(asked, invalid(['name_rude']))).toEqual({
      kind: 'invalid',
      problems: [],
    });
  });

  it('is slug-taken on 409', async () => {
    expect(await createWorkspace(asked, reply(409, { error: 'slug_taken' }))).toEqual({
      kind: 'slug-taken',
    });
  });

  it('is signed out on 401', async () => {
    expect(await createWorkspace(asked, reply(401, { error: 'signed_out' }))).toEqual({
      kind: 'signed-out',
    });
  });

  it('is unavailable on any other answer', async () => {
    for (const api of [
      reply(403, { error: 'bad_origin' }),
      reply(500, { error: 'boom' }),
      reply(400, { error: 'something_else' }),
      reply(400, { error: 'invalid_workspace', problems: 'slug_invalid' }),
      reply(400, '<html>bad request</html>'),
      reply(409, { error: 'conflict' }),
      reply(201, '<html>created</html>'),
      reply(200, acme),
      rejects,
    ]) {
      expect(await createWorkspace(asked, api)).toEqual({ kind: 'unavailable' });
    }
  });
});

describe('switchWorkspace', () => {
  it('puts the workspace id as JSON with the person’s cookie', async () => {
    const api = reply(200, sprocket);
    await switchWorkspace('w2', api);
    expect(api.calls).toEqual([
      {
        method: 'PUT',
        url: `${ORIGIN}/api/me/workspace`,
        credentials: 'same-origin',
        contentType: 'application/json',
        body: JSON.stringify({ workspaceId: 'w2' }),
      },
    ]);
  });

  it('is switched with the workspace on 200', async () => {
    expect(await switchWorkspace('w2', reply(200, sprocket))).toEqual({
      kind: 'switched',
      workspace: sprocket,
    });
  });

  it('is not found on 404', async () => {
    expect(await switchWorkspace('gone', reply(404, { error: 'workspace_not_found' }))).toEqual({
      kind: 'not-found',
    });
  });

  it('is signed out on 401', async () => {
    expect(await switchWorkspace('w2', reply(401, { error: 'signed_out' }))).toEqual({
      kind: 'signed-out',
    });
  });

  it('is unavailable on any other answer', async () => {
    for (const api of [
      reply(400, { error: 'invalid_request' }),
      reply(403, { error: 'bad_origin' }),
      reply(404, { error: 'not_found' }),
      reply(404, '<html>not found</html>'),
      reply(500, { error: 'boom' }),
      reply(200, '<html>ok</html>'),
      rejects,
    ]) {
      expect(await switchWorkspace('w2', api)).toEqual({ kind: 'unavailable' });
    }
  });
});
