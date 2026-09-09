import { useEffect } from 'react';

/**
 * Stop a drag nothing in the app handles from replacing the window.
 *
 * A window that does not handle a drop lets Chromium navigate to the dropped
 * file or link, which unloads the whole renderer — the UI simply disappears.
 * These listeners run after the React tree has had the event, so a target that
 * wants the drag has already cancelled it; everything else is swallowed, and
 * shows "no drop" rather than inviting a gesture the window ignores.
 *
 * Cancelling is the whole signal, and it has to be. Vetoing by elimination —
 * "anything outside the elements I know about" — silently vetoes the next drop
 * target added, because `dropEffect` is last-write-wins and this runs last: the
 * target sets `move`, the guard overwrites it with `none`, and Chromium refuses
 * the drop without ever firing `drop`. There is no error and nothing on screen,
 * which is exactly how it hid in the sidebar's group headers.
 */
export function useWindowDropGuard(): void {
  useEffect(() => {
    const handleDragOver = (event: DragEvent) => {
      // Claimed by a drop target on the way up; its dropEffect is the answer.
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'none';
      }
    };

    const handleDrop = (event: DragEvent) => {
      event.preventDefault();
    };

    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('drop', handleDrop);

    return () => {
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('drop', handleDrop);
    };
  }, []);
}
