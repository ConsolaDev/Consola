import { describe, expect, it } from 'vitest';
import { defaultLayout, openKind, setVisible, splitWithTab, toggleMaximize } from './layout';
import { labelWithMarks, markDots, markPlaces, marksOnToggle } from './marks';

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

  it('the pull request’s mark takes the same three places', () => {
    const places = (headerKinds: readonly string[], layout: ReturnType<typeof defaultLayout>) =>
      markPlaces('pull-request', { marked: true, headerKinds, layout });
    expect(places(['changes', 'files', 'pull-request'], defaultLayout())).toEqual({
      ...none,
      shortcut: true,
    });
    // Behind Changes, on screen.
    expect(places(header, opened('pull-request', 'changes'))).toEqual({ ...none, tab: true });
    expect(places(header, defaultLayout())).toEqual({ ...none, toggle: true });
  });
});

describe('marksOnToggle', () => {
  const agent = {
    tone: 'agent' as const,
    onKind: 'which the agent used',
    onPanel: 'where the agent used the browser',
  };
  const alert = {
    tone: 'alert' as const,
    onKind: 'a check is failing',
    onPanel: 'where the pull request has a failing check',
  };

  it('the toggle carries every mark with nowhere else to go, in registry order', () => {
    const entries = [
      { kind: 'browser', mark: agent },
      { kind: 'pull-request', mark: alert },
    ];
    expect(marksOnToggle(entries, { headerKinds: header, layout: defaultLayout() })).toEqual([
      agent,
      alert,
    ]);
    // The pull request's tab, behind Changes on screen, carries its own.
    expect(
      marksOnToggle(entries, { headerKinds: header, layout: opened('pull-request', 'changes') }),
    ).toEqual([agent]);
    expect(
      marksOnToggle(
        [
          { kind: 'browser', mark: null },
          { kind: 'pull-request', mark: null },
        ],
        { headerKinds: header, layout: defaultLayout() },
      ),
    ).toEqual([]);
  });
});

describe('markDots', () => {
  const agent = { tone: 'agent' as const };
  const alert = { tone: 'alert' as const };

  it('an agent’s use draws the accent dot alone', () => {
    expect(markDots([agent])).toEqual({ 'data-agent-dot': true, 'data-alert-dot': undefined });
  });

  it('something wrong draws the red dot alone', () => {
    expect(markDots([alert])).toEqual({ 'data-agent-dot': undefined, 'data-alert-dot': true });
  });

  it('a button carrying both draws both, and one carrying none draws neither', () => {
    expect(markDots([alert, agent])).toEqual({ 'data-agent-dot': true, 'data-alert-dot': true });
    expect(markDots([])).toEqual({ 'data-agent-dot': undefined, 'data-alert-dot': undefined });
  });
});

describe('labelWithMarks', () => {
  it('labelWithMarks names each mark after the label', () => {
    expect(labelWithMarks('Show side panel', [])).toBe('Show side panel');
    expect(labelWithMarks('Show side panel', ['where the agent used the browser'])).toBe(
      'Show side panel, where the agent used the browser',
    );
    expect(
      labelWithMarks('Show side panel', [
        'where the agent used the browser',
        'where the pull request has a failing check',
      ]),
    ).toBe(
      'Show side panel, where the agent used the browser and where the pull request has a failing check',
    );
  });
});
