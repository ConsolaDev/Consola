// Two chats on one session, in one page and in two windows, share its registration and its pass.
import { CredentialStore, EnvironmentRegistry } from '@t3tools/client-runtime/connection';
import { EnvironmentId } from '@t3tools/contracts';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { afterEach, beforeAll, expect, it } from 'vite-plus/test';
import { connectionIdFor, runInConnection } from './connection.ts';
import { addToPage, answerOf, forgetStoredThreads, host, mountChat } from './testing/render.tsx';

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

/** t3's connection phase for the session in this page, or null once it is not registered. */
const phaseOf = async (sessionId: string): Promise<string | null> => {
  const exit = await runInConnection(
    Effect.gen(function* () {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      return yield* registry.state(EnvironmentId.make(sessionId));
    }),
  );
  return exit._tag === 'Success' ? exit.value.phase : null;
};

/** The pass stays stored over a stretch, so a delete followed by a put is not mistaken for it. */
const staysStored = async (sessionId: string, pass: string) => {
  await expect.poll(() => phaseOf(sessionId)).toBeNull();
  await expect.poll(() => storedPass(sessionId)).toBe(pass);
  for (let reads = 0; reads < 5; reads++) {
    await new Promise((done) => setTimeout(done, 100));
    expect(await storedPass(sessionId)).toBe(pass);
  }
};

const windows: HTMLIFrameElement[] = [];
afterEach(() => {
  for (const frame of windows.splice(0)) frame.remove();
});

/** Another window of the origin showing the session: the dev page in an iframe. */
const openOtherWindow = (hostUrl: string, pass: string, sessionId: string) => {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'width: 900px; height: 600px; border: 0';
  frame.src = `/dev/index.html?host=${encodeURIComponent(hostUrl)}&session=${sessionId}&pass=${pass}`;
  addToPage(frame);
  windows.push(frame);
  return frame;
};

it('keeps the other chat connected and the pass stored when one of two chats on a session unmounts', async () => {
  const { hostUrl, pass, sessionId, assistantText } = host();
  const first = await mountChat({ hostUrl, pass, sessionId });
  const second = await mountChat({ hostUrl, pass, sessionId });
  await expect.poll(() => storedPass(sessionId)).toBe(pass);
  await expect.poll(() => phaseOf(sessionId)).toBe('connected');

  first.unmount();
  // Fresh state, not the page: the connection t3 holds for the session is up, with the pass.
  await expect.poll(() => storedPass(sessionId)).toBe(pass);
  for (let reads = 0; reads < 5; reads++) {
    await new Promise((done) => setTimeout(done, 100));
    expect(await phaseOf(sessionId)).toBe('connected');
    expect(await storedPass(sessionId)).toBe(pass);
  }
  await expect.element(answerOf(assistantText)).toBeVisible();

  second.unmount();
  await expect.poll(() => storedPass(sessionId)).toBeNull();
});

it('hands t3 the pass of the chat that registered last', async () => {
  const { hostUrl, sessionId } = host();
  const first = await mountChat({ hostUrl, pass: 'a-pass-first-chat', sessionId });
  await mountChat({ hostUrl, pass: 'a-pass-second-chat', sessionId });
  await expect.poll(() => storedPass(sessionId)).toBe('a-pass-second-chat');

  // Arrival order: a chat whose pass changes goes last, whatever its pass was before.
  await first.rerender({ hostUrl, pass: 'a-pass-first-chat-renewed', sessionId });
  await expect.poll(() => storedPass(sessionId)).toBe('a-pass-first-chat-renewed');
});

it("keeps the pass another window needs when this window's last chat on the session unmounts", async () => {
  const { hostUrl, pass, sessionId, assistantText } = host();
  const frame = openOtherWindow(hostUrl, pass, sessionId);
  await expect
    .poll(() => frame.contentDocument?.body.textContent ?? '', { timeout: 30_000 })
    .toContain(assistantText);
  const here = await mountChat({ hostUrl, pass, sessionId });
  await expect.poll(() => phaseOf(sessionId)).toBe('connected');

  here.unmount();
  await staysStored(sessionId, pass);
  // The other window still shows its conversation.
  expect(frame.contentDocument?.body.textContent).toContain(assistantText);

  // Once it closes too, nobody shows the session and its record is swept at the next page's start.
  frame.remove();
  windows.splice(0);
});
