// Nothing of the package is imported up front: the first test looks at the page before the
// package's modules run, as they run when a page imports it.
import { beforeAll, expect, it } from 'vite-plus/test';
import {
  addToPage,
  answerOf,
  emulateColorScheme,
  forgetStoredThreads,
  host,
  mountChat,
  pageDocument,
} from './testing/render.tsx';

// What the chat shows comes from the host, not from t3's stored copy of an earlier file's chat.
beforeAll(forgetStoredThreads);

const PROPERTIES = ['font-family', 'margin', 'line-height', 'color'] as const;
const styleOf = (element: Element) => {
  const computed = getComputedStyle(element);
  return Object.fromEntries(PROPERTIES.map((name) => [name, computed.getPropertyValue(name)]));
};

it("renders the session's thread from its host, leaving the page as it was", async () => {
  const { hostUrl, pass, sessionId, assistantText } = host();
  // A page with a background of its own, on a system in dark mode: what t3's theme module writes
  // to a document at import (its appearance on <html>, that background inline on <html> and
  // <body>, a theme-color <meta>) would show.
  await emulateColorScheme('dark');
  const pageStyle = document.createElement('style');
  pageStyle.textContent = 'body { background-color: rgb(250, 248, 240); }';
  addToPage(pageStyle);
  const outside = document.createElement('p');
  outside.id = 'outside';
  outside.textContent = 'A paragraph of the page that mounts the chat.';
  addToPage(outside);
  const before = { document: pageDocument(), outside: styleOf(outside) };

  await import('./index.ts');
  expect({ document: pageDocument(), outside: styleOf(outside) }).toEqual(before);

  await mountChat({ hostUrl, pass, sessionId });
  await expect.element(answerOf(assistantText)).toBeVisible();
  expect({ document: pageDocument(), outside: styleOf(outside) }).toEqual(before);
});
