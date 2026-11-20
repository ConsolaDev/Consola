import { describe, expect, it } from 'vitest';
import {
  decidePopup,
  parsePopupSize,
  PERSON_INPUT_MS,
  PersonInputClock,
  placePopupTab,
  popupTitle,
  type PopupContext,
  type PopupTabFacts,
} from './popupPolicy';

const ready: PopupContext = {
  openerKnown: true,
  openerIsPopup: false,
  recentPersonInput: true,
  atTabCap: false,
  openerHasPopup: false,
};

const open = (
  disposition: string,
  features = '',
  url = 'https://example.com/next',
  context: Partial<PopupContext> = {},
) => decidePopup({ url, disposition, features }, { ...ready, ...context });

describe('parsePopupSize', () => {
  it('reads width and height, and treats inner sizes the same', () => {
    expect(parsePopupSize('width=500,height=600')).toEqual({ width: 500, height: 600 });
    expect(parsePopupSize('innerWidth=480, innerHeight=640')).toEqual({ width: 480, height: 640 });
  });

  it('is null when no size is asked for, even with other features', () => {
    expect(parsePopupSize('')).toBeNull();
    expect(parsePopupSize('noopener,noreferrer')).toBeNull();
  });

  it('fills in a missing side and keeps both within sane bounds', () => {
    expect(parsePopupSize('width=500')).toEqual({ width: 500, height: 700 });
    expect(parsePopupSize('width=10,height=99999')).toEqual({ width: 200, height: 1600 });
  });
});

describe('decidePopup', () => {
  it('turns a link that wants a new tab into a tab, with or without focus', () => {
    for (const disposition of ['foreground-tab', 'background-tab', 'new-window']) {
      expect(open(disposition)).toEqual({ action: 'tab', url: 'https://example.com/next' });
    }
  });

  it('needs no person input for a plain tab, only for a sized popup', () => {
    expect(open('foreground-tab', '', undefined, { recentPersonInput: false }).action).toBe('tab');
  });

  it('denies a tab at the cap', () => {
    expect(open('foreground-tab', '', undefined, { atTabCap: true }).action).toBe('deny');
  });

  it('opens a sized popup that follows a click', () => {
    expect(open('new-window', 'width=500,height=600')).toEqual({
      action: 'popup',
      url: 'https://example.com/next',
      width: 500,
      height: 600,
    });
  });

  it('allows the blank page a sign-in popup starts on', () => {
    expect(open('new-window', 'width=500,height=600', 'about:blank').action).toBe('popup');
  });

  it('denies a sized popup with no person input behind it', () => {
    expect(
      open('new-window', 'width=500,height=600', undefined, { recentPersonInput: false }).action,
    ).toBe('deny');
  });

  it('denies anything opened from a popup', () => {
    expect(open('foreground-tab', '', undefined, { openerIsPopup: true }).action).toBe('deny');
    expect(
      open('new-window', 'width=500,height=600', undefined, { openerIsPopup: true }).action,
    ).toBe('deny');
  });

  it('denies when the opener belongs to no known session', () => {
    expect(open('foreground-tab', '', undefined, { openerKnown: false }).action).toBe('deny');
    expect(
      open('new-window', 'width=500,height=600', undefined, { openerKnown: false }).action,
    ).toBe('deny');
  });

  it('denies addresses that are not web pages, as a tab or a popup', () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hi',
      'chrome://gpu',
    ]) {
      expect(open('foreground-tab', '', url).action).toBe('deny');
      expect(open('new-window', 'width=500,height=600', url).action).toBe('deny');
    }
    // A tab has no use for a blank address of its own making.
    expect(open('foreground-tab', '', 'about:blank').action).toBe('deny');
  });

  it('denies dispositions that are not a window being opened', () => {
    expect(open('other').action).toBe('deny');
    expect(open('default').action).toBe('deny');
  });
});

