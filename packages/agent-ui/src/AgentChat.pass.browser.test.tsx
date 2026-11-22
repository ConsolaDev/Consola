// A file of its own: its page has never shown the session, and t3's stored copy of it is
// deleted first, so nothing it shows is left over. The tests run in order, and only the last one
// connects.
import { beforeAll, expect, it, vi } from 'vite-plus/test';
import { page } from 'vite-plus/test/browser';
import {
  addStylesheet,
  answerOf,
  forgetStoredThreads,
  host,
  mountChat,
} from './testing/render.tsx';

beforeAll(forgetStoredThreads);

const REFUSED_PASS = 'a-pass-the-host-refuses';

/** Time for t3 to try a pass, be refused, and stay there. */
const settle = () => new Promise((settled) => setTimeout(settled, 2_500));

it("without onPassExpired, a refused pass leaves t3's own state for a thread it cannot reach", async () => {
  const { hostUrl, sessionId, assistantText } = host();
  addStylesheet();
  await mountChat({ hostUrl, pass: REFUSED_PASS, sessionId });

  await expect.element(page.getByText('No active thread')).toBeVisible();
  await settle();
  expect(answerOf(assistantText).query()).toBeNull();
  await expect.element(page.getByText('No active thread')).toBeVisible();
});

it('asks once when the new pass is refused too, and leaves it there', async () => {
  const { hostUrl, sessionId, assistantText } = host();
  addStylesheet();
  const onPassExpired = vi.fn(async () => 'another-pass-the-host-refuses');
  await mountChat({ hostUrl, pass: REFUSED_PASS, sessionId, onPassExpired });

  await expect.poll(() => onPassExpired.mock.calls.length, { timeout: 30_000 }).toBe(1);
  await settle();
  expect(onPassExpired).toHaveBeenCalledTimes(1);
  expect(answerOf(assistantText).query()).toBeNull();
});

it('asks for a new pass when the host refuses the one it has, and connects with it', async () => {
  const { hostUrl, pass, sessionId, assistantText } = host();
  addStylesheet();
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
});
