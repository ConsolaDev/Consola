import postcss, { type AtRule, type Node, type PluginCreator, type Root, type Rule } from 'postcss';

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
 * The one cascade layer the stylesheet's rules are in (AGENTS.md, "The page's CSS"). t3's layers
 * (Tailwind's `properties`, then `theme, base, clerk, components, utilities`) become its
 * sublayers, and the rules that were in none (t3's own, KaTeX's, the PDF viewer's, Consola's
 * `styles.css`) its direct rules, which outrank its sublayers as unlayered rules outrank layers:
 * t3's cascade is the same inside it, `!important` included.
 */
export const CHAT_LAYER = 'consola-agent-ui';

/** An id no element has, so `:not()` of it excludes nothing: it gives a selector an ID's weight. */
const GUARD_ID = `#${SCOPE_CLASS}-guard`;
/**
 * Three IDs' weight, more than a page rule with one or two IDs (`#app .x`, `#root #app .x`) has,
 * so such a rule cannot tie the guard and win by coming later.
 */
const GUARD_WEIGHT = `:not(${GUARD_ID}):not(${GUARD_ID}):not(${GUARD_ID})`;

/**
 * What the guard's selectors start with (`styles.css`): every element inside the chat's root (the
 * theme element and all t3 renders) and its popups, with `GUARD_WEIGHT`.
 */
export const GUARDED = `:is(.${SCOPE_CLASS} *, .${PORTAL_CLASS}, .${PORTAL_CLASS} *)${GUARD_WEIGHT}`;
/**
 * The chat's root, guarded only for what keeps the chat in its box (`styles.css`): its
 * `contain: layout` and `height: 100%`. The rest of it is the page's to place.
 */
export const ROOT_GUARDED = `.${SCOPE_CLASS}${GUARD_WEIGHT}`;

/**
 * The chat layer's lowest sublayer, the floor (`styles.css`, completed by scopeCss): what each
 * property of the chat's elements falls to where t3's stylesheet sets nothing. Below it are only
 * the page's layers declared before the chat's, which it keeps out.
 */
export const RESET_LAYER = 'reset';
/**
 * What the floor's rules start with: the guard's elements without its weight (the floor is in a
 * layer, and `:where` lets the theme element's rule after it win), and none of MathML, whose
 * attributes style it and which KaTeX renders only for screen readers, out of sight.
 */
export const FLOOR = `:where(.${SCOPE_CLASS} *, .${PORTAL_CLASS}, .${PORTAL_CLASS} *):where(:not(math, math *))`;

/**
 * SVG's presentation attributes, each named as the property it sets (`fill="none"` is
 * `fill: none`). Lucide's icons are drawn by them.
 */
export const SVG_PRESENTATION_ATTRIBUTES = [
  'alignment-baseline',
  'baseline-shift',
  'clip',
  'clip-path',
  'clip-rule',
  'color',
  'color-interpolation',
  'color-interpolation-filters',
  'color-rendering',
  'cursor',
  'cx',
  'cy',
  'd',
  'direction',
  'display',
  'dominant-baseline',
  'fill',
  'fill-opacity',
  'fill-rule',
  'filter',
  'flood-color',
  'flood-opacity',
  'font-family',
  'font-size',
  'font-size-adjust',
  'font-stretch',
  'font-style',
  'font-variant',
  'font-weight',
  'height',
  'image-rendering',
  'letter-spacing',
  'lighting-color',
  'marker-end',
  'marker-mid',
  'marker-start',
  'mask',
  'mask-type',
  'opacity',
  'overflow',
  'paint-order',
  'pointer-events',
  'r',
  'rx',
  'ry',
  'shape-rendering',
  'stop-color',
  'stop-opacity',
  'stroke',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
  'stroke-width',
  'text-anchor',
  'text-decoration',
  'text-overflow',
  'text-rendering',
  'transform',
  'transform-origin',
  'unicode-bidi',
  'vector-effect',
  'visibility',
  'white-space',
  'width',
  'word-spacing',
  'writing-mode',
  'x',
  'y',
] as const;

/**
 * HTML's attributes that style the element carrying them (Chromium's presentational hints, read
 * from what `all: revert` takes away from each), and the properties each sets. With SVG's, they
 * are where the floor lets a property fall through (`revert-layer`): `revert` rolls back to the
 * browser's own styles, and the attributes' styles are the page's origin, so the floor would take
 * them away (an icon's `stroke`, a `hidden` element's `display: none`).
 */
export const ATTRIBUTE_STYLED: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ['[hidden]', ['display', 'content-visibility']],
  ['[dir]', ['direction', 'unicode-bidi']],
  ['[lang]', ['-webkit-locale']],
  ['[contenteditable]', ['line-break', 'overflow-wrap', '-webkit-line-break']],
  ['[draggable]', ['user-select', '-webkit-user-drag']],
  ['[width]', ['width', 'aspect-ratio']],
  ['[height]', ['height', 'aspect-ratio']],
  ['[align]', ['text-align', 'float', 'vertical-align', 'margin-left', 'margin-right']],
  ['[valign]', ['vertical-align']],
  ['[nowrap]', ['white-space']],
  ['[wrap]', ['white-space', 'overflow-wrap']],
  ['[bgcolor]', ['background-color']],
  ['[background]', ['background-image']],
  ['[border]', ['border']],
  ['[frameborder]', ['border']],
  ['[cellspacing]', ['border-spacing']],
  [':is(ol, ul, li)[type]', ['list-style-type']],
  ...SVG_PRESENTATION_ATTRIBUTES.map((name) => [`[${name}]`, [name]] as const),
];

