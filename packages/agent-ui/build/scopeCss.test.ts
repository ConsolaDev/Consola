import postcss from 'postcss';
import type { ChildNode } from 'postcss';
import { describe, expect, it } from 'vite-plus/test';
import {
  AS_DOCUMENT,
  ATTRIBUTE_STYLED,
  compact,
  FLOOR,
  GUARDED,
  GUARDED_PSEUDO_ELEMENTS,
  INSIDE,
  OWN_DARK,
  ROOT_GUARDED,
  scopeCss,
  scopeSelector,
} from './scopeCss.ts';

/** A node, short: an at-rule's name and parameters, a rule's selector, a declaration. */
const shown = (node: ChildNode): string => {
  if (node.type === 'atrule') return `@${node.name} ${node.params}`;
  if (node.type === 'rule') return node.selector;
  if (node.type === 'decl') return `${node.prop}: ${node.value.trim()}`;
  return node.type;
};

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

describe('compact', () => {
  it('compares selectors however they were formatted', () => {
    expect(compact(':is(.a *, .b):not(\n  #c\n)  .d')).toBe(':is(.a *,.b):not(#c) .d');
    // Three IDs' weight: a page rule with one or two cannot tie it.
    expect(compact(GUARDED)).toBe(
      ':is(.consola-agent-ui *,.consola-agent-ui-portal,.consola-agent-ui-portal *):not(#consola-agent-ui-guard):not(#consola-agent-ui-guard):not(#consola-agent-ui-guard)',
    );
  });
});

describe('scopeCss', () => {
  it("rewrites a nested rule's dark, which only a minifier flattens", async () => {
    const { css } = await postcss([scopeCss()]).process(
      ':root { color-scheme: light; &:is(.dark, .dark *) { color-scheme: dark; } }',
      { from: undefined },
    );
    expect(css).toBe(
      `@layer consola-agent-ui { ${AS_DOCUMENT} { color-scheme: light; &:is(${OWN_DARK}, ${OWN_DARK} *) { color-scheme: dark; } } }`,
    );
  });

  it("puts the stylesheet in the chat's layer, in order, over the floor and under the guard", async () => {
    const { css } = await postcss([scopeCss()]).process(
      [
        '@layer theme, base;',
        '@layer base { * { margin: 0 } }',
        '.prose p { margin: 1em }',
        '@keyframes spin { to { rotate: 1turn } }',
        '@media (width >= 40rem) { .sm\\:flex { display: flex } }',
        '@property --tw-shadow { syntax: "*"; inherits: false }',
        `@layer reset { ${FLOOR} { all: revert; direction: revert } ${AS_DOCUMENT} { all: initial } }`,
        `${GUARDED} { all: revert-layer; direction: revert-layer }`,
        `${ROOT_GUARDED} { contain: revert-layer }`,
      ].join('\n'),
      { from: undefined },
    );
    const root = postcss.parse(css);
    const pseudoRules = (prefix: string) =>
      GUARDED_PSEUDO_ELEMENTS.map((pseudo) =>
        pseudo
          .split(',')
          .map((part) => `${prefix}${part.trim()}`)
          .join(', '),
      );
    expect(root.nodes.map(shown)).toEqual([
      '@layer consola-agent-ui',
      '@keyframes spin',
      '@layer consola-agent-ui',
      '@property --tw-shadow',
      GUARDED,
      ...pseudoRules(GUARDED),
      ROOT_GUARDED,
    ]);
    const [first, , second, , guard, beforeAfter, , marker] = root.nodes;
    // The floor is the chat layer's first sublayer, so its lowest; t3's layers are its other
    // sublayers, and t3's unlayered rules are the layer's own.
    expect(first?.type === 'atrule' && first.nodes?.map(shown)).toEqual([
      '@layer reset',
      '@layer theme, base',
      '@layer base',
      `${INSIDE} .prose p`,
    ]);
    expect(second?.type === 'atrule' && second.nodes?.map(shown)).toEqual([
      '@media (width >= 40rem)',
    ]);
    // The guard rolls back the registered properties too, on elements, ::before, ::after and
    // ::backdrop, and each pseudo-element as much as elements.
    expect(guard?.type === 'rule' && guard.nodes.map(shown)).toEqual([
      'all: revert-layer',
      'direction: revert-layer',
      '--tw-shadow: revert-layer',
    ]);
    expect(beforeAfter?.type === 'rule' && beforeAfter.nodes.map(shown)).toEqual([
      'all: revert-layer',
      'direction: revert-layer',
      '--tw-shadow: revert-layer',
    ]);
    expect(marker?.type === 'rule' && marker.nodes.map(shown)).toEqual([
      'all: revert-layer',
      'direction: revert-layer',
    ]);
    // The floor the same, with `revert`; then what attributes style falls through; then the
    // document stand-ins, as styles.css wrote them.
    const reset = first?.type === 'atrule' ? first.nodes?.[0] : undefined;
    const floorRules = reset?.type === 'atrule' ? (reset.nodes ?? []) : [];
    expect(floorRules.map(shown)).toEqual([
      FLOOR,
      ...pseudoRules(FLOOR),
      ...ATTRIBUTE_STYLED.map(([attribute]) => `${INSIDE} ${attribute}`),
      AS_DOCUMENT,
    ]);
    const [floor, floorBeforeAfter] = floorRules;
    expect(floor?.type === 'rule' && floor.nodes.map(shown)).toEqual([
      'all: revert',
      'direction: revert',
      '--tw-shadow: revert',
    ]);
    expect(floorBeforeAfter?.type === 'rule' && floorBeforeAfter.nodes.map(shown)).toEqual([
      'all: revert',
      'direction: revert',
      '--tw-shadow: revert',
    ]);
    const hidden = floorRules[1 + GUARDED_PSEUDO_ELEMENTS.length];
    expect(hidden?.type === 'rule' && hidden.nodes.map(shown)).toEqual([
      'display: revert-layer',
      'content-visibility: revert-layer',
    ]);
  });
});
