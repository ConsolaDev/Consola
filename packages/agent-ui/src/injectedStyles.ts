/**
 * Unlayered CSS that t3's dependencies add to the page's `<head>` while the chat runs:
 *
 * - Tiptap's editor styles (`style[data-tiptap-style]`, `@tiptap/core`'s `injectCSS`), which the
 *   composer needs: `white-space: break-spaces`, no ligatures, the gap cursor;
 * - Legend List's hidden scrollbars (`#legend-list-scrollbar-axis-hidden-style`), added only for a
 *   list that hides its scrollbar, which no list of t3's does today.
 *
 * The guard rolls such CSS back inside the chat, as it does any unlayered rule of the page's
 * (AGENTS.md, "The page's CSS"). So while a chat is mounted, each gets a copy in the chat's layer,
 * right after it, whose rules then apply inside the chat as the original's do everywhere else.
 * The copy's rules are nested in `INSIDE_CHAT`, so they match only inside the chat and its
 * popups, with the original's specificity: outside, a page that rolls its own unlayered rules
 * back (`revert-layer`) would otherwise fall to the copy. Nesting rather than `@scope`, which
 * would do the same but reached Firefox only in 146 (nesting in 117). The copy leaves out
 * `!important`: an important declaration outranks the guard, so the original's still applies,
 * and a copy of it in a layer would outrank the page's own. A copy holds no `@keyframes` (a
 * nested one is dropped); the original's are the page's, and name the same animations.
 */
export const INJECTED_STYLES =
  'style[data-tiptap-style], style#legend-list-scrollbar-axis-hidden-style';

/** The attribute that marks a copy. */
export const COPY_ATTRIBUTE = 'data-consola-agent-ui-copy';

const copies = new Map<HTMLStyleElement, HTMLStyleElement>();
let chats = 0;
let observer: MutationObserver | undefined;

/** Inside the chat or one of its popups (`build/scopeCss.ts` `INSIDE`). */
export const INSIDE_CHAT = ':where(.consola-agent-ui, .consola-agent-ui-portal)';

const layered = (css: string) =>
  `@layer consola-agent-ui {\n${INSIDE_CHAT} {\n${css.replace(/!\s*important/gi, '')}\n}\n}`;

/** Copies each injected style that has none, follows a changed one, and drops a removed one's. */
const sync = () => {
  for (const original of document.head.querySelectorAll<HTMLStyleElement>(INJECTED_STYLES)) {
    const css = layered(original.textContent ?? '');
    const copy = copies.get(original);
    if (copy === undefined) {
      const added = document.createElement('style');
      added.setAttribute(COPY_ATTRIBUTE, '');
      added.textContent = css;
      original.after(added);
      copies.set(original, added);
    } else if (copy.textContent !== css) copy.textContent = css;
  }
  for (const [original, copy] of copies) {
    if (!original.isConnected) {
      copy.remove();
      copies.delete(original);
    }
  }
};

/**
 * Keeps the copies while a chat is mounted, for every chat on the page together; the returned
 * function, called as each unmounts, removes them after the last.
 */
export const copyInjectedStyles = (): (() => void) => {
  chats++;
  if (chats === 1) {
    sync();
    observer = new MutationObserver(sync);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  }
  return () => {
    chats--;
    if (chats > 0) return;
    observer?.disconnect();
    observer = undefined;
    for (const copy of copies.values()) copy.remove();
    copies.clear();
  };
};
