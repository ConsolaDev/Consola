// A file of its own: what it checks happens at a page's first registration.
import { BearerConnectionCredential, CredentialStore } from '@t3tools/client-runtime/connection';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { beforeAll, expect, it } from 'vite-plus/test';
import { connectionIdFor, runInConnection } from './connection.ts';
import { holdSession } from './storedSessions.ts';
import { answerOf, forgetStoredThreads, host, mountChat } from './testing/render.tsx';

beforeAll(forgetStoredThreads);

const RECORD_PREFIX = 'consola-agent-ui:session:';

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

/** What a page that registered `sessionId` and closed without unmounting the chat leaves. */
const leaveStoredPass = async (sessionId: string, pass: string) => {
  const exit = await runInConnection(
    Effect.gen(function* () {
      const credentials = yield* CredentialStore.ConnectionCredentialStore;
      yield* credentials.put(
        connectionIdFor(sessionId),
        new BearerConnectionCredential({ token: pass }),
      );
    }),
  );
  if (exit._tag === 'Failure') throw new Error(`could not store a pass for ${sessionId}`);
  localStorage.setItem(`${RECORD_PREFIX}${sessionId}`, '');
};

it("removes the passes t3 kept for sessions no page shows, at the page's first registration", async () => {
  const { hostUrl, pass, sessionId, assistantText } = host();
  await leaveStoredPass('a-closed-window-session', 'a-pass-a-closed-window-left');
  // Another window still shows this one: it holds the session.
  await leaveStoredPass('an-open-window-session', 'a-pass-an-open-window-uses');
  const releaseOpenWindow = await holdSession('an-open-window-session');
  try {
    const chat = await mountChat({ hostUrl, pass, sessionId });
    await expect.element(answerOf(assistantText)).toBeVisible();

    await expect.poll(() => storedPass('a-closed-window-session')).toBeNull();
    expect(localStorage.getItem(`${RECORD_PREFIX}a-closed-window-session`)).toBeNull();
    expect(await storedPass('an-open-window-session')).toBe('a-pass-an-open-window-uses');
    expect(await storedPass(sessionId)).toBe(pass);

    // Unmounting removes the chat's own pass.
    chat.unmount();
    await expect.poll(() => storedPass(sessionId)).toBeNull();
  } finally {
    releaseOpenWindow();
  }
});
