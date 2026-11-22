import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, inject } from 'vite-plus/test';
import { page } from 'vite-plus/test/browser';
import type { AgentChatProps } from '../index.ts';
import { HOST_SESSION_KEY, type HostSession } from './hostSessionKey.ts';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** The replay host `hostSession.ts` started (Vitest's provided values are untyped here). */
export const host = (): HostSession =>
  (inject as unknown as (key: string) => HostSession)(HOST_SESSION_KEY);

/** The assistant's message, not the user's prompt that quotes it. */
export const answerOf = (text: string) => page.getByText(text, { exact: true });

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/**
 * Deletes what t3 keeps in the browser's IndexedDB (its saved connections and its cache of thread
 * snapshots, shown before a connection is back), which outlives a test file's page.
 */
export const forgetStoredThreads = async () => {
  const databases = await indexedDB.databases();
  await Promise.all(
    databases.map(
      ({ name }) =>
        new Promise<void>((done, failed) => {
          if (name === undefined) return done();
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => done();
          request.onerror = () => failed(request.error);
        }),
    ),
  );
};

/** Appends `element` to the page until the test ends. */
export const addToPage = (element: HTMLElement) => {
  document.body.append(element);
  cleanups.push(() => element.remove());
};

/**
 * Mounts `AgentChat` in a container of a chat's size, until the test ends. The package is imported
 * here, on first use, as a page imports it (its stylesheet with it), so a test can look at the page
 * before anything of the package has run.
 */
export const mountChat = async (props: AgentChatProps) => {
  const { AgentChat } = await import('../index.ts');
  const container = document.createElement('div');
  container.style.height = '720px';
  addToPage(container);
  const root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(<AgentChat {...props} />));
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  cleanups.push(() => root.unmount());
};
