import { commands } from 'vite-plus/test/browser';

/**
 * A page that embeds the chat, for `AgentChat.pageCss.browser.test.tsx`: the CSS it loads, read
 * from the files the page itself loads (never a copy of them), and the element the chat sits in.
 */
export interface EmbeddingPage {
  /** What the page carries without its rules: custom properties only (the desktop's tokens). */
  readonly tokens: readonly string[];
  /** The page's rules, in the order it loads them. */
  readonly rules: readonly string[];
  /** The attributes of the element the page puts around the chat. */
  readonly around: Readonly<Record<string, string>>;
  /**
   * Whether the page's stylesheets come before the chat's in the document, as a page's own CSS
   * usually loads first. Then the layers it names are below the chat's. Otherwise they come
   * after it, where a page rule that ties the guard's weight would win.
   */
  readonly first?: boolean;
}

/** Paths are the package's: Vitest's `readFile` command resolves them from its root. */
const read = (path: string) => commands.readFile(path);

/**
 * Consola desktop's renderer (`apps/desktop/src/renderer/main.tsx`): its theme tokens on
 * `[data-theme]`, then `global.css`, whose unlayered `*` reset, `button`, `a`, `:focus-visible`
 * and scrollbar rules apply to every element of the page.
 */
export const desktopPage = async (): Promise<EmbeddingPage> => ({
  tokens: await Promise.all([
    read('../../apps/desktop/src/renderer/styles/themes/tokens.css'),
    read('../../apps/desktop/src/renderer/styles/themes/light.css'),
  ]),
  rules: [await read('../../apps/desktop/src/renderer/styles/global.css')],
  around: { 'data-theme': 'light' },
});

/**
 * Consola Cloud's web app (`apps/cloud-web/src/main.tsx`): Radix Themes' stylesheet, from
 * cloud-web's own `node_modules`, and cloud-web's `ui/styles.css`, with the chat inside the
 * element Radix's `<Theme accentColor="cyan" grayColor="slate">` renders.
 */
export const cloudWebPage = async (): Promise<EmbeddingPage> => ({
  tokens: [],
  rules: await Promise.all([
    read('../../apps/cloud-web/node_modules/@radix-ui/themes/styles.css'),
    read('../../apps/cloud-web/src/ui/styles.css'),
  ]),
  around: {
    class: 'radix-themes light',
    'data-is-root-theme': 'true',
    'data-accent-color': 'cyan',
    'data-gray-color': 'slate',
    'data-has-background': 'true',
    'data-panel-background': 'translucent',
    'data-radius': 'medium',
    'data-scaling': '100%',
  },
});

/**
 * Tailwind 3's per-element defaults, which its `@tailwind base` emits unlayered on every page
 * that uses it (Tailwind CSS v3.4, MIT): the same `--tw-*` names Tailwind 4 (t3's) reads, set on
 * every element.
 */
const TAILWIND_3_DEFAULTS = `
*, ::before, ::after, ::backdrop {
  --tw-border-spacing-x: 0; --tw-border-spacing-y: 0;
  --tw-translate-x: 0; --tw-translate-y: 0; --tw-rotate: 0; --tw-skew-x: 0; --tw-skew-y: 0;
  --tw-scale-x: 1; --tw-scale-y: 1;
  --tw-pan-x: ; --tw-pan-y: ; --tw-pinch-zoom: ; --tw-scroll-snap-strictness: proximity;
  --tw-gradient-from-position: ; --tw-gradient-via-position: ; --tw-gradient-to-position: ;
  --tw-ordinal: ; --tw-slashed-zero: ; --tw-numeric-figure: ; --tw-numeric-spacing: ;
  --tw-numeric-fraction: ;
  --tw-ring-inset: ; --tw-ring-offset-width: 0px; --tw-ring-offset-color: #fff;
  --tw-ring-color: rgb(59 130 246 / 0.5); --tw-ring-offset-shadow: 0 0 #0000;
  --tw-ring-shadow: 0 0 #0000; --tw-shadow: 0 0 #0000; --tw-shadow-colored: 0 0 #0000;
  --tw-blur: ; --tw-brightness: ; --tw-contrast: ; --tw-grayscale: ; --tw-hue-rotate: ;
  --tw-invert: ; --tw-saturate: ; --tw-sepia: ; --tw-drop-shadow: ;
  --tw-backdrop-blur: ; --tw-backdrop-brightness: ; --tw-backdrop-contrast: ;
  --tw-backdrop-grayscale: ; --tw-backdrop-hue-rotate: ; --tw-backdrop-invert: ;
  --tw-backdrop-opacity: ; --tw-backdrop-saturate: ; --tw-backdrop-sepia: ;
  --tw-contain-size: ; --tw-contain-layout: ; --tw-contain-paint: ; --tw-contain-style: ;
}
`;

