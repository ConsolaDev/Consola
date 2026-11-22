import { beforeEach, describe, expect, it, vi } from 'vitest';

// Node runs these with web storage off (vitest.config.ts): a Map stands in
// for the side panel's localStorage, as in sidePanelStore.test.ts, so what is
// written can be read back.
const { storage } = vi.hoisted(() => {
  const data = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
  return { storage: data };
});

import { INFO_PANEL_ROOM_PX } from '../infoPanel/stepAside';
import { infoPanelShownNow, toggleInfoPanel, useInfoPanelRoomStore } from './infoPanelRoomStore';
import { SIDE_PANEL_STORAGE_KEY, useSidePanelStore } from './sidePanelStore';

const NARROW = 704;
const WIDE = INFO_PANEL_ROOM_PX + 100;

const sidePanel = () => useSidePanelStore.getState();
const kept = () => useInfoPanelRoomStore.getState().keptByPerson;
const stored = () => JSON.parse(storage.get(SIDE_PANEL_STORAGE_KEY) ?? '{}').state;

beforeEach(() => {
  useSidePanelStore.setState(useSidePanelStore.getInitialState(), true);
  useInfoPanelRoomStore.setState(useInfoPanelRoomStore.getInitialState(), true);
  storage.clear();
});

describe('the info panel steps aside', () => {
  it('while the side panel is open on a narrow pane, and is back when it hides', () => {
    useInfoPanelRoomStore.getState().setContentWidth(NARROW);
    expect(infoPanelShownNow()).toBe(true);
    sidePanel().setVisible(true);
    expect(infoPanelShownNow()).toBe(false);
    sidePanel().setVisible(false);
    expect(infoPanelShownNow()).toBe(true);
  });

  it('and is back when the pane grows past the room it needs', () => {
    useInfoPanelRoomStore.getState().setContentWidth(NARROW);
    sidePanel().setVisible(true);
    expect(infoPanelShownNow()).toBe(false);
    useInfoPanelRoomStore.getState().setContentWidth(WIDE);
    expect(infoPanelShownNow()).toBe(true);
  });

  it('never writes the person’s setting', () => {
    useInfoPanelRoomStore.getState().setContentWidth(NARROW);
    sidePanel().setVisible(true);
    expect(infoPanelShownNow()).toBe(false);
    expect(sidePanel().infoVisible).toBe(true);
    expect(stored().infoVisible).toBe(true);
  });
});

describe('toggleInfoPanel', () => {
  it('hides and shows the panel as ever when there is room', () => {
    useInfoPanelRoomStore.getState().setContentWidth(WIDE);
    sidePanel().setVisible(true);
    toggleInfoPanel();
    expect(sidePanel().infoVisible).toBe(false);
    expect(infoPanelShownNow()).toBe(false);
    toggleInfoPanel();
    expect(sidePanel().infoVisible).toBe(true);
    expect(infoPanelShownNow()).toBe(true);
    expect(kept()).toBe(false);
  });

  it('shows a panel that stepped aside, kept by the person, and pressed again hides it', () => {
    useInfoPanelRoomStore.getState().setContentWidth(NARROW);
    sidePanel().setVisible(true);
    toggleInfoPanel();
    expect(infoPanelShownNow()).toBe(true);
    expect(kept()).toBe(true);
    expect(sidePanel().infoVisible).toBe(true);

    toggleInfoPanel();
    expect(infoPanelShownNow()).toBe(false);
    expect(sidePanel().infoVisible).toBe(false);
    expect(stored().infoVisible).toBe(false);
  });

  it('keeps it until the side panel next hides, then steps aside again', () => {
    useInfoPanelRoomStore.getState().setContentWidth(NARROW);
    sidePanel().setVisible(true);
    toggleInfoPanel();
    expect(infoPanelShownNow()).toBe(true);

    // Opening another kind keeps it: the side panel never hid.
    sidePanel().openKind('files');
    expect(infoPanelShownNow()).toBe(true);

    sidePanel().setVisible(false);
    expect(kept()).toBe(false);
    sidePanel().setVisible(true);
    expect(infoPanelShownNow()).toBe(false);
  });

  it('keeps it until the pane grows past the room, then steps aside at the next squeeze', () => {
    useInfoPanelRoomStore.getState().setContentWidth(NARROW);
    sidePanel().setVisible(true);
    toggleInfoPanel();
    useInfoPanelRoomStore.getState().setContentWidth(NARROW + 20);
    expect(kept()).toBe(true);
    useInfoPanelRoomStore.getState().setContentWidth(WIDE);
    expect(kept()).toBe(false);
    useInfoPanelRoomStore.getState().setContentWidth(NARROW);
    expect(infoPanelShownNow()).toBe(false);
  });

  it('writes nothing when it only shows a panel that stepped aside', () => {
    useInfoPanelRoomStore.getState().setContentWidth(NARROW);
    sidePanel().setVisible(true);
    const before = storage.get(SIDE_PANEL_STORAGE_KEY);
    toggleInfoPanel();
    expect(storage.get(SIDE_PANEL_STORAGE_KEY)).toBe(before);
  });

  it('counts nothing and asks for no focus', () => {
    sidePanel().openKind('changes');
    sidePanel().takeFocusRequest('changes');
    const { uses, layout } = sidePanel();
    toggleInfoPanel();
    toggleInfoPanel();
    expect(sidePanel().uses).toBe(uses);
    expect(sidePanel().layout).toBe(layout);
    expect(sidePanel().focusRequest).toBeNull();
  });
});
