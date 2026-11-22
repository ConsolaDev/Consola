import { beforeAll, expect, it } from 'vite-plus/test';
import { addToPage, answerOf, forgetStoredThreads, host, mountChat } from './testing/render.tsx';

// What the chat shows comes from the host, not from t3's stored copy of an earlier file's chat.
beforeAll(forgetStoredThreads);

const PROPERTIES = ['font-family', 'margin', 'line-height', 'color'] as const;
const styleOf = (element: Element) => {
  const computed = getComputedStyle(element);
  return Object.fromEntries(PROPERTIES.map((name) => [name, computed.getPropertyValue(name)]));
};

it("renders the session's thread from its host, styling nothing outside the chat", async () => {
  const { hostUrl, pass, sessionId, assistantText } = host();
  const outside = document.createElement('p');
  outside.id = 'outside';
  outside.textContent = 'A paragraph of the page that mounts the chat.';
  addToPage(outside);
  const before = styleOf(outside);

  await mountChat({ hostUrl, pass, sessionId });

  await expect.element(answerOf(assistantText)).toBeVisible();
  expect(styleOf(outside)).toEqual(before);
});
