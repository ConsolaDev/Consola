import { useRef, useEffect, useCallback, RefObject } from 'react';

/**
 * Custom hook that enables Cmd+A (Mac) / Ctrl+A (Windows/Linux) to select
 * only the content within a specific container instead of the entire page.
 *
 * @returns A ref to attach to the selectable container element.
 *          The element should have tabIndex={0} to be focusable.
 */
export function useSelectAll<T extends HTMLElement>(): RefObject<T | null> {
  const contentRef = useRef<T>(null);

  const selectAllContent = useCallback(() => {
    if (!contentRef.current) return;
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(contentRef.current);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const isSelectAll = (isMac ? e.metaKey : e.ctrlKey) && e.key === 'a';

      if (isSelectAll && contentRef.current?.contains(document.activeElement as Node)) {
        e.preventDefault();
        selectAllContent();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectAllContent]);

  return contentRef;
}
