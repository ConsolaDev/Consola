// A file of its own: what the page's console says, and which of its requests the host refuses,
// from the moment a chat mounts until it shows its thread (`@consola/host`'s `hostHttp.ts`).
import { beforeAll, expect, it } from 'vite-plus/test';
import { server } from 'vite-plus/test/browser';
import { answerOf, forgetStoredThreads, host, mountChat } from './testing/render.tsx';

beforeAll(forgetStoredThreads);

/** The commands `vite.config.ts` defines for these tests. */
type NoiseCommands = {
  watchPageNoise(): Promise<void>;
  takePageNoise(): Promise<string[]>;
};
const commands = server.commands as unknown as NoiseCommands;

const SHELL_REFUSED = '404 GET /api/orchestration/shell';
const RESOURCE_404 =
  'console.error: Failed to load resource: the server responded with a status of 404 (Not Found)';

/**
 * The noise left once the shell's is taken out. The host serves no shell (the thread list,
 * `subscribeShell`, which the plan leaves out), and no t3 option keeps its client from asking:
 * each try is a `404` (and Chromium's line for it) and two of Effect's warnings.
 */
const withoutShellNoise = (noise: ReadonlyArray<string>): string[] => {
  let shellRefusals = noise.filter((line) => line === SHELL_REFUSED).length;
  return noise.filter((line) => {
    if (line === SHELL_REFUSED || /environment shell/.test(line)) return false;
    if (line === RESOURCE_404 && shellRefusals > 0) {
      shellRefusals -= 1;
      return false;
    }
    return true;
  });
};

it('connects and shows the thread with no bounded snapshot asked for and nothing else said', async () => {
  const { hostUrl, pass, sessionId, assistantText } = host();
  await commands.watchPageNoise();
  await commands.takePageNoise();
  await mountChat({ hostUrl, pass, sessionId });
  await expect.element(answerOf(assistantText)).toBeVisible();
  // Once connected, t3's client reads the session's scopes and its thread loaders run.
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const noise = await commands.takePageNoise();
  // The host pages thread snapshots over the socket (`threadSnapshotPagination`), so t3's client
  // opens the thread there and never asks the HTTP route the host does not serve.
  expect(noise.filter((line) => /bounded/.test(line))).toEqual([]);
  expect(withoutShellNoise(noise)).toEqual([]);
});
