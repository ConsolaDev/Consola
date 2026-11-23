import { describe, expect, it } from 'vitest';
import {
  createApi,
  createWorkspace,
  disconnectGitHub,
  loadConnections,
  loadMe,
  loadWorkspaces,
  setWorkspaceIcon,
  startGitHubConnect,
  switchWorkspace,
} from './api';

const acme = {
  id: 'w1',
  name: 'Acme',
  slug: 'acme',
  region: 'eu',
  role: 'owner',
  icon: null,
  canManage: true,
};
const sprocket = {
  id: 'w2',
  name: 'Sprocket',
  slug: 'sprocket',
  region: 'us',
  role: 'member',
  icon: 'emoji-fox',
  canManage: false,
};

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
      // A 204 carries no body: a Response refuses one.
      const sent = status === 204 ? null : typeof body === 'string' ? body : JSON.stringify(body);
      return new Response(sent, { status });
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

describe('setWorkspaceIcon', () => {
  it('puts the icon as JSON with the person’s cookie', async () => {
    const api = reply(200, { ...acme, icon: 'leaf' });
    await setWorkspaceIcon('leaf', api);
    expect(api.calls).toEqual([
      {
        method: 'PUT',
        url: `${ORIGIN}/api/me/workspace/icon`,
        credentials: 'same-origin',
        contentType: 'application/json',
        body: JSON.stringify({ icon: 'leaf' }),
      },
    ]);
  });

  it('is changed with the workspace on 200, null taking the icon off', async () => {
    expect(await setWorkspaceIcon(null, reply(200, acme))).toEqual({
      kind: 'changed',
      workspace: acme,
    });
  });

  it('is not allowed for a member, and signed out on 401', async () => {
    expect(await setWorkspaceIcon('leaf', reply(403, { error: 'not_allowed' }))).toEqual({
      kind: 'not-allowed',
    });
    expect(await setWorkspaceIcon('leaf', reply(401, { error: 'signed_out' }))).toEqual({
      kind: 'signed-out',
    });
  });

  it('is unavailable on any other answer', async () => {
    for (const api of [
      reply(400, { error: 'icon_unknown' }),
      reply(403, { error: 'not_a_member' }),
      reply(409, { error: 'no_active_workspace' }),
      reply(500, '<html>boom</html>'),
    ]) {
      expect(await setWorkspaceIcon('leaf', api)).toEqual({ kind: 'unavailable' });
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

const connections = {
  canManage: true,
  github: {
    configured: true,
    installations: [
      {
        id: 41,
        account: { id: 9001, login: 'sprocket', type: 'Organization' },
        connectedAt: '2026-11-22T09:00:00.000Z',
        settingsUrl: 'https://github.com/organizations/sprocket/settings/installations/41',
        repositories: { kind: 'listed', repositories: [] },
      },
    ],
  },
};

describe('loadConnections', () => {
  it('is loaded with the body on 200', async () => {
    const api = reply(200, connections);
    expect(await loadConnections(api)).toEqual({ kind: 'loaded', connections });
    expect(api.calls[0]).toMatchObject({
      method: 'GET',
      url: `${ORIGIN}/api/connections`,
      credentials: 'same-origin',
    });
  });

  it('is signed out on 401, and no workspace on 409', async () => {
    expect(await loadConnections(reply(401, { error: 'signed_out' }))).toEqual({
      kind: 'signed-out',
    });
    expect(await loadConnections(reply(409, { error: 'no_active_workspace' }))).toEqual({
      kind: 'no-workspace',
    });
  });

  it('is unavailable on any other answer, or a body of another shape', async () => {
    for (const api of [
      reply(403, { error: 'not_a_member' }),
      reply(500, { error: 'boom' }),
      reply(200, { canManage: 'yes', github: connections.github }),
      reply(200, { canManage: true, github: { configured: true } }),
      reply(200, '<html>ok</html>'),
      rejects,
    ]) {
      expect(await loadConnections(api)).toEqual({ kind: 'unavailable' });
    }
  });
});

describe('startGitHubConnect', () => {
  const url = 'https://github.com/apps/consola-dev/installations/new?state=s';

  it('is started with the address on GitHub, asked as a change from the page', async () => {
    const api = reply(200, { url });
    expect(await startGitHubConnect(api)).toEqual({ kind: 'started', url });
    expect(api.calls[0]).toMatchObject({
      method: 'POST',
      url: `${ORIGIN}/api/connections/github/install`,
      credentials: 'same-origin',
    });
  });

  it('names the refusals the page words', async () => {
    expect(await startGitHubConnect(reply(403, { error: 'not_allowed' }))).toEqual({
      kind: 'not-allowed',
    });
    expect(await startGitHubConnect(reply(503, { error: 'github_not_configured' }))).toEqual({
      kind: 'not-configured',
    });
    expect(await startGitHubConnect(reply(401, { error: 'signed_out' }))).toEqual({
      kind: 'signed-out',
    });
  });

  it('never sends the person anywhere but github.com', async () => {
    for (const elsewhere of [
      'https://github.com.evil.test/apps/x',
      'http://github.com/apps/x',
      'javascript:alert(1)',
      '/api/elsewhere',
    ]) {
      expect(await startGitHubConnect(reply(200, { url: elsewhere }))).toEqual({
        kind: 'unavailable',
      });
    }
  });

  it('is unavailable on any other answer', async () => {
    for (const api of [
      reply(403, { error: 'bad_origin' }),
      reply(409, { error: 'no_active_workspace' }),
      reply(200, {}),
      rejects,
    ]) {
      expect(await startGitHubConnect(api)).toEqual({ kind: 'unavailable' });
    }
  });
});

describe('disconnectGitHub', () => {
  it('is disconnected on 204, asked of that installation', async () => {
    const api = reply(204, null);
    expect(await disconnectGitHub(41, api)).toEqual({ kind: 'disconnected' });
    expect(api.calls[0]).toMatchObject({
      method: 'DELETE',
      url: `${ORIGIN}/api/connections/github/installations/41`,
      credentials: 'same-origin',
    });
  });

  it('names the refusals the page words', async () => {
    expect(await disconnectGitHub(41, reply(404, { error: 'installation_not_found' }))).toEqual({
      kind: 'not-found',
    });
    expect(await disconnectGitHub(41, reply(403, { error: 'not_allowed' }))).toEqual({
      kind: 'not-allowed',
    });
    expect(await disconnectGitHub(41, reply(401, { error: 'signed_out' }))).toEqual({
      kind: 'signed-out',
    });
  });

  it('is unavailable on any other answer', async () => {
    for (const api of [
      reply(403, { error: 'bad_origin' }),
      reply(500, { error: 'boom' }),
      rejects,
    ]) {
      expect(await disconnectGitHub(41, api)).toEqual({ kind: 'unavailable' });
    }
  });
});
