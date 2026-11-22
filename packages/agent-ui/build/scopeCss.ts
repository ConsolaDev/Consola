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
const INSIDE = `:where(.${SCOPE_CLASS}, .${PORTAL_CLASS})`;
const AS_DOCUMENT = `:where(.${SCOPE_CLASS} .${THEME_CLASS}, .${PORTAL_CLASS})`;

/**
 * One selector of t3's CSS, moved inside the scope. A selector for the document (`:root`,
 * `:host`, `html`, `body`, with whatever follows) names the theme element and the marked portals
 * instead; any other selector applies only to their descendants. `:where` adds no specificity, so t3's own
 * rules keep their order against each other. A selector that already names the scope is
 * Consola's (`styles.css`) and is left alone (which `.consola-agent-ui-portal` also names).
 */
export const scopeSelector = (selector: string): string => {
  const trimmed = selector.trim();
  if (trimmed.includes(`.${SCOPE_CLASS}`)) return trimmed;
  if (DOCUMENT_SELECTOR.test(trimmed)) return trimmed.replace(DOCUMENT_SELECTOR, AS_DOCUMENT);
  return `${INSIDE} ${trimmed}`;
};

const insideKeyframes = (rule: Rule): boolean => {
  for (let node: Node | undefined = rule.parent; node !== undefined; node = node.parent) {
    if (node.type === 'atrule' && /keyframes$/i.test((node as AtRule).name)) return true;
  }
  return false;
};

/**
 * Runs after Tailwind on the compiled stylesheet, so its preflight, theme variables and
 * utilities, and t3's own global rules, apply only inside `.consola-agent-ui`. A rule nested in
 * another rule follows its parent, and keyframe steps are not selectors.
 */
export const scopeCss: PluginCreator<void> = () => ({
  postcssPlugin: 'consola-agent-ui-scope',
  Rule(rule) {
    if (rule.parent?.type === 'rule' || insideKeyframes(rule)) return;
    const scoped = rule.selectors.map(scopeSelector);
    if (scoped.join() !== rule.selectors.join()) rule.selectors = scoped;
  },
});
scopeCss.postcss = true;
