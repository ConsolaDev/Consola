// @effect-diagnostics nodeBuiltinImport:off - A build script: it reads the build's output.
/**
 * Checks the built stylesheet, `dist/agent-ui.css` (`@consola/agent-ui/styles.css`), which a page
 * imports: that it holds the chat's styles (t3's theme, Tailwind's utilities, Consola's mapping)
 * and that they style nothing but the chat. Every rule must be scoped (`build/scopeCss.ts`); what
 * is page-global anyway is a short list of at-rules that style nothing by themselves (AGENTS.md,
 * "What is page-global"). The browser tests import the stylesheet from source, so this is what
 * notices a build that drops it or loses its scope. Run after `pnpm build`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import {
  AS_DOCUMENT,
  DARK_CLASS,
  INSIDE,
  insideKeyframes,
  OWN_DARK,
  PORTAL_CLASS,
  SCOPE_CLASS,
} from './scopeCss.ts';

/** Commas without the spaces a minifier drops, so a selector compares as scopeCss wrote it. */
const compact = (selector: string) => selector.replace(/\s*,\s*/g, ',').trim();

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

const SCOPED_PREFIXES = [compact(INSIDE), compact(AS_DOCUMENT), ...OWN_PREFIXES];

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
 * Whether a selector applies only inside the chat. A minifier merges selectors into one
 * `:is(a, b)`, so such a selector is scoped when each of its arguments is.
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
      (compacted.startsWith(prefix) && /^[\s.:[>+~]/.test(compacted.slice(prefix.length))),
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

  root.walkAtRules((atRule) => {
    const name = atRule.name.toLowerCase();
    if (name === 'layer') {
      for (const layer of atRule.params.split(',')) if (layer.trim()) layers.add(layer.trim());
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
    `dist/agent-ui.css: every rule scoped to the chat. Page-global: ${pageGlobal.keyframes.length} @keyframes (${pageGlobal.keyframes.join(', ')}), ${pageGlobal.properties.length} @property (--tw-* and --assistant-citation-highlight-opacity), @font-face ${pageGlobal.fontFamilies.join(', ')}, @layer ${pageGlobal.layers.join(', ')}.\n`,
  );
}
