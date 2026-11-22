import { type RefObject, useLayoutEffect } from 'react';
import { create } from 'zustand';
import {
  infoPanelShown,
  keepAfter,
  toggledInfoPanel,
  type InfoPanelRoom,
} from '../infoPanel/stepAside';
import { useSidePanelStore } from './sidePanelStore';

/**
 * What decides, beside the person's own setting, whether the info panel is on
 * screen (`infoPanel/stepAside.ts`): the session pane's width and whether
 * the person kept the panel while it had stepped aside. Held in memory only,
 * apart from `sidePanelStore`, which writes its whole state to localStorage
 * on every change, and must never hear of a resize.
 */
interface InfoPanelRoomState {
  /** The width of `ContentView`'s `Group`, or null before it is measured. */
  contentWidth: number | null;
  keptByPerson: boolean;
  setContentWidth(width: number): void;
}

function roomNow(): InfoPanelRoom {
  const { infoVisible, layout } = useSidePanelStore.getState();
  const { contentWidth, keptByPerson } = useInfoPanelRoomStore.getState();
  return { infoVisible, sidePanelVisible: layout.visible, contentWidth, keptByPerson };
}

export const useInfoPanelRoomStore = create<InfoPanelRoomState>()((set, get) => ({
  contentWidth: null,
  keptByPerson: false,
  setContentWidth: (contentWidth) => {
    if (contentWidth === get().contentWidth) return;
    set({ contentWidth, keptByPerson: keepAfter({ ...roomNow(), contentWidth }) });
  },
}));

// The side panel hiding ends the person's keep, as the pane growing past the
// room does (`setContentWidth`): the next squeeze steps aside again.
useSidePanelStore.subscribe((state, previous) => {
  if (state.layout.visible === previous.layout.visible) return;
  const keptByPerson = keepAfter(roomNow());
  if (keptByPerson !== useInfoPanelRoomStore.getState().keptByPerson) {
    useInfoPanelRoomStore.setState({ keptByPerson });
  }
});

/** Whether the info panel is on screen, for callers outside a component. */
export function infoPanelShownNow(): boolean {
  return infoPanelShown(roomNow());
}

/** Whether the info panel is on screen; renders again only when that changes. */
export function useInfoPanelShown(): boolean {
  const infoVisible = useSidePanelStore((state) => state.infoVisible);
  const sidePanelVisible = useSidePanelStore((state) => state.layout.visible);
  return useInfoPanelRoomStore((state) =>
    infoPanelShown({
      infoVisible,
      sidePanelVisible,
      contentWidth: state.contentWidth,
      keptByPerson: state.keptByPerson,
    }),
  );
}

/**
 * What the info panel's toggle does, from its button, its chord and the
 * palette: hides a panel on screen, and shows one that is not, the person
 * keeping it when it had stepped aside (`toggledInfoPanel`). The person's
 * setting is written only when it changes, so showing a panel that only
 * stepped aside saves nothing.
 */
export function toggleInfoPanel(): void {
  const { infoVisible, keptByPerson } = toggledInfoPanel(roomNow());
  useInfoPanelRoomStore.setState({ keptByPerson });
  const sidePanel = useSidePanelStore.getState();
  if (sidePanel.infoVisible !== infoVisible) sidePanel.setInfoVisible(infoVisible);
}

/**
 * Measures `ref`'s element, the session pane's `Group`, into the store: at
 * once as it mounts, before the first paint, and on every resize after.
 * `mounted` names when the element can be there, so the measure starts once
 * it is. On unmount the width is forgotten, so a pane mounted later is never
 * judged by a width it no longer has.
 */
export function useContentWidth(ref: RefObject<HTMLElement | null>, mounted: boolean): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!mounted || !element) return undefined;
    const { setContentWidth } = useInfoPanelRoomStore.getState();
    const measure = () => setContentWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      useInfoPanelRoomStore.setState({ contentWidth: null });
    };
  }, [ref, mounted]);
}
