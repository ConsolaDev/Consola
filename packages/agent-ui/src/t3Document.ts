/**
 * Keeps t3's theme module from writing the page's document.
 *
 * t3's web app owns its document, so its theme module (`src/t3/hooks/useTheme.ts`,
 * `applyTheme`) writes it: `dark` (and `no-transitions`) on `<html>`, its palette's
 * `--app-theme-*` and context-chip variables and `data-theme-id` on `<html>`, an inline
 * `background-color` on `<html>` and `<body>`, and a `<meta name="theme-color">`. It does so at
 * import, and again when its appearance preference changes, when the system's appearance changes
 * while it follows the system, and when another window changes its stored theme. Here the page
 * is Consola's, and none of that is the chat's to write.
 *
 * `applyTheme` has an early return of t3's own: it writes nothing while `<html data-theme-id>`
 * names t3's theme preview (`THEME_PREVIEW_ID`), which t3's theme editor sets while a draft owns
 * the document's theme. This module sets that mark only while t3 could write, and puts back what
 * the page had:
 *
 * - around t3's modules running at import: this module is the first `AgentChat.tsx` imports, and
 *   `AgentChat.tsx` releases the hold once its imports have run (`vite.config.ts` builds with
 *   `strictExecutionOrder`, so the library keeps that order across its chunks);
 * - around each change `AgentChat` makes to t3's appearance (`sparingThePage`), which it keeps
 *   on the chat's theme, so t3 never follows the system and its own code reads Consola's theme;
 * - for the task in which another window's change to t3's stored theme reaches t3's `storage`
 *   listener (a capturing listener on `window` runs before it).
 */
import { THEME_PREVIEW_ID } from '~/themePalette';

const MARK = 'data-theme-id';
/** t3's stored theme: `t3code:theme`, `t3code:theme-appearance-mode`, `t3code:themes:v1`, … */
const T3_THEME_KEY_PREFIX = 't3code:theme';

let holds = 0;
let pageMark: string | null = null;

/** Marks the document as t3's preview until the returned function is called. */
const hold = (): (() => void) => {
  if (typeof document === 'undefined') return () => {};
  const root = document.documentElement;
  if (holds === 0) {
    pageMark = root.getAttribute(MARK);
    root.setAttribute(MARK, THEME_PREVIEW_ID);
  }
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    if (holds > 0) return;
    if (pageMark === null) root.removeAttribute(MARK);
    else root.setAttribute(MARK, pageMark);
  };
};

/** Runs `change` (a call into t3's theme module) without letting t3 write the document. */
export const sparingThePage = <A>(change: () => A): A => {
  const release = hold();
  try {
    return change();
  } finally {
    release();
  }
};

/** The hold around t3's modules running at import; `AgentChat.tsx` releases it. */
export const releaseImportHold = hold();

if (typeof window !== 'undefined') {
  window.addEventListener(
    'storage',
    (event) => {
      // `null` is another window clearing the storage, which t3 also answers by applying.
      if (event.key !== null && !event.key.startsWith(T3_THEME_KEY_PREFIX)) return;
      setTimeout(hold(), 0);
    },
    { capture: true },
  );
}
