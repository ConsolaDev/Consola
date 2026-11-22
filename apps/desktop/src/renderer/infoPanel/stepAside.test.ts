import { describe, expect, it } from 'vitest';
import {
  conversationKeepsRoom,
  crowded,
  INFO_PANEL_ROOM_PX,
  infoPanelShown,
  keepAfter,
  toggledInfoPanel,
  type InfoPanelRoom,
} from './stepAside';

/** The default window's session pane, with the sidebar shown. */
const NARROW = 704;
const WIDE = 1100;

const room = (over: Partial<InfoPanelRoom> = {}): InfoPanelRoom => ({
  infoVisible: true,
  sidePanelVisible: true,
  contentWidth: NARROW,
  keptByPerson: false,
  ...over,
});

describe('INFO_PANEL_ROOM_PX', () => {
  it('holds 60 columns of conversation beside both panels at their narrowest defaults', () => {
    expect(INFO_PANEL_ROOM_PX).toBe(480 + 250 + 280);
  });
});

describe('infoPanelShown', () => {
  it('steps aside on a narrow pane while the side panel is open', () => {
    expect(infoPanelShown(room())).toBe(false);
    expect(infoPanelShown(room({ contentWidth: INFO_PANEL_ROOM_PX - 1 }))).toBe(false);
  });

  it('shows on a pane with room for all three', () => {
    expect(infoPanelShown(room({ contentWidth: WIDE }))).toBe(true);
    expect(infoPanelShown(room({ contentWidth: INFO_PANEL_ROOM_PX }))).toBe(true);
  });

  it('shows at any width while the side panel is hidden', () => {
    expect(infoPanelShown(room({ sidePanelVisible: false }))).toBe(true);
    expect(infoPanelShown(room({ sidePanelVisible: false, contentWidth: 300 }))).toBe(true);
    expect(infoPanelShown(room({ sidePanelVisible: false, contentWidth: null }))).toBe(true);
  });

  it('shows on a narrow pane when the person kept it', () => {
    expect(infoPanelShown(room({ keptByPerson: true }))).toBe(true);
  });

  it('never shows a panel the person hid', () => {
    expect(infoPanelShown(room({ infoVisible: false, contentWidth: WIDE }))).toBe(false);
    expect(infoPanelShown(room({ infoVisible: false, sidePanelVisible: false }))).toBe(false);
    expect(infoPanelShown(room({ infoVisible: false, keptByPerson: true }))).toBe(false);
  });

  it('waits for the pane to be measured before drawing beside the side panel', () => {
    expect(crowded(room({ contentWidth: null }))).toBe(true);
    expect(infoPanelShown(room({ contentWidth: null }))).toBe(false);
  });
});

describe('toggledInfoPanel', () => {
  it('hides a panel that shows, as ever', () => {
    expect(toggledInfoPanel(room({ contentWidth: WIDE }))).toEqual({
      infoVisible: false,
      keptByPerson: false,
    });
    expect(toggledInfoPanel(room({ keptByPerson: true }))).toEqual({
      infoVisible: false,
      keptByPerson: false,
    });
  });

  it('shows a panel that stepped aside, kept by the person, and leaves their setting as it was', () => {
    expect(toggledInfoPanel(room())).toEqual({ infoVisible: true, keptByPerson: true });
  });

  it('shows a hidden panel, kept only while it would otherwise step aside', () => {
    expect(toggledInfoPanel(room({ infoVisible: false }))).toEqual({
      infoVisible: true,
      keptByPerson: true,
    });
    expect(toggledInfoPanel(room({ infoVisible: false, contentWidth: WIDE }))).toEqual({
      infoVisible: true,
      keptByPerson: false,
    });
    expect(toggledInfoPanel(room({ infoVisible: false, sidePanelVisible: false }))).toEqual({
      infoVisible: true,
      keptByPerson: false,
    });
  });
});

describe('conversationKeepsRoom', () => {
  it('keeps 60 columns beside both panels on a pane that holds all three', () => {
    expect(conversationKeepsRoom(room({ contentWidth: INFO_PANEL_ROOM_PX }))).toBe(true);
    expect(conversationKeepsRoom(room({ contentWidth: WIDE }))).toBe(true);
  });

  it('keeps no 60 columns while the person keeps the panel on a narrow pane, which has no room for them', () => {
    expect(conversationKeepsRoom(room({ keptByPerson: true }))).toBe(false);
    expect(
      conversationKeepsRoom(room({ keptByPerson: true, contentWidth: INFO_PANEL_ROOM_PX - 1 })),
    ).toBe(false);
  });

  it('keeps none beside one panel or none', () => {
    expect(conversationKeepsRoom(room({ contentWidth: WIDE, infoVisible: false }))).toBe(false);
    expect(conversationKeepsRoom(room({ contentWidth: WIDE, sidePanelVisible: false }))).toBe(
      false,
    );
    expect(
      conversationKeepsRoom(
        room({ contentWidth: WIDE, infoVisible: false, sidePanelVisible: false }),
      ),
    ).toBe(false);
  });

  it('keeps none before the pane is measured', () => {
    expect(conversationKeepsRoom(room({ contentWidth: null }))).toBe(false);
    expect(conversationKeepsRoom(room({ contentWidth: null, keptByPerson: true }))).toBe(false);
  });
});

describe('keepAfter', () => {
  it('lasts while the pane stays narrow with the side panel open', () => {
    expect(keepAfter(room({ keptByPerson: true }))).toBe(true);
    expect(keepAfter(room({ keptByPerson: false }))).toBe(false);
  });

  it('ends when the side panel hides or the pane has room again', () => {
    expect(keepAfter(room({ keptByPerson: true, sidePanelVisible: false }))).toBe(false);
    expect(keepAfter(room({ keptByPerson: true, contentWidth: WIDE }))).toBe(false);
  });
});
