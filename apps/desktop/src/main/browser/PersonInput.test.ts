import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  PERSON_INPUT_GUARD_MS,
  PERSON_USING_TAB_MESSAGE,
  PersonInput,
  personIsUsing,
  watchPersonInput,
} from './PersonInput';
import { decideDownload, QUIET_SESSION } from './sessionPolicy';

const T0 = 1_700_000_000_000;

describe('the person comes first', () => {
  // As long as the activation a real press leaves the page (about 5 s), and a margin.
  it('is using a tab for 6 seconds after pressing in it', () => {
    expect(PERSON_INPUT_GUARD_MS).toBe(6_000);
    expect(personIsUsing(T0, T0 + PERSON_INPUT_GUARD_MS - 100)).toBe(true);
    expect(personIsUsing(T0, T0 + PERSON_INPUT_GUARD_MS + 100)).toBe(false);
    expect(personIsUsing(undefined, T0)).toBe(false);
  });

  it('refuses an act just inside the guard after the person’s input on that tab, and allows it just after', () => {
    let now = T0;
    const person = new PersonInput(() => now);
    person.noteInput('tab1');
    now = T0 + PERSON_INPUT_GUARD_MS - 100;
    expect(person.refusal('tab1')).toBe(PERSON_USING_TAB_MESSAGE);
    expect(PERSON_USING_TAB_MESSAGE).toBe('The person is using this tab.');
    expect(person.refusal('tab2')).toBeNull();
    now = T0 + PERSON_INPUT_GUARD_MS + 100;
    expect(person.refusal('tab1')).toBeNull();
  });

  it('counts the newest input', () => {
    let now = T0;
    const person = new PersonInput(() => now);
    person.noteInput('tab1');
    now = T0 + PERSON_INPUT_GUARD_MS - 1_000;
    person.noteInput('tab1');
    // Past the first input's guard, inside the second's.
    now = T0 + PERSON_INPUT_GUARD_MS + 500;
    expect(person.refusal('tab1')).toBe(PERSON_USING_TAB_MESSAGE);
  });
});

describe('whose hands a tab is in', () => {
  /** What the gate decides for a page's first download, with nobody's input, from the tab, by its hands now. */
  const download = (person: PersonInput, tabId: string, openedBy: 'person' | 'agent') =>
    decideDownload(
      {
        kind: 'tabs',
        tabIds: [tabId],
        hands: [person.handsOf(tabId, openedBy)],
        personInputAt: [undefined],
        sessionIds: ['s'],
      },
      QUIET_SESSION,
    );

  it("starts in its opener's: an agent's tab is the agent's, also after a restart nobody touched it in", () => {
    // A fresh record is what a restart leaves.
    const person = new PersonInput(() => T0);
    expect(person.handsOf('tab1', 'agent')).toBe('agent');
    expect(download(person, 'tab1', 'agent')).toBe('cancel');
    expect(person.handsOf('tab2', 'person')).toBe('person');
    expect(download(person, 'tab2', 'person')).toBe('allow');
  });

  it("is the agent's from its use of the person's tab, however long ago, until the person presses in it", () => {
    let now = T0;
    const person = new PersonInput(() => now);
    // The agent moves it, or acts on it; its page loads, and starts a download 10 s later.
    person.noteAgentUse('tab1');
    now = T0 + 10_000;
    expect(download(person, 'tab1', 'person')).toBe('cancel');
    // The person presses in it: theirs again, for good.
    person.noteInput('tab1');
    now = T0 + 60_000;
    expect(download(person, 'tab1', 'person')).toBe('allow');
    // The agent acts again, once the person's guard is over: the agent's again.
    expect(person.refusal('tab1')).toBeNull();
    person.noteAgentUse('tab1');
    now = T0 + 70_000;
    expect(download(person, 'tab1', 'person')).toBe('cancel');
  });

  it("is the person's once they navigate it from the toolbar, which is their input on it too", () => {
    const person = new PersonInput(() => T0);
    person.noteAgentUse('tab1');
    person.notePersonNavigation('tab1');
    expect(download(person, 'tab1', 'person')).toBe('allow');
    expect(person.refusal('tab1')).toBe(PERSON_USING_TAB_MESSAGE);
    // An agent's own tab too, which they took.
    person.notePersonNavigation('tab2');
    expect(download(person, 'tab2', 'agent')).toBe('allow');
  });

  it("is the person's when they press in an agent's tab", () => {
    const person = new PersonInput(() => T0);
    person.noteInput('tab1');
    expect(person.handsOf('tab1', 'agent')).toBe('person');
  });

  it('reports the person’s last input', () => {
    const person = new PersonInput(() => T0);
    expect(person.lastInput('tab1')).toBeUndefined();
    person.noteInput('tab1');
    expect(person.lastInput('tab1')).toBe(T0);
  });

  it('forgets what no longer matters, so the record stays small', () => {
    let now = T0;
    const tabs = new Set(['kept']);
    const person = new PersonInput(
      () => now,
      (tabId) => tabs.has(tabId),
    );
    for (let i = 0; i < 50; i++) {
      tabs.add(`tab${i}`);
      person.noteInput(`tab${i}`);
      person.noteAgentUse(`tab${i}`);
    }
    person.noteAgentUse('kept');
    // Fifty tabs closed, and their input long past.
    for (let i = 0; i < 50; i++) tabs.delete(`tab${i}`);
    now = T0 + 60_000;
    person.noteAgentUse('kept');
    expect(person.size()).toBe(1);
    expect(person.handsOf('kept', 'person')).toBe('agent');
  });
});

