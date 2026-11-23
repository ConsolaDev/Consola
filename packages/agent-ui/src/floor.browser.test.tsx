// The floor (AGENTS.md, "The page's CSS") rolls every property of the chat's elements back to the
// browser's own styles, and in Chromium that also takes away what an element's own attributes
// style (presentational hints). `ATTRIBUTE_STYLED` (build/scopeCss.ts) names those attributes,
// where the floor lets their properties fall through. Here each element of a fixture of
// attribute-carrying elements, under the floor alone, computes as it does without it: an
// attribute the list misses, or a browser update that styles one from another property, fails.
import { afterEach, expect, it } from 'vite-plus/test';
import chatCss from './styles.css?inline';

/**
 * Elements carrying each attribute the floor lets through, as t3 renders them or a markdown
 * answer can: a lucide icon, text marked with a direction or a language, the composer's
 * `contenteditable`, a numbered list resumed after a code block (`start`), and so on. Every
 * HTML attribute of `ATTRIBUTE_STYLED` is here (checked below); of SVG's, the ones lucide uses.
 */
const FIXTURE = `
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5 12h14"/><circle cx="12" cy="12" r="3"/><line x1="1" y1="1" x2="9" y2="9"/>
    <rect x="2" y="2" width="4" height="4" rx="1"/>
  </svg>
  <p dir="auto">שלום Sprocket</p>
  <p dir="rtl">Acme</p>
  <bdi>Sprocket</bdi>
  <p lang="he">Acme</p>
  <div hidden>hidden</div>
  <div draggable="true">drag</div>
  <div contenteditable="true">composer</div>
  <div contenteditable="plaintext-only">composer</div>
  <img width="10" height="12" border="2" align="left" alt=""
    src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
  <p align="center">centred</p>
  <textarea wrap="off"></textarea>
  <table cellspacing="4" width="200">
    <tr>
      <td nowrap valign="top" bgcolor="#ff0000" align="right" width="50" height="20"
        background="data:image/gif;base64,R0lGODlhAQABAAAAACw=">Acme Sprocket</td>
    </tr>
  </table>
  <iframe frameborder="0" width="20" height="10"></iframe>
  <canvas width="30" height="20"></canvas>
  <ol type="a"><li type="i">one</li></ol>
  <ul type="square"><li>one</li></ul>
  <ol start="3"><li>three</li><li value="9">nine</li><li>ten</li></ol>
  <ol reversed><li>two</li><li>one</li></ol>
  <details><summary>Sprocket</summary><p>inside</p></details>
  <div inert><button type="button">Acme</button></div>
`;

/** The chat's floor alone: its layer's `reset` sublayer, from the stylesheet as scopeCss leaves it. */
const floorOnly = () => {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(chatCss);
  for (const rule of sheet.cssRules) {
    if (!(rule instanceof CSSLayerBlockRule) || rule.name !== 'consola-agent-ui') continue;
    for (const sublayer of rule.cssRules) {
      if (sublayer instanceof CSSLayerBlockRule && sublayer.name === 'reset') {
        return `@layer consola-agent-ui {\n${sublayer.cssText}\n}`;
      }
    }
  }
  throw new Error("the chat's stylesheet has no floor");
};

/** The floor's rules for the document stand-ins, which both readings keep. */
const isStandIn = (rule: CSSRule) =>
  rule instanceof CSSStyleRule && rule.selectorText.includes('.consola-agent-ui-theme');

const reset = (style: HTMLStyleElement) => {
  for (const rule of style.sheet?.cssRules ?? []) {
    if (!(rule instanceof CSSLayerBlockRule)) continue;
    const sublayer = rule.cssRules[0];
    if (sublayer instanceof CSSLayerBlockRule && sublayer.name === 'reset') return sublayer;
  }
  throw new Error('the floor did not load');
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** The fixture inside the chat's root and theme element, under the floor alone. */
const mountFixture = () => {
  const style = document.createElement('style');
  style.textContent = floorOnly();
  document.head.append(style);
  const root = document.createElement('div');
  root.className = 'consola-agent-ui';
  root.innerHTML = `<div class="consola-agent-ui-theme"><div id="fixture">${FIXTURE}</div></div>`;
  document.body.append(root);
  cleanups.push(() => {
    root.remove();
    style.remove();
  });
  return { style, fixture: root.querySelector('#fixture') as HTMLElement };
};

type Reading = Record<string, string>;

const computed = (element: Element, pseudo?: string): Reading => {
  const style = getComputedStyle(element, pseudo);
  const values: Reading = {};
  for (let index = 0; index < style.length; index++) {
    const name = style.item(index);
    if (!name.startsWith('--')) values[name] = style.getPropertyValue(name);
  }
  return values;
};

/** Every computed property of each element of the fixture, its `::marker`, and its box. */
const read = (fixture: HTMLElement): Record<string, Reading> => {
  const readings: Record<string, Reading> = {};
  for (const [index, element] of [...fixture.querySelectorAll('*')].entries()) {
    const name = `${index}:${element.outerHTML.slice(0, 60).replace(/\s+/g, ' ')}`;
    const { x, y, width, height } = element.getBoundingClientRect();
    readings[name] = { ...computed(element), box: `${x},${y} ${width}x${height}` };
    if (element.tagName === 'LI') readings[`${name}::marker`] = computed(element, '::marker');
  }
  return readings;
};

const differences = (without: Record<string, Reading>, withFloor: Record<string, Reading>) =>
  Object.entries(withFloor).flatMap(([name, values]) =>
    Object.entries(values).flatMap(([property, value]) =>
      without[name]?.[property] === value
        ? []
        : [`${name} ${property}: ${without[name]?.[property]} → ${value}`],
    ),
  );

it('takes nothing away from what an element of the chat is styled by its own attributes', () => {
  const { style, fixture } = mountFixture();
  const withFloor = read(fixture);

  const floor = reset(style);
  const taken: string[] = [];
  for (let index = floor.cssRules.length - 1; index >= 0; index--) {
    const rule = floor.cssRules[index] as CSSRule;
    if (isStandIn(rule)) continue;
    taken.push(rule.cssText);
    floor.deleteRule(index);
  }
  expect(taken.length).toBeGreaterThan(100);
  const without = read(fixture);

  expect(differences(without, withFloor)).toEqual([]);
});

it('has an element in the fixture for each HTML attribute the floor lets through', () => {
  const { style, fixture } = mountFixture();
  // The floor's attribute rules: those that only fall through (`revert-layer`). SVG's each set
  // exactly the property their attribute names (`[fill]` sets `fill`), and the fixture holds only
  // lucide's.
  const namesItsProperty = (rule: CSSStyleRule) => {
    const attribute = /\[([\w-]+)\]$/.exec(rule.selectorText)?.[1];
    if (attribute === undefined) return false;
    const probe = document.createElement('div').style;
    probe.setProperty(attribute, 'revert-layer');
    return [...probe].sort().join() === [...rule.style].sort().join();
  };
  const unexercised = [...reset(style).cssRules].flatMap((rule) => {
    if (!(rule instanceof CSSStyleRule) || isStandIn(rule)) return [];
    const properties = [...rule.style];
    if (!properties.every((name) => rule.style.getPropertyValue(name) === 'revert-layer')) {
      return [];
    }
    if (namesItsProperty(rule)) return [];
    const matched = [...document.querySelectorAll(rule.selectorText)].some((element) =>
      fixture.contains(element),
    );
    return matched ? [] : [rule.selectorText];
  });
  expect(unexercised).toEqual([]);
});
