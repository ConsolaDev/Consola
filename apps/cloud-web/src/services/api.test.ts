import { describe, expect, it } from 'vitest';
import { loadMe } from './api';

const me = {
  user: { id: 'u1', name: 'Dana', email: 'dana@sprocket.test', image: null },
  workspace: { id: 'w1', name: 'Sprocket', slug: 'sprocket', region: 'us', role: 'owner' },
};

function reply(status: number, body: unknown): typeof fetch {
  return async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

const rejects: typeof fetch = async () => {
  throw new TypeError('Failed to fetch');
};

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
