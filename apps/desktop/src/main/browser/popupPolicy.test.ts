import { describe, expect, it } from 'vitest';
import { decidePopup, parsePopupSize, type PopupContext } from './popupPolicy';

const ready: PopupContext = {
  openerKnown: true,
  openerIsPopup: false,
  recentPersonInput: true,
  atTabCap: false,
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