describe('one popup at a time', () => {
  it('denies a sized popup while the opener already has one open', () => {
    expect(
      open('new-window', 'width=500,height=600', undefined, { openerHasPopup: true }).action,
    ).toBe('deny');
  });

  it('still opens tabs while a popup is open', () => {
    expect(open('foreground-tab', '', undefined, { openerHasPopup: true }).action).toBe('tab');
  });
});

describe('placePopupTab', () => {
  const T0 = 1_700_000_000_000;
  /** A person's tab nobody touched and no agent is on. */
  const quiet: PopupTabFacts = {
    now: T0,
    openerOpenedBy: 'person',
    agentCallInFlight: false,
    actInFlight: false,
  };
  const place = (facts: Partial<PopupTabFacts>) => placePopupTab({ ...quiet, ...facts });

  it("is the person's, and shows, when they pressed in the opener within 3 s", () => {
    expect(place({ personInputAt: T0 - 2_900 })).toEqual({ openedBy: 'person', activate: true });
    // Whoever's tab it is, and whatever an agent is doing there: the person caused it.
    expect(
      place({
        personInputAt: T0 - 2_900,
        openerOpenedBy: 'agent',
        agentCallInFlight: true,
        actInFlight: true,
      }),
    ).toEqual({ openedBy: 'person', activate: true });
  });

  it("opens behind as the agent's from an agent's tab the person last pressed in 3.1 s ago", () => {
    expect(place({ personInputAt: T0 - 3_100, openerOpenedBy: 'agent' })).toEqual({
      openedBy: 'agent',
      activate: false,
    });
  });

  it("opens behind, still the person's, from their own tab with no agent on it", () => {
    expect(place({ personInputAt: T0 - 3_100 })).toEqual({ openedBy: 'person', activate: false });
    expect(place({})).toEqual({ openedBy: 'person', activate: false });
  });

  it("opens behind as the agent's from the person's tab while an agent's call is on it", () => {
    expect(place({ agentCallInFlight: true })).toEqual({ openedBy: 'agent', activate: false });
  });

  it("is the agent's when its act or move on the opener is under way, or ended within 3 s", () => {
    // A synthetic click on a target=_blank link, or a window.open an evaluate ran.
    expect(place({ actInFlight: true })).toEqual({ openedBy: 'agent', activate: false });
    // What a click starts reaches main after the click returns.
    expect(place({ actEndedAt: T0 - 2_900 })).toEqual({ openedBy: 'agent', activate: false });
    expect(place({ actEndedAt: T0 - 3_100 })).toEqual({ openedBy: 'person', activate: false });
  });
});

describe('PersonInputClock', () => {
  it('lets one gesture pay for one popup', () => {
    let now = 1_000;
    const clock = new PersonInputClock(() => now);
    clock.touch();
    now += 10;
    expect(clock.consume()).toBe(true);
    expect(clock.isRecent()).toBe(false);
    expect(clock.consume()).toBe(false);
  });

  it('expires after PERSON_INPUT_MS', () => {
    let now = 1_000;
    const clock = new PersonInputClock(() => now);
    clock.touch();
    now += PERSON_INPUT_MS + 1;
    expect(clock.consume()).toBe(false);
  });
});

describe('popupTitle', () => {
  it('always names the site the popup is showing, ahead of the page title', () => {
    expect(popupTitle('https://accounts.example.com/login?x=1', 'Sign in to Bank')).toBe(
      'https://accounts.example.com \u2014 Sign in to Bank',
    );
  });

  it('shows the origin alone while the page has no title', () => {
    expect(popupTitle('https://a.test/', '')).toBe('https://a.test');
  });

  it('does not let a page title pose as another site', () => {
    expect(popupTitle('https://evil.test/', 'https://bank.com \u2014 Sign in')).toBe(
      'https://evil.test \u2014 https://bank.com \u2014 Sign in',
    );
  });

  it('says so for a blank page', () => {
    expect(popupTitle('about:blank', '')).toBe('about:blank');
  });
});
