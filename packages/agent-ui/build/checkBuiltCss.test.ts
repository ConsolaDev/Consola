import { describe, expect, it } from 'vite-plus/test';
import { checkBuiltCss } from './checkBuiltCss.ts';
import { compact, GUARDED, GUARDED_PSEUDO_ELEMENTS } from './scopeCss.ts';

const INSIDE = ':where(.consola-agent-ui,.consola-agent-ui-portal)';
const DOCUMENT = ':where(.consola-agent-ui .consola-agent-ui-theme,.consola-agent-ui-portal)';
const GUARD = compact(GUARDED);

/** Rules in the chat's layer, as scopeCss puts them there. */
const inLayer = (rules: string) => `@layer consola-agent-ui{${rules}}`;

/** The guard as scopeCss completes it, minified: rolling back `registered` too. */
const guard = (
  registered: ReadonlyArray<string>,
  pseudoElements: ReadonlyArray<string> = GUARDED_PSEUDO_ELEMENTS,
) =>
  [
    `${GUARD}{all:revert-layer${registered.map((name) => `;${name}:revert-layer`).join('')}}`,
    ...pseudoElements.map(
      (pseudo) =>
        `${compact(
          pseudo
            .split(',')
            .map((part) => `${GUARDED}${part.trim()}`)
            .join(','),
        )}{all:revert-layer}`,
    ),
  ].join('');

/** What the chat's stylesheet holds, minified as the build writes it. */
const CHAT = [
  inLayer(
    [
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

  it('reads the guard as a minifier merges it', () => {
    const merged = CHAT.replace(
      guard(['--tw-border-style']),
      [
        `${GUARD},${GUARD}:before,${GUARD}:after,${GUARD}::backdrop{all:revert-layer;--tw-border-style:revert-layer}`,
        // The rest, from ::marker on, without the element's rule.
        guard([], GUARDED_PSEUDO_ELEMENTS.slice(2)).replace(/^[^}]*\}/, ''),
      ].join(''),
    );
    expect(checkBuiltCss(merged).problems).toEqual([]);
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
    ]);
  });
});
