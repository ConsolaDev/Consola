import { useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { createShiftGuard } from '../../sidebar/shiftGuard';
import type { RowBox } from '../../sidebar/shiftGuard';

/** A tree's row: a conductor's children ride inside it, as they do in `BucketMotion`. */
const ROW = '.session-list > [data-entry-key]';

const PRESS_FOLLOW_UPS = ['click', 'auxclick', 'dblclick', 'contextmenu'] as const;

/** Typing into a field cannot move rows; Enter and shortcuts in one can (sending a prompt). */
function editsText(event: KeyboardEvent): boolean {
  const target = event.target;
  const editable =
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement);
  return editable && event.key !== 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey;
}

/**
 * A row's top as laid out. Offsets ignore scrolling, so scrolling the list
 * moves no row, and ignore transforms, so a row mid-flight (`BucketMotion`)
 * reads where it is landing.
 */
function layoutTop(element: HTMLElement): number {
  let top = 0;
  for (let node: Element | null = element; node instanceof HTMLElement; node = node.offsetParent) {
    top += node.offsetTop;
  }
  return top;
}

function measure(root: HTMLElement): Map<string, RowBox> {
  const boxes = new Map<string, RowBox>();
  for (const row of root.querySelectorAll<HTMLElement>(ROW)) {
    const key = row.dataset.entryKey;
    if (key) boxes.set(key, { top: layoutTop(row), height: row.offsetHeight });
  }
  return boxes;
}

function listen(root: HTMLElement): { update: () => void; dispose: () => void } {
  const guard = createShiftGuard(() => performance.now());
  const view = root.ownerDocument.defaultView;
  const rowOf = (target: EventTarget | null): string | null => {
    const row = target instanceof Element ? target.closest<HTMLElement>(ROW) : null;
    return row && root.contains(row) ? (row.dataset.entryKey ?? null) : null;
  };
  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const onPointerDown = (event: PointerEvent) => {
    if (guard.press(event.pointerId, rowOf(event.target)) === 'drop') swallow(event);
  };
  const onPointerUp = (event: PointerEvent) => {
    if (guard.release(event.pointerId, rowOf(event.target)) === 'drop') swallow(event);
  };
  const onPointerCancel = (event: PointerEvent) => guard.cancel(event.pointerId);
  const onKeyDown = (event: KeyboardEvent) => guard.key(editsText(event));
  const onFollowUp = (event: MouseEvent) => {
    // Keyboard activation clicks carry no click count; only pointer presses are dropped.
    if (event.type === 'click' && event.detail === 0) return;
    const pointerId = event instanceof PointerEvent ? event.pointerId : undefined;
    if (guard.followUp(pointerId, rowOf(event.target)) === 'drop') swallow(event);
  };

  // Window capture runs before React, the row's drag and Radix see the press.
  const capture = { capture: true };
  view?.addEventListener('pointerdown', onPointerDown, capture);
  view?.addEventListener('pointerup', onPointerUp, capture);
  view?.addEventListener('pointercancel', onPointerCancel, capture);
  view?.addEventListener('keydown', onKeyDown, capture);
  for (const type of PRESS_FOLLOW_UPS) view?.addEventListener(type, onFollowUp, capture);
  guard.layout(measure(root));

  return {
    update: () => guard.layout(measure(root)),
    dispose: () => {
      view?.removeEventListener('pointerdown', onPointerDown, capture);
      view?.removeEventListener('pointerup', onPointerUp, capture);
      view?.removeEventListener('pointercancel', onPointerCancel, capture);
      view?.removeEventListener('keydown', onKeyDown, capture);
      for (const type of PRESS_FOLLOW_UPS) view?.removeEventListener(type, onFollowUp, capture);
    },
  };
}

/**
 * Keeps a press on a row the list just moved from landing (`createShiftGuard`).
 * Reads where the rows are after every render of the sidebar, which is every
 * time the list can have moved one.
 */
export function useShiftGuard(rootRef: RefObject<HTMLElement | null>): void {
  const active = useRef<{ root: HTMLElement; update: () => void; dispose: () => void } | null>(
    null,
  );
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (active.current?.root === root) {
      active.current?.update();
      return;
    }
    active.current?.dispose();
    active.current = root ? { root, ...listen(root) } : null;
  });
  useEffect(
    () => () => {
      active.current?.dispose();
      active.current = null;
    },
    [],
  );
}
