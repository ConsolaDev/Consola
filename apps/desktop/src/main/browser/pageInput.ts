/**
 * An agent's acts, done inside the page.
 *
 * Not through the browser's input: on a `<webview>` guest Chromium hands CDP
 * keys and text to whatever the window has focused (the probe of Task 19
 * typed into the person's terminal), and a trusted press makes the page the
 * window's focused element, taking the keyboard from the person. The relay
 * refuses both (`cdpRelayProtocol`). So a click is a pointer and mouse
 * sequence dispatched on the element the press would land on, typing goes
 * through the page's own editing (`execCommand`), and a key is a key event
 * the page's handlers hear, with the few default actions a page relies on
 * (Enter submits or activates, Space activates, Tab moves focus, Backspace
 * and Delete edit, a character types). The page's own `focus()` moves only
 * the page's focus, never the window's.
 *
 * Every function here RUNS IN THE PAGE: Playwright sends its source
 * (`locator.evaluate(fn, arg)`), so it may use only what a page has, and
 * nothing from this module, not even a constant; whatever it needs comes in
 * as its argument. A refusal is thrown as `consola-act:<reason>` (see
 * `ActRefusal`), never as page text, and main words it.
 */

/** Why an act was refused in the page; main turns each into a sentence. */
export type ActRefusal =
  | 'not-visible'
  | 'disabled'
  | 'covered'
  | 'not-editable'
  | 'read-only'
  | 'not-text'
  | 'file-input'
  | 'color-input'
  | 'is-select'
  | 'not-focused';

/** Every refusal these functions throw, and nothing else. */
const ACT_REFUSALS: ReadonlySet<string> = new Set<ActRefusal>([
  'not-visible',
  'disabled',
  'covered',
  'not-editable',
  'read-only',
  'not-text',
  'file-input',
  'color-input',
  'is-select',
  'not-focused',
]);

/**
 * What a refusal thrown in the page reads as, once Playwright has wrapped
 * it: one of Consola's, `'unknown'` for a code it never throws (a page that
 * patches the DOM can throw anything), or null for no refusal at all.
 */
export function actRefusalIn(message: string): ActRefusal | 'unknown' | null {
  const match = /consola-act:([a-z-]+)/.exec(message);
  if (!match) return null;
  return ACT_REFUSALS.has(match[1]) ? (match[1] as ActRefusal) : 'unknown';
}

/** The fields of a text field, an input or a textarea, these acts read. */
type Field = HTMLInputElement & HTMLTextAreaElement;

/**
 * Clicks an element as the person's mouse would, in the page: checks it can
 * be clicked (visible, enabled, not covered at its centre), brings it into
 * view, and dispatches over, move, down, focus, up and click on whatever is
 * at its centre (the element or one of its own parts).
 */
