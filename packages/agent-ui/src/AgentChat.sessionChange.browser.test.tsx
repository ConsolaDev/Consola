// A mounted chat whose `sessionId` changes (a `/sessions/:id` route that keeps its element):
// the new session is registered only once this page holds it, and only with the new pass. The
// session's hold, pass and registration start again (`SessionChat`'s key in `AgentChat.tsx`).
import { CredentialStore, EnvironmentRegistry } from '@t3tools/client-runtime/connection';
import { EnvironmentId } from '@t3tools/contracts';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { beforeAll, expect, it } from 'vite-plus/test';
import { connectionIdFor, runInConnection } from './connection.ts';
import { answerOf, forgetStoredThreads, host, mountChat } from './testing/render.tsx';

beforeAll(forgetStoredThreads);

/** The pass t3 keeps for a session's host, read through t3's own credential store. */
const storedPass = async (sessionId: string): Promise<string | null> => {
  const exit = await runInConnection(
    Effect.gen(function* () {
      const credentials = yield* CredentialStore.ConnectionCredentialStore;
      return yield* credentials.get(connectionIdFor(sessionId));
    }),
  );
  if (exit._tag === 'Failure') throw new Error(`could not read the stored pass of ${sessionId}`);
  return Option.match(exit.value, {
    onNone: () => null,
    onSome: (credential) =>
      credential._tag === 'BearerConnectionCredential' ? credential.token : null,
  });
};

/** t3's connection phase for the session in this page, or null while it is not registered. */
const phaseOf = async (sessionId: string): Promise<string | null> => {
  const exit = await runInConnection(
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      return yield* registry.state(EnvironmentId.make(sessionId));
    }),
  );
  return exit._tag === 'Success' ? exit.value.phase : null;
};

/**
 * Takes the session's Web Lock (`storedSessions.ts`) exclusively, as a page removing what t3
 * keeps for it does, so no page's hold on it is granted until the returned function is called.
 */
const keepFromHolding = async (sessionId: string): Promise<() => void> => {
  let release = () => {};
  const released = new Promise<void>((done) => {
    release = done;
  });
  await new Promise<void>((granted) => {
    void navigator.locks.request(
      `consola-agent-ui:session:${sessionId}`,
      { mode: 'exclusive' },
      () => {
        granted();
        return released;
      },
    );
  });
  return release;
};

it('registers a new sessionId only once its hold is granted, and with the new pass', async () => {
  const { hostUrl, pass, sessionId, assistantText } = host();
  const chat = await mountChat({ hostUrl, pass, sessionId });
  await expect.element(answerOf(assistantText)).toBeVisible();
  await expect.poll(() => storedPass(sessionId)).toBe(pass);

  const next = 'session-sprocket-next';
  const nextPass = 'a-pass-for-the-next-session';
  const release = await keepFromHolding(next);
  try {
    await chat.rerender({ hostUrl, pass: nextPass, sessionId: next });
    // The first session goes with its pass...
    await expect.poll(() => storedPass(sessionId)).toBeNull();
    // ...and the next one waits for its hold: nothing of it reaches t3, with either pass.
    for (let reads = 0; reads < 10; reads++) {
      expect(await storedPass(next)).toBeNull();
      expect(await phaseOf(next)).toBeNull();
      await new Promise((done) => setTimeout(done, 100));
    }
  } finally {
    release();
  }
  await expect.poll(() => storedPass(next)).toBe(nextPass);
});
