// A file of its own: its page has never registered the session, so the environment is unknown to
// t3's registry until this test lets the registration land.
import { afterEach, beforeAll, expect, it, vi } from 'vite-plus/test';
import { page } from 'vite-plus/test/browser';
import { answerOf, forgetStoredThreads, host, mountChat, watchConsole } from './testing/render.tsx';

beforeAll(forgetStoredThreads);
afterEach(() => {
  vi.restoreAllMocks();
});

/** How long AgentChat looks for its environment before it says it could not connect. */
const REGISTRATION_WAIT_MS = 10_000;

it('takes back "could not connect" once a registration held past the wait connects', async () => {
  const { hostUrl, pass, sessionId, assistantText } = host();
  const consoleText = watchConsole();
  const logged = vi.spyOn(console, 'error');
  // Another window removing the session's pass holds its lock (`storedSessions.ts`): this page's
  // hold, and so its registration, waits until it lets go.
  let letGo: () => void = () => {};
  const otherWindow = new Promise<void>((held) => {
    void navigator.locks.request(
      `consola-agent-ui:session:${sessionId}`,
      () =>
        new Promise<void>((done) => {
          letGo = done;
          held();
        }),
    );
  });
  await otherWindow;
  await mountChat({ hostUrl, pass, sessionId });

  const notice = page.getByRole('alert');
  await expect
    .element(notice, { timeout: REGISTRATION_WAIT_MS + 20_000 })
    .toMatchTextContent(/The chat could not connect to its host/);
  expect(logged).toHaveBeenCalledWith(
    "@consola/agent-ui: t3's connection has not shown the host's state after 10 seconds; still waiting.",
    expect.any(String),
  );

  letGo();
  await expect.element(answerOf(assistantText), { timeout: 20_000 }).toBeVisible();
  await expect.poll(() => notice.query(), { timeout: 10_000 }).toBeNull();
  expect(consoleText()).not.toContain(pass);
}, 60_000);