export function clickInPage(element: Element): 'clicked' {
  const refuse = (reason: string): never => {
    throw new Error(`consola-act:${reason}`);
  };
  const doc = element.ownerDocument;
  const view = doc.defaultView as Window & typeof globalThis;
  const rect0 = element.getBoundingClientRect();
  const visible =
    rect0.width > 0 &&
    rect0.height > 0 &&
    element.getClientRects().length > 0 &&
    (element.checkVisibility ? element.checkVisibility({ visibilityProperty: true }) : true);
  if (!visible) refuse('not-visible');
  if (element.matches(':disabled') || element.closest('[inert]')) refuse('disabled');

  let rect = rect0;
  const inView =
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= view.innerHeight &&
    rect.right <= view.innerWidth;
  if (!inView) {
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    rect = element.getBoundingClientRect();
  }
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const root = element.getRootNode() as Document | ShadowRoot;
  const atPoint = root.elementFromPoint ? root.elementFromPoint(x, y) : doc.elementFromPoint(x, y);
  // The press lands on whatever is on top there; it must be the element or a part of it.
  let node: Node | null = atPoint;
  while (node && node !== element) {
    const parent: Node | null = node.parentNode;
    node = parent instanceof view.ShadowRoot ? parent.host : parent;
  }
  if (!atPoint || node !== element) refuse('covered');
  const hit = atPoint as HTMLElement;
  // A click on a file or colour input, or on a label for one, opens a chooser
  // over the person's window. The relay already takes the user gesture that
  // would let it (Ruling MM); this refuses it outright, and says why.
  const chooserOf = (start: Element): string | null => {
    for (let at: Element | null = start; at; at = at.parentElement) {
      const control = at.tagName === 'LABEL' ? (at as HTMLLabelElement).control : at;
      const kind =
        control?.tagName === 'INPUT' ? (control as HTMLInputElement).type?.toLowerCase() : '';
      if (kind === 'file' || kind === 'color') return kind;
      if (at.tagName === 'LABEL') return null;
    }
    return null;
  };
  const chooser = chooserOf(hit) ?? chooserOf(element);
  if (chooser) refuse(chooser === 'file' ? 'file-input' : 'color-input');

  const mouse = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    button: 0,
    detail: 1,
  };
  const pointer = {
    ...mouse,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    width: 1,
    height: 1,
  };
  hit.dispatchEvent(new view.PointerEvent('pointerover', { ...pointer, buttons: 0 }));
  hit.dispatchEvent(new view.MouseEvent('mouseover', { ...mouse, buttons: 0 }));
  hit.dispatchEvent(new view.PointerEvent('pointermove', { ...pointer, buttons: 0 }));
  hit.dispatchEvent(new view.MouseEvent('mousemove', { ...mouse, buttons: 0 }));
  // A page that cancels the pointer going down gets no mouse events for it,
  // as in a browser; the click still follows.
  const pointerDown = hit.dispatchEvent(
    new view.PointerEvent('pointerdown', { ...pointer, buttons: 1, pressure: 0.5 }),
  );
  const mouseDown =
    pointerDown && hit.dispatchEvent(new view.MouseEvent('mousedown', { ...mouse, buttons: 1 }));
  if (mouseDown) {
    // The page's own focus, as a press gives it: the nearest focusable part
    // of what was pressed, or none. Never the window's.
    let focusable: HTMLElement | null = hit;
    while (
      focusable &&
      !(
        focusable.tabIndex >= 0 ||
        focusable.hasAttribute('tabindex') ||
        focusable.isContentEditable
      )
    ) {
      focusable = focusable.parentElement;
    }
    const active = doc.activeElement as HTMLElement | null;
    if (focusable) focusable.focus({ preventScroll: true });
    else if (active && active !== doc.body) active.blur();
  }
  hit.dispatchEvent(new view.PointerEvent('pointerup', { ...pointer, buttons: 0, pressure: 0 }));
  if (pointerDown) hit.dispatchEvent(new view.MouseEvent('mouseup', { ...mouse, buttons: 0 }));
  hit.dispatchEvent(new view.MouseEvent('click', { ...mouse, buttons: 0 }));
  return 'clicked';
}

/**
 * What `fill` did: typed, and the field holds exactly the text; typed, but
 * the page made something else of it (a maxlength, a mask, a number field
 * given letters), which it keeps, with what it holds (never for a password
 * field: what it holds may be what the person typed); or, for a field
 * editing cannot type into, set the value as a script would, and what the
 * field holds when that is not the text (a colour lowercased, a range
 * clamped, a date given words emptied).
 */
export type FillOutcome =
  | { how: 'typed' }
  | { how: 'changed'; value: string }
  | { how: 'changed-hidden' }
  | { how: 'set'; kind: string }
  | { how: 'set-other'; kind: string; value: string };

/**
 * Replaces what a text field holds with `text`, as typing it would: focuses
 * it, checks it really has the page's focus (else nothing is typed: the
 * page's editing types into whatever has it), selects what is there, and
 * types through the page's own editing, so the page hears the same input
 * events as for the person's typing. What the page then makes of the typing
 * is left as it is and said. The kinds of field editing cannot type into
 * (date, time, month, week, datetime-local, color, range) are set as a script
 * would set them, with their input and change events.
 */
