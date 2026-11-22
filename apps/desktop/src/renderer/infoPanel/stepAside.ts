/**
 * When the info panel steps aside: on a narrow window, the conversation keeps
 * room to be read before every panel is drawn.
 *
 * While the side panel is open and the session pane (`ContentView`'s
 * `Group`) is too narrow for the conversation and both panels, the info
 * panel is not drawn, and so reads nothing. It is back as soon as there is
 * room again, or the side panel hides. The person's own show and hide
 * (`sidePanelStore.infoVisible`) is never written by this, so nothing is
 * saved: a relaunch at a wide window shows the panel as before.
 *
 * While all three are on screen on a pane with that room, the conversation's
 * 60 columns are its floor (`conversationKeepsRoom`): the panels give way
 * before it does, and a split saved while the person kept the panel on a
 * narrow pane, with the conversation down to 20%, never restores that narrow
 * on a pane that holds the 60 columns.
 *
 * The rule reads the pane's width only, never the conversation's. The panels
 * inside the pane do not change its width, so showing or hiding the info
 * panel cannot flip the rule back.
 */

/**
 * About 60 columns of the conversation's terminal at its default font size:
 * its `minSize` in `ContentView` while it keeps room beside both panels.
 */
export const CONVERSATION_ROOM_PX = 480;
/** The info panel's `defaultSize` in `ContentView`. */
export const INFO_PANEL_DEFAULT_PX = 250;
/** The side panel's `minSize` in `ContentView`. */
export const SIDE_PANEL_MIN_PX = 280;
/**
 * The width of each separator between the session pane's panels: the
 * `.resize-handle` rule in `components/Views/styles.css`, which must move
 * with it. The panels' sizes are shares of what the separators leave.
 */
export const PANEL_SEPARATOR_PX = 8;
/**
 * The narrowest session pane that holds all three: 60 columns of
 * conversation beside the info panel at its default width and the side panel
 * at its narrowest, with the two separators between them,
 * 480 + 250 + 280 + 2 × 8 = 1026px. Narrower, with the side panel open, the
 * info panel steps aside.
 */
export const INFO_PANEL_ROOM_PX =
  CONVERSATION_ROOM_PX + INFO_PANEL_DEFAULT_PX + SIDE_PANEL_MIN_PX + 2 * PANEL_SEPARATOR_PX;

export interface InfoPanelRoom {
  /** Whether the person wants the info panel: `sidePanelStore.infoVisible`. */
  infoVisible: boolean;
  sidePanelVisible: boolean;
  /** The session pane's width in CSS pixels, or null before it is measured. */
  contentWidth: number | null;
  /** The person showed the panel while it had stepped aside: held in memory only. */
  keptByPerson: boolean;
}

/**
 * Whether there is too little room for the info panel: the side panel open
 * on a pane narrower than `INFO_PANEL_ROOM_PX`. A pane not yet measured
 * counts as narrow, so the panel is never drawn beside the side panel, nor
 * reads anything, before it is known to fit.
 */
export function crowded({
  sidePanelVisible,
  contentWidth,
}: Pick<InfoPanelRoom, 'sidePanelVisible' | 'contentWidth'>): boolean {
  return sidePanelVisible && (contentWidth === null || contentWidth < INFO_PANEL_ROOM_PX);
}

/**
 * Whether the info panel is on screen. Everything that asks whether it is
 * shown reads this, never `infoVisible` alone.
 */
export function infoPanelShown(room: InfoPanelRoom): boolean {
  return room.infoVisible && (room.keptByPerson || !crowded(room));
}

/**
 * Whether the conversation keeps 60 columns (`CONVERSATION_ROOM_PX` as its
 * `minSize`): while the info panel and the side panel are both on screen on
 * a pane that holds all three. Otherwise its floor is 20% of the pane, as
 * while the person keeps the info panel on a narrow pane, where 60 columns
 * would leave the two panels too little.
 */
export function conversationKeepsRoom(room: InfoPanelRoom): boolean {
  return infoPanelShown(room) && room.sidePanelVisible && !crowded(room);
}

/**
 * What the toggle (its button, ⌥⌘J, the palette's row) leaves. A panel on
 * screen hides, as it always has. One that is not shows, as the person's own
 * choice: kept while it would otherwise step aside, and with `infoVisible`
 * left as it was when only the rule had moved it.
 */
export function toggledInfoPanel(
  room: InfoPanelRoom,
): Pick<InfoPanelRoom, 'infoVisible' | 'keptByPerson'> {
  if (infoPanelShown(room)) return { infoVisible: false, keptByPerson: false };
  return { infoVisible: true, keptByPerson: crowded(room) };
}

/**
 * The person's keep once the room has changed: it lasts while the panel
 * would otherwise step aside, and ends when the side panel hides or the pane
 * has room again, so the next squeeze steps aside as before.
 */
export function keepAfter(room: InfoPanelRoom): boolean {
  return room.keptByPerson && crowded(room);
}
