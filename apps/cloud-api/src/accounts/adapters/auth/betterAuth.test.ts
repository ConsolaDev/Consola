import { describe, expect, it } from 'vitest';
import { whoIsAskingOf } from './betterAuth.js';
import type { CloudAuth } from './betterAuth.js';

/** Better Auth as far as reading a session goes: what `getSession` answers for any request. */
function authAnswering(answer: unknown): CloudAuth {
  // Only `api.getSession` is read, so the stand-in holds nothing else.
  return { api: { getSession: async () => answer } } as unknown as CloudAuth;
}

const user = {
  id: 'dana',
  name: 'Dana Ortiz',
  email: 'dana@acme.test',
  image: 'https://avatars.acme.test/dana.png',
};

describe('whoIsAskingOf', () => {
  it("is the session's person by id, the session's own id, and its active workspace", async () => {
    const whoIsAsking = whoIsAskingOf(
      authAnswering({ user, session: { id: 's-1', activeOrganizationId: 'acme' } }),
    );
    expect(await whoIsAsking(new Headers())).toEqual({
      personId: 'dana',
      sessionId: 's-1',
      activeWorkspaceId: 'acme',
    });
  });

  it('has no active workspace when the session names none', async () => {
    for (const activeOrganizationId of [null, undefined]) {
      const whoIsAsking = whoIsAskingOf(
        authAnswering({ user, session: { id: 's-1', activeOrganizationId } }),
      );
      expect(await whoIsAsking(new Headers())).toEqual({
        personId: 'dana',
        sessionId: 's-1',
        activeWorkspaceId: null,
      });
    }
  });

  it('is null with no session', async () => {
    expect(await whoIsAskingOf(authAnswering(null))(new Headers())).toBeNull();
  });
});
