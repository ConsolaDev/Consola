import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it } from 'vitest';
import {
  ACT_AFTERMATH_MS,
  PERSON_INPUT_GUARD_MS,
  PERSON_USING_TAB_MESSAGE,
  PersonInput,
  personIsUsing,
  watchLoadsSettling,
  watchPersonInput,
} from './PersonInput';
import { decideDownload } from './sessionPolicy';

const T0 = 1_700_000_000_000;

describe('the person comes first', () => {
  it('is using a tab for 3 seconds after pressing in it', () => {
    expect(PERSON_INPUT_GUARD_MS).toBe(3_000);
    expect(personIsUsing(T0, T0 + 2_900)).toBe(true);
    expect(personIsUsing(T0, T0 + 3_100)).toBe(false);
    expect(personIsUsing(undefined, T0)).toBe(false);
  });

  it('refuses an act 2.9 s after the person’s input on that tab, and allows it at 3.1 s', () => {
    let now = T0;
    const person = new PersonInput(() => now);
    person.noteInput('tab1');
    now = T0 + 2_900;
    expect(person.refusal('tab1')).toBe(PERSON_USING_TAB_MESSAGE);
    expect(PERSON_USING_TAB_MESSAGE).toBe('The person is using this tab.');
    expect(person.refusal('tab2')).toBeNull();
    now = T0 + 3_100;
    expect(person.refusal('tab1')).toBeNull();
  });

  it('counts the newest input', () => {
    let now = T0;
    const person = new PersonInput(() => now);
    person.noteInput('tab1');
    now = T0 + 2_000;
    person.noteInput('tab1');
    now = T0 + 4_000;
    expect(person.refusal('tab1')).toBe(PERSON_USING_TAB_MESSAGE);
  });
});

describe('acts on a tab', () => {
  it('are in flight from begin to end, and just done for a while after', () => {
    let now = T0;
    const person = new PersonInput(() => now);
    expect(person.downloadFacts('tab1')).toEqual({ actInFlight: false, now: T0 });
    const first = person.beginAct('tab1');
    const second = person.beginAct('tab1');
    first();
    first();
    expect(person.downloadFacts('tab1').actInFlight).toBe(true);
    now = T0 + 500;
    second();
    expect(person.downloadFacts('tab1')).toEqual({
      actInFlight: false,
      actEndedAt: T0 + 500,
      now: T0 + 500,
    });
    expect(ACT_AFTERMATH_MS).toBe(3_000);
  });

  it('reports the person’s last input beside them', () => {
    let now = T0;
    const person = new PersonInput(() => now);
    person.noteInput('tab1');
    now = T0 + 100;
    expect(person.downloadFacts('tab1')).toMatchObject({ personInputAt: T0, now: T0 + 100 });
  });

  it('forgets what no longer matters, so the record stays small', () => {
    let now = T0;
    const person = new PersonInput(() => now);
    for (let i = 0; i < 50; i++) {
      person.noteInput(`tab${i}`);
      person.beginAct(`tab${i}`)();
    }
    now = T0 + 60_000;
    person.noteInput('fresh');
    person.beginAct('fresh')();
    expect(person.size()).toBe(1);
  });
});

describe("an agent's move of a tab", () => {
  it('is in flight until the tab’s page has loaded, however long that takes, then just done for 3 s', () => {
    let now = T0;
    const person = new PersonInput(() => now);
    person.noteAgentMove('tab1');
    expect(person.downloadFacts('tab1').actInFlight).toBe(true);
    expect(decideDownload(person.downloadFacts('tab1'))).toBe('cancel');
    // A tab with no page loads the address only when it is next shown or read.
    now = T0 + 10 * 60_000;
    expect(decideDownload(person.downloadFacts('tab1'))).toBe('cancel');
    person.noteLoadSettled('tab1');
    expect(person.downloadFacts('tab1')).toEqual({
      actInFlight: false,
      actEndedAt: now,
      now,
    });
    const settled = now;
    now = settled + 2_900;
    expect(decideDownload(person.downloadFacts('tab1'))).toBe('cancel');
    now = settled + 3_100;
    expect(decideDownload(person.downloadFacts('tab1'))).toBe('allow');
  });

  it('gives way to the person pressing in the tab, as an act does', () => {
    let now = T0;
    const person = new PersonInput(() => now);
    person.noteAgentMove('tab1');
    now = T0 + 1_000;
    person.noteInput('tab1');
    now = T0 + 3_900;
    expect(decideDownload(person.downloadFacts('tab1'))).toBe('allow');
  });

  it('is not ended by a load on another tab, and a load with no move pending changes nothing', () => {
    const person = new PersonInput(() => T0);
    person.noteAgentMove('tab1');
    person.noteLoadSettled('tab2');
    expect(person.downloadFacts('tab1').actInFlight).toBe(true);
    expect(person.downloadFacts('tab2')).toEqual({ actInFlight: false, now: T0 });
  });

  it('stays in flight while an act it overlaps ends', () => {
    const person = new PersonInput(() => T0);
    const endAct = person.beginAct('tab1');
    person.noteAgentMove('tab1');
    endAct();
    expect(person.downloadFacts('tab1').actInFlight).toBe(true);
    person.noteLoadSettled('tab1');
    expect(person.downloadFacts('tab1').actInFlight).toBe(false);
  });

  it('gives the tab’s next load to the person when they navigate it from the toolbar', () => {
    let now = T0;
    const person = new PersonInput(() => now);
    person.noteAgentMove('tab1');
    person.notePersonNavigation('tab1');
    // Their input on the tab, as a press in its page is.
    expect(person.refusal('tab1')).toBe(PERSON_USING_TAB_MESSAGE);
    // And their load: once their 3 s are over, nothing of the agent's is left.
    now = T0 + 3_100;
    expect(person.downloadFacts('tab1')).toEqual({
      actInFlight: false,
      personInputAt: T0,
      now,
    });
  });

  it('is forgotten once its tab is gone, so the record stays small', () => {
    const tabs = new Set(['tab1', 'tab2']);
    const person = new PersonInput(
      () => T0,
      (tabId) => tabs.has(tabId),
    );
    person.noteAgentMove('tab1');
    person.noteAgentMove('tab2');
    tabs.delete('tab1');
    person.noteAgentMove('tab2');
    expect(person.size()).toBe(1);
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

  it('hears a page stop loading, for its tab, once it is bound to one', () => {
    const guest = new FakeGuest();
    const settled: string[] = [];
    let tabId: string | null = 'tab1';
    watchLoadsSettling(
      guest.asWebContents(),
      () => tabId,
      (tab) => settled.push(tab),
    );
    guest.emit('did-start-loading');
    guest.emit('did-stop-loading');
    tabId = null;
    guest.emit('did-stop-loading');
    expect(settled).toEqual(['tab1']);
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
