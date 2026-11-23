/**
 * Unlayered CSS that t3's dependencies add to the page's `<head>` while the chat runs:
 *
 * - Tiptap's editor styles (`style[data-tiptap-style]`, `@tiptap/core`'s `injectCSS`), which the
 *   composer needs: `white-space: break-spaces`, no ligatures, the gap cursor;
 * - Base UI's hidden scrollbars (`.base-ui-disable-scrollbar`, `@base-ui/react`'s
 *   `utils/styles`), a `<style precedence="base-ui:low">` that React hoists to the start of
 *   `<head>` (`data-precedence`) when a scroll area or a select list first renders: t3's markdown
 *   tables, dialogs, comboboxes, autocompletes and the composer's select popups draw Base UI's
 *   thumb instead of the native scrollbar;
 * - Legend List's hidden scrollbars (`#legend-list-scrollbar-axis-hidden-style`), added only for a
 *   list that hides its scrollbar, which no list of t3's does today.
 *
 * The guard rolls such CSS back inside the chat, as it does any unlayered rule of the page's
 * (AGENTS.md, "The page's CSS"). So while a chat is mounted, each gets a copy in the chat's layer,
 * whose rules then apply inside the chat as the original's do everywhere else. Copies go at the end
 * of `<head>`, never beside their original: React puts Base UI's first in `<head>`, and a copy
 * there would name the chat's layer before the page's own layers, which fixes the chat's below
 * them (a layer's place is where its name first appears). At the end, the chat's own stylesheet
 * has named it already. A copy carries its original's `nonce`, so a page whose `style-src` allows
 * the original by its nonce allows the copy too.
 *
 * The copy's rules are nested in `INSIDE_CHAT`, so they match only inside the chat and its
 * popups, with the original's specificity: outside, a page that rolls its own unlayered rules
 * back (`revert-layer`) would otherwise fall to the copy. Nesting rather than `@scope`, which
 * would do the same but reached Firefox only in 146 (nesting in 117). The copy leaves out
 * `!important`: an important declaration outranks the guard, so the original's still applies,
 * and a copy of it in a layer would outrank the page's own. A copy holds no `@keyframes` (a
 * nested one is dropped); the original's are the page's, and name the same animations.
 */
export const INJECTED_STYLES = [
  'style[data-tiptap-style]',
  'style[data-precedence^="base-ui:"]',
  'style#legend-list-scrollbar-axis-hidden-style',
].join(', ');

/** The attribute that marks a copy. */
export const COPY_ATTRIBUTE = 'data-consola-agent-ui-copy';

const copies = new Map<HTMLStyleElement, HTMLStyleElement>();
let chats = 0;
let observer: MutationObserver | undefined;

/** Inside the chat or one of its popups (`build/scopeCss.ts` `INSIDE`). */
export const INSIDE_CHAT = ':where(.consola-agent-ui, .consola-agent-ui-portal)';

const layered = (css: string) =>
  `@layer consola-agent-ui {\n${INSIDE_CHAT} {\n${css.replace(/!\s*important/gi, '')}\n}\n}`;

/** The text of an injected style's copy. */
export const copyTextOf = (original: HTMLStyleElement): string =>
  layered(original.textContent ?? '');

/** Copies each injected style that has none, follows a changed one, and drops a removed one's. */
const sync = () => {
  for (const original of document.head.querySelectorAll<HTMLStyleElement>(INJECTED_STYLES)) {
    const css = copyTextOf(original);
    const copy = copies.get(original);
    if (copy === undefined) {
      const added = document.createElement('style');
      added.setAttribute(COPY_ATTRIBUTE, '');
      // Before it is in the document, where a nonce-based `style-src` checks it.
      added.nonce = original.nonce;
      added.textContent = css;
      document.head.append(added);
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
