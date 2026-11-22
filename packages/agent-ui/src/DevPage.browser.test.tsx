// The local dev page (`dev/DevPage.tsx`), rendered as `dev/main.tsx` renders it, against the
// browser tests' replay host (no real CLI: `src/testing/hostSession.ts`).
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, expect, it, vi } from 'vite-plus/test';
import { page } from 'vite-plus/test/browser';
import { DevPage } from '../dev/DevPage.tsx';
import { addToPage, answerOf, forgetStoredThreads, host } from './testing/render.tsx';

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
  const logged = vi.spyOn(console, 'error');
  const { container, unmount } = await mountPage('?pass=secret-pass-value');

  await expect
    .element(page.getByRole('alert'))
    .toMatchTextContent(/Missing parameters: host, session\./);
  expect(container.textContent).not.toContain('secret-pass-value');
  expect(JSON.stringify(logged.mock.calls)).not.toContain('secret-pass-value');
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
  const { container, unmount } = await mountPage(`?${query}`);

  await expect.element(answerOf(assistantText)).toBeVisible();
  expect(container.querySelector('[data-theme="dark"]')).not.toBeNull();
  expect(container.textContent).not.toContain(pass);
  unmount();
});
