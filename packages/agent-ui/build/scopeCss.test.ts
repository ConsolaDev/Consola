import postcss from 'postcss';
import { describe, expect, it } from 'vite-plus/test';
import { AS_DOCUMENT, INSIDE, OWN_DARK, scopeCss, scopeSelector } from './scopeCss.ts';

describe('scopeSelector', () => {
  it("moves t3's document onto the theme element and everything else inside the chat", () => {
    expect(scopeSelector(':root')).toBe(AS_DOCUMENT);
    expect(scopeSelector('html body')).toBe(`${AS_DOCUMENT} body`);
    expect(scopeSelector('.flex')).toBe(`${INSIDE} .flex`);
    expect(scopeSelector('.consola-agent-ui .consola-agent-ui-theme')).toBe(
      '.consola-agent-ui .consola-agent-ui-theme',
    );
  });

  it("makes t3's dark (and light) variants follow only the chat's own dark class", () => {
    expect(scopeSelector(':root:is(.dark, .dark *)')).toBe(
      `${AS_DOCUMENT}:is(${OWN_DARK}, ${OWN_DARK} *)`,
    );
    expect(scopeSelector('.border:not(.dark, .dark *)')).toBe(
      `${INSIDE} .border:not(${OWN_DARK}, ${OWN_DARK} *)`,
    );
  });

  it('leaves class names that only contain "dark" alone', () => {
    expect(scopeSelector('.dark\\:bg-x:is(.dark, .dark *)')).toBe(
      `${INSIDE} .dark\\:bg-x:is(${OWN_DARK}, ${OWN_DARK} *)`,
    );
    expect(scopeSelector('.not-dark\\:hidden')).toBe(`${INSIDE} .not-dark\\:hidden`);
    expect(scopeSelector('.dark-panel')).toBe(`${INSIDE} .dark-panel`);
    expect(scopeSelector('.w-0\\.dark')).toBe(`${INSIDE} .w-0\\.dark`);
  });
});

describe('scopeCss', () => {
  it("rewrites a nested rule's dark, which only a minifier flattens", async () => {
    const { css } = await postcss([scopeCss()]).process(
      ':root { color-scheme: light; &:is(.dark, .dark *) { color-scheme: dark; } }',
      { from: undefined },
    );
    expect(css).toBe(
      `${AS_DOCUMENT} { color-scheme: light; &:is(${OWN_DARK}, ${OWN_DARK} *) { color-scheme: dark; } }`,
    );
  });
});
