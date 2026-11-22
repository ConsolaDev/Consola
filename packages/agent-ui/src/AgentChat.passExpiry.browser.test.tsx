// A file of its own: the host closes a connection when its pass expires (`@consola/host`'s
// `rpcServer.ts`), and this page sees that happen to a chat that was showing its thread.
import { beforeAll, expect, it, vi } from 'vite-plus/test';
import { page, server } from 'vite-plus/test/browser';
import { answerOf, forgetStoredThreads, host, mountChat } from './testing/render.tsx';

beforeAll(forgetStoredThreads);

/** The commands `vite.config.ts` defines for these tests. */
type PassCommands = {
  signHostPass(privateKeyFile: string, sessionId: string, lifetimeSeconds: number): Promise<string>;
  watchSockets(): Promise<void>;
  openedSockets(): Promise<string[]>;
};
const commands = server.commands as unknown as PassCommands;

/** The pass a socket was opened with: t3's ticket, which the host issues as the pass. */
const ticketsOf = (urls: ReadonlyArray<string>) =>
  urls.map((url) => new URL(url).searchParams.get('wsTicket'));

it('asks for a new pass when the host ends the connection at its pass’s expiry, and reconnects with it', async () => {
  const { hostUrl, sessionId, assistantText, passKeyFile } = host();
  await commands.watchSockets();
  const expiring = await commands.signHostPass(passKeyFile, sessionId, 8);
  const next = await commands.signHostPass(passKeyFile, sessionId, 600);
  const onPassExpired = vi.fn(async () => next);
  await mountChat({ hostUrl, pass: expiring, sessionId, onPassExpired });

  // Connected with the expiring pass, and shown the thread, before anything is refused.
  await expect.element(answerOf(assistantText)).toBeVisible();
  expect(ticketsOf(await commands.openedSockets())).toContain(expiring);
  expect(onPassExpired).not.toHaveBeenCalled();

  // At its expiry the host closes the socket (4401); t3 asks again, is refused, and the chat
  // asks for a new pass, then connects with it.
  await expect.poll(() => onPassExpired.mock.calls.length, { timeout: 30_000 }).toBe(1);
  await expect
    .poll(async () => ticketsOf(await commands.openedSockets()), { timeout: 30_000 })
    .toContain(next);
  await expect.element(answerOf(assistantText)).toBeVisible();
  expect(page.getByRole('alert').query()).toBeNull();
  expect(onPassExpired).toHaveBeenCalledTimes(1);
});
