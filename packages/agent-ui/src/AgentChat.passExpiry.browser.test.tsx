// A file of its own: the host closes a connection when its pass expires (`@consola/host`'s
// `rpcServer.ts`), and this page sees that happen to a chat that was showing its thread.
import { afterEach, beforeAll, expect, it, vi } from 'vite-plus/test';
import { page, server } from 'vite-plus/test/browser';
import { answerOf, forgetStoredThreads, host, mountChat, watchConsole } from './testing/render.tsx';

beforeAll(forgetStoredThreads);
afterEach(() => {
  vi.restoreAllMocks();
});

/** The commands `vite.config.ts` defines for these tests. */
type PassCommands = {
  signHostPass(privateKeyFile: string, sessionId: string, lifetimeSeconds: number): Promise<string>;
  watchSockets(): Promise<void>;
  openedSockets(): Promise<string[]>;
};
const commands = server.commands as unknown as PassCommands;

/** The ticket each socket was opened with: one the host issued for a pass, never the pass. */
const ticketsOf = (urls: readonly string[]) =>
  urls.map((url) => new URL(url).searchParams.get('wsTicket'));

it('asks for a new pass when the host ends the connection at its pass’s expiry, and reconnects with it', async () => {
  const { hostUrl, sessionId, assistantText, passKeyFile } = host();
  await commands.watchSockets();
  const expiring = await commands.signHostPass(passKeyFile, sessionId, 8);
  const next = await commands.signHostPass(passKeyFile, sessionId, 300);
  // How many sockets the page had opened when the chat asked for a new pass.
  let openedAtExpiry = -1;
  const onPassExpired = vi.fn(async () => {
    openedAtExpiry = (await commands.openedSockets()).length;
    return next;
  });
  const consoleText = watchConsole();
  await mountChat({ hostUrl, pass: expiring, sessionId, onPassExpired });

  // Connected with a ticket for the expiring pass, and shown the thread, before anything is
  // refused.
  await expect.element(answerOf(assistantText)).toBeVisible();
  expect(ticketsOf(await commands.openedSockets()).length).toBeGreaterThan(0);
  expect(onPassExpired).not.toHaveBeenCalled();

  // At its expiry the host closes the socket (4401); t3 asks for a ticket again, is refused, and
  // the chat asks for a new pass, then connects with a ticket for it: the only pass the host
  // still takes.
  await expect.poll(() => onPassExpired.mock.calls.length, { timeout: 30_000 }).toBe(1);
  await expect
    .poll(
      async () => openedAtExpiry >= 0 && (await commands.openedSockets()).length > openedAtExpiry,
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect.element(answerOf(assistantText)).toBeVisible();
  // Every socket opened with a ticket of its own, and no socket's address carried a pass.
  const tickets = ticketsOf(await commands.openedSockets());
  expect(new Set(tickets).size).toBe(tickets.length);
  for (const url of await commands.openedSockets()) {
    expect(url).not.toContain(expiring);
    expect(url).not.toContain(next);
  }
  expect(page.getByRole('alert').query()).toBeNull();
  expect(onPassExpired).toHaveBeenCalledTimes(1);
  expect(consoleText()).not.toContain(expiring);
  expect(consoleText()).not.toContain(next);
});
