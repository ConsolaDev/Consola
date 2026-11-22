// A file of its own: its page has never shown the session, and t3's stored copy of it is
// deleted first, so nothing it shows is left over. The tests run in order, and only the last one
// connects.
import { afterEach, beforeAll, expect, it, vi } from 'vite-plus/test';
import { page } from 'vite-plus/test/browser';
import { answerOf, forgetStoredThreads, host, mountChat } from './testing/render.tsx';

beforeAll(forgetStoredThreads);
afterEach(() => {
  vi.restoreAllMocks();
});

const REFUSED_PASS = 'a-pass-the-host-refuses';

/** Time for t3 to try a pass, be refused, and stay there. */
const settle = () => new Promise((settled) => setTimeout(settled, 2_500));

/** AgentChat's notice over t3's view. */
const notice = () => page.getByRole('alert');

it("without onPassExpired, a refused pass shows that the host refused the chat's pass", async () => {
  const { hostUrl, sessionId, assistantText } = host();
  await mountChat({ hostUrl, pass: REFUSED_PASS, sessionId });

  await expect.element(notice()).toMatchTextContent(/The host refused this chat's pass/);
  await expect.element(notice()).toMatchTextContent(/It has expired or was revoked\./);
  await settle();
  expect(answerOf(assistantText).query()).toBeNull();
  await expect.element(notice()).toBeVisible();
});

it('asks once when the new pass is refused too, and says so', async () => {
  const { hostUrl, sessionId, assistantText } = host();
  const onPassExpired = vi.fn(async () => 'another-pass-the-host-refuses');
  await mountChat({ hostUrl, pass: REFUSED_PASS, sessionId, onPassExpired });

  await expect.poll(() => onPassExpired.mock.calls.length, { timeout: 30_000 }).toBe(1);
  await expect.element(notice()).toMatchTextContent(/The host refused this chat's pass/);
  await settle();
  expect(onPassExpired).toHaveBeenCalledTimes(1);
  expect(answerOf(assistantText).query()).toBeNull();
});

it('says so, and logs why, when onPassExpired fails', async () => {
  const { hostUrl, sessionId, assistantText } = host();
  const logged = vi.spyOn(console, 'error');
  const onPassExpired = vi.fn(async (): Promise<string> => {
    throw new Error('the page could not reach its pass service');
  });
  await mountChat({ hostUrl, pass: REFUSED_PASS, sessionId, onPassExpired });

  await expect.element(notice()).toMatchTextContent(/A new pass could not be fetched\./);
  expect(onPassExpired).toHaveBeenCalledTimes(1);
  expect(answerOf(assistantText).query()).toBeNull();
  const ours = logged.mock.calls.filter(([message]) => String(message).includes('onPassExpired'));
  expect(ours).toEqual([
    [
      '@consola/agent-ui: onPassExpired failed, so the refused pass was not replaced.',
      expect.stringContaining('the page could not reach its pass service'),
    ],
  ]);
});

it("says so, and logs why, when the chat's connection cannot be set up", async () => {
  const { sessionId } = host();
  const logged = vi.spyOn(console, 'error');
  await mountChat({ hostUrl: 'not an address', pass: REFUSED_PASS, sessionId });

  await expect.element(notice()).toMatchTextContent(/The chat could not connect to its host/);
  expect(logged).toHaveBeenCalledWith(
    '@consola/agent-ui: the host address "not an address" is not a URL.',
    expect.any(String),
  );
  expect(JSON.stringify(logged.mock.calls)).not.toContain(REFUSED_PASS);
});

it('asks for a new pass when the host refuses the one it has, and connects with it', async () => {
  const { hostUrl, pass, sessionId, assistantText } = host();
  let answer: (pass: string) => void = () => {};
  const onPassExpired = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        answer = resolve;
      }),
  );
  await mountChat({ hostUrl, pass: REFUSED_PASS, sessionId, onPassExpired });

  await expect.poll(() => onPassExpired.mock.calls.length, { timeout: 30_000 }).toBe(1);
  expect(answerOf(assistantText).query()).toBeNull();

  answer(pass);
  await expect.element(answerOf(assistantText)).toBeVisible();
  expect(onPassExpired).toHaveBeenCalledTimes(1);
  expect(notice().query()).toBeNull();
});
