import { describe, expect, it } from 'vitest';
import { defaultLayout, openKind, setVisible, splitWithTab, toggleMaximize } from './layout';
import { markPlaces } from './marks';

const header = ['changes', 'files', 'terminal'];
const none = { shortcut: false, tab: false, toggle: false };
const opened = (...kinds: string[]) => kinds.reduce(openKind, defaultLayout());

describe('markPlaces', () => {
  it('an unmarked kind is drawn nowhere', () => {
    expect(
      markPlaces('browser', {
        marked: false,
        headerKinds: header,
        layout: opened('browser', 'files'),
      }),
    ).toEqual(none);
  });

  it('off the header and not on screen, the side panel toggle carries it', () => {
    const places = (layout: ReturnType<typeof defaultLayout>) =>
      markPlaces('browser', { marked: true, headerKinds: header, layout });
    // Not open.
    expect(places(defaultLayout())).toEqual({ ...none, toggle: true });
    // Open, with the panel hidden.
    expect(places(setVisible(opened('browser', 'files'), false))).toEqual({
      ...none,
      toggle: true,
    });
    // In the group Maximize hides.
    expect(
      places(
        toggleMaximize(splitWithTab(opened('changes', 'browser'), 'g1', 'browser', 'bottom'), 'g1'),
      ),
    ).toEqual({ ...none, toggle: true });
  });

  it('its tab carries it while it sits behind another tab on screen', () => {
    expect(
      markPlaces('browser', {
        marked: true,
        headerKinds: header,
        layout: opened('browser', 'files'),
      }),
    ).toEqual({ ...none, tab: true });
  });

  it('on the header, its shortcut carries it, and its tab too while on screen', () => {
    const headerKinds = ['changes', 'files', 'browser'];
    expect(markPlaces('browser', { marked: true, headerKinds, layout: defaultLayout() })).toEqual({
      ...none,
      shortcut: true,
    });
    expect(
      markPlaces('browser', { marked: true, headerKinds, layout: opened('browser', 'files') }),
    ).toEqual({ shortcut: true, tab: true, toggle: false });
  });
});
