// Review Focus 2: the CSS of the page that embeds the chat does not reach inside it. Each page's
// own stylesheets (`src/testing/embeddingPages.ts`, read from the files those pages load) go on
// and off around one mounted chat, and every element of the chat and its popups must compute
// every property alike with them and without them, at rest, hovered and focused, and its root
// keep its containment. And on a page with no CSS, the guard and the floor that keep the page's
// CSS out change nothing of t3's own.
import { beforeAll, expect, it } from 'vite-plus/test';
import type { TestContext } from 'vite-plus/test';
import { userEvent } from 'vite-plus/test/browser';
import {
  barePage,
  cloudWebPage,
  desktopPage,
  reachingPage,
  tailwind4Page,
  tailwindPage,
} from './testing/embeddingPages.ts';
import type { EmbeddingPage } from './testing/embeddingPages.ts';
import { addToPage, answerOf, forgetStoredThreads, host, mountChat } from './testing/render.tsx';

beforeAll(forgetStoredThreads);

/**
 * The computed properties not compared, because they are not the same from one reading to the
 * next on any page: none yet. Custom properties are not compared either (a page's own inherit
 * in, and t3 reads only its own); what t3 computes from its registered ones is.
 */
const UNCOMPARED = new Set<string>([]);

/** The root's own properties that are the chat's, not the page's: what keeps the chat in its box. */
const ROOT_PROPERTIES = ['contain', 'height'] as const;

/** What a popup's portal computes from its size, which the page's layout sets (above). */
const PORTAL_SIZED = [
  'width',
  'height',
  'block-size',
  'inline-size',
  'perspective-origin',
  'transform-origin',
];

/** The pseudo-elements a reset reaches (Tailwind's `*, ::before, ::after`, `::placeholder`). */
const PSEUDO_ELEMENTS = ['::before', '::after', '::placeholder'] as const;

/**
 * A scroll container's scrollbar, which a page styles (the desktop's `global.css` sets its width,
 * track and thumb). Read as computed styles: Vitest's Chromium runs headless with
 * `--hide-scrollbars`, so a drawn scrollbar's width is always 0, whatever the CSS says.
 */
const SCROLLBAR_PSEUDO_ELEMENTS = [
  '::-webkit-scrollbar',
  '::-webkit-scrollbar-track',
  '::-webkit-scrollbar-thumb',
] as const;

const SCROLLS = /^(auto|scroll|overlay)$/;

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

/** Every computed property of an element, but `UNCOMPARED` and custom properties. */
const stylesOf = (element: Element, pseudo?: string): Styles => {
  const computed = getComputedStyle(element, pseudo);
  const styles: Styles = {};
  for (let index = 0; index < computed.length; index++) {
    const name = computed.item(index);
    if (!name.startsWith('--') && !UNCOMPARED.has(name)) {
      styles[name] = computed.getPropertyValue(name);
    }
  }
  return styles;
};

/**
 * What the chat computes, element by element: its styles, each pseudo-element's that is there
 * (`content` other than `none`, or an input's placeholder), and, for a scroll container, its
 * scrollbar's, track's and thumb's; and the root's containment and height. A popup's portal is a
 * block in the page's `<body>`, so its own size is the page's layout (a `body { margin: 0 }`
 * widens it); what is in it is the chat's.
 */