/**
 * A page with Tailwind's resets unlayered, as a Tailwind 3 page has them (or one that imports
 * `tailwindcss/preflight.css` without a layer): Tailwind's own preflight, from this package's
 * `node_modules`, and Tailwind 3's per-element defaults.
 */
export const tailwindPage = async (): Promise<EmbeddingPage> => ({
  tokens: [],
  rules: [await read('node_modules/tailwindcss/preflight.css'), TAILWIND_3_DEFAULTS],
  around: {},
});

/**
 * What a Tailwind 4 page with shadcn's base has on every element, in its own layers, named before
 * the chat's stylesheet loads, so they are below the chat's layer: a theme on `:root` (the same
 * custom property names as t3's), shadcn's `*` border and outline colours, a focus ring and a
 * paragraph style, and utilities named as t3's, with other values.
 */
const TAILWIND_4_BASE = `
@layer theme {
  :root, :host {
    --font-sans: "Comic Sans MS", cursive; --default-font-family: var(--font-sans);
    --spacing: 0.4rem; --text-xs: 0.9rem; --radius: 2rem; --color-zinc-25: rgb(255 0 0);
  }
}
@layer base {
  * { border-color: rgb(255 0 0); outline-color: rgb(0 128 0 / 0.5); }
  body { background-color: rgb(255 255 0); color: rgb(0 0 255); }
  :focus-visible { outline: 5px solid rgb(255 0 0); outline-offset: 3px; }
  p { text-decoration-line: line-through; }
  a:hover { text-decoration: underline wavy; }
  ::selection { background-color: rgb(255 0 255); }
  ::placeholder { color: rgb(255 0 0); }
}
@layer utilities {
  .flex { display: flex; gap: 9px; }
  .font-medium { font-weight: 900; }
  .text-sm { font-size: 30px; line-height: 3; }
  .rounded-lg { border-radius: 0; }
  .shadow-lg { box-shadow: 0 0 20px red; }
  .border { border-width: 4px; }
  .sprocket-shell {
    font-weight: 700; font-style: italic; font-size: 22px; font-variant-caps: small-caps;
    font-feature-settings: "smcp"; font-kerning: none; letter-spacing: 3px; word-spacing: 6px;
    line-height: 3; text-transform: uppercase; text-align: right; text-indent: 2em;
    text-shadow: 0 0 2px red; text-underline-offset: 6px; white-space: pre; word-break: break-all;
    overflow-wrap: anywhere; hyphens: auto; tab-size: 2; line-break: anywhere; cursor: wait;
    user-select: none; caret-color: red; accent-color: red; list-style-type: square;
    quotes: "<" ">"; border-collapse: collapse; color-scheme: dark; color: rgb(0 128 0);
    -webkit-font-smoothing: antialiased; -webkit-text-stroke: 1px red; paint-order: stroke;
    text-rendering: optimizeSpeed; font-synthesis: none; text-wrap-style: balance;
  }
}
`;

/**
 * A Tailwind 4 page (shadcn's, the most common modern one): Tailwind's preflight in its
 * `@layer base`, as Tailwind 4 emits it, with the base and utilities above, and the chat inside a
 * container whose utility carries every inherited property a page might set there.
 */
export const tailwind4Page = async (): Promise<EmbeddingPage> => ({
  tokens: [],
  rules: [
    '@layer theme, base, components, utilities;',
    `@layer base { ${await read('node_modules/tailwindcss/preflight.css')} }`,
    TAILWIND_4_BASE,
  ],
  around: { class: 'sprocket-shell' },
  first: true,
});

/**
 * A page whose unlayered rules reach for what the guard's `all` leaves out (`direction`,
 * `unicode-bidi`) and for the chat's root (its containment and height), with rules of one and of
 * two IDs, which outweigh any class (`#sprocket-chat#sprocket-chat` is two IDs' weight on one
 * element).
 */
export const reachingPage = async (): Promise<EmbeddingPage> => ({
  tokens: [],
  rules: [
    `
* { direction: rtl; unicode-bidi: bidi-override; contain: none; height: auto; }
#sprocket-chat .flex { gap: 11px; padding: 7px; }
#sprocket-chat#sprocket-chat button { margin: 5px; font-size: 21px; }
#sprocket-chat#sprocket-chat .consola-agent-ui div { border: 3px dashed red; }
`,
  ],
  around: { id: 'sprocket-chat' },
});

/** A page with no CSS of its own. */
export const barePage: EmbeddingPage = { tokens: [], rules: [], around: {} };
