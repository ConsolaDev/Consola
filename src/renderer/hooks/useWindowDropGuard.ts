import { useEffect } from 'react';

/** Elements that accept file drops mark themselves with this attribute. */
const DROP_ZONE_SELECTOR = '[data-file-drop-zone]';

/**
 * Stop a file dropped outside a drop zone from replacing the app.
 *
 * A window that does not handle a drop lets Chromium navigate to the dropped
 * file, which unloads the whole renderer — the UI simply disappears. These
 * listeners run after the React tree has had the event, so a drop zone still
 * sees its own drop; everything else is swallowed. Outside a zone the cursor
 * shows "no drop", so the window never invites a gesture it ignores.
 */
export function useWindowDropGuard(): void {
  useEffect(() => {
    const isInsideDropZone = (target: EventTarget | null) =>
      target instanceof Element && target.closest(DROP_ZONE_SELECTOR) !== null;

    const handleDragOver = (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer && !isInsideDropZone(event.target)) {
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
