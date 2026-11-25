// The chat's own layout, in a default box and as Consola Cloud's session page lays it out: no
// header bar of t3's, a box the chat fills and scrolls inside, and popups that leave the page as it
// was. A file of its own: it resizes the window and stands in for the page's WebSocket.
import { afterAll, afterEach, beforeAll, expect, it } from 'vite-plus/test';
import { page, server, userEvent } from 'vite-plus/test/browser';
import { cloudWebSessionPage } from './testing/embeddingPages.ts';
import { addToPage, answerOf, forgetStoredThreads, host, mountChat } from './testing/render.tsx';

beforeAll(forgetStoredThreads);

/** The commands `vite.config.ts` defines for these tests. */
type NoiseCommands = {
  watchPageNoise(): Promise<void>;
  takePageNoise(): Promise<string[]>;
};
const noise = server.commands as unknown as NoiseCommands;

/**
 * What the host sends the page, each message as text: t3's client makes each socket with the
 * page's `WebSocket` (Effect's `layerWebSocketConstructorGlobal`), so a page's own stands in for it.
 */
const received: string[] = [];
const NativeWebSocket = globalThis.WebSocket;
class RecordingWebSocket extends NativeWebSocket {
  constructor(...args: ConstructorParameters<typeof WebSocket>) {
    super(...args);
    this.addEventListener('message', ({ data }) => {
      if (typeof data === 'string') received.push(data);
    });
  }
}
beforeAll(() => {
  globalThis.WebSocket = RecordingWebSocket;
});
afterAll(() => {
  globalThis.WebSocket = NativeWebSocket;
});

/** What a test changed on the page beyond `addToPage`, undone as it ends. */
const undo: Array<() => void> = [];
afterEach(() => {
  for (const step of undo.splice(0).reverse()) step();
});

/**
 * Mounts the chat in Consola Cloud's page for a running session, in a window of `width` by
 * `height`: cloud-web's stylesheets first in `<head>`, as its entry loads them before the chat's,
 * and the chat in `SessionChat`'s frame. Answers the frame and the page's own parts.
 */
const mountInSessionPage = async (width: number, height: number) => {
  const { hostUrl, pass, sessionId, assistantText } = host();
  await page.viewport(width, height);
  const sessionPage = await cloudWebSessionPage();
  const styles = sessionPage.rules.map((rules) => {
    const style = document.createElement('style');
    style.textContent = rules;
    return style;
  });
  document.head.prepend(...styles);
  undo.push(() => {
    for (const style of styles) style.remove();
  });
  const around = document.createElement('div');
  for (const [name, value] of Object.entries(sessionPage.around)) around.setAttribute(name, value);
  around.innerHTML = sessionPage.markup;
  addToPage(around);
  const slot = around.querySelector<HTMLElement>('.session-chat');
  if (slot === null) throw new Error("The session page's markup has no .session-chat.");
  await mountChat({ hostUrl, pass, sessionId }, { parent: slot, className: 'session-chat-frame' });
  await expect.element(answerOf(assistantText)).toBeVisible();
  const part = (selector: string) => {
    const element = around.querySelector<HTMLElement>(selector);
    if (element === null) throw new Error(`The session page has no ${selector}.`);
    return element;
  };
  return {
    frame: part('.session-chat-frame'),
    sidebar: part('.sidebar'),
    header: part('.session-header'),
    warning: part('.session-warning'),
  };
};

/** An element of the chat, which must be there. */
const chatPart = (selector: string): HTMLElement => {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`The chat has no ${selector}.`);
  return element;
};

/** Where an element is in the window, rounded to the pixel. */
const placeOf = (element: Element) => {
  const { top, left, width, height } = element.getBoundingClientRect();
  return {
    top: Math.round(top),
    left: Math.round(left),
    width: Math.round(width),
    height: Math.round(height),
  };
};

/** Whether `inner` lies inside `outer`, to the pixel. */
const inside = (inner: Element, outer: Element) => {
  const a = inner.getBoundingClientRect();
  const b = outer.getBoundingClientRect();
  return (
    a.top >= b.top - 0.5 &&
    a.bottom <= b.bottom + 0.5 &&
    a.left >= b.left - 0.5 &&
    a.right <= b.right + 0.5
  );
};

it('shows no header bar of its own: no thread title, no panel toggles', async () => {
  const { hostUrl, pass, sessionId, assistantText, threadTitle } = host();
  await mountChat({ hostUrl, pass, sessionId });
  await expect.element(answerOf(assistantText)).toBeVisible();

  const root = chatPart('.consola-agent-ui');
  // t3's header: the project's badge and name, the thread's title, and the panel toggles.
  for (const element of root.querySelectorAll(
    '[data-chat-header], [data-workspace-titlebar-controls], [data-panel-layout-controls]',
  )) {
    expect(element.checkVisibility(), element.outerHTML.slice(0, 120)).toBe(false);
  }
  const titles = [...root.querySelectorAll('*')].filter(
    (element) => element.childElementCount === 0 && element.textContent === threadTitle,
  );
  for (const title of titles) expect(title.checkVisibility()).toBe(false);
  // The conversation starts at the chat's top edge, with no bar's room kept above it.
  expect(placeOf(chatPart('[data-chat-workspace-drop-target]')).top).toBe(placeOf(root).top);
});

