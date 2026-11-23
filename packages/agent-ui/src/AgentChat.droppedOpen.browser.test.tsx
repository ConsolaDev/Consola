// A file of its own: its first socket drops, so its thread is opened cold a second time.
import { afterAll, beforeAll, expect, it } from 'vite-plus/test';
import { server } from 'vite-plus/test/browser';
import { answerOf, forgetStoredThreads, host, mountChat } from './testing/render.tsx';

beforeAll(forgetStoredThreads);

/** The commands `vite.config.ts` defines for these tests. */
type NoiseCommands = {
  watchPageNoise(): Promise<void>;
  takePageNoise(): Promise<string[]>;
};
const commands = server.commands as unknown as NoiseCommands;

/** What t3's client sends when it opens its thread on a socket (`subscribeThread`). */
const SUBSCRIBE_THREAD = '"orchestration.subscribeThread"';

/**
 * The page's sockets, the first of which ends as it asks for its thread, before the host has sent
 * any of it: a first session that drops before its data arrives, as a network that drops, or a
 * sandbox's proxy that restarts, would end it. t3's client makes each socket with the page's
 * `WebSocket` (Effect's `layerWebSocketConstructorGlobal`), so a page's own stands in for it.
 */
const NativeWebSocket = globalThis.WebSocket;
const drops = { toCome: 1, done: 0 };
class DroppingWebSocket extends NativeWebSocket {
  override send(data: Parameters<WebSocket['send']>[0]): void {
    if (drops.toCome > 0 && typeof data === 'string' && data.includes(SUBSCRIBE_THREAD)) {
      drops.toCome -= 1;
      drops.done += 1;
      this.close(4000, 'The test drops the first open.');
      return;
    }
    super.send(data);
  }
}
beforeAll(() => {
  globalThis.WebSocket = DroppingWebSocket;
});
afterAll(() => {
  globalThis.WebSocket = NativeWebSocket;
});

it('stays quiet when its first socket drops before the thread arrives, and shows the thread', async () => {
  const { hostUrl, pass, sessionId, assistantText } = host();
  await commands.watchPageNoise();
  await commands.takePageNoise();
  // t3's client opens a cold thread over the socket once (`threadSnapshotPagination`); a later
  // cold open, after that session dropped, asks the host for its bounded snapshot over HTTP.
  await mountChat({ hostUrl, pass, sessionId });
  await expect.element(answerOf(assistantText)).toBeVisible();
  expect(drops.done).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(await commands.takePageNoise()).toEqual([]);
});
