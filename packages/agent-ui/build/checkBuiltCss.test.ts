import { describe, expect, it } from 'vite-plus/test';
import { checkBuiltCss } from './checkBuiltCss.ts';
import {
  ATTRIBUTE_STYLED,
  compact,
  FLOOR,
  GUARDED,
  GUARDED_PSEUDO_ELEMENTS,
  ROOT_GUARDED,
} from './scopeCss.ts';

const INSIDE = ':where(.consola-agent-ui,.consola-agent-ui-portal)';
const DOCUMENT = ':where(.consola-agent-ui .consola-agent-ui-theme,.consola-agent-ui-portal)';
const GUARD = compact(GUARDED);
const FLOORED = compact(FLOOR);
const ROOT_GUARD = `${compact(ROOT_GUARDED)}{contain:revert-layer;height:revert-layer}`;

/** Rules in the chat's layer, as scopeCss puts them there. */
const inLayer = (rules: string) => `@layer consola-agent-ui{${rules}}`;

/**
 * A rule of the guard's or the floor's for elements, from `prefix`, and one for each of
 * `pseudoElements`, as scopeCss completes them, minified: rolling back with `value`, the
 * registered properties too.
 */
const rollback = (
  prefix: string,
  value: string,
  registered: readonly string[],
  pseudoElements: readonly string[] = GUARDED_PSEUDO_ELEMENTS,
) =>
  [
    `${compact(prefix)}{all:${value};direction:${value};unicode-bidi:${value}${registered.map((name) => `;${name}:${value}`).join('')}}`,
    ...pseudoElements.map(
      (pseudo) =>
        `${compact(
          pseudo
            .split(',')
            .map((part) => `${prefix}${part.trim()}`)
            .join(','),
        )}{all:${value}}`,
    ),
  ].join('');

/** The guard as scopeCss completes it, minified (the root's guard aside). */
const guard = (registered: readonly string[], pseudoElements?: readonly string[]) =>
  rollback(GUARDED, 'revert-layer', registered, pseudoElements);

/** What the floor lets fall through to the attributes that style an element. */
const ATTRIBUTE_RULES = ATTRIBUTE_STYLED.map(
  ([attribute, properties]) =>
    `${compact(`${INSIDE} ${attribute}`)}{${properties.map((name) => `${name}:revert-layer`).join(';')}}`,
).join('');
const DOCUMENT_RESET = `${DOCUMENT}{all:initial;display:block;direction:ltr}`;

/** The floor, the chat layer's first sublayer, as scopeCss completes it, minified. */
const floor = (registered: readonly string[]) =>
  `@layer reset{${rollback(FLOOR, 'revert', registered)}${ATTRIBUTE_RULES}${DOCUMENT_RESET}}`;

/** What the chat's stylesheet holds, minified as the build writes it. */
const CHAT = [
  inLayer(
    [
      floor(['--tw-border-style']),
      `${DOCUMENT}{--background:#fff}`,
      `${INSIDE} .flex{display:flex}`,
      ':where([data-theme]):not(.consola-agent-ui){--consola-agent-ui-bg:var(--color-bg-primary)}',
      ':where([data-theme]) .consola-agent-ui .consola-agent-ui-theme{--background:var(--consola-agent-ui-bg)}',
      ':where([data-theme]) .consola-agent-ui-portal[data-base-ui-portal]{--background:var(--consola-agent-ui-bg)}',
      '.consola-agent-ui{contain:layout;height:100%}',
      '@layer base{@media (min-width:40rem){:where(.consola-agent-ui,.consola-agent-ui-portal) .sm\\:flex{display:flex}}}',
    ].join(''),
  ),
  guard(['--tw-border-style']),
  ROOT_GUARD,
  '@keyframes spin{to{transform:rotate(360deg)}}',
  '@property --tw-border-style{syntax:"*";inherits:false;initial-value:solid}',
  '@font-face{font-family:KaTeX_Main;src:url(x.woff2)}',
].join('');

