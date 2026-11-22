// Review Focus 2: the CSS of the page that embeds the chat does not reach inside it. Each page's
// own stylesheets (`src/testing/embeddingPages.ts`, read from the files those pages load) go on
// and off around one mounted chat, and every element of the chat and its popups must compute the
// same spacing, fonts, sizes, colours, link styles, focus ring and scrollbars with them as
// without them.
import { beforeAll, expect, it } from 'vite-plus/test';
import { userEvent } from 'vite-plus/test/browser';
import {
  cloudWebPage,
  desktopPage,
  type EmbeddingPage,
  tailwindPage,
} from './testing/embeddingPages.ts';
import { addToPage, answerOf, forgetStoredThreads, host, mountChat } from './testing/render.tsx';

beforeAll(forgetStoredThreads);

/** What each element of the chat must compute alike on the page and on a bare one. */
const PROPERTIES = [
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-style',
  'border-top-color',
  'box-sizing',
  'width',
  'height',
  'display',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'color',
  'background-color',
  'text-decoration-line',
  'box-shadow',
  'outline-style',
  'outline-width',
  'outline-color',
  'outline-offset',
] as const;

/** The pseudo-elements a reset reaches (Tailwind's `*, ::before, ::after`, `::placeholder`). */
const PSEUDO_ELEMENTS = ['::before', '::after', '::placeholder'] as const;

/** Every element of the chat (its document stand-in and what is in it) and of its popups. */
const chatElements = () => [
  ...document.querySelectorAll<HTMLElement>(
    '.consola-agent-ui-theme, .consola-agent-ui-theme *, .consola-agent-ui-portal, .consola-agent-ui-portal *',
  ),
];

const nameOf = (element: Element, index: number) =>
  `${index}:${element.tagName.toLowerCase()}${[...element.classList]
    .slice(0, 3)
    .map((name) => `.${name}`)
    .join('')}`;

type Styles = Record<string, string>;

const stylesOf = (element: Element, pseudo?: string): Styles => {
  const computed = getComputedStyle(element, pseudo);
  return Object.fromEntries(PROPERTIES.map((name) => [name, computed.getPropertyValue(name)]));
};

/**
 * What the chat computes, element by element: its styles, each pseudo-element's that is there
 * (`content` other than `none`, or an input's placeholder), and the width of its scrollbars. A
 * popup's portal is a block in the page's `<body>`, so its own size is the page's layout (a
 * `body { margin: 0 }` widens it); what is in it is the chat's.
 */
const readChat = (): Record<string, Styles> => {
  const read: Record<string, Styles> = {};
  chatElements().forEach((element, index) => {
    const name = nameOf(element, index);
    const box = getComputedStyle(element);
    const borders =
      Number.parseFloat(box.borderLeftWidth) + Number.parseFloat(box.borderRightWidth);
    const laidOutByPage = element.matches('[data-base-ui-portal]') ? ['width', 'height'] : [];
    read[name] = {
      ...Object.fromEntries(
        Object.entries(stylesOf(element)).filter(([property]) => !laidOutByPage.includes(property)),
      ),
      scrollbar: String(element.offsetWidth - element.clientWidth - borders),
    };
    for (const pseudo of PSEUDO_ELEMENTS) {
      const shown =
        pseudo === '::placeholder'
          ? element.matches('input[placeholder], textarea[placeholder]')
          : getComputedStyle(element, pseudo).content !== 'none';
      if (shown) read[`${name}${pseudo}`] = stylesOf(element, pseudo);
    }
  });
  return read;
};

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));

/** What the chat computes once it stops changing (t3 measures and lays out after a style change). */
const settledChat = async (): Promise<Record<string, Styles>> => {
  let last = JSON.stringify(readChat());
  for (let attempt = 0; attempt < 40; attempt++) {
    await frame();
    await frame();
    const next = JSON.stringify(readChat());
    if (next === last) return JSON.parse(next) as Record<string, Styles>;
    last = next;
  }
  throw new Error('the chat kept changing');
};

/** Each property of each element that differs, `bare → embedded`, the first 40 of them. */
const differences = (bare: Record<string, Styles>, embedded: Record<string, Styles>) => {
  const found: string[] = [];
  const names = new Set([...Object.keys(bare), ...Object.keys(embedded)]);
  for (const name of names) {
    const before = bare[name];
    const after = embedded[name];
    if (before === undefined || after === undefined) {
      found.push(`${name}: ${before === undefined ? 'only on the page' : 'only on a bare page'}`);
      continue;
    }
    for (const property of Object.keys(before)) {
      if (before[property] !== after[property]) {
        found.push(`${name} ${property}: ${before[property]} → ${after[property]}`);
      }
    }
  }
  return { count: found.length, first: found.slice(0, 40) };
};

const styleElements = (sheets: ReadonlyArray<string>) =>
  sheets.map((css) => {
    const style = document.createElement('style');
    style.textContent = css;
    return style;
  });

/**
 * A popup of the chat's, as Base UI puts one at the end of `<body>`, which `AgentChat` marks as the
 * chat's: a panel with a button and a link in t3's utilities, where the pointer can rest on them.
 */
const addPopup = () => {
  const popup = document.createElement('div');
  popup.setAttribute('data-base-ui-portal', '');
  popup.innerHTML = `
    <div class="fixed right-4 bottom-4 flex flex-col gap-2 rounded-lg border bg-popover p-3 text-sm shadow-lg">
      <button type="button" class="rounded-md border px-2 py-1 text-xs font-medium">Sprocket</button>
      <a href="https://acme.example/">Acme's dashboard</a>
    </div>`;
  addToPage(popup);
  return {
    button: popup.querySelector('button') as HTMLButtonElement,
    link: popup.querySelector('a') as HTMLAnchorElement,
  };
};