export function fillInPage(element: Element, text: string): FillOutcome {
  const refuse = (reason: string): never => {
    throw new Error(`consola-act:${reason}`);
  };
  const doc = element.ownerDocument;
  const view = doc.defaultView as Window & typeof globalThis;
  const self = element as Field;
  const tag = element.tagName;
  const type = (self.type ?? '').toLowerCase();
  if (tag === 'SELECT') refuse('is-select');
  if (tag === 'INPUT' && type === 'file') refuse('file-input');
  if (
    tag === 'INPUT' &&
    ['checkbox', 'radio', 'submit', 'reset', 'button', 'image', 'hidden'].includes(type)
  ) {
    refuse('not-text');
  }
  const field = tag === 'INPUT' || tag === 'TEXTAREA';
  if (!field && !self.isContentEditable) refuse('not-editable');
  if (self.disabled) refuse('disabled');
  if (self.readOnly) refuse('read-only');

  const setKinds = ['date', 'time', 'month', 'week', 'datetime-local', 'color', 'range'];
  if (tag === 'INPUT' && setKinds.includes(type)) {
    const prototype = view.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, text);
    element.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new view.Event('change', { bubbles: true }));
    return self.value === text
      ? { how: 'set', kind: type }
      : { how: 'set-other', kind: type, value: self.value };
  }

  const root = element.getRootNode() as Document | ShadowRoot;
  if (!field) {
    // Editable text takes the page's focus through its editing host, the
    // outermost editable element around it (body only where body is that
    // host): a paragraph inside an editor cannot take focus itself.
    let host = element as HTMLElement;
    while (host.parentElement?.isContentEditable) host = host.parentElement;
    host.focus();
    if (root.activeElement !== host) refuse('not-focused');
    const range = doc.createRange();
    range.selectNodeContents(element);
    const selection = doc.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (!selection?.anchorNode || !element.contains(selection.anchorNode)) refuse('not-focused');
    if (text === '') doc.execCommand('delete');
    else doc.execCommand('insertText', false, text);
    return { how: 'typed' };
  }
  self.focus();
  if (root.activeElement !== element) refuse('not-focused');
  try {
    self.select();
  } catch {
    // A kind of field with no selection of its own: typing goes where the caret is.
  }
  if (text === '') {
    if (self.value !== '') doc.execCommand('delete');
  } else {
    doc.execCommand('insertText', false, text);
  }
  if (self.value === text) return { how: 'typed' };
  return type === 'password' ? { how: 'changed-hidden' } : { how: 'changed', value: self.value };
}

/** A key to press in the page (`keyPress.parseKeyPress`), and where. */
export interface PageKeyPress {
  key: string;
  code: string;
  keyCode: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  text?: string;
  /** Press it on the page's focused element rather than the one evaluated on. */
  toFocused: boolean;
}

/** What followed a key press: the page took it, or which default action ran. */
export type KeyOutcome =
  | 'prevented'
  | 'typed'
  | 'new-line'
  | 'submitted'
  | 'activated'
  | 'moved-focus'
  | 'deleted'
  | 'selected-all'
  | 'none';

/**
 * Presses a key on an element (or the page's focused element) as the page's
 * key handlers would hear it: keydown, keypress for a character, keyup. If
 * the page does not prevent it, the browser's own effect follows for the keys
 * a page relies on; for others (arrows, Escape) the page's handlers are all
 * there is.
 */
