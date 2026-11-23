// The copies `src/injectedStyles.ts` keeps of the CSS t3's dependencies inject (AGENTS.md, "The
// page's CSS", runtime-injected CSS): one per injected style while any chat is mounted, a later
// injection picked up, all gone after the last chat unmounts, and none styling anything outside
// the chat.
import { beforeAll, expect, it } from 'vite-plus/test';
import { COPY_ATTRIBUTE, INJECTED_STYLES } from './injectedStyles.ts';
import { addToPage, answerOf, forgetStoredThreads, host, mountChat } from './testing/render.tsx';

beforeAll(forgetStoredThreads);

/** Legend List's style (`@legendapp/list`'s `ensureScrollbarHiddenStyle`), which it adds later. */
const LEGEND_LIST_STYLE =
  '.legend-list-scrollbar-y-hidden::-webkit-scrollbar:vertical{width:0;display:none;}.legend-list-scrollbar-x-hidden::-webkit-scrollbar:horizontal{height:0;display:none;}';

const originals = () => [...document.head.querySelectorAll<HTMLStyleElement>(INJECTED_STYLES)];
const copies = () => [...document.head.querySelectorAll<HTMLStyleElement>(`[${COPY_ATTRIBUTE}]`)];

/** Whether each injected style has one copy, right after it. */
const eachCopiedOnce = () =>
  copies().length === originals().length &&
  originals().every((original) => original.nextElementSibling?.hasAttribute(COPY_ATTRIBUTE));

const mountTwo = async () => {
  const { hostUrl, pass, sessionId, assistantText } = host();
  const first = await mountChat({ hostUrl, pass, sessionId });
  const second = await mountChat({ hostUrl, pass, sessionId });
  await expect
    .poll(() => document.querySelectorAll('.consola-agent-ui .ProseMirror').length)
    .toBe(2);
  await expect.element(answerOf(assistantText).first()).toBeVisible();
  return { first, second };
};

it('keeps one copy of each injected style while a chat is mounted, and none after the last', async () => {
  const { first, second } = await mountTwo();
  // Tiptap's, injected as the first composer was created.
  expect(originals().map((style) => style.hasAttribute('data-tiptap-style'))).toEqual([true]);
  expect(eachCopiedOnce()).toBe(true);

  // A dependency that injects once the chats are up (Legend List, for a list that hides its
  // scrollbar) is copied too.
  const later = document.createElement('style');
  later.id = 'legend-list-scrollbar-axis-hidden-style';
  later.textContent = LEGEND_LIST_STYLE;
  document.head.append(later);
  try {
    await expect.poll(() => later.nextElementSibling?.hasAttribute(COPY_ATTRIBUTE)).toBe(true);
    expect(originals()).toHaveLength(2);
    expect(eachCopiedOnce()).toBe(true);
    expect(later.nextElementSibling?.textContent).toContain('legend-list-scrollbar-y-hidden');

    // The copies apply inside the chat, where the guard rolls Tiptap's own rules back.
    const composer = document.querySelector('.consola-agent-ui .ProseMirror') as HTMLElement;
    expect(getComputedStyle(composer).whiteSpaceCollapse).toBe('break-spaces');

    first.unmount();
    expect(eachCopiedOnce()).toBe(true);

    second.unmount();
    expect(copies()).toEqual([]);
    expect(originals()).toHaveLength(2);
  } finally {
    later.remove();
  }
});

it('styles nothing outside the chat with the copies, even where the page rolls its rules back', async () => {
  await mountTwo();
  // An element of the page's, outside the chat, that Tiptap's rule matches, and a rule of the
  // page's that rolls its own unlayered rules back to its layers (as the chat's guard does): the
  // original is rolled back with it, and nothing of the chat's layer may answer instead.
  const outside = document.createElement('div');
  outside.className = 'ProseMirror sprocket-outside';
  outside.textContent = 'Acme';
  addToPage(outside);
  const rollback = document.createElement('style');
  rollback.textContent = '.sprocket-outside { white-space: revert-layer; }';
  addToPage(rollback);

  expect(eachCopiedOnce()).toBe(true);
  expect(getComputedStyle(outside).whiteSpaceCollapse).toBe('collapse');
});
