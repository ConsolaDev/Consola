import { describe, expect, it } from 'vitest';
import {
  actRefusalIn,
  clickInPage,
  fillInPage,
  type PageKeyPress,
  pressInPage,
  scrollInPage,
} from './pageInput';

/*
 * A small stand-in for the page's DOM: just what the in-page acts touch,
 * logging every event dispatched and every editing command, in order.
 */

class FakeEvent {
  defaultPrevented = false;
  constructor(
    public readonly type: string,
    public readonly init: Record<string, unknown>,
  ) {}
  preventDefault() {
    if (this.init.cancelable) this.defaultPrevented = true;
  }
}

type Listener = (event: FakeEvent) => void;

class FakeElement {
  parentNode: FakeElement | null = null;
  isConnected = true;
  isContentEditable = false;
  tabIndex = -1;
  readonly attributes = new Set<string>();
  type?: string;
  value?: string;
  disabled?: boolean;
  readOnly?: boolean;
  form?: { requestSubmit(): void } | null;
  shadowRoot?: { host: FakeElement; activeElement: FakeElement | null } | null;
  rect = { left: 10, top: 10, width: 100, height: 20 };
  hidden = false;
  scrollTop = 0;
  scrollLeft = 0;
  scrollHeight = 0;
  scrollWidth = 0;
  clientHeight = 0;
  clientWidth = 0;
  overflowY = 'visible';
  assigned?: string;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    public readonly ownerDocument: FakeDocument,
    public readonly tagName: string,
    public readonly id: string,
  ) {
    ownerDocument.all.push(this);
  }

  get parentElement() {
    return this.parentNode;
  }

  append(child: FakeElement): FakeElement {
    child.parentNode = this;
    return child;
  }

  on(type: string, listener: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  dispatchEvent(event: FakeEvent) {
    this.ownerDocument.log.push(`${event.type}@${this.id}`);
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return !event.defaultPrevented;
  }

  getBoundingClientRect() {
    const { left, top, width, height } = this.hidden
      ? { left: 0, top: 0, width: 0, height: 0 }
      : this.rect;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }

  getClientRects() {
    return { length: this.hidden ? 0 : 1 };
  }

  getRootNode() {
    return this.ownerDocument;
  }

  checkVisibility() {
    return !this.hidden;
  }

  matches(selector: string): boolean {
    return selector.split(',').some((part) => this.matchesOne(part.trim()));
  }

  private matchesOne(selector: string): boolean {
    if (selector === ':disabled') return !!this.disabled;
    const match = /^([a-z]*)(?:\[([a-z]+)(?:=([a-z]+))?\])?$/.exec(selector);
    if (!match) return false;
    const [, tag, attribute, value] = match;
    if (tag && tag.toUpperCase() !== this.tagName) return false;
    if (!attribute) return true;
    if (attribute === 'type') return (this.type ?? '') === value;
    return this.attributes.has(attribute);
  }

  closest(selector: string): FakeElement | null {
    let node: FakeElement | null = this;
    while (node && !node.matches(selector)) node = node.parentNode;
    return node;
  }

  hasAttribute(name: string) {
    return this.attributes.has(name);
  }

  focus() {
    this.ownerDocument.log.push(`focus@${this.id}`);
    this.ownerDocument.activeElement = this;
  }

  blur() {
    this.ownerDocument.log.push(`blur@${this.id}`);
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
    }
  }

  click() {
    this.ownerDocument.log.push(`click()@${this.id}`);
  }

  select() {
    this.ownerDocument.log.push(`select@${this.id}`);
    this.ownerDocument.selectedAll = true;
  }

  scrollIntoView() {
    this.ownerDocument.log.push(`scrollIntoView@${this.id}`);
    this.rect = { ...this.rect, left: 10, top: 10 };
  }

  scrollBy(options: { top?: number; left?: number }) {
    const room = this.scrollHeight - this.clientHeight;
    this.scrollTop = Math.min(room, Math.max(0, this.scrollTop + (options.top ?? 0)));
  }
}