/**
 * The guard's and the floor's pseudo-elements, each in a rule of its own (a pseudo-element a
 * browser does not know drops only its rule): those a page's reset reaches (Tailwind's
 * `*, ::before, ::after`, `::placeholder`, `::file-selector-button`, its date and number parts; a
 * page's `::selection` and scrollbars) and the other standard ones but `::first-line` and
 * `::first-letter`: a rule that matches them, even one that only rolls back, gives every block a
 * first-line style, and Chromium then lays out its text a fraction of a pixel wider. t3 styles
 * scrollbars on every element but an iframe (`:where(:not(iframe))`, a WebKit resize loop), and
 * so do these: a `::-webkit-scrollbar` rule that matches turns an element's scrollbars custom.
 */
export const GUARDED_PSEUDO_ELEMENTS = [
  '::before, ::after',
  '::backdrop',
  '::marker',
  '::placeholder',
  '::selection',
  '::file-selector-button',
  ':where(:not(iframe))::-webkit-scrollbar',
  ':where(:not(iframe))::-webkit-scrollbar-track',
  ':where(:not(iframe))::-webkit-scrollbar-thumb',
  ':where(:not(iframe))::-webkit-scrollbar-corner',
  ':where(:not(iframe))::-webkit-scrollbar-button',
  ':where(:not(iframe))::-webkit-resizer',
  '::-webkit-inner-spin-button',
  '::-webkit-outer-spin-button',
  '::-webkit-search-decoration',
  '::-webkit-search-cancel-button',
  '::-webkit-date-and-time-value',
  '::-webkit-datetime-edit',
  '::-webkit-calendar-picker-indicator',
] as const;

/**
 * A selector as a minifier writes it, to compare selectors however they were formatted: one space
 * for each run of whitespace, and none around commas or inside parentheses' edges.
 */
export const compact = (selector: string) =>
  selector
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ',')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();

/** Whether a rule is the guard's: each of its selectors starts with `GUARDED`, or is the root's. */
export const isGuard = (rule: Rule): boolean =>
  rule.selectors.every((selector) => {
    const compacted = compact(selector);
    return compacted.startsWith(compact(GUARDED)) || compacted === compact(ROOT_GUARDED);
  });

/** At-rules that stay where they are: a layer cannot hold an import, and these name page-wide things. */
const STAYS_OUTSIDE = /^(?:-[a-z]+-)?(?:charset|import|namespace|property|font-face|keyframes)$/i;

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

/** The pseudo-elements that get the registered properties too: Tailwind sets them on these. */
const WITH_REGISTERED = new Set(['::before, ::after', '::backdrop']);

/**
 * Completes a rule of the guard's (`revert-layer`) or the floor's (`revert`), as `styles.css`
 * writes it for elements: the same declarations in a rule for each of `GUARDED_PSEUDO_ELEMENTS`,
 * after it, and every custom property the stylesheet registers (`@property`: Tailwind's `--tw-*`,
 * t3's) rolled back too, since `all` leaves custom properties alone and a page with Tailwind 3
 * sets the same `--tw-*` names on every element (`--tw-shadow: 0 0 #0000`, which would take t3's
 * shadows away). Returns the last rule it added.
 */
