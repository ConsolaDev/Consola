import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, inject, it, vi } from 'vite-plus/test';
import { page } from 'vite-plus/test/browser';
import { AgentChat, type AgentChatProps } from './index.ts';
import stylesheet from './styles.css?inline';
import { HOST_SESSION_KEY, type HostSession } from './testing/hostSessionKey.ts';

// Vitest's provided values are typed through a module this package cannot name.
const host = (inject as unknown as (key: string) => HostSession)(HOST_SESSION_KEY);

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** Adds the package's stylesheet as a consumer's import of `@consola/agent-ui/styles.css` would. */
const addStylesheet = () => {
  const style = document.createElement('style');
  style.textContent = stylesheet;
  document.head.append(style);
  cleanups.push(() => style.remove());
};

const mount = async (props: AgentChatProps) => {
  const container = document.createElement('div');
  container.style.height = '720px';
  document.body.append(container);
  const root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(<AgentChat {...props} />));
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  cleanups.push(() => {
    root.unmount();
    container.remove();
  });
};

const INHERITED_AND_BOX = ['font-family', 'margin', 'line-height', 'color'] as const;
const styleOf = (element: Element) => {
  const computed = getComputedStyle(element);
  return Object.fromEntries(
    INHERITED_AND_BOX.map((name) => [name, computed.getPropertyValue(name)]),
  );
};

it("renders the session's thread from its host, styling nothing outside the chat", async () => {
  const outside = document.createElement('p');
  outside.id = 'outside';
  outside.textContent = 'A paragraph of the page that mounts the chat.';
  document.body.append(outside);
  cleanups.push(() => outside.remove());
  const before = styleOf(outside);

  addStylesheet();
  await mount({ hostUrl: host.hostUrl, pass: host.pass, sessionId: host.sessionId });

  await expect.element(page.getByText(host.assistantText)).toBeVisible();
  expect(styleOf(outside)).toEqual(before);
});

it('asks for a new pass when the host refuses the one it has, and reconnects with it', async () => {
  addStylesheet();
  const onPassExpired = vi.fn(async () => host.pass);
  await mount({
    hostUrl: host.hostUrl,
    pass: 'a-pass-the-host-refuses',
    sessionId: host.sessionId,
    onPassExpired,
  });

  await expect.element(page.getByText(host.assistantText)).toBeVisible();
  expect(onPassExpired).toHaveBeenCalledTimes(1);
});
