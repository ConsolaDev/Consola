import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, inject, vi } from 'vite-plus/test';
import { page, server } from 'vite-plus/test/browser';
import type { AgentChatProps } from '../index.ts';
import { HOST_SESSION_KEY, type HostSession } from './hostSessionKey.ts';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** The replay host `hostSession.ts` started (Vitest's provided values are untyped here). */
export const host = (): HostSession =>
  (inject as unknown as (key: string) => HostSession)(HOST_SESSION_KEY);

/**
 * Watches `console.error`, `warn`, `log` and `info` (calls still go through) until the spies
 * are restored (`vi.restoreAllMocks`); answers everything they were called with so far, as text,
 * for a test to check no pass reached the console.
 */
export const watchConsole = (): (() => string) => {
  const spies = (['error', 'warn', 'log', 'info'] as const).map((level) =>
    vi.spyOn(console, level),
  );
  return () => JSON.stringify(spies.map((spy) => spy.mock.calls));
};

/** The assistant's message, not the user's prompt that quotes it. */
export const answerOf = (text: string) => page.getByText(text, { exact: true });

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type ColorScheme = 'light' | 'dark';
/** The command `vite.config.ts` defines: Playwright's `emulateMedia` on the tests' page. */
type ColorSchemeCommands = { emulateColorScheme(scheme: ColorScheme | null): Promise<void> };

/** Makes the system's appearance (`prefers-color-scheme`) `scheme` until the test ends. */
export const emulateColorScheme = async (scheme: ColorScheme) => {
  const { emulateColorScheme: emulate } = server.commands as unknown as ColorSchemeCommands;
  await emulate(scheme);
  cleanups.push(() => emulate(null));
};

const elementState = (element: HTMLElement) => ({
  attributes: Object.fromEntries([...element.attributes].map(({ name, value }) => [name, value])),
  background: getComputedStyle(element).backgroundColor,
  colorScheme: getComputedStyle(element).colorScheme,
});

/**
 * What the page's own document says: `<html>` and `<body>` (every attribute, so their classes,
 * inline styles, `lang` and data attributes, and their computed background and colour scheme)
 * and the `<meta>` elements of `<head>`. The chat must leave all of it as it was.
 */
export const pageDocument = () => ({
  html: elementState(document.documentElement),
  body: elementState(document.body),
  metas: [...document.head.querySelectorAll('meta')].map((meta) => meta.outerHTML),
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
 * Mounts `AgentChat` in a container of a chat's size, until the test ends: at the end of the
 * page's `<body>`, or of `parent` (an element of the page's around the chat). The package is
 * imported here, on first use, as a page imports it (its stylesheet with it), so a test can look
 * at the page before anything of the package has run.
 */
export const mountChat = async (
  props: AgentChatProps,
  { parent }: { readonly parent?: HTMLElement } = {},
) => {
  const { AgentChat } = await import('../index.ts');
  const container = document.createElement('div');
  container.style.height = '720px';
  if (parent === undefined) addToPage(container);
  else {
    parent.append(container);
    cleanups.push(() => container.remove());
  }
  const root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(<AgentChat {...props} />));
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  let mounted = true;
  const unmount = () => {
    if (mounted) root.unmount();
    mounted = false;
  };
  cleanups.push(unmount);
  const rerender = async (next: AgentChatProps) => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(<AgentChat {...next} />));
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  };
  return { unmount, rerender };
};
