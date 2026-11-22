// @effect-diagnostics nodeBuiltinImport:off - A build script: it reads the build's output.
/**
 * Checks the built stylesheet, `dist/agent-ui.css` (`@consola/agent-ui/styles.css`), which a page
 * imports: that it holds the chat's styles (t3's theme, Tailwind's utilities, Consola's mapping)
 * and that they style nothing but the chat. Every rule must be scoped (`build/scopeCss.ts`); what
 * is page-global anyway is a short list of at-rules that style nothing by themselves (AGENTS.md,
 * "What is page-global"). Every rule is in the chat's cascade layer but the guard's, which roll
 * back what a page's rules set inside the chat and set nothing themselves (AGENTS.md, "The page's
 * CSS"). The browser tests import the stylesheet from source, so this is what notices a build
 * that drops it, loses its scope or its layer, or the guard. Run after `pnpm build`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss, { type AtRule, type Node, type Rule } from 'postcss';
import {
  AS_DOCUMENT,
  CHAT_LAYER,
  compact,
  DARK_CLASS,
  GUARDED,
  GUARDED_PSEUDO_ELEMENTS,
  INSIDE,
  insideKeyframes,
  isGuard,
  OWN_DARK,
  PORTAL_CLASS,
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

const SCOPED_PREFIXES = [compact(INSIDE), compact(AS_DOCUMENT), compact(GUARDED), ...OWN_PREFIXES];

/** Whether a layer name is the chat's layer or one of its sublayers (`consola-agent-ui.base`). */
const isChatLayerName = (name: string) => name === CHAT_LAYER || name.startsWith(`${CHAT_LAYER}.`);

/** Whether a node is inside an `@layer` block of the chat's (a minifier may write its sublayers dotted). */
const inChatLayer = (node: Node): boolean => {
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (parent.type === 'atrule' && (parent as AtRule).name.toLowerCase() === 'layer') {
      const names = (parent as AtRule).params.split(',').map((name) => name.trim());
      if (parent.parent?.type === 'root') return names.every(isChatLayerName);
    }
  }
  return false;
};

/**
 * A guard selector compared as written: CSS 2's pseudo-elements in either spelling (a minifier
 * writes `::before` as `:before`).
 */
const guardKey = (selector: string) =>
  compact(selector).replace(/(?<!:):(before|after|first-line|first-letter)\b/g, '::$1');

/** The guard's selectors for `pseudo` (`GUARDED_PSEUDO_ELEMENTS`), as scopeCss writes them. */
const guardSelectors = (pseudo: string) =>
  pseudo.split(',').map((part) => guardKey(`${GUARDED}${part.trim()}`));

/** What is wrong with a guard rule: it may only roll properties back, never set one. */
const guardProblems = (rule: Rule): string[] => {
  const problems: string[] = [];
  rule.each((node) => {
    if (node.type !== 'decl') return;
    const rollsBack = node.value.trim() === 'revert-layer' && !node.important;
    if (!rollsBack || (node.prop !== 'all' && !node.prop.startsWith('--'))) {
      problems.push(
        `the guard sets ${node.prop}: ${node.value} (${rule.selector}): it may only roll back`,
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
  readonly problems: ReadonlyArray<string>;
  /** What the stylesheet declares for the whole page (AGENTS.md lists these kinds). */
  readonly pageGlobal: {
    readonly keyframes: ReadonlyArray<string>;
    readonly properties: ReadonlyArray<string>;
    readonly fontFamilies: ReadonlyArray<string>;
    /** The layer names a page shares the cascade with: the chat's own, its sublayers inside it. */
    readonly layers: ReadonlyArray<string>;
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
  const guards = new Map<string, Rule[]>();

  root.walkAtRules((atRule) => {
    const name = atRule.name.toLowerCase();
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
        // A minifier merges the guard's rules that roll back the same properties into one.
        for (const selector of rule.selectors.map(guardKey)) {
          guards.set(selector, [...(guards.get(selector) ?? []), rule]);
        }
        problems.push(...guardProblems(rule));
      } else {
        problems.push(`outside the ${CHAT_LAYER} layer: ${rule.selector}`);
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

  const rollsBack = (rules: ReadonlyArray<Rule> | undefined, prop: string) =>
    (rules ?? []).some((rule) => rule.some((node) => node.type === 'decl' && node.prop === prop));
  const guard = guards.get(guardKey(GUARDED));
  if (!rollsBack(guard, 'all')) {
    problems.push(`no guard (${GUARDED} { all: revert-layer })`);
  } else {
    const unguarded = GUARDED_PSEUDO_ELEMENTS.filter((pseudo) =>
      guardSelectors(pseudo).some((selector) => !rollsBack(guards.get(selector), 'all')),
    );
    if (unguarded.length > 0) problems.push(`no guard for ${unguarded.join(', ')}`);
    for (const property of properties) {
      if (!rollsBack(guard, property)) problems.push(`the guard does not roll back ${property}`);
    }
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

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
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
    `dist/agent-ui.css: every rule scoped to the chat and in its layer, under the guard. Page-global: ${pageGlobal.keyframes.length} @keyframes (${pageGlobal.keyframes.join(', ')}), ${pageGlobal.properties.length} @property (--tw-* and --assistant-citation-highlight-opacity), @font-face ${pageGlobal.fontFamilies.join(', ')}, @layer ${pageGlobal.layers.join(', ')}.\n`,
  );
}