class FakeDocument {
  readonly log: string[] = [];
  readonly all: FakeElement[] = [];
  activeElement: FakeElement | null = null;
  readonly documentElement: FakeElement;
  readonly body: FakeElement;
  atPoint: FakeElement | null = null;
  selectedAll = false;
  /** What execCommand does to the focused field; a date field refuses it. */
  editingWorks = true;
  readonly defaultView = {
    innerWidth: 800,
    innerHeight: 600,
    PointerEvent: FakeEvent,
    MouseEvent: FakeEvent,
    KeyboardEvent: FakeEvent,
    Event: FakeEvent,
    ShadowRoot: class FakeShadowRoot {},
    HTMLInputElement: { prototype: valueSetter() },
    HTMLTextAreaElement: { prototype: valueSetter() },
    getComputedStyle: (element: FakeElement) => ({
      overflowX: 'visible',
      overflowY: element.overflowY,
    }),
  };

  constructor() {
    this.documentElement = new FakeElement(this, 'HTML', 'html');
    this.body = this.documentElement.append(new FakeElement(this, 'BODY', 'body'));
    this.activeElement = this.body;
  }

  get scrollingElement() {
    return this.documentElement;
  }

  element(tagName: string, id: string, fields: Partial<FakeElement> = {}): FakeElement {
    return Object.assign(this.body.append(new FakeElement(this, tagName, id)), fields);
  }

  elementFromPoint() {
    return this.atPoint;
  }

  execCommand(command: string, _ui?: boolean, value?: string) {
    this.log.push(value === undefined ? `exec:${command}` : `exec:${command}:${value}`);
    const field = this.activeElement;
    if (!this.editingWorks || !field) return false;
    const held = field.value;
    if (held !== undefined) {
      if (command === 'insertText') field.value = this.selectedAll ? value : `${held}${value}`;
      if (command === 'delete') field.value = this.selectedAll ? '' : held.slice(0, -1);
    }
    this.selectedAll = false;
    return true;
  }

  createRange() {
    return { selectNodeContents: () => this.log.push('range:all') };
  }

  getSelection() {
    return { removeAllRanges: () => {}, addRange: () => (this.selectedAll = true) };
  }

  querySelectorAll(selector: string) {
    return this.all.filter((element) => element.matches(selector));
  }
}

function valueSetter() {
  return Object.defineProperty({}, 'value', {
    set(this: FakeElement, value: string) {
      this.assigned = value;
      this.value = value;
    },
  });
}

const page = (element: FakeElement) => element as unknown as HTMLElement;

function refusalOf(act: () => unknown): string | null {
  try {
    act();
  } catch (error) {
    return actRefusalIn((error as Error).message);
  }
  return null;
}