export function pressInPage(element: Element, press: PageKeyPress): KeyOutcome {
  let target = element as Field;
  if (press.toFocused) {
    target = (element.ownerDocument.activeElement ??
      element.ownerDocument.documentElement) as Field;
    for (;;) {
      const inner = (target.shadowRoot?.activeElement ??
        (target as unknown as HTMLIFrameElement).contentDocument?.activeElement) as
        | Field
        | null
        | undefined;
      if (!inner || inner === target) break;
      target = inner;
    }
  } else if (target.isContentEditable) {
    // Editable text: the page's editing acts at the caret, wherever it is in
    // the editing host (the outermost editable element around it, which is
    // what takes the focus; body only where body is that host). So the host
    // must take the page's focus, and the caret must be in the element named:
    // one elsewhere, or a selection running out of it, goes to the element's
    // end, as a click there would put it. Else nothing is pressed.
    let host = target as HTMLElement;
    while (host.parentElement?.isContentEditable) host = host.parentElement;
    host.focus();
    if ((element.getRootNode() as Document | ShadowRoot).activeElement !== host) {
      throw new Error('consola-act:not-focused');
    }
    const doc = element.ownerDocument;
    const caretInside = () => {
      const selection = doc.getSelection();
      return (
        !!selection?.anchorNode &&
        !!selection.focusNode &&
        element.contains(selection.anchorNode) &&
        element.contains(selection.focusNode)
      );
    };
    if (!caretInside()) {
      const range = doc.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      const selection = doc.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      if (!caretInside()) throw new Error('consola-act:not-focused');
    }
  } else {
    // The page's own focus: where a person's keys would go once they were on
    // it. The page's editing acts on whatever has it, so nothing is pressed
    // unless the element really took it.
    target.focus();
    if ((element.getRootNode() as Document | ShadowRoot).activeElement !== element) {
      throw new Error('consola-act:not-focused');
    }
  }
  const doc = target.ownerDocument;
  const view = doc.defaultView as Window & typeof globalThis;
  const tag = target.tagName;
  const type = (target.type ?? '').toLowerCase();
  const textInput =
    tag === 'INPUT' &&
    ['', 'text', 'search', 'url', 'tel', 'password', 'email', 'number'].includes(type);
  const editable =
    !target.disabled &&
    !target.readOnly &&
    (target.isContentEditable || tag === 'TEXTAREA' || textInput);
  const key = (eventType: string) => {
    const event = new view.KeyboardEvent(eventType, {
      key: press.key,
      code: press.code,
      ctrlKey: press.ctrlKey,
      shiftKey: press.shiftKey,
      altKey: press.altKey,
      metaKey: press.metaKey,
      bubbles: true,
      cancelable: true,
      composed: true,
      view,
    });
    // Older handlers read these, which the constructor cannot set.
    const code = eventType === 'keypress' && press.text ? press.text.charCodeAt(0) : press.keyCode;
    Object.defineProperty(event, 'keyCode', { get: () => code });
    Object.defineProperty(event, 'which', { get: () => code });
    if (eventType === 'keypress') Object.defineProperty(event, 'charCode', { get: () => code });
    return target.dispatchEvent(event);
  };
  const activatable = (selector: string) => target.matches(selector) && !target.disabled;

  let outcome: KeyOutcome = 'none';
  if (!key('keydown')) {
    key('keyup');
    return 'prevented';
  }
  const command = press.ctrlKey || press.metaKey;
  if (press.text !== undefined) {
    if (!key('keypress')) outcome = 'prevented';
    else if (editable) {
      doc.execCommand('insertText', false, press.text);
      outcome = 'typed';
    }
  } else if (press.key === 'Enter' && !command) {
    if (editable && tag !== 'INPUT') {
      doc.execCommand(tag === 'TEXTAREA' ? 'insertText' : 'insertParagraph', false, '\n');
      outcome = 'new-line';
    } else if (textInput && target.form) {
      // Implicit submission: the form's default button (its first submit
      // button) is clicked, so a page listening for that click hears it; a
      // disabled one blocks the submission; with none, the form is submitted.
      const submitter = Array.from(target.form.elements as unknown as ArrayLike<Field>).find(
        (control) =>
          (control.tagName === 'BUTTON' && (control.type ?? 'submit').toLowerCase() === 'submit') ||
          (control.tagName === 'INPUT' &&
            ['submit', 'image'].includes((control.type ?? '').toLowerCase())),
      );
      if (!submitter) {
        target.form.requestSubmit();
        outcome = 'submitted';
      } else if (!submitter.disabled) {
        submitter.click();
        outcome = 'submitted';
      }
    } else if (
      activatable(
        'a[href], area[href], button, input[type=submit], input[type=reset], input[type=button], input[type=image], summary',
      )
    ) {
      target.click();
      outcome = 'activated';
    }
  } else if (press.key === 'Tab' && !command && !press.altKey) {
    const candidates = Array.from(
      doc.querySelectorAll<Field>(
        'a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable]',
      ),
    ).filter(
      (candidate) =>
        candidate.tabIndex >= 0 &&
        !candidate.disabled &&
        (candidate.type ?? '').toLowerCase() !== 'hidden' &&
        candidate.getClientRects().length > 0 &&
        !candidate.closest('[inert]'),
    );
    const order = [
      ...candidates
        .filter((candidate) => candidate.tabIndex > 0)
        .sort((a, b) => a.tabIndex - b.tabIndex),
      ...candidates.filter((candidate) => candidate.tabIndex === 0),
    ];
    if (order.length > 0) {
      const at = order.indexOf(target);
      const step = press.shiftKey ? -1 : 1;
      const next =
        at === -1
          ? order[press.shiftKey ? order.length - 1 : 0]
          : order[(at + step + order.length) % order.length];
      next.focus();
      target = next;
      outcome = 'moved-focus';
    }
  } else if ((press.key === 'Backspace' || press.key === 'Delete') && editable) {
    doc.execCommand(press.key === 'Backspace' ? 'delete' : 'forwardDelete');
    outcome = 'deleted';
  } else if (command && press.key.toLowerCase() === 'a' && editable) {
    if (tag === 'INPUT' || tag === 'TEXTAREA') target.select();
    else doc.execCommand('selectAll');
    outcome = 'selected-all';
  }
  const up = key('keyup');
  if (
    up &&
    press.key === ' ' &&
    !editable &&
    activatable(
      'button, input[type=checkbox], input[type=radio], input[type=submit], input[type=reset], input[type=button], input[type=image], summary',
    )
  ) {
    target.click();
    outcome = 'activated';
  }
  return outcome;
}