const readChat = (): Record<string, Styles> => {
  const read: Record<string, Styles> = {};
  const root = document.querySelector('.consola-agent-ui');
  if (root === null) throw new Error("no chat's root on the page");
  const rootStyle = getComputedStyle(root);
  read.root = Object.fromEntries(
    ROOT_PROPERTIES.map((name) => [name, rootStyle.getPropertyValue(name)]),
  );
  chatElements().forEach((element, index) => {
    const name = nameOf(element, index);
    const laidOutByPage = element.matches('[data-base-ui-portal]') ? PORTAL_SIZED : [];
    const styles = stylesOf(element);
    read[name] = Object.fromEntries(
      Object.entries(styles).filter(([property]) => !laidOutByPage.includes(property)),
    );
    for (const pseudo of PSEUDO_ELEMENTS) {
      const shown =
        pseudo === '::placeholder'
          ? element.matches('input[placeholder], textarea[placeholder]')
          : getComputedStyle(element, pseudo).content !== 'none';
      if (shown) read[`${name}${pseudo}`] = stylesOf(element, pseudo);
    }
    if (SCROLLS.test(styles['overflow-x'] ?? '') || SCROLLS.test(styles['overflow-y'] ?? '')) {
      for (const pseudo of SCROLLBAR_PSEUDO_ELEMENTS) {
        read[`${name}${pseudo}`] = stylesOf(element, pseudo);
      }
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

/** How many times the three readings are taken at most, while t3 changes what it shows. */
const ATTEMPTS = 5;

/** What a test says about itself: Vitest's annotations, which reporters show with the test. */
type Annotate = TestContext['annotate'];

/**
 * Reads the chat without a change, with it, and without it again. A reading with it counts only
 * between two without it that agree, so that nothing but the change changed in between (t3 may
 * still change what it shows; then the three are read again). The test says how often it had to
 * (an annotation, which the reporters show with the test, passed or not: `--reporter=verbose`
 * locally, a notice on GitHub).
 */
const compareReadings = async (
  annotate: Annotate,
  readings: {
    readonly without: () => Promise<States>;
    readonly with: () => Promise<States>;
  },
) => {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    await quietChat();
    const before = await readings.without();
    const changed = await readings.with();
    const after = await readings.without();
    const drift = compareStates(before, after);
    if (JSON.stringify(drift) === JSON.stringify(UNCHANGED)) {
      if (attempt > 1) await annotate(`read alike on attempt ${attempt} of ${ATTEMPTS}`, 'retry');
      return compareStates(before, changed);
    }
    await annotate(
      `attempt ${attempt} of ${ATTEMPTS}: t3's chat changed between the two readings without the change: ${JSON.stringify(drift).slice(0, 600)}`,
      'retry',
    );
  }
  throw new Error("t3's chat changed between every two readings without the change");
};

/**
 * Mounts the chat inside the page's element (a box of a fixed size, so the page's own layout
 * does not resize it), with the page's tokens, and adds a popup.
 */
const mountOn = async (page: EmbeddingPage) => {
  const { hostUrl, pass, sessionId, assistantText } = host();
  for (const style of styleElements(page.tokens)) addToPage(style);
  const around = document.createElement('div');
  for (const [name, value] of Object.entries(page.around)) around.setAttribute(name, value);
  around.style.cssText = 'position: fixed; inset: 0 auto auto 0; width: 960px; height: 720px;';
  addToPage(around);
  await mountChat({ hostUrl, pass, sessionId }, { parent: around });
  await expect.element(answerOf(assistantText)).toBeVisible();
  return addPopup();
};

/**
 * Compares the chat on `page` with its rules and without them, where they load (before the chat's
 * stylesheet or after it). The page's root font size is held in every reading: t3 sizes in `rem`
 * and measures `document.documentElement` (`ComposerCommandMenuLayer.tsx`,
 * `useTallEnoughToFold.ts`), so the chat follows the root size a page picks (the desktop's 14px),
 * as t3 follows it in its own window.
 */
const compareOn = async (annotate: Annotate, page: EmbeddingPage) => {
  const popup = await mountOn(page);
  const html = document.documentElement;
  const inline = html.style.fontSize;
  const rules = styleElements(page.rules);
  const load = () =>
    page.first === true ? document.head.prepend(...rules) : document.head.append(...rules);
  load();
  const rootFontSize = getComputedStyle(html).fontSize;
  for (const style of rules) style.remove();

  return compareReadings(annotate, {
    without: async () => {
      html.style.fontSize = rootFontSize;
      try {
        return await readStates(popup);
      } finally {
        html.style.fontSize = inline;
      }
    },
    with: async () => {
      load();
      try {
        return await readStates(popup);
      } finally {
        for (const style of rules) style.remove();
      }
    },
  });
};

/** Whether a stylesheet is the chat's: its rules are in the chat's layer. */
const isChatSheet = (sheet: CSSStyleSheet) =>
  [...sheet.cssRules].some(
    (rule) => rule instanceof CSSLayerBlockRule && rule.name === 'consola-agent-ui',
  );

/**
 * Turns the page's CSS into t3's own cascade, as on a page of t3's, and returns what turns it
 * back. The guard's rules (the chat's unlayered ones) and the floor's (its layer's `reset`
 * sublayer) go. So does every other stylesheet on this page without CSS of its own, which t3's
 * dependencies injected (Tiptap's): on t3's own page it is unlayered beside t3's unlayered rules,
 * which here are the chat layer's own, so it goes into the chat layer too, as it is
 * (`AgentChat`'s copies of it go, with the guard they are for).
 */
const t3sOwnCascade = () => {
  const undo: Array<() => void> = [];
  const take = (parent: CSSStyleSheet | CSSGroupingRule, test: (rule: CSSRule) => boolean) => {
    const taken = [...parent.cssRules].flatMap((rule, index) =>
      test(rule) ? [{ index, text: rule.cssText }] : [],
    );
    for (const { index } of [...taken].reverse()) parent.deleteRule(index);
    undo.push(() => {
      for (const { index, text } of taken) parent.insertRule(text, index);
    });
    return taken.length;
  };
  let guards = 0;
  let floors = 0;
  for (const element of document.querySelectorAll<HTMLStyleElement | HTMLLinkElement>(
    'style, link[rel="stylesheet"]',
  )) {
    const sheet = element.sheet;
    if (sheet === null) continue;
    if (element.hasAttribute('data-consola-agent-ui-copy')) {
      sheet.disabled = true;
      undo.push(() => {
        sheet.disabled = false;
      });
    } else if (isChatSheet(sheet)) {
      guards += take(
        sheet,
        (rule) =>
          rule instanceof CSSStyleRule && rule.selectorText.includes('#consola-agent-ui-guard'),
      );
      for (const rule of sheet.cssRules) {
        if (!(rule instanceof CSSLayerBlockRule) || rule.name !== 'consola-agent-ui') continue;
        for (const sublayer of rule.cssRules) {
          if (sublayer instanceof CSSLayerBlockRule && sublayer.name === 'reset') {
            floors += take(sublayer, () => true);
          }
        }
      }
    } else {
      const layered = document.createElement('style');
      layered.textContent = `@layer consola-agent-ui {\n${[...sheet.cssRules].map((rule) => rule.cssText).join('\n')}\n}`;
      element.after(layered);
      sheet.disabled = true;
      undo.push(() => {
        layered.remove();
        sheet.disabled = false;
      });
    }
  }
  const back = () => {
    for (const step of undo.reverse()) step();
  };
  if (guards === 0 || floors === 0) {
    back();
    throw new Error(`the chat's stylesheet has ${guards} guard rules and ${floors} floor rules`);
  }
  return back;
};

/** Three readings of every element of the chat, five times over at worst, on a loaded machine. */
const TIMEOUT = 300_000;

it("keeps the chat as on a bare page under Consola desktop's global CSS", {
  timeout: TIMEOUT,
}, async ({ annotate }) => {
  expect(await compareOn(annotate, await desktopPage())).toEqual(UNCHANGED);
});

it("keeps the chat as on a bare page under cloud-web's Radix Themes and its own CSS", {
  timeout: TIMEOUT,
}, async ({ annotate }) => {
  expect(await compareOn(annotate, await cloudWebPage())).toEqual(UNCHANGED);
});

it("keeps the chat as on a bare page under Tailwind's unlayered resets", {
  timeout: TIMEOUT,
}, async ({ annotate }) => {
  expect(await compareOn(annotate, await tailwindPage())).toEqual(UNCHANGED);
});

it("keeps the chat as on a bare page under a Tailwind 4 page's layers, and its container's inherited properties", {
  timeout: TIMEOUT,
}, async ({ annotate }) => {
  expect(await compareOn(annotate, await tailwind4Page())).toEqual(UNCHANGED);
});

it("keeps the chat as on a bare page under rules with IDs, a page's direction, and rules on the root's containment", {
  timeout: TIMEOUT,
}, async ({ annotate }) => {
  expect(await compareOn(annotate, await reachingPage())).toEqual(UNCHANGED);
});

it("changes nothing of t3's own with the guard and the floor, on a page without CSS", {
  timeout: TIMEOUT,
}, async ({ annotate }) => {
  const popup = await mountOn(barePage);
  const result = await compareReadings(annotate, {
    without: async () => {
      const restore = t3sOwnCascade();
      try {
        return await readStates(popup);
      } finally {
        restore();
      }
    },
    with: () => readStates(popup),
  });
  expect(result).toEqual(UNCHANGED);
});
