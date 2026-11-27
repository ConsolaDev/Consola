import { describe, expect, it } from 'vitest';
import {
  connectChosenGitHub,
  createApi,
  createWorkspace,
  disconnectGitHub,
  loadConnections,
  loadGitHubChoice,
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
      const request = input;
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
  const asked = { name: 'Acme', slug: 'acme' } as const;

  it('posts the workspace as JSON with the person’s cookie, and no region: the server gives it', async () => {
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
    expect(await createWorkspace(asked, invalid(['name_too_long', 'slug_invalid']))).toEqual({
      kind: 'invalid',
      problems: ['name_too_long', 'slug_invalid'],
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

const ACME = { id: 'w1' };

/**
 * Where a connections call sends from, answering every call with one status and body: the call
 * makes its own client, naming the workspace, so the test hands it `fetch` and the origin.
 */
function at(status: number, body: unknown) {
  const calls: Array<{ method: string; url: string; workspace: string | null }> = [];
  return {
    calls,
    baseUrl: ORIGIN,
    fetch: async (request: Request) => {
      calls.push({
        method: request.method,
        url: request.url,
        workspace: request.headers.get('x-consola-workspace'),
      });
      const sent = status === 204 ? null : typeof body === 'string' ? body : JSON.stringify(body);
      return new Response(sent, { status });
    },
  };
}

/** Where a call sends from when the API is out of reach, as when the network is down. */
const unreachable = {
  baseUrl: ORIGIN,
  fetch: async (): Promise<Response> => {
    throw new TypeError('Failed to fetch');
  },
};

describe('loadConnections', () => {
  it('is loaded with the body on 200, asked for the workspace the page shows', async () => {
    const api = at(200, connections);
    expect(await loadConnections(ACME, api)).toEqual({ kind: 'loaded', connections });
    expect(api.calls).toEqual([
      { method: 'GET', url: `${ORIGIN}/api/connections`, workspace: 'w1' },
    ]);
  });

  it('is signed out on 401', async () => {
    expect(await loadConnections(ACME, at(401, { error: 'signed_out' }))).toEqual({
      kind: 'signed-out',
    });
  });

  it('is switched when the session has another workspace open, none, or one the person left', async () => {
    for (const api of [
      at(409, { error: 'no_active_workspace' }),
      at(409, { error: 'workspace_switched' }),
      at(403, { error: 'not_a_member' }),
    ]) {
      expect(await loadConnections(ACME, api)).toEqual({ kind: 'switched' });
    }
  });

  it('is unavailable on any other answer, or a body of another shape', async () => {
    for (const api of [
      at(400, { error: 'invalid_request' }),
      at(500, { error: 'boom' }),
      at(200, { canManage: 'yes', github: connections.github }),
      at(200, { canManage: true, github: { configured: true } }),
      at(200, '<html>ok</html>'),
      unreachable,
    ]) {
      expect(await loadConnections(ACME, api)).toEqual({ kind: 'unavailable' });
    }
  });
});

describe('startGitHubConnect', () => {
  const url = 'https://github.com/login/oauth/authorize?client_id=Iv23li&state=s';
  const installUrl = 'https://github.com/apps/consola-dev/installations/new?state=s';

  it('is started with the addresses on GitHub, asked for the workspace the page shows', async () => {
    const api = at(200, { url, installUrl });
    expect(await startGitHubConnect(ACME, api)).toEqual({ kind: 'started', url, installUrl });
    expect(api.calls).toEqual([
      { method: 'POST', url: `${ORIGIN}/api/connections/github/install`, workspace: 'w1' },
    ]);
  });

  it('names the refusals the page words', async () => {
    expect(await startGitHubConnect(ACME, at(403, { error: 'not_allowed' }))).toEqual({
      kind: 'not-allowed',
    });
    expect(await startGitHubConnect(ACME, at(503, { error: 'github_not_configured' }))).toEqual({
      kind: 'not-configured',
    });
    expect(await startGitHubConnect(ACME, at(401, { error: 'signed_out' }))).toEqual({
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
      for (const body of [
        { url: elsewhere, installUrl },
        { url, installUrl: elsewhere },
      ]) {
        expect(await startGitHubConnect(ACME, at(200, body))).toEqual({ kind: 'unavailable' });
      }
    }
  });

  it('is unavailable on any other answer', async () => {
    for (const api of [
      at(403, { error: 'bad_origin' }),
      at(409, { error: 'no_active_workspace' }),
      at(409, { error: 'workspace_switched' }),
      at(200, {}),
      at(200, { url }),
      unreachable,
    ]) {
      expect(await startGitHubConnect(ACME, api)).toEqual({ kind: 'unavailable' });
    }
  });
});

describe('loadGitHubChoice', () => {
  const candidates = [
    { id: 41, account: { id: 9001, login: 'sprocket', type: 'Organization' } },
    { id: 63, account: { id: 7, login: 'dana', type: 'User' } },
  ];

  it('is loaded with the candidates, asked with the choice for the workspace the page shows', async () => {
    const api = at(200, { candidates });
    expect(await loadGitHubChoice(ACME, 'eyJ3.c2ln+/=', api)).toEqual({
      kind: 'loaded',
      candidates,
    });
    expect(api.calls).toEqual([
      {
        method: 'GET',
        url: `${ORIGIN}/api/connections/github/choice?choice=eyJ3.c2ln%2B%2F%3D`,
        workspace: 'w1',
      },
    ]);
  });

  it('names each refusal of the choice', async () => {
    for (const [status, error, reason] of [
      [400, 'bad_choice', 'bad-choice'],
      [403, 'not_allowed', 'not-allowed'],
      [409, 'choice_for_another_workspace', 'other-workspace'],
      [410, 'choice_expired', 'expired'],
    ] as const) {
      expect(await loadGitHubChoice(ACME, 'c', at(status, { error }))).toEqual({
        kind: 'refused',
        reason,
      });
    }
  });

  it('is signed out on 401, and switched when the session has another workspace open', async () => {
    expect(await loadGitHubChoice(ACME, 'c', at(401, { error: 'signed_out' }))).toEqual({
      kind: 'signed-out',
    });
    for (const api of [
      at(409, { error: 'no_active_workspace' }),
      at(409, { error: 'workspace_switched' }),
      at(403, { error: 'not_a_member' }),
    ]) {
      expect(await loadGitHubChoice(ACME, 'c', api)).toEqual({ kind: 'switched' });
    }
  });

  it('is unavailable on any other answer, or candidates of another shape', async () => {
    for (const api of [
      at(400, { error: 'invalid_request' }),
      at(500, { error: 'boom' }),
      at(200, {}),
      at(200, { candidates: [{ id: '41', account: candidates[0]?.account }] }),
      at(200, { candidates: [{ id: 41, account: { login: 'sprocket', type: 'Enterprise' } }] }),
      at(200, '<html>ok</html>'),
      unreachable,
    ]) {
      expect(await loadGitHubChoice(ACME, 'c', api)).toEqual({ kind: 'unavailable' });
    }
  });
});

describe('connectChosenGitHub', () => {
  const chosen = { choice: 'eyJ3.c2ln', installationId: 41 };

  it('is connected, sending the choice and the installation for the workspace the page shows', async () => {
    const calls: Array<{ url: string; workspace: string | null; body: string }> = [];
    const api = {
      baseUrl: ORIGIN,
      fetch: async (request: Request) => {
        calls.push({
          url: `${request.method} ${request.url}`,
          workspace: request.headers.get('x-consola-workspace'),
          body: await request.text(),
        });
        return Response.json({ result: 'connected' });
      },
    };
    expect(await connectChosenGitHub(ACME, chosen, api)).toEqual({ kind: 'connected' });
    expect(calls).toEqual([
      {
        url: `POST ${ORIGIN}/api/connections/github/choice`,
        workspace: 'w1',
        body: JSON.stringify(chosen),
      },
    ]);
  });

  it('is already connected when the workspace held it', async () => {
    expect(
      await connectChosenGitHub(ACME, chosen, at(200, { result: 'already_connected' })),
    ).toEqual({ kind: 'already-connected' });
  });

  it('names each refusal of the choice', async () => {
    for (const [status, error, reason] of [
      [400, 'bad_choice', 'bad-choice'],
      [400, 'not_a_candidate', 'not-a-candidate'],
      [403, 'not_allowed', 'not-allowed'],
      [409, 'choice_for_another_workspace', 'other-workspace'],
      [409, 'installation_taken', 'taken'],
      [410, 'choice_expired', 'expired'],
    ] as const) {
      expect(await connectChosenGitHub(ACME, chosen, at(status, { error }))).toEqual({
        kind: 'refused',
        reason,
      });
    }
    expect(await connectChosenGitHub(ACME, chosen, at(401, { error: 'signed_out' }))).toEqual({
      kind: 'signed-out',
    });
  });

  it('is unavailable on any other answer, a stale page included', async () => {
    for (const api of [
      at(403, { error: 'bad_origin' }),
      at(403, { error: 'not_a_member' }),
      at(409, { error: 'workspace_switched' }),
      at(400, { error: 'invalid_request' }),
      at(415, { error: 'unsupported_media_type' }),
      at(200, { result: 'maybe' }),
      unreachable,
    ]) {
      expect(await connectChosenGitHub(ACME, chosen, api)).toEqual({ kind: 'unavailable' });
    }
  });
});

describe('disconnectGitHub', () => {
  it('is disconnected on 204, asked of that installation in the workspace the page shows', async () => {
    const api = at(204, null);
    expect(await disconnectGitHub(ACME, 41, api)).toEqual({ kind: 'disconnected' });
    expect(api.calls).toEqual([
      {
        method: 'DELETE',
        url: `${ORIGIN}/api/connections/github/installations/41`,
        workspace: 'w1',
      },
    ]);
  });

  it('names the refusals the page words', async () => {
    expect(await disconnectGitHub(ACME, 41, at(404, { error: 'installation_not_found' }))).toEqual({
      kind: 'not-found',
    });
    expect(await disconnectGitHub(ACME, 41, at(403, { error: 'not_allowed' }))).toEqual({
      kind: 'not-allowed',
    });
    expect(await disconnectGitHub(ACME, 41, at(401, { error: 'signed_out' }))).toEqual({
      kind: 'signed-out',
    });
  });

  it('is unavailable on any other answer', async () => {
    for (const api of [
      at(403, { error: 'bad_origin' }),
      at(409, { error: 'workspace_switched' }),
      at(500, { error: 'boom' }),
      unreachable,
    ]) {
      expect(await disconnectGitHub(ACME, 41, api)).toEqual({ kind: 'unavailable' });
    }
  });
});
