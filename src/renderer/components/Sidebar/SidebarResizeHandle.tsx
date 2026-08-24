import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import {
  useNavigationStore,
  clampSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
} from '../../stores/navigationStore';

interface SidebarResizeHandleProps {
  /**
   * The element carrying `--sidebar-width`. Layout sets the committed width
   * on it declaratively; a drag in flight paints there too, so the two never
   * shadow each other.
   */
  layoutRef: RefObject<HTMLElement | null>;
}

interface Gesture {
  pointerId: number;
  startX: number;
  startWidth: number;
  /** The last width painted; what gets committed when the pointer lifts. */
  width: number;
}

/**
 * The drag handle on the sidebar's right edge.
 *
 * A pointer move writes the width straight to the CSS variable rather than to
 * the store: every move would otherwise re-render the header, the sidebar and
 * the content area, and re-serialise the navigation store to localStorage,
 * for a value nothing needs until the pointer lifts. The store is written
 * once, at the end of the gesture; Layout's style prop then agrees with what
 * is already on screen.
 *
 * Pointer capture keeps every event of the gesture targeted at this element,
 * so the terminal canvas the pointer crosses on the way never sees it.
 */
export function SidebarResizeHandle({ layoutRef }: SidebarResizeHandleProps) {
  const setSidebarWidth = useNavigationStore((state) => state.setSidebarWidth);
  const [isDragging, setIsDragging] = useState(false);
  const gesture = useRef<Gesture | null>(null);

  const paint = (width: number) => {
    layoutRef.current?.style.setProperty('--sidebar-width', `${width}px`);
  };

  // Hidden mid-drag (⌘\): the gesture dies with this element, so it ends
  // where it was rather than leaving an uncommitted width on screen.
  useEffect(
    () => () => {
      if (gesture.current) setSidebarWidth(gesture.current.width);
    },
    [setSidebarWidth]
  );

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // Keeps the press from starting a text selection or moving focus.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startWidth = useNavigationStore.getState().sidebarWidth;
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth,
      width: startWidth,
    };
    setIsDragging(true);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    current.width = clampSidebarWidth(current.startWidth + event.clientX - current.startX);
    paint(current.width);
  };

  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    gesture.current = null;
    setIsDragging(false);
    // A click that never moved has nothing to persist.
    if (current.width !== current.startWidth) setSidebarWidth(current.width);
  };

  const handleDoubleClick = () => setSidebarWidth(SIDEBAR_WIDTH_DEFAULT);

  return (
    <div
      className="sidebar-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      data-dragging={isDragging || undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onDoubleClick={handleDoubleClick}
    />
  );
}
