import type { AtRule, Node, PluginCreator, Rule } from 'postcss';

/** The element `AgentChat` renders: t3's CSS applies only inside it. */
export const SCOPE_CLASS = 'consola-agent-ui';
/** The element inside it that stands in for t3's document: `:root`, `html` and `body` rules land here. */
export const THEME_CLASS = 'consola-agent-ui-theme';
/**
 * t3's popups (menus, tooltips, dialogs) are Base UI portals, `<div data-base-ui-portal>` at the
 * end of `<body>`, outside the chat. `AgentChat` marks those it opens with this class (and
 * `dark`), and each stands in for t3's document too.
 */
export const PORTAL_CLASS = 'consola-agent-ui-portal';

const DOCUMENT_SELECTOR = /^(?::root|:host|html|body)(?![\w-])/;
/** What every scoped selector but a document one starts with: inside the chat or a popup of it. */
export const INSIDE = `:where(.${SCOPE_CLASS}, .${PORTAL_CLASS})`;
/** What a scoped document selector starts with: the theme element or a popup. */
export const AS_DOCUMENT = `:where(.${SCOPE_CLASS} .${THEME_CLASS}, .${PORTAL_CLASS})`;

/**
 * The class `dark` in a selector: t3's dark mode is `dark` on its document or an ancestor
 * (`index.css`: `@custom-variant dark (&:is(.dark, .dark *))`, and `light` its `:not`). Not a
 * longer class name (`.dark-x`, Tailwind's escaped `.dark\:bg-x`) nor an escaped dot inside one.
 */
export const DARK_CLASS = /(?<!\\)\.dark(?![\w\\-]|[^\x00-\x7f])/g;
/**
 * The only `dark` that counts: the one `AgentChat` puts on the theme element and its popups,
 * from the nearest `[data-theme]`. A `dark` on the page's `<html>` (t3's own theme module would
 * put one there, and a Tailwind page has its own) or on any other ancestor of the chat does not
 * make it dark. `:where` keeps `.dark`'s specificity.
 */
export const OWN_DARK = `:where(.${THEME_CLASS}, .${PORTAL_CLASS}).dark`;

/**
 * One selector of t3's CSS, moved inside the scope. A selector for the document (`:root`,
 * `:host`, `html`, `body`, with whatever follows) names the theme element and the marked portals
 * instead; any other selector applies only to their descendants. Its `dark` is the chat's own
 * (`OWN_DARK`). `:where` adds no specificity, so t3's own rules keep their order against each
 * other. A selector that already names the scope is Consola's (`styles.css`) and is left alone
 * (which `.consola-agent-ui-portal` also names).
 */
export const scopeSelector = (selector: string): string => {
  const trimmed = selector.trim();
  if (trimmed.includes(`.${SCOPE_CLASS}`)) return trimmed;
  const ownDark = trimmed.replace(DARK_CLASS, OWN_DARK);
  if (DOCUMENT_SELECTOR.test(ownDark)) return ownDark.replace(DOCUMENT_SELECTOR, AS_DOCUMENT);
  return `${INSIDE} ${ownDark}`;
};

/** Whether a rule is a keyframe step, which is not a selector. */
export const insideKeyframes = (rule: Rule): boolean => {
  for (let node: Node | undefined = rule.parent; node !== undefined; node = node.parent) {
    if (node.type === 'atrule' && /keyframes$/i.test((node as AtRule).name)) return true;
  }
  return false;
};

/** Whether a rule is nested in another (CSS nesting, possibly through an at-rule). */
const nestedInRule = (rule: Rule): boolean => {
  for (let node: Node | undefined = rule.parent; node !== undefined; node = node.parent) {
    if (node.type === 'rule') return true;
  }
  return false;
};

/**
 * Runs after Tailwind on the compiled stylesheet, so its preflight, theme variables and
 * utilities, and t3's own global rules, apply only inside `.consola-agent-ui`. A rule nested in
 * another rule follows its parent's scope, but its `dark` is still the chat's own: t3's dark
 * blocks compile to nested `&:is(.dark, .dark *)` rules, which a minifier flattens only in the
 * build. Keyframe steps are not selectors.
 */
export const scopeCss: PluginCreator<void> = () => ({
  postcssPlugin: 'consola-agent-ui-scope',
  Rule(rule) {
    if (insideKeyframes(rule)) return;
    const scoped = nestedInRule(rule)
      ? rule.selectors.map((selector) =>
          selector.includes(`.${SCOPE_CLASS}`) ? selector : selector.replace(DARK_CLASS, OWN_DARK),
        )
      : rule.selectors.map(scopeSelector);
    if (scoped.join() !== rule.selectors.join()) rule.selectors = scoped;
  },
});
scopeCss.postcss = true;
