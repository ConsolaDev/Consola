// The local dev page (`dev/DevPage.tsx`), rendered as `dev/main.tsx` renders it, against the
// browser tests' replay host (no real CLI: `src/testing/hostSession.ts`).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, expect, it, vi } from 'vite-plus/test';
import { page } from 'vite-plus/test/browser';
import { DevPage, forgetPassInAddress } from '../dev/DevPage.tsx';
import { addToPage, answerOf, forgetStoredThreads, host, watchConsole } from './testing/render.tsx';

beforeAll(forgetStoredThreads);
afterEach(() => {
  vi.restoreAllMocks();
});

const mountPage = async (search: string) => {
  const container = document.createElement('div');
  container.style.height = '720px';
  addToPage(container);
  const root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(<DevPage search={search} />));
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  return { container, unmount: () => root.unmount() };
};

it('names the parameters that are missing, and never the pass', async () => {
  const consoleText = watchConsole();
  const { container, unmount } = await mountPage('?pass=secret-pass-value');

  await expect
    .element(page.getByRole('alert'))
    .toMatchTextContent(/Missing parameters: host, session\./);
  expect(container.textContent).not.toContain('secret-pass-value');
  expect(consoleText()).not.toContain('secret-pass-value');
  unmount();
});

it('names one missing parameter in the singular', async () => {
  const { sessionId } = host();
  const { unmount } = await mountPage(`?host=ws://127.0.0.1:1&session=${sessionId}`);

  await expect.element(page.getByRole('alert')).toMatchTextContent(/Missing parameter: pass\./);
  unmount();
});

it("renders the session's conversation from ws:// host, pass and session parameters", async () => {
  const { hostUrl, pass, sessionId, assistantText } = host();
  const wsHost = hostUrl.replace(/^http/, 'ws');
  const query = new URLSearchParams({ host: wsHost, pass, session: sessionId, theme: 'dark' });
  const consoleText = watchConsole();
  const { container, unmount } = await mountPage(`?${query}`);

  await expect.element(answerOf(assistantText)).toBeVisible();
  expect(container.querySelector('[data-theme="dark"]')).not.toBeNull();
  expect(container.textContent).not.toContain(pass);
  expect(consoleText()).not.toContain(pass);
  unmount();
});

it('takes the pass out of the address, replacing the history entry and keeping the rest', () => {
  const replaced: Array<{ state: unknown; url: string }> = [];
  const state = { page: 'sprocket' };
  const bar = (href: string) => ({
    location: { href },
    history: {
      state,
      replaceState: (given: unknown, _unused: string, url: URL) => {
        replaced.push({ state: given, url: url.href });
      },
    },
  });

  forgetPassInAddress(
    bar(
      'http://localhost:5176/?host=ws://127.0.0.1:7420&pass=secret-pass-value&session=demo-1&theme=dark',
    ),
  );
  expect(replaced).toEqual([
    {
      state,
      url: 'http://localhost:5176/?host=ws%3A%2F%2F127.0.0.1%3A7420&session=demo-1&theme=dark',
    },
  ]);

  // An address with no pass is left as it is.
  forgetPassInAddress(bar('http://localhost:5176/?host=ws://127.0.0.1:7420&session=demo-1'));
  expect(replaced).toHaveLength(1);
});