describe('clickInPage', () => {
  it('presses and releases on what is at the element’s centre, focusing it, in a browser’s order', () => {
    const doc = new FakeDocument();
    const button = doc.element('BUTTON', 'go', { tabIndex: 0 });
    doc.atPoint = button;
    expect(clickInPage(page(button))).toBe('clicked');
    expect(doc.log).toEqual([
      'pointerover@go',
      'mouseover@go',
      'pointermove@go',
      'mousemove@go',
      'pointerdown@go',
      'mousedown@go',
      'focus@go',
      'pointerup@go',
      'mouseup@go',
      'click@go',
    ]);
  });

  it('lands on the part of the element that is on top, and focuses the nearest focusable', () => {
    const doc = new FakeDocument();
    const link = doc.element('A', 'link', { tabIndex: 0 });
    link.attributes.add('href');
    const icon = link.append(new FakeElement(doc, 'SPAN', 'icon'));
    doc.atPoint = icon;
    clickInPage(page(link));
    expect(doc.log).toContain('click@icon');
    expect(doc.log).toContain('focus@link');
    expect(doc.activeElement).toBe(link);
  });

  it('gives a page that cancels the press no mouse events for it, and no focus, but still the click', () => {
    const doc = new FakeDocument();
    const target = doc.element('DIV', 'pad', { tabIndex: 0 });
    target.on('pointerdown', (event) => event.preventDefault());
    doc.atPoint = target;
    clickInPage(page(target));
    expect(doc.log).not.toContain('mousedown@pad');
    expect(doc.log).not.toContain('mouseup@pad');
    expect(doc.log).not.toContain('focus@pad');
    expect(doc.log.at(-1)).toBe('click@pad');
  });

  it('takes the focus away from a field when what is pressed cannot hold it', () => {
    const doc = new FakeDocument();
    const field = doc.element('INPUT', 'name', { tabIndex: 0, value: '' });
    const text = doc.element('P', 'text');
    field.focus();
    doc.atPoint = text;
    clickInPage(page(text));
    expect(doc.log).toContain('blur@name');
  });

  it('refuses an element something else covers, and sends nothing', () => {
    const doc = new FakeDocument();
    const button = doc.element('BUTTON', 'go', { tabIndex: 0 });
    doc.atPoint = doc.element('DIV', 'overlay');
    expect(refusalOf(() => clickInPage(page(button)))).toBe('covered');
    expect(doc.log).toEqual([]);
  });

  it('refuses an element that is not visible, or disabled', () => {
    const doc = new FakeDocument();
    const hidden = doc.element('BUTTON', 'hidden', { hidden: true });
    doc.atPoint = hidden;
    expect(refusalOf(() => clickInPage(page(hidden)))).toBe('not-visible');
    const off = doc.element('BUTTON', 'off', { disabled: true });
    doc.atPoint = off;
    expect(refusalOf(() => clickInPage(page(off)))).toBe('disabled');
    expect(doc.log).toEqual([]);
  });

  it('brings an element below the fold into view first', () => {
    const doc = new FakeDocument();
    const far = doc.element('BUTTON', 'far', {
      tabIndex: 0,
      rect: { left: 10, top: 2000, width: 50, height: 20 },
    });
    doc.atPoint = far;
    clickInPage(page(far));
    expect(doc.log[0]).toBe('scrollIntoView@far');
  });
});

describe('fillInPage', () => {
  it('types into a field through the page’s editing, replacing what it held', () => {
    const doc = new FakeDocument();
    const field = doc.element('INPUT', 'name', { type: 'text', value: 'old', tabIndex: 0 });
    expect(fillInPage(page(field), 'Ada')).toBe('typed');
    expect(doc.log).toEqual(['focus@name', 'select@name', 'exec:insertText:Ada']);
    expect(field.value).toBe('Ada');
  });

  it('empties a field with an empty text', () => {
    const doc = new FakeDocument();
    const field = doc.element('TEXTAREA', 'notes', { value: 'old', tabIndex: 0 });
    expect(fillInPage(page(field), '')).toBe('typed');
    expect(doc.log).toContain('exec:delete');
    expect(field.value).toBe('');
  });

  it('sets a field the editing cannot type into, as a script would, with its events', () => {
    const doc = new FakeDocument();
    doc.editingWorks = false;
    const date = doc.element('INPUT', 'when', { type: 'date', value: '', tabIndex: 0 });
    expect(fillInPage(page(date), '2026-11-20')).toBe('set');
    expect(date.assigned).toBe('2026-11-20');
    expect(doc.log.slice(-2)).toEqual(['input@when', 'change@when']);
  });

  it('types into editable text, all of it selected first', () => {
    const doc = new FakeDocument();
    const editor = doc.element('DIV', 'editor', { isContentEditable: true, tabIndex: 0 });
    expect(fillInPage(page(editor), 'rich')).toBe('typed');
    expect(doc.log).toEqual(['focus@editor', 'range:all', 'exec:insertText:rich']);
  });

  it.each([
    [{ tagName: 'SELECT' }, 'is-select'],
    [{ tagName: 'INPUT', type: 'file' }, 'file-input'],
    [{ tagName: 'INPUT', type: 'checkbox' }, 'not-text'],
    [{ tagName: 'DIV' }, 'not-editable'],
    [{ tagName: 'INPUT', type: 'text', disabled: true }, 'disabled'],
    [{ tagName: 'INPUT', type: 'text', readOnly: true }, 'read-only'],
  ])('refuses %j as %s, touching nothing', (fields, reason) => {
    const doc = new FakeDocument();
    const { tagName, ...rest } = fields as { tagName: string } & Partial<FakeElement>;
    const element = doc.element(tagName, 'x', rest);
    expect(refusalOf(() => fillInPage(page(element), 'a'))).toBe(reason);
    expect(doc.log).toEqual([]);
  });
});

