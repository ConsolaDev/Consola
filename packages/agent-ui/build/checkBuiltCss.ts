// @effect-diagnostics nodeBuiltinImport:off - A build script: it reads the build's output.
/**
 * Checks the built stylesheet, `dist/agent-ui.css` (`@consola/agent-ui/styles.css`), which a page
 * imports: that it holds the chat's styles (t3's theme, Tailwind's utilities, Consola's mapping)
 * and that they style nothing but the chat. Every rule must be scoped (`build/scopeCss.ts`); what
 * is page-global anyway is a short list of at-rules that style nothing by themselves (AGENTS.md,
 * "What is page-global"). Every rule is in the chat's cascade layer but the guard's, which roll
 * back what a page's rules set inside the chat and set nothing themselves, and the layer's lowest
 * sublayer is the floor, which keeps the page's own layers out (AGENTS.md, "The page's CSS"). The
 * browser tests import the stylesheet from source, so this is what notices a build that drops it,
 * loses its scope or its layer, the guard or the floor. Run after `pnpm build`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import type { AtRule, Node, Rule } from 'postcss';
import {
  AS_DOCUMENT,
  ATTRIBUTE_STYLED,
  CHAT_LAYER,
  compact,
  DARK_CLASS,
  FLOOR,
  GUARDED,
  GUARDED_PSEUDO_ELEMENTS,
  INSIDE,
  insideKeyframes,
  isGuard,
  OWN_DARK,
  PORTAL_CLASS,
  RESET_LAYER,
  ROOT_GUARDED,
  SCOPE_CLASS,
} from './scopeCss.ts';

/** Consola's own rules (`src/styles.css`), which name the chat's elements directly. */
const OWN_PREFIXES = [
  `.${SCOPE_CLASS}`,
  `:where([data-theme]) .${SCOPE_CLASS}`,
  `:where([data-theme]) .${PORTAL_CLASS}`,
].map(compact);
/**
 * The one rule that matches outside the chat: it reads Consola's colour tokens on the page's
 * `[data-theme]` element into the package's own custom properties, and may set nothing else.
 */
const TOKEN_RULE = compact(`:where([data-theme]):not(.${SCOPE_CLASS})`);
const OWN_PROPERTY = /^--consola-agent-ui-/;

const SCOPED_PREFIXES = [
  compact(INSIDE),
  compact(AS_DOCUMENT),
  compact(GUARDED),
  compact(FLOOR),
  ...OWN_PREFIXES,
];

/** Whether a layer name is the chat's layer or one of its sublayers (`consola-agent-ui.base`). */
const isChatLayerName = (name: string) => name === CHAT_LAYER || name.startsWith(`${CHAT_LAYER}.`);

/**
 * The layer a node is in, dotted (`consola-agent-ui.reset`), however a minifier wrote it: nested
 * blocks, a dotted block, or both. `undefined` outside every layer, or in a block of several names.
 */
const layerOf = (node: Node): string | undefined => {
  const names: string[] = [];
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (parent.type === 'atrule' && (parent as AtRule).name.toLowerCase() === 'layer') {
      names.unshift((parent as AtRule).params.trim());
    }
  }
  return names.length === 0 || names.some((name) => name.includes(','))
    ? undefined
    : names.join('.');
};

/** Whether a node is inside an `@layer` block of the chat's (a minifier may write its sublayers dotted). */
const inChatLayer = (node: Node): boolean => {
  const layer = layerOf(node);
  return layer !== undefined && isChatLayerName(layer);
};

/** The floor's layer, the chat layer's lowest sublayer. */
const FLOOR_LAYER = `${CHAT_LAYER}.${RESET_LAYER}`;

/**
 * A guard selector compared as written: CSS 2's pseudo-elements in either spelling (a minifier
 * writes `::before` as `:before`).
 */
const guardKey = (selector: string) =>
  compact(selector).replace(/(?<!:):(before|after|first-line|first-letter)\b/g, '::$1');

/** The selectors of the rule for `pseudo` (`GUARDED_PSEUDO_ELEMENTS`) that scopeCss adds after `prefix`'s. */
const pseudoSelectors = (prefix: string, pseudo: string) =>
  pseudo.split(',').map((part) => guardKey(`${prefix}${part.trim()}`));

/**
 * What is wrong with a rule of the guard's (`revert-layer`) or the floor's (`revert`): it may
 * only roll properties back, never set one.
 */