describe('checkBuiltCss', () => {
  it("passes the chat's stylesheet and lists what is page-global", () => {
    const { problems, pageGlobal } = checkBuiltCss(CHAT);
    expect(problems).toEqual([]);
    expect(pageGlobal).toEqual({
      keyframes: ['spin'],
      properties: ['--tw-border-style'],
      fontFamilies: ['KaTeX_Main'],
      layers: ['consola-agent-ui'],
    });
  });

  it("fails a stylesheet without the chat's styles (only what t3's modules import)", () => {
    const katexOnly = inLayer(`${INSIDE} .katex{font:normal 1.21em KaTeX_Main}`);
    expect(checkBuiltCss(katexOnly).problems).toEqual([
      `no guard (${GUARDED} { all: revert-layer })`,
      `the root's guard (${ROOT_GUARDED}) does not roll back contain`,
      `the root's guard (${ROOT_GUARDED}) does not roll back height`,
      `no floor (${FLOOR} { all: revert })`,
      `the floor takes away what ${ATTRIBUTE_STYLED.map(([attribute]) => attribute).join(', ')} style`,
      `the floor does not reset the document stand-ins (${DOCUMENT.replace(',', ', ')} { all: initial })`,
      "the floor is not the chat layer's lowest sublayer (consola-agent-ui.reset; first: none)",
      `no t3 theme variable (--background on ${DOCUMENT.replace(',', ', ')})`,
      `no Tailwind utility (${INSIDE.replace(',', ', ')} .flex)`,
      "no mapping of t3's theme to Consola's tokens (src/styles.css)",
    ]);
  });

  it('fails a rule that applies outside the chat', () => {
    expect(
      checkBuiltCss(`${CHAT}${inLayer('body{margin:0}.flex{display:flex}')}`).problems,
    ).toEqual(['unscoped selector: body', 'unscoped selector: .flex']);
    // A prefix that only starts the same way is not the scope.
    expect(
      checkBuiltCss(`${CHAT}${inLayer('.consola-agent-ui-other{color:red}')}`).problems,
    ).toEqual(['unscoped selector: .consola-agent-ui-other']);
  });

  it('fails a sibling combinator straight after the scope, which styles the page beside the chat', () => {
    const leaks = [
      '.consola-agent-ui+p',
      '.consola-agent-ui ~ p',
      `${INSIDE}~p`,
      '.consola-agent-ui:hover+p',
      '.consola-agent-ui[data-x] ~ .page',
      `${GUARD}+p`,
    ];
    expect(
      checkBuiltCss(`${CHAT}${inLayer(leaks.map((leak) => `${leak}{color:red}`).join(''))}`)
        .problems,
    ).toEqual(leaks.map((leak) => `unscoped selector: ${leak}`));
    // Siblings inside the chat stay inside it.
    const inside = [`${INSIDE} .a+.b`, '.consola-agent-ui>.a~.b', '.consola-agent-ui :is(.a+.b)'];
    expect(
      checkBuiltCss(`${CHAT}${inLayer(inside.map((rule) => `${rule}{color:red}`).join(''))}`)
        .problems,
    ).toEqual([]);
  });

  it("takes dark mode only from the chat's own dark class", () => {
    const own = ':where(.consola-agent-ui-theme,.consola-agent-ui-portal).dark';
    expect(
      checkBuiltCss(`${CHAT}${inLayer(`${INSIDE} .a:is(${own},${own} *){color:red}`)}`).problems,
    ).toEqual([]);
    expect(
      checkBuiltCss(`${CHAT}${inLayer(`${INSIDE} .a:is(.dark,.dark *){color:red}`)}`).problems,
    ).toEqual([`a .dark that is not the chat's own: ${INSIDE} .a:is(.dark,.dark *)`]);
    // Tailwind's escaped variant names are class names, not the class `dark`.
    expect(
      checkBuiltCss(`${CHAT}${inLayer(`${INSIDE} .dark\\:flex:is(${own}){display:flex}`)}`)
        .problems,
    ).toEqual([]);
  });

  it('reads selectors a minifier merged into one :is()', () => {
    expect(
      checkBuiltCss(`${CHAT}${inLayer(`:is(${INSIDE} .a:hover,${INSIDE} .b:hover){color:red}`)}`)
        .problems,
    ).toEqual([]);
    expect(
      checkBuiltCss(`${CHAT}${inLayer(`:is(${INSIDE} .a:hover,.b:hover){color:red}`)}`).problems,
    ).toEqual([`unscoped selector: :is(${INSIDE} .a:hover,.b:hover)`]);
  });

  it("lets the page's [data-theme] rule set only the package's own properties", () => {
    const leaky = ':where([data-theme]):not(.consola-agent-ui){color:red}';
    expect(checkBuiltCss(`${CHAT}${inLayer(leaky)}`).problems).toEqual([
      ':where([data-theme]):not(.consola-agent-ui) sets color: it may set only --consola-agent-ui-*',
    ]);
  });

  it("keeps every rule in the chat's layer but the guard, and no layer a page shares", () => {
    const utility = `${INSIDE} .p-4{padding:1rem}`;
    expect(checkBuiltCss(`${CHAT}${utility}`).problems).toEqual([
      `outside the consola-agent-ui layer: ${INSIDE} .p-4`,
    ]);
    expect(checkBuiltCss(`${CHAT}@layer utilities{${utility}}`).problems).toEqual([
      '@layer utilities: a layer outside consola-agent-ui, which a page shares',
      `outside the consola-agent-ui layer: ${INSIDE} .p-4`,
    ]);
    // A minifier may write the chat's sublayers dotted, at the top.
    const dotted = checkBuiltCss(
      `${CHAT}@layer consola-agent-ui.theme,consola-agent-ui.utilities;@layer consola-agent-ui.utilities{${utility}}`,
    );
    expect(dotted.problems).toEqual([]);
    expect(dotted.pageGlobal.layers).toEqual(['consola-agent-ui']);
  });

  it('reads the guard and the floor as a minifier merges them', () => {
    const merged = (prefix: string, value: string) =>
      [
        `${prefix},${prefix}:before,${prefix}:after,${prefix}::backdrop{all:${value};direction:${value};unicode-bidi:${value};--tw-border-style:${value}}`,
        // The rest, from ::marker on, without the element's rule.
        rollback(prefix, value, [], GUARDED_PSEUDO_ELEMENTS.slice(2)).replace(/^[^}]*\}/, ''),
      ].join('');
    const both = CHAT.replace(guard(['--tw-border-style']), merged(GUARD, 'revert-layer')).replace(
      rollback(FLOOR, 'revert', ['--tw-border-style']),
      merged(FLOORED, 'revert'),
    );
    expect(both).not.toBe(CHAT);
    expect(checkBuiltCss(both).problems).toEqual([]);
  });

  it('fails a guard that sets a property, or that leaves one unguarded', () => {
    expect(checkBuiltCss(`${CHAT}${GUARD}::before{color:red}`).problems).toEqual([
      `the guard sets color: red (${GUARD}::before): it may only roll back`,
    ]);
    expect(checkBuiltCss(`${CHAT}${GUARD}{margin:revert-layer!important}`).problems).toEqual([
      `the guard sets margin: revert-layer (${GUARD}): it may only roll back`,
    ]);
    const unguarded = CHAT.replace(guard(['--tw-border-style']), guard([], ['::before, ::after']));
    expect(checkBuiltCss(unguarded).problems).toEqual([
      `no guard for ${GUARDED_PSEUDO_ELEMENTS.slice(1).join(', ')}`,
      'the guard does not roll back --tw-border-style',
    ]);
    const noDirection = CHAT.replace(
      `${GUARD}{all:revert-layer;direction:revert-layer;`,
      `${GUARD}{all:revert-layer;`,
    );
    expect(checkBuiltCss(noDirection).problems).toEqual(['the guard does not roll back direction']);
    expect(checkBuiltCss(CHAT.replace(ROOT_GUARD, '')).problems).toEqual([
      `the root's guard (${ROOT_GUARDED}) does not roll back contain`,
      `the root's guard (${ROOT_GUARDED}) does not roll back height`,
    ]);
    expect(checkBuiltCss(CHAT.replace(guard(['--tw-border-style']), '')).problems).toEqual([
      `no guard (${GUARDED} { all: revert-layer })`,
    ]);
  });

  it('fails page-global at-rules not known to be harmless, and the system colour scheme', () => {
    const extra = [
      '@property --page-colour{syntax:"<color>";inherits:true;initial-value:red}',
      '@counter-style thumbs{system:cyclic;symbols:"👍"}',
      inLayer(`@media (prefers-color-scheme:dark){${INSIDE} .a{color:red}}`),
    ].join('');
    expect(checkBuiltCss(`${CHAT}${extra}`).problems).toEqual([
      '@property --page-colour: a page-global property not listed as harmless',
      '@counter-style thumbs: an at-rule kind not known to be harmless',
      "@media (prefers-color-scheme:dark): dark mode is Consola's, never the system's",
      'the guard does not roll back --page-colour',
      'the floor does not roll back --page-colour',
    ]);
  });

  it('fails a floor that is not the lowest sublayer, sets a value, or takes away what attributes style', () => {
    const base = `@layer base{${INSIDE} *{margin:0}}`;
    const above = CHAT.replace(
      floor(['--tw-border-style']),
      `${base}${floor(['--tw-border-style'])}`,
    );
    expect(checkBuiltCss(above).problems).toEqual([
      "the floor is not the chat layer's lowest sublayer (consola-agent-ui.reset; first: base)",
    ]);
    // Named first in a statement, it is the lowest, wherever its block is.
    const named = CHAT.replace(
      floor(['--tw-border-style']),
      `@layer reset,base;${base}${floor(['--tw-border-style'])}`,
    );
    expect(checkBuiltCss(named).problems).toEqual([]);
    const setting = CHAT.replace(`${FLOORED}{all:revert;`, `${FLOORED}{all:revert;margin:0;`);
    expect(checkBuiltCss(setting).problems).toEqual([
      `the floor sets margin: 0 (${FLOORED}): it may only roll back`,
    ]);
    const hidden = `${compact(`${INSIDE} [hidden]`)}{display:revert-layer;content-visibility:revert-layer}`;
    expect(checkBuiltCss(CHAT.replace(hidden, '')).problems).toEqual([
      'the floor takes away what [hidden] style',
    ]);
    expect(checkBuiltCss(CHAT.replace(DOCUMENT_RESET, '')).problems).toEqual([
      `the floor does not reset the document stand-ins (${DOCUMENT.replace(',', ', ')} { all: initial })`,
    ]);
    const stray = CHAT.replace(DOCUMENT_RESET, `${DOCUMENT_RESET}${INSIDE} .p-4{padding:1rem}`);
    expect(checkBuiltCss(stray).problems).toEqual([
      `in the floor, not one of its rules: ${INSIDE} .p-4`,
    ]);
  });
});