const key = (fields: Partial<PageKeyPress>): PageKeyPress => ({
  key: 'a',
  code: 'KeyA',
  keyCode: 65,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  toFocused: false,
  ...fields,
});

describe('pressInPage', () => {
  it('sends keydown, keypress and keyup to the focused element, and types a character into a field', () => {
    const doc = new FakeDocument();
    const field = doc.element('INPUT', 'name', { type: 'text', value: '', tabIndex: 0 });
    field.focus();
    doc.log.length = 0;
    const codes: number[] = [];
    field.on('keydown', (event) => codes.push((event as unknown as { keyCode: number }).keyCode));
    expect(pressInPage(page(doc.documentElement), key({ text: 'a', toFocused: true }))).toBe(
      'typed',
    );
    expect(doc.log).toEqual(['keydown@name', 'keypress@name', 'exec:insertText:a', 'keyup@name']);
    expect(codes).toEqual([65]);
  });

  it('focuses the element named before pressing on it', () => {
    const doc = new FakeDocument();
    const field = doc.element('INPUT', 'q', { type: 'search', value: '', tabIndex: 0 });
    pressInPage(page(field), key({ key: 'Escape', code: 'Escape', keyCode: 27 }));
    expect(doc.log).toEqual(['focus@q', 'keydown@q', 'keyup@q']);
  });

  it('lets the page’s own handler take a key, with nothing else following', () => {
    const doc = new FakeDocument();
    const field = doc.element('INPUT', 'name', { type: 'text', value: '', tabIndex: 0 });
    field.on('keydown', (event) => event.preventDefault());
    expect(pressInPage(page(field), key({ text: 'a' }))).toBe('prevented');
    expect(doc.log).toEqual(['focus@name', 'keydown@name', 'keyup@name']);
  });

  it('submits a field’s form on Enter', () => {
    const doc = new FakeDocument();
    let submitted = 0;
    const field = doc.element('INPUT', 'q', {
      type: 'text',
      value: '',
      tabIndex: 0,
      form: { requestSubmit: () => (submitted += 1) },
    });
    expect(pressInPage(page(field), key({ key: 'Enter', code: 'Enter', keyCode: 13 }))).toBe(
      'submitted',
    );
    expect(submitted).toBe(1);
  });

  it('activates a button on Enter, and a checkbox on Space', () => {
    const doc = new FakeDocument();
    const button = doc.element('BUTTON', 'go', { tabIndex: 0 });
    expect(pressInPage(page(button), key({ key: 'Enter', code: 'Enter', keyCode: 13 }))).toBe(
      'activated',
    );
    expect(doc.log).toContain('click()@go');
    const box = doc.element('INPUT', 'agree', { type: 'checkbox', tabIndex: 0 });
    doc.log.length = 0;
    expect(pressInPage(page(box), key({ key: ' ', code: 'Space', keyCode: 32, text: ' ' }))).toBe(
      'activated',
    );
    expect(doc.log).toEqual([
      'focus@agree',
      'keydown@agree',
      'keypress@agree',
      'keyup@agree',
      'click()@agree',
    ]);
  });

  it('moves the focus on Tab and back on Shift+Tab, wrapping round', () => {
    const doc = new FakeDocument();
    const first = doc.element('INPUT', 'first', { type: 'text', value: '', tabIndex: 0 });
    doc.element('INPUT', 'gone', { type: 'text', value: '', tabIndex: 0, hidden: true });
    const second = doc.element('BUTTON', 'second', { tabIndex: 0 });
    doc.element('DIV', 'plain');
    const tab = key({ key: 'Tab', code: 'Tab', keyCode: 9 });
    expect(pressInPage(page(first), tab)).toBe('moved-focus');
    expect(doc.activeElement).toBe(second);
    expect(doc.log.at(-1)).toBe('keyup@second');
    pressInPage(page(second), tab);
    expect(doc.activeElement).toBe(first);
    pressInPage(page(first), { ...tab, shiftKey: true });
    expect(doc.activeElement).toBe(second);
  });

  it('deletes on Backspace and selects everything on Control+A, in a field', () => {
    const doc = new FakeDocument();
    const field = doc.element('INPUT', 'name', { type: 'text', value: 'abc', tabIndex: 0 });
    expect(pressInPage(page(field), key({ key: 'Backspace', code: 'Backspace', keyCode: 8 }))).toBe(
      'deleted',
    );
    expect(field.value).toBe('ab');
    expect(pressInPage(page(field), key({ ctrlKey: true }))).toBe('selected-all');
    expect(doc.log).toContain('select@name');
  });

  it('leaves the keys a page handles itself to its handlers', () => {
    const doc = new FakeDocument();
    const list = doc.element('UL', 'list', { tabIndex: 0 });
    expect(pressInPage(page(list), key({ key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 }))).toBe(
      'none',
    );
  });

  it('reaches the focused element inside a shadow root', () => {
    const doc = new FakeDocument();
    const host = doc.element('MY-FIELD', 'host', { tabIndex: -1 });
    const inner = new FakeElement(doc, 'INPUT', 'inner');
    Object.assign(inner, { type: 'text', value: '', tabIndex: 0 });
    host.shadowRoot = { host, activeElement: inner };
    doc.activeElement = host;
    pressInPage(page(doc.documentElement), key({ text: 'a', toFocused: true }));
    expect(doc.log[0]).toBe('keydown@inner');
  });
});