it("fills its box on cloud-web's session page, where a conversation taller than the box scrolls under the composer", async () => {
  // The shortest window the session page keeps its height in (`.session-page`'s `min-height`),
  // with the page's root font size up, which the chat follows (AGENTS.md, "What still reaches the
  // chat"): the conversation is taller than the chat's box.
  document.documentElement.style.fontSize = '24px';
  undo.push(() => document.documentElement.style.removeProperty('font-size'));
  const { frame } = await mountInSessionPage(1280, 560);

  const root = chatPart('.consola-agent-ui');
  const theme = chatPart('.consola-agent-ui-theme');
  const view = theme.firstElementChild;
  expect(view).not.toBeNull();
  // The chat, the theme element and t3's view are the frame's size, not the window's or the
  // conversation's.
  for (const element of [root, theme, view as Element]) {
    expect(placeOf(element), String((element as HTMLElement).className)).toEqual(placeOf(frame));
  }

  const composer = chatPart('[data-chat-composer-overlay]');
  const editor = chatPart('[data-chat-composer-overlay] [contenteditable="true"]');
  expect(inside(composer, frame)).toBe(true);
  expect(inside(editor, frame)).toBe(true);
  expect(editor.checkVisibility()).toBe(true);

  // t3's message list scrolls inside the box: the conversation is taller than it.
  const list = chatPart('.messages-timeline-scroll');
  expect(inside(list, frame)).toBe(true);
  expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
  const before = list.scrollTop;
  await userEvent.wheel(list, { delta: { y: before > 0 ? -400 : 400 } });
  await expect.poll(() => list.scrollTop).not.toBe(before);
  // Nothing else moved: the page itself does not scroll.
  expect(document.scrollingElement?.scrollTop).toBe(0);
  expect(theme.scrollTop).toBe(0);
});

it("keeps the chat and cloud-web's session page in place when a model is picked, and the host takes the pick", async () => {
  const parts = await mountInSessionPage(1280, 720);
  await noise.watchPageNoise();
  await noise.takePageNoise();
  const pagePlaces = () => ({
    scrolled: document.scrollingElement?.scrollTop,
    height: document.documentElement.scrollHeight,
    sidebar: placeOf(parts.sidebar),
    header: placeOf(parts.header),
    warning: placeOf(parts.warning),
    frame: placeOf(parts.frame),
    chat: placeOf(chatPart('.consola-agent-ui')),
    theme: placeOf(chatPart('.consola-agent-ui-theme')),
  });
  const before = pagePlaces();
  expect(before.scrolled).toBe(0);
  expect(before.height).toBe(window.innerHeight);
  expect(before.chat).toEqual(before.frame);

  const trigger = chatPart('[data-chat-provider-model-picker]');
  const pick = trigger.textContent?.includes('Sonnet 5.5')
    ? { name: 'Haiku 5.5', model: 'claude-haiku-5-5' }
    : { name: 'Sonnet 5.5', model: 'claude-sonnet-5-5' };
  await userEvent.click(trigger);
  const picker = chatPart('[data-model-picker-content]');
  await expect.element(picker).toBeVisible();
  // The host serves the session's own provider, so the picker lists its models alone.
  const models = [...picker.querySelectorAll('[role="option"]')]
    .map((option) => option.textContent ?? '')
    .filter((text) => text.includes(','));
  expect(models.length).toBeGreaterThan(0);
  for (const model of models) expect(model).toMatch(/, Claude$/);
  expect(pagePlaces()).toEqual(before);
  expect(inside(picker, document.documentElement)).toBe(true);

  const sentFrom = received.length;
  const option = [...picker.querySelectorAll<HTMLElement>('[role="option"]')].find((element) =>
    element.textContent?.startsWith(`Claude ${pick.name},`),
  );
  expect(option, `no option for ${pick.name}`).toBeDefined();
  await userEvent.click(option as HTMLElement);
  // The host applied it: its thread now runs on the model picked.
  await expect
    .poll(() =>
      received
        .slice(sentFrom)
        .some(
          (message) =>
            message.includes('"type":"thread.model-selection-updated"') &&
            message.includes(`"model":"${pick.model}"`),
        ),
    )
    .toBe(true);
  expect(pagePlaces()).toEqual(before);
  for (const popup of document.querySelectorAll('[data-model-picker-content]')) {
    expect(inside(popup, document.documentElement)).toBe(true);
  }

  await userEvent.keyboard('{Escape}');
  await expect.poll(() => document.querySelector('[data-model-picker-content]')).toBeNull();
  // The trigger names the model, then its effort.
  await expect.poll(() => trigger.textContent).toContain(pick.name);
  expect(pagePlaces()).toEqual(before);
  expect(await noise.takePageNoise()).toEqual([]);
});
