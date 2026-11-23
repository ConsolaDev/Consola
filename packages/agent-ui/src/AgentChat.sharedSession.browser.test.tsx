// Two chats on one session share its registration and its stored pass.
import { CredentialStore } from '@t3tools/client-runtime/connection';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { beforeAll, expect, it } from 'vite-plus/test';
import { connectionIdFor, runInConnection } from './connection.ts';
import { holdSession } from './storedSessions.ts';
import { answerOf, forgetStoredThreads, host, mountChat } from './testing/render.tsx';

beforeAll(forgetStoredThreads);

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

/** Lets t3 apply a registration change, which is asynchronous. */
const settle = () => new Promise((done) => setTimeout(done, 1500));

it('keeps the other chat connected and the pass stored when one of two chats on a session unmounts', async () => {
  const { hostUrl, pass, sessionId, assistantText } = host();
  const first = await mountChat({ hostUrl, pass, sessionId });
  const second = await mountChat({ hostUrl, pass, sessionId });
  await expect.poll(() => storedPass(sessionId)).toBe(pass);

  first.unmount();
  await settle();
  expect(await storedPass(sessionId)).toBe(pass);
  await expect.element(answerOf(assistantText)).toBeVisible();

  second.unmount();
  await expect.poll(() => storedPass(sessionId)).toBeNull();
});

it('keeps the pass while another window holds the session and a chat in this one unmounts', async () => {
  const { hostUrl, pass, sessionId } = host();
  // Another window showing the session holds its lock.
  const releaseOtherWindow = await holdSession(sessionId);
  try {
    const chat = await mountChat({ hostUrl, pass, sessionId });
    await expect.poll(() => storedPass(sessionId)).toBe(pass);
    chat.unmount();
    await settle();
    // The same page's second chat or another window: the lock is held until the last goes.
    expect(localStorage.getItem(`consola-agent-ui:session:${sessionId}`)).not.toBeNull();
  } finally {
    releaseOtherWindow();
  }
});
