import { commands } from 'vite-plus/test/browser';

/**
 * A page that embeds the chat, for `AgentChat.pageCss.browser.test.tsx`: the CSS it loads, read
 * from the files the page itself loads (never a copy of them), and the element the chat sits in.
 */
export interface EmbeddingPage {
  /** What the page carries without its rules: custom properties only (the desktop's tokens). */
  readonly tokens: ReadonlyArray<string>;
  /** The page's rules, in the order it loads them. */
  readonly rules: ReadonlyArray<string>;
  /** The attributes of the element the page puts around the chat. */
  readonly around: Readonly<Record<string, string>>;
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
