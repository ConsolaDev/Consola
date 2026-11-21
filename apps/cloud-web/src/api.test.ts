import { describe, expect, it } from 'vitest';
import { loadMe, loadOrg } from './api';

const me = {
  user: { id: 'u1', name: 'Dana', email: 'dana@sprocket.test', image: null },
  organization: { id: 'o1', name: 'Sprocket', slug: 'sprocket' },
  role: 'owner',
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

  it('is not a member on 403', async () => {
    expect(await loadMe(reply(403, { error: 'not_a_member' }))).toEqual({ kind: 'not-member' });
  });

  it('is unavailable on a server error, a network failure or a body that is not JSON', async () => {
    expect(await loadMe(reply(500, { error: 'boom' }))).toEqual({ kind: 'unavailable' });
    expect(await loadMe(rejects)).toEqual({ kind: 'unavailable' });
    expect(await loadMe(reply(200, '<html>proxy error</html>'))).toEqual({ kind: 'unavailable' });
  });
});

describe('loadOrg', () => {
  it('returns the organisation on 200', async () => {
    const org = { name: 'Sprocket', slug: 'sprocket' };
    expect(await loadOrg(reply(200, org))).toEqual(org);
  });

  it('returns null on a bad gateway or a network failure', async () => {
    expect(await loadOrg(reply(502, ''))).toBeNull();
    expect(await loadOrg(rejects)).toBeNull();
  });
});
