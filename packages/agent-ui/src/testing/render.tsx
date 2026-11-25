import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, inject, vi } from 'vite-plus/test';
import { page, server } from 'vite-plus/test/browser';
import type { AgentChatProps } from '../index.ts';
import { HOST_SESSION_KEY, type HostSession, type ProvidedHost } from './hostSessionKey.ts';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/**
 * What `hostSession.ts` provides (Vitest's provided values are untyped here), or `undefined` in a
 * project that starts no host: the built library's (`dist`), whose test imports this module for
 * its page helpers only.
 */
const provided = (): ProvidedHost | undefined =>
  (inject as unknown as (key: string) => ProvidedHost | undefined)(HOST_SESSION_KEY);

/** The command `vite.config.ts` defines: a pass signed with the key the host trusts. */
type PassCommands = {
  signHostPass(privateKeyFile: string, sessionId: string, lifetimeSeconds: number): Promise<string>;
};

/** The running test's pass, signed as it starts (below); none outside a test. */
let testPass: string | undefined;

/**
 * Every test is handed a pass of its own, signed as it starts and living as long as a pass may
 * (five minutes), so a test never meets the expiry of a pass signed for the whole run, however
 * long the run takes: a test runs for at most `testTimeout` (`vite.config.ts`, a minute).
 */
beforeEach(async () => {
  const replayHost = provided();
  if (replayHost === undefined) return;
  const { passKeyFile, sessionId, passLifetimeSeconds } = replayHost;
  const { signHostPass } = server.commands as unknown as PassCommands;
  testPass = await signHostPass(passKeyFile, sessionId, passLifetimeSeconds);
});
afterEach(() => {
  testPass = undefined;
});

/** The replay host `hostSession.ts` started, with the running test's own pass. */
export const host = (): HostSession => {
  const replayHost = provided();
  if (replayHost === undefined) {
    throw new Error("host() needs the browser project's replay host (src/testing/hostSession.ts).");
  }
  if (testPass === undefined) {
    throw new Error('host() is called inside a test: its pass is signed as the test starts.');
  }
  return { ...replayHost, pass: testPass };
};

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
 * page's `<body>`, or of `parent` (an element of the page's around the chat). With `className`,
 * the container is the page's own element of that class, which the page's CSS places and sizes
 * (cloud-web's `.session-chat-frame`), rather than 720px tall. The package is imported here, on
 * first use, as a page imports it (its stylesheet with it), so a test can look at the page before
 * anything of the package has run.
 */
export const mountChat = async (
  props: AgentChatProps,
  { parent, className }: { readonly parent?: HTMLElement; readonly className?: string } = {},
) => {
  const { AgentChat } = await import('../index.ts');
  const container = document.createElement('div');
  if (className === undefined) container.style.height = '720px';
  else container.className = className;
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