/** Which way to scroll the page when no element is named. */
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

export interface PageScroll {
  /** Scroll this element into view, rather than the page by a screen. */
  intoView: boolean;
  direction: ScrollDirection;
}

/** How far a scroll went, and where it ended, in CSS pixels. */
export interface ScrollOutcome {
  moved: number;
  at: number;
  extent: number;
}

/**
 * Scrolls an element into view, or the page by most of a screen: whatever
 * scrolls under the middle of the viewport (a panel, a list) or else the
 * page itself, as a wheel there would.
 */
export function scrollInPage(element: Element, scroll: PageScroll): ScrollOutcome {
  const doc = element.ownerDocument;
  const view = doc.defaultView as Window & typeof globalThis;
  if (scroll.intoView) {
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    return { moved: 0, at: 0, extent: 0 };
  }
  const vertical = scroll.direction === 'up' || scroll.direction === 'down';
  const sign = scroll.direction === 'up' || scroll.direction === 'left' ? -1 : 1;
  const scrolls = (candidate: Element) => {
    const style = view.getComputedStyle(candidate);
    const overflow = vertical ? style.overflowY : style.overflowX;
    const room = vertical
      ? candidate.scrollHeight - candidate.clientHeight
      : candidate.scrollWidth - candidate.clientWidth;
    return room > 0 && /(auto|scroll|overlay)/.test(overflow);
  };
  const isPage = (candidate: Element | null) =>
    !candidate || candidate === doc.body || candidate === doc.documentElement;
  let found = doc.elementFromPoint(view.innerWidth / 2, view.innerHeight / 2);
  while (!isPage(found) && found && !scrolls(found)) found = found.parentElement;
  const scroller: Element =
    !found || isPage(found) ? (doc.scrollingElement ?? doc.documentElement) : found;
  const size = vertical
    ? scroller.clientHeight || view.innerHeight
    : scroller.clientWidth || view.innerWidth;
  const position = () => (vertical ? scroller.scrollTop : scroller.scrollLeft);
  const before = position();
  scroller.scrollBy({
    [vertical ? 'top' : 'left']: sign * Math.round(size * 0.8),
    behavior: 'instant',
  });
  const after = position();
  const extent = vertical
    ? scroller.scrollHeight - scroller.clientHeight
    : scroller.scrollWidth - scroller.clientWidth;
  return {
    moved: Math.round(Math.abs(after - before)),
    at: Math.round(after),
    extent: Math.round(extent),
  };
}
