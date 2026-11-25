// A file of its own: what the page's console says, and which of its requests the host refuses,
// from the moment a chat mounts until it shows its thread (`@consola/host`'s `hostHttp.ts`).
import { beforeAll, expect, it } from 'vite-plus/test';
import { page, server } from 'vite-plus/test/browser';
import { answerOf, forgetStoredThreads, host, mountChat } from './testing/render.tsx';

beforeAll(forgetStoredThreads);

/** The commands `vite.config.ts` defines for these tests. */
type NoiseCommands = {
  watchPageNoise(): Promise<void>;
  takePageNoise(): Promise<string[]>;
};
const commands = server.commands as unknown as NoiseCommands;

it('connects and shows the thread, titled as the thread is, with nothing said and no request refused', async () => {
  const { hostUrl, pass, sessionId, assistantText, threadTitle } = host();
  await commands.watchPageNoise();
  await commands.takePageNoise();
  await mountChat({ hostUrl, pass, sessionId });
  await expect.element(answerOf(assistantText)).toBeVisible();
  // t3's header reads the title from the thread's row in the host's shell, which the host keeps
  // as the thread is: a row it left behind would still say the first message or "New thread".
  // The header renders, but is not shown (`styles.css`): the page around the chat names it.
  await expect.element(page.getByText(threadTitle, { exact: true })).toBeInTheDocument();
  // Once connected, t3's client reads the session's scopes, its shell and its thread; a refused
  // shell is retried with a backoff, so a few seconds show whether anything is asked again.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(await commands.takePageNoise()).toEqual([]);
});
