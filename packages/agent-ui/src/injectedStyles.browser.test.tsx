// The copies `src/injectedStyles.ts` keeps of the CSS t3's dependencies inject (AGENTS.md, "The
// page's CSS", runtime-injected CSS): one per injected style while any chat is mounted, at the end
// of `<head>`, with the original's nonce, a later injection picked up, all gone after the last
// chat unmounts, and none styling anything outside the chat. Base UI's, which React puts first in
// `<head>`, applies inside the chat as on t3's own page, under a page's layer named first.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, expect, it } from 'vite-plus/test';
import { COPY_ATTRIBUTE, copyTextOf, INJECTED_STYLES } from './injectedStyles.ts';
import { addToPage, answerOf, forgetStoredThreads, host, mountChat } from './testing/render.tsx';

beforeAll(forgetStoredThreads);

/** Legend List's style (`@legendapp/list`'s `ensureScrollbarHiddenStyle`), which it adds later. */
const LEGEND_LIST_STYLE =
  '.legend-list-scrollbar-y-hidden::-webkit-scrollbar:vertical{width:0;display:none;}.legend-list-scrollbar-x-hidden::-webkit-scrollbar:horizontal{height:0;display:none;}';

const originals = () => [...document.head.querySelectorAll<HTMLStyleElement>(INJECTED_STYLES)];
const copies = () => [...document.head.querySelectorAll<HTMLStyleElement>(`[${COPY_ATTRIBUTE}]`)];

/** The copy of `original`: the one whose text is the original's, in the chat's layer. */
const copyOf = (original: HTMLStyleElement) =>
  copies().find((copy) => copy.textContent === copyTextOf(original));

/** The chat's own stylesheets: those that name its layer, other than the copies. */
const chatSheets = () =>
  [...document.head.querySelectorAll<HTMLStyleElement>('style, link[rel="stylesheet"]')].filter(
    (element) =>
      !element.hasAttribute(COPY_ATTRIBUTE) &&
      [...(element.sheet?.cssRules ?? [])].some(
        (rule) => rule instanceof CSSLayerBlockRule && rule.name === 'consola-agent-ui',
      ),
  );

/** Whether `later` comes after `earlier` in the document. */
const follows = (later: Node, earlier: Node) =>
  (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

/**
 * Whether each injected style has one copy, after both its original and the chat's stylesheet
 * (where the chat's layer is first named, so the copy cannot move it).
 */
const eachCopiedOnce = () => {
  const made = copies();
  const sheets = chatSheets();
  return (
    sheets.length > 0 &&
    made.length === originals().length &&
    originals().every((original) => {
      const own = made.filter((copy) => copy.textContent === copyTextOf(original));
      return (
        own.length === 1 &&
        follows(own[0] as Node, original) &&
        sheets.every((sheet) => follows(own[0] as Node, sheet))
      );
    })
  );
};

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

/** Renders t3's own `ScrollArea` (Base UI's) into `parent`, with more content than it shows. */
const renderScrollArea = async (parent: HTMLElement) => {
  const { ScrollArea } = await import('~/components/ui/scroll-area');
  const container = document.createElement('div');
  container.style.cssText = 'width: 200px; height: 100px;';
  parent.append(container);
  const root = createRoot(container);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () =>
    root.render(
      <ScrollArea>
        <div style={{ width: 600, height: 400 }}>Acme's wide table</div>
      </ScrollArea>,
    ),
  );
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  const viewport = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
  if (viewport === null) throw new Error("t3's ScrollArea rendered no viewport");
  return {
    viewport,
    remove: () => {
      root.unmount();
      container.remove();
    },
  };
};

/** What hides a viewport's native scrollbars: Base UI's style sets both. */
const scrollbarOf = (viewport: HTMLElement) => ({
  scrollbarWidth: getComputedStyle(viewport).scrollbarWidth,
  webkitScrollbar: getComputedStyle(viewport, '::-webkit-scrollbar').display,
});

it("hides a Base UI scroll area's native scrollbars inside the chat, as on t3's own page", async () => {
  // A page's own layer, named before the chat's stylesheet loads (a Tailwind 4 page's), so it
  // is below the chat's layer, with a scrollbar rule for every element. React puts Base UI's
  // style first in `<head>`, before it: a copy right after the original would name the chat's
  // layer first, below the page's, and this rule would win inside the chat.
  const pageLayer = document.createElement('style');
  pageLayer.textContent = '@layer sprocket-page { * { scrollbar-width: thin; } }';
  document.head.prepend(pageLayer);
  const areas: Array<{ remove(): void }> = [];
  try {
    const { hostUrl, pass, sessionId, assistantText } = host();
    await mountChat({ hostUrl, pass, sessionId });
    await expect.element(answerOf(assistantText)).toBeVisible();
    const theme = document.querySelector('.consola-agent-ui-theme') as HTMLElement;
    const inside = await renderScrollArea(theme);
    areas.push(inside);
    // Outside the chat, as on t3's own page: Base UI's unlayered style over the page's layer.
    const page = document.createElement('div');
    addToPage(page);
    const outside = await renderScrollArea(page);
    areas.push(outside);

    const baseUi = document.head.querySelector<HTMLStyleElement>(
      'style[data-href="base-ui-disable-scrollbar"]',
    );
    expect(baseUi?.compareDocumentPosition(pageLayer)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(scrollbarOf(outside.viewport)).toEqual({
      scrollbarWidth: 'none',
      webkitScrollbar: 'none',
    });
    await expect.poll(() => scrollbarOf(inside.viewport)).toEqual(scrollbarOf(outside.viewport));
  } finally {
    for (const area of areas) area.remove();
    pageLayer.remove();
  }
});

it('keeps one copy of each injected style while a chat is mounted, and none after the last', async () => {
  const { first, second } = await mountTwo();
  // Tiptap's, injected as the first composer was created.
  expect(originals().some((style) => style.hasAttribute('data-tiptap-style'))).toBe(true);
  const injected = originals().length;
  expect(eachCopiedOnce()).toBe(true);

  // A dependency that injects once the chats are up (Legend List, for a list that hides its
  // scrollbar) is copied too.
  // Its nonce, which a page's nonce-based `style-src` checks, goes with its copy.
  const later = document.createElement('style');
  later.id = 'legend-list-scrollbar-axis-hidden-style';
  later.nonce = 'sprocket-nonce';
  later.textContent = LEGEND_LIST_STYLE;
  document.head.append(later);
  try {
    await expect.poll(() => copyOf(later)).toBeDefined();
    expect(originals()).toHaveLength(injected + 1);
    expect(eachCopiedOnce()).toBe(true);
    expect(copyOf(later)?.textContent).toContain('legend-list-scrollbar-y-hidden');
    expect(copyOf(later)?.nonce).toBe('sprocket-nonce');

    // The copies apply inside the chat, where the guard rolls Tiptap's own rules back.
    const composer = document.querySelector('.consola-agent-ui .ProseMirror') as HTMLElement;
    expect(getComputedStyle(composer).whiteSpaceCollapse).toBe('break-spaces');

    first.unmount();
    expect(eachCopiedOnce()).toBe(true);

    second.unmount();
    expect(copies()).toEqual([]);
    expect(originals()).toHaveLength(injected + 1);
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