/**
 * What the chat computes in three states, on whatever page is around it: at rest, with a link of
 * its own hovered, and with its composer focused from the keyboard (`:focus-visible`).
 */
const readStates = async (popup: ReturnType<typeof addPopup>) => {
  const rest = await settledChat();
  await userEvent.hover(popup.link);
  const hovered = await settledChat();
  await userEvent.unhover(popup.link);
  const composer = document.querySelector<HTMLElement>(
    '.consola-agent-ui-theme [contenteditable="true"]',
  );
  if (composer === null) throw new Error("no composer in t3's chat");
  composer.focus({ focusVisible: true } as FocusOptions);
  const composerFocused = await settledChat();
  popup.button.focus({ focusVisible: true } as FocusOptions);
  const buttonFocused = await settledChat();
  popup.button.blur();
  await settledChat();
  return { rest, hovered, composerFocused, buttonFocused };
};

const pause = (milliseconds: number) => new Promise<void>((done) => setTimeout(done, milliseconds));

/**
 * Waits until what the chat shows (its elements and their text) has not changed for two
 * seconds: t3 goes on loading the thread's details after the answer shows.
 */
const quietChat = async () => {
  const shape = () =>
    `${chatElements().map(nameOf).join('|')}#${document.querySelector('.consola-agent-ui-theme')?.textContent?.length}`;
  const start = performance.now();
  let last = shape();
  let since = start;
  while (performance.now() - since < 2000) {
    if (performance.now() - start > 30_000) throw new Error("t3's chat kept changing");
    await pause(100);
    const next = shape();
    if (next !== last) {
      last = next;
      since = performance.now();
    }
  }
};

type States = Awaited<ReturnType<typeof readStates>>;

const compareStates = (bare: States, embedded: States) => ({
  rest: differences(bare.rest, embedded.rest),
  hovered: differences(bare.hovered, embedded.hovered),
  composerFocused: differences(bare.composerFocused, embedded.composerFocused),
  buttonFocused: differences(bare.buttonFocused, embedded.buttonFocused),
});

const NONE = { count: 0, first: [] };
const UNCHANGED = { rest: NONE, hovered: NONE, composerFocused: NONE, buttonFocused: NONE };

/**
 * Mounts the chat inside the page's element (a box of a fixed size, so the page's own layout
 * does not resize it), then reads it without the page's rules, with them, and without them again.
 * A reading with them counts only between two without that agree, so that nothing but the page's
 * CSS changed in between (t3 may still change what it shows; then the three are read again). The
 * page's root font size is held in every reading: t3 sizes in `rem` and measures
 * `document.documentElement` (`ComposerCommandMenuLayer.tsx`, `useTallEnoughToFold.ts`), so the
 * chat follows the root size a page picks (the desktop's 14px), as t3 follows it in its own window.
 */
const compareOn = async (page: EmbeddingPage) => {
  const { hostUrl, pass, sessionId, assistantText } = host();
  for (const style of styleElements(page.tokens)) addToPage(style);
  const around = document.createElement('div');
  for (const [name, value] of Object.entries(page.around)) around.setAttribute(name, value);
  around.style.cssText = 'position: fixed; inset: 0 auto auto 0; width: 960px; height: 720px;';
  addToPage(around);
  await mountChat({ hostUrl, pass, sessionId }, { parent: around });
  await expect.element(answerOf(assistantText)).toBeVisible();
  const popup = addPopup();

  const html = document.documentElement;
  const inline = html.style.fontSize;
  const rules = styleElements(page.rules);
  document.head.append(...rules);
  const rootFontSize = getComputedStyle(html).fontSize;
  for (const style of rules) style.remove();

  const readBare = async () => {
    html.style.fontSize = rootFontSize;
    try {
      return await readStates(popup);
    } finally {
      html.style.fontSize = inline;
    }
  };
  const readEmbedded = async () => {
    document.head.append(...rules);
    try {
      return await readStates(popup);
    } finally {
      for (const style of rules) style.remove();
    }
  };

  for (let attempt = 0; attempt < 5; attempt++) {
    await quietChat();
    const before = await readBare();
    const embedded = await readEmbedded();
    const after = await readBare();
    const drift = compareStates(before, after);
    if (JSON.stringify(drift) === JSON.stringify(UNCHANGED)) return compareStates(before, embedded);
  }
  throw new Error("t3's chat changed between every two readings without the page's CSS");
};

/** Three readings of every element of the chat, five times over at worst, on a loaded machine. */
const TIMEOUT = 300_000;

it("keeps the chat as on a bare page under Consola desktop's global CSS", {
  timeout: TIMEOUT,
}, async () => {
  expect(await compareOn(await desktopPage())).toEqual(UNCHANGED);
});

it("keeps the chat as on a bare page under cloud-web's Radix Themes and its own CSS", {
  timeout: TIMEOUT,
}, async () => {
  expect(await compareOn(await cloudWebPage())).toEqual(UNCHANGED);
});

it("keeps the chat as on a bare page under Tailwind's unlayered resets", {
  timeout: TIMEOUT,
}, async () => {
  expect(await compareOn(await tailwindPage())).toEqual(UNCHANGED);
});