class FakeGuest extends EventEmitter {
  asWebContents() {
    return this as unknown as WebContents;
  }
}

describe('hearing the person', () => {
  it('records a key pressed or a mouse button pressed in the page, for its tab', () => {
    const guest = new FakeGuest();
    const heard: string[] = [];
    let tabId: string | null = 'tab1';
    watchPersonInput(
      guest.asWebContents(),
      () => tabId,
      (tab) => heard.push(tab),
    );

    guest.emit('before-input-event', {}, { type: 'keyDown', key: 'a' });
    guest.emit('before-input-event', {}, { type: 'keyUp', key: 'a' });
    guest.emit('before-mouse-event', {}, { type: 'mouseDown', button: 'left', x: 1, y: 1 });
    guest.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'left', x: 1, y: 1 });
    // Moving the mouse or turning the wheel over a page is not using it, and
    // is all an agent's acts ever send through the browser.
    guest.emit('before-mouse-event', {}, { type: 'mouseMove', x: 2, y: 2 });
    guest.emit('before-mouse-event', {}, { type: 'mouseWheel', x: 2, y: 2 });
    expect(heard).toEqual(['tab1', 'tab1']);

    // A page not bound to a tab yet has nobody to count it for.
    tabId = null;
    guest.emit('before-input-event', {}, { type: 'keyDown', key: 'b' });
    expect(heard).toEqual(['tab1', 'tab1']);
  });

  it('never stops the page from getting the input', () => {
    const guest = new FakeGuest();
    watchPersonInput(
      guest.asWebContents(),
      () => 'tab1',
      () => {},
    );
    let prevented = false;
    guest.emit(
      'before-input-event',
      {
        preventDefault: () => {
          prevented = true;
        },
      },
      { type: 'keyDown', key: 'a' },
    );
    expect(prevented).toBe(false);
  });
});

describe('telling others of the person’s input', () => {
  it('tells its listeners of each input, a toolbar move included, until they stop listening', () => {
    const person = new PersonInput(() => T0);
    const heard: string[] = [];
    const stop = person.onInput((tabId) => heard.push(tabId));
    person.noteInput('tab1');
    person.notePersonNavigation('tab2');
    // An agent's use is not the person's.
    person.noteAgentUse('tab3');
    stop();
    person.noteInput('tab4');
    expect(heard).toEqual(['tab1', 'tab2']);
  });

  it('records the input even when a listener throws, and tells the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const person = new PersonInput(() => T0);
    person.onInput(() => {
      throw new Error('gone');
    });
    const heard: string[] = [];
    person.onInput((tabId) => heard.push(tabId));
    person.noteInput('tab1');
    expect(heard).toEqual(['tab1']);
    expect(person.refusal('tab1')).not.toBeNull();
    warn.mockRestore();
  });
});
