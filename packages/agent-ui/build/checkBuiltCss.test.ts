import { describe, expect, it } from 'vite-plus/test';
import { checkBuiltCss } from './checkBuiltCss.ts';

const INSIDE = ':where(.consola-agent-ui,.consola-agent-ui-portal)';
const DOCUMENT = ':where(.consola-agent-ui .consola-agent-ui-theme,.consola-agent-ui-portal)';

/** What the chat's stylesheet holds, minified as the build writes it. */
const CHAT = [
  `${DOCUMENT}{--background:#fff}`,
  `${INSIDE} .flex{display:flex}`,
  ':where([data-theme]):not(.consola-agent-ui){--consola-agent-ui-bg:var(--color-bg-primary)}',
  ':where([data-theme]) .consola-agent-ui .consola-agent-ui-theme{--background:var(--consola-agent-ui-bg)}',
  ':where([data-theme]) .consola-agent-ui-portal[data-base-ui-portal]{--background:var(--consola-agent-ui-bg)}',
  '.consola-agent-ui{contain:layout;height:100%}',
  '@layer base{@media (min-width:40rem){:where(.consola-agent-ui,.consola-agent-ui-portal) .sm\\:flex{display:flex}}}',
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
      layers: ['base'],
    });
  });

  it("fails a stylesheet without the chat's styles (only what t3's modules import)", () => {
    const katexOnly = `${INSIDE} .katex{font:normal 1.21em KaTeX_Main}`;
    expect(checkBuiltCss(katexOnly).problems).toEqual([
      `no t3 theme variable (--background on ${DOCUMENT.replace(',', ', ')})`,
      `no Tailwind utility (${INSIDE.replace(',', ', ')} .flex)`,
      "no mapping of t3's theme to Consola's tokens (src/styles.css)",
    ]);
  });

  it('fails a rule that applies outside the chat', () => {
    expect(checkBuiltCss(`${CHAT}body{margin:0}.flex{display:flex}`).problems).toEqual([
      'unscoped selector: body',
      'unscoped selector: .flex',
    ]);
    // A prefix that only starts the same way is not the scope.
    expect(checkBuiltCss(`${CHAT}.consola-agent-ui-other{color:red}`).problems).toEqual([
      'unscoped selector: .consola-agent-ui-other',
    ]);
  });

  it("takes dark mode only from the chat's own dark class", () => {
    const own = ':where(.consola-agent-ui-theme,.consola-agent-ui-portal).dark';
    expect(checkBuiltCss(`${CHAT}${INSIDE} .a:is(${own},${own} *){color:red}`).problems).toEqual(
      [],
    );
    expect(checkBuiltCss(`${CHAT}${INSIDE} .a:is(.dark,.dark *){color:red}`).problems).toEqual([
      `a .dark that is not the chat's own: ${INSIDE} .a:is(.dark,.dark *)`,
    ]);
    // Tailwind's escaped variant names are class names, not the class `dark`.
    expect(
      checkBuiltCss(`${CHAT}${INSIDE} .dark\\:flex:is(${own}){display:flex}`).problems,
    ).toEqual([]);
  });

  it('reads selectors a minifier merged into one :is()', () => {
    expect(
      checkBuiltCss(`${CHAT}:is(${INSIDE} .a:hover,${INSIDE} .b:hover){color:red}`).problems,
    ).toEqual([]);
    expect(checkBuiltCss(`${CHAT}:is(${INSIDE} .a:hover,.b:hover){color:red}`).problems).toEqual([
      `unscoped selector: :is(${INSIDE} .a:hover,.b:hover)`,
    ]);
  });

  it("lets the page's [data-theme] rule set only the package's own properties", () => {
    const leaky = ':where([data-theme]):not(.consola-agent-ui){color:red}';
    expect(checkBuiltCss(`${CHAT}${leaky}`).problems).toEqual([
      ':where([data-theme]):not(.consola-agent-ui) sets color: it may set only --consola-agent-ui-*',
    ]);
  });

  it('fails page-global at-rules not known to be harmless, and the system colour scheme', () => {
    const extra = [
      '@property --page-colour{syntax:"<color>";inherits:true;initial-value:red}',
      '@counter-style thumbs{system:cyclic;symbols:"👍"}',
      `@media (prefers-color-scheme:dark){${INSIDE} .a{color:red}}`,
    ].join('');
    expect(checkBuiltCss(`${CHAT}${extra}`).problems).toEqual([
      '@property --page-colour: a page-global property not listed as harmless',
      '@counter-style thumbs: an at-rule kind not known to be harmless',
      "@media (prefers-color-scheme:dark): dark mode is Consola's, never the system's",
    ]);
  });
});