describe('scrollInPage', () => {
  it('scrolls the page by most of a screen, saying how far and where it is', () => {
    const doc = new FakeDocument();
    Object.assign(doc.documentElement, { scrollHeight: 3000, clientHeight: 600 });
    doc.atPoint = doc.body;
    expect(scrollInPage(page(doc.documentElement), { intoView: false, direction: 'down' })).toEqual(
      { moved: 480, at: 480, extent: 2400 },
    );
    expect(scrollInPage(page(doc.documentElement), { intoView: false, direction: 'up' })).toEqual({
      moved: 480,
      at: 0,
      extent: 2400,
    });
  });

  it('scrolls the panel under the middle of the screen when it scrolls', () => {
    const doc = new FakeDocument();
    const panel = doc.element('DIV', 'panel', {
      overflowY: 'auto',
      scrollHeight: 1000,
      clientHeight: 200,
    });
    doc.atPoint = panel.append(new FakeElement(doc, 'P', 'row'));
    expect(scrollInPage(page(doc.documentElement), { intoView: false, direction: 'down' })).toEqual(
      { moved: 160, at: 160, extent: 800 },
    );
    expect(doc.documentElement.scrollTop).toBe(0);
  });

  it('brings an element into view', () => {
    const doc = new FakeDocument();
    const row = doc.element('LI', 'row');
    scrollInPage(page(row), { intoView: true, direction: 'down' });
    expect(doc.log).toEqual(['scrollIntoView@row']);
  });
});

describe('a refusal from the page', () => {
  it('is read back from Playwright’s wrapping, and nothing else is', () => {
    expect(actRefusalIn('locator.evaluate: Error: consola-act:covered\n    at eval')).toBe(
      'covered',
    );
    expect(actRefusalIn('locator.evaluate: Error: boom')).toBeNull();
  });
});