const rollbackProblems = (rule: Rule, value: string, what: string): string[] => {
  const problems: string[] = [];
  rule.each((node) => {
    if (node.type !== 'decl') return;
    if (node.value.trim() !== value || node.important) {
      problems.push(
        `${what} sets ${node.prop}: ${node.value} (${rule.selector}): it may only roll back`,
      );
    }
  });
  return problems;
};

/**
 * The custom properties the stylesheet registers for the whole page: Tailwind's `--tw-*` and one
 * of t3's (`src/t3/index.css`). A name no page of Consola's uses, so registering it changes nothing
 * outside the chat; another one fails the check until it is looked at and listed here.
 */
const isKnownProperty = (name: string) =>
  name.startsWith('--tw-') || name === '--assistant-citation-highlight-opacity';

/** At-rules that hold scoped rules and style nothing themselves. */
const WRAPPERS = new Set(['media', 'supports', 'container', 'starting-style', 'layer']);
/** Page-global at-rules that style nothing by themselves; AGENTS.md lists them. */
const GLOBAL = new Set(['keyframes', 'property', 'font-face']);

/** The top-level arguments of a selector list, split at commas outside brackets and parentheses. */
const splitTopLevel = (list: string): string[] => {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < list.length; index++) {
    const char = list[index];
    if (char === '\\') index++;
    else if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth--;
    else if (char === ',' && depth === 0) {
      parts.push(list.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(list.slice(start));
  return parts.map((part) => part.trim());
};

/**
 * The first combinator at the top level of `rest` (what follows a scope prefix): `' '` for a
 * descendant, `>`, `+` or `~`; `null` when there is none.
 */
const firstCombinator = (rest: string): string | null => {
  let depth = 0;
  for (let index = 0; index < rest.length; index++) {
    const char = rest[index] ?? '';
    if (char === '\\') index++;
    else if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth--;
    else if (depth === 0 && '>+~'.includes(char)) return char;
    else if (depth === 0 && /\s/.test(char)) {
      const next = rest.slice(index).trimStart()[0] ?? '';
      return '>+~'.includes(next) && next !== '' ? next : ' ';
    }
  }
  return null;
};

/**
 * Whether a selector applies only inside the chat. A minifier merges selectors into one
 * `:is(a, b)`, so such a selector is scoped when each of its arguments is. A sibling
 * combinator straight after the scope (`.consola-agent-ui + p`, `….consola-agent-ui:hover ~ p`)
 * styles the scope's siblings, outside the chat, so it is not.
 */
const isScoped = (selector: string): boolean => {
  const compacted = compact(selector);
  if (compacted.startsWith(':is(') && compacted.endsWith(')')) {
    const inner = compacted.slice(4, -1);
    if (splitTopLevel(inner).every(isScoped)) return true;
  }
  return SCOPED_PREFIXES.some(
    (prefix) =>
      compacted === prefix ||
      (compacted.startsWith(prefix) &&
        /^[\s.:[>+~]/.test(compacted.slice(prefix.length)) &&
        !'+~'.includes(firstCombinator(compacted.slice(prefix.length)) ?? ' ')),
  );
};

export interface BuiltCssReport {
  /** What is wrong; empty when the stylesheet passes. */
  readonly problems: readonly string[];
  /** What the stylesheet declares for the whole page (AGENTS.md lists these kinds). */
  readonly pageGlobal: {
    readonly keyframes: readonly string[];
    readonly properties: readonly string[];
    readonly fontFamilies: readonly string[];
    /** The layer names a page shares the cascade with: the chat's own, its sublayers inside it. */
    readonly layers: readonly string[];
  };
}

export const checkBuiltCss = (css: string): BuiltCssReport => {
  const root = postcss.parse(css);
  const problems: string[] = [];
  const keyframes: string[] = [];
  const properties: string[] = [];
  const fontFamilies = new Set<string>();
  const layers = new Set<string>();
  let theme = false;
  let utility = false;
  let mapping = false;
  let documentReset = false;
  /** The rules of the guard's and the floor's, by each selector (a minifier merges them). */
  const guards = new Map<string, Rule[]>();
  const floors = new Map<string, Rule[]>();
  const sublayers: string[] = [];
  const collect = (into: Map<string, Rule[]>, rule: Rule) => {
    for (const selector of rule.selectors.map(guardKey)) {
      into.set(selector, [...(into.get(selector) ?? []), rule]);
    }
  };
  const attributeStyled = new Set(
    ATTRIBUTE_STYLED.map(([attribute]) => compact(`${INSIDE} ${attribute}`)),
  );

  root.walkAtRules((atRule) => {
    const name = atRule.name.toLowerCase();
    if (name === 'layer') {
      // The chat layer's sublayers, in the order they are first named, which is their order.
      const inChat = layerOf(atRule) === CHAT_LAYER;
      for (const layer of atRule.params.split(',').map((part) => part.trim())) {
        const sublayer = inChat
          ? layer
          : layer.startsWith(`${CHAT_LAYER}.`)
            ? layer.slice(CHAT_LAYER.length + 1)
            : '';
        const top = sublayer.split('.')[0] ?? '';
        if (top !== '' && (inChat || atRule.parent?.type === 'root') && !sublayers.includes(top)) {
          sublayers.push(top);
        }
      }
    }
    if (name === 'layer' && atRule.parent?.type === 'root') {
      for (const layer of atRule.params.split(',').map((part) => part.trim())) {
        if (layer === '') continue;
        if (!isChatLayerName(layer)) {
          problems.push(`@layer ${layer}: a layer outside ${CHAT_LAYER}, which a page shares`);
        }
        layers.add(layer.split('.')[0] ?? layer);
      }
    }
    if (/keyframes$/.test(name)) keyframes.push(atRule.params);
    else if (name === 'property') {
      properties.push(atRule.params);
      if (!isKnownProperty(atRule.params)) {
        problems.push(`@property ${atRule.params}: a page-global property not listed as harmless`);
      }
    } else if (name === 'font-face') {
      atRule.walkDecls('font-family', (decl) => {
        fontFamilies.add(decl.value);
      });
    } else if (!WRAPPERS.has(name) && !GLOBAL.has(name)) {
      problems.push(`@${atRule.name} ${atRule.params}: an at-rule kind not known to be harmless`);
    }
    if (name === 'media' && /prefers-color-scheme/.test(atRule.params)) {
      problems.push(`@media ${atRule.params}: dark mode is Consola's, never the system's`);
    }
  });

  root.walkRules((rule) => {
    if (insideKeyframes(rule)) return;
    if (!inChatLayer(rule)) {
      // Only the guard is outside the chat's layer, at the top: anything else unlayered would
      // either lose to the guard or fight the page's rules on their weight.
      if (isGuard(rule) && rule.parent?.type === 'root') {
        collect(guards, rule);
        problems.push(...rollbackProblems(rule, 'revert-layer', 'the guard'));
      } else {
        problems.push(`outside the ${CHAT_LAYER} layer: ${rule.selector}`);
      }
    } else if (layerOf(rule) === FLOOR_LAYER) {
      // The floor rolls back to the browser's styles, but where an element's attributes style it,
      // and makes the document stand-ins inherit nothing; it holds nothing else.
      const selectors = rule.selectors.map(compact);
      if (selectors.every((selector) => selector.startsWith(compact(FLOOR)))) {
        collect(floors, rule);
        problems.push(...rollbackProblems(rule, 'revert', 'the floor'));
      } else if (selectors.every((selector) => attributeStyled.has(selector))) {
        collect(floors, rule);
        problems.push(...rollbackProblems(rule, 'revert-layer', 'the floor'));
      } else if (selectors.length === 1 && selectors[0] === compact(AS_DOCUMENT)) {
        documentReset ||= rule.some(
          (node) => node.type === 'decl' && node.prop === 'all' && node.value === 'initial',
        );
      } else {
        problems.push(`in the floor, not one of its rules: ${rule.selector}`);
      }
    }
    for (const selector of rule.selectors) {
      const compacted = compact(selector);
      if (compacted === TOKEN_RULE) {
        rule.each((node) => {
          if (node.type === 'decl' && !OWN_PROPERTY.test(node.prop)) {
            problems.push(`${selector} sets ${node.prop}: it may set only --consola-agent-ui-*`);
          }
        });
        continue;
      }
      if (!isScoped(selector)) problems.push(`unscoped selector: ${selector}`);
      // Dark mode is the chat's own `dark`, never a page's or the system's.
      if (compacted.split(compact(OWN_DARK)).join('').match(DARK_CLASS)) {
        problems.push(`a .dark that is not the chat's own: ${selector}`);
      }
    }
    rule.walkDecls((decl) => {
      const selectors = rule.selectors.map(compact);
      if (decl.prop === '--background' && selectors.includes(compact(AS_DOCUMENT))) theme = true;
      if (decl.prop === '--background' && decl.value === 'var(--consola-agent-ui-bg)') {
        mapping = true;
      }
      if (
        decl.prop === 'display' &&
        decl.value === 'flex' &&
        selectors.includes(compact(`${INSIDE} .flex`))
      ) {
        utility = true;
      }
    });
  });

  const rollsBack = (rules: readonly Rule[] | undefined, prop: string) =>
    (rules ?? []).some((rule) => rule.some((node) => node.type === 'decl' && node.prop === prop));
  /** What is missing from the guard or the floor, which roll back from `prefix` with `value`. */
  const incomplete = (rules: Map<string, Rule[]>, prefix: string, value: string, what: string) => {
    const element = rules.get(guardKey(prefix));
    if (!rollsBack(element, 'all')) return [`no ${what} (${prefix} { all: ${value} })`];
    const missing: string[] = [];
    const left = GUARDED_PSEUDO_ELEMENTS.filter((pseudo) =>
      pseudoSelectors(prefix, pseudo).some((selector) => !rollsBack(rules.get(selector), 'all')),
    );
    if (left.length > 0) missing.push(`no ${what} for ${left.join(', ')}`);
    for (const property of ['direction', 'unicode-bidi', ...properties]) {
      if (!rollsBack(element, property)) missing.push(`the ${what} does not roll back ${property}`);
    }
    return missing;
  };
  problems.push(...incomplete(guards, GUARDED, 'revert-layer', 'guard'));
  const rootGuard = guards.get(guardKey(ROOT_GUARDED));
  for (const property of ['contain', 'height']) {
    if (!rollsBack(rootGuard, property)) {
      problems.push(`the root's guard (${ROOT_GUARDED}) does not roll back ${property}`);
    }
  }
  problems.push(...incomplete(floors, FLOOR, 'revert', 'floor'));
  const unstyled = ATTRIBUTE_STYLED.filter(
    ([attribute]) => !floors.has(guardKey(`${INSIDE} ${attribute}`)),
  );
  if (unstyled.length > 0) {
    problems.push(`the floor takes away what ${unstyled.map(([a]) => a).join(', ')} style`);
  }
  if (!documentReset) {
    problems.push(
      `the floor does not reset the document stand-ins (${AS_DOCUMENT} { all: initial })`,
    );
  }
  if (sublayers[0] !== RESET_LAYER) {
    problems.push(
      `the floor is not the chat layer's lowest sublayer (${FLOOR_LAYER}; first: ${sublayers[0] ?? 'none'})`,
    );
  }
  if (!theme) problems.push(`no t3 theme variable (--background on ${AS_DOCUMENT})`);
  if (!utility) problems.push(`no Tailwind utility (${INSIDE} .flex)`);
  if (!mapping) problems.push("no mapping of t3's theme to Consola's tokens (src/styles.css)");

  return {
    problems,
    pageGlobal: {
      keyframes,
      properties,
      fontFamilies: [...fontFamilies],
      layers: [...layers],
    },
  };
};

const isMain = process.argv[1] === import.meta.filename;
if (isMain) {
  const path = fileURLToPath(new URL('../dist/agent-ui.css', import.meta.url));
  let css: string;
  try {
    css = readFileSync(path, 'utf8');
  } catch (cause) {
    process.stderr.write(
      `No built stylesheet at ${path}: run pnpm build first (${String(cause)}).\n`,
    );
    process.exit(1);
  }
  const { problems, pageGlobal } = checkBuiltCss(css);
  for (const problem of problems) process.stderr.write(`error: ${problem}\n`);
  if (problems.length > 0) process.exit(1);
  process.stdout.write(
    `dist/agent-ui.css: every rule scoped to the chat and in its layer, over the floor and under the guard. Page-global: ${pageGlobal.keyframes.length} @keyframes (${pageGlobal.keyframes.join(', ')}), ${pageGlobal.properties.length} @property (--tw-* and --assistant-citation-highlight-opacity), @font-face ${pageGlobal.fontFamilies.join(', ')}, @layer ${pageGlobal.layers.join(', ')}.\n`,
  );
}