const completeRollback = (
  rule: Rule,
  prefix: string,
  value: string,
  registered: ReadonlyArray<string>,
): Rule => {
  const own = rule.nodes.filter((node) => node.type === 'decl').map((decl) => decl.clone());
  for (const name of registered) rule.append({ prop: name, value });
  let last = rule;
  for (const pseudo of GUARDED_PSEUDO_ELEMENTS) {
    const selector = pseudo
      .split(',')
      .map((part) => `${prefix}${part.trim()}`)
      .join(', ');
    const next = postcss.rule({ selector });
    next.append(own.map((decl) => decl.clone()));
    if (WITH_REGISTERED.has(pseudo)) {
      for (const name of registered) next.append({ prop: name, value });
    }
    last.after(next);
    last = next;
  }
  return last;
};

/**
 * Completes the floor (`styles.css`'s `@layer reset`): its rule for elements as a rollback
 * (`completeRollback`), then a rule for each attribute that styles the element carrying it
 * (`ATTRIBUTE_STYLED`), which lets those properties fall through to the attribute's style.
 */
const completeFloor = (reset: AtRule, registered: ReadonlyArray<string>) => {
  const floor = reset.nodes?.find(
    (node): node is Rule => node.type === 'rule' && compact(node.selector) === compact(FLOOR),
  );
  if (floor === undefined) return;
  let last = completeRollback(floor, FLOOR, 'revert', registered);
  for (const [attribute, properties] of ATTRIBUTE_STYLED) {
    const rule = postcss.rule({ selector: `${INSIDE} ${attribute}` });
    for (const prop of properties) rule.append({ prop, value: 'revert-layer' });
    last.after(rule);
    last = rule;
  }
};

/** Whether a node is `styles.css`'s floor, `@layer reset { … }`. */
const isReset = (node: Node): node is AtRule =>
  node.type === 'atrule' &&
  (node as AtRule).name.toLowerCase() === 'layer' &&
  (node as AtRule).params.trim() === RESET_LAYER &&
  (node as AtRule).nodes !== undefined;

/**
 * Moves the stylesheet into `CHAT_LAYER`, in order: each run of top-level nodes goes into an
 * `@layer consola-agent-ui` block where it stood, so what was in a layer of t3's is in that
 * sublayer, and what was in none is the layer's own. The floor goes first, so it is the lowest
 * sublayer, below t3's. The guard stays outside (it must outrank a page's unlayered rules), and
 * so do the at-rules in `STAYS_OUTSIDE`.
 */
const intoChatLayer = (root: Root) => {
  const registered: string[] = [];
  root.walkAtRules('property', (atRule) => {
    registered.push(atRule.params.trim());
  });
  let reset = root.nodes.find(isReset);
  if (reset !== undefined) {
    reset.remove();
    completeFloor(reset, registered);
  }
  let layer: AtRule | undefined;
  for (const node of [...root.nodes]) {
    const stays =
      (node.type === 'atrule' && STAYS_OUTSIDE.test(node.name)) ||
      (node.type === 'rule' && isGuard(node));
    if (stays) {
      if (node.type === 'rule' && compact(node.selector) === compact(GUARDED)) {
        completeRollback(node, GUARDED, 'revert-layer', registered);
      }
      layer = undefined;
      continue;
    }
    if (node.type === 'comment' && layer === undefined) continue;
    if (layer === undefined) {
      layer = postcss.atRule({ name: 'layer', params: CHAT_LAYER });
      node.before(layer);
      if (reset !== undefined) layer.append(reset);
      reset = undefined;
    }
    layer.append(node);
  }
};

/**
 * Runs after Tailwind on the compiled stylesheet, so its preflight, theme variables and
 * utilities, and t3's own global rules, apply only inside `.consola-agent-ui`. A rule nested in
 * another rule follows its parent's scope, but its `dark` is still the chat's own: t3's dark
 * blocks compile to nested `&:is(.dark, .dark *)` rules, which a minifier flattens only in the
 * build. Keyframe steps are not selectors. Then the whole stylesheet goes into the chat's layer,
 * under the guard (`intoChatLayer`).
 */
export const scopeCss: PluginCreator<void> = () => ({
  postcssPlugin: 'consola-agent-ui-scope',
  OnceExit: intoChatLayer,
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
