/**
 * useCodeSelection Hook
 *
 * A reusable hook for detecting text selection within code elements.
 * Provides selection state and position for displaying the selection popup.
 *
 * Usage:
 * ```tsx
 * function MyCodeBlock({ filePath, code }) {
 *   const { containerRef, selection, clearSelection } = useCodeSelection({
 *     filePath,
 *     instanceId: 'my-instance',
 *     getLineNumber: (element) => {
 *       // Return the line number for the element
 *       return parseInt(element.dataset.lineNumber ?? '1', 10);
 *     },
 *   });
 *
 *   return (
 *     <div ref={containerRef}>
 *       {code}
 *       {selection && (
 *         <SelectionPopup
 *           position={selection.position}
 *           onAddToChat={() => {
 *             addToChat(selection);
 *             clearSelection();
 *           }}
 *         />
 *       )}
 *     </div>
 *   );
 * }
 * ```
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { useCodeReferencesStore } from '../../stores/codeReferencesStore';

export interface SelectionData {
  /** Selected text content */
  text: string;
  /** Starting line number (1-indexed) */
  startLine: number;
  /** Ending line number (1-indexed) */
  endLine: number;
  /** Position for the popup (viewport coordinates) */
  position: { x: number; y: number };
}

export interface UseCodeSelectionOptions {
  /** The file path this code belongs to */
  filePath: string;
  /** Instance ID for the chat session */
  instanceId: string;
  /**
   * Function to get the line number from an element.
   * The element is the deepest element in the selection.
   * Should return a 1-indexed line number.
   */
  getLineNumber?: (element: Element) => number | null;
  /** Whether selection detection is enabled (default: true) */
  enabled?: boolean;
}

const POPUP_OFFSET_Y = 8; // Gap between selection and popup
const SELECTION_DEBOUNCE_MS = 300; // Debounce for double-click handling

/**
 * Find the line number for a given node in the DOM.
 * Walks up the tree looking for data-line-number or line number elements.
 * Also checks sibling elements for line numbers (react-syntax-highlighter pattern).
 */
function findLineNumber(node: Node | null, customGetter?: (el: Element) => number | null): number | null {
  let current: Node | null = node;

  while (current) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      const element = current as Element;

      // Try custom getter first
      if (customGetter) {
        const lineNum = customGetter(element);
        if (lineNum !== null) return lineNum;
      }

      // Common patterns for line number attributes
      const dataLine = element.getAttribute('data-line-number');
      if (dataLine) return parseInt(dataLine, 10);

      const dataLineNum = element.getAttribute('data-line');
      if (dataLineNum) return parseInt(dataLineNum, 10);

      // Check for line number in class name (e.g., "line-5")
      const lineClass = Array.from(element.classList).find((c) => c.startsWith('line-'));
      if (lineClass) {
        const num = parseInt(lineClass.replace('line-', ''), 10);
        if (!isNaN(num)) return num;
      }

      // react-syntax-highlighter uses linenumber class with index
      if (element.classList.contains('linenumber')) {
        const text = element.textContent?.trim();
        if (text) {
          const num = parseInt(text, 10);
          if (!isNaN(num)) return num;
        }
      }

      // Check for line number element in siblings (react-syntax-highlighter pattern)
      // Lines are often rendered as: <span class="linenumber">5</span><span>code</span>
      const parent = element.parentElement;
      if (parent) {
        // Look for a preceding sibling with .linenumber class
        const siblings = Array.from(parent.children);
        const lineNumSibling = siblings.find(
          (s) => s.classList.contains('linenumber') || s.classList.contains('react-syntax-highlighter-line-number')
        );
        if (lineNumSibling) {
          const text = lineNumSibling.textContent?.trim();
          if (text) {
            const num = parseInt(text, 10);
            if (!isNaN(num)) return num;
          }
        }

        // Git review diff pattern: check for .git-review-inline-diff-line-number sibling
        const diffLineNumSibling = siblings.find((s) =>
          s.classList.contains('git-review-inline-diff-line-number')
        );
        if (diffLineNumSibling) {
          const text = diffLineNumSibling.textContent?.trim();
          if (text) {
            const num = parseInt(text, 10);
            if (!isNaN(num)) return num;
          }
        }
      }
    }

    current = current.parentNode;
  }

  return null;
}

/**
 * Find the line number by looking at the row structure.
 * This is used as a fallback when walking up from the text node doesn't work.
 * It finds the containing row element and extracts the line number from it.
 */
function findLineNumberFromRow(node: Node | null): number | null {
  let current: Node | null = node;

  while (current) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      const element = current as Element;

      // Check if this is a line row in react-syntax-highlighter
      // Rows typically have a span with linenumber as first child
      if (element.tagName === 'SPAN' || element.tagName === 'DIV') {
        const lineNumEl = element.querySelector('.linenumber, .react-syntax-highlighter-line-number');
        if (lineNumEl) {
          const text = lineNumEl.textContent?.trim();
          if (text) {
            const num = parseInt(text, 10);
            if (!isNaN(num)) return num;
          }
        }

        // Git review diff pattern
        const diffLineNumEl = element.querySelector('.git-review-inline-diff-line-number');
        if (diffLineNumEl) {
          const text = diffLineNumEl.textContent?.trim();
          if (text) {
            const num = parseInt(text, 10);
            if (!isNaN(num)) return num;
          }
        }
      }

      // Check for row-level line number attribute
      const dataLine = element.getAttribute('data-line-number');
      if (dataLine) return parseInt(dataLine, 10);
    }

    current = current.parentNode;
  }

  return null;
}

/**
 * Get line numbers from a selection range
 */
function getSelectionLineRange(
  selection: Selection,
  customGetter?: (el: Element) => number | null
): { startLine: number; endLine: number } | null {
  const range = selection.getRangeAt(0);

  // Try to find line numbers using various methods
  let startLine = findLineNumber(range.startContainer, customGetter);
  let endLine = findLineNumber(range.endContainer, customGetter);

  // If direct lookup failed, try row-based lookup
  if (startLine === null) {
    startLine = findLineNumberFromRow(range.startContainer);
  }
  if (endLine === null) {
    endLine = findLineNumberFromRow(range.endContainer);
  }

  // If we still can't find line numbers, return null to indicate failure
  // This is better than returning incorrect line numbers
  if (startLine === null || endLine === null) {
    // Last resort: try to find any line number in the selection range
    const container = range.commonAncestorContainer;
    const containerEl = container.nodeType === Node.ELEMENT_NODE
      ? (container as Element)
      : container.parentElement;

    if (containerEl) {
      // Look for any line number element within the selection context
      const lineNumEls = containerEl.querySelectorAll(
        '.linenumber, .react-syntax-highlighter-line-number, .git-review-inline-diff-line-number, [data-line-number]'
      );

      if (lineNumEls.length > 0) {
        // Get the first visible line number
        const firstLineNum = lineNumEls[0].textContent?.trim();
        if (firstLineNum) {
          const num = parseInt(firstLineNum, 10);
          if (!isNaN(num)) {
            startLine = startLine ?? num;
            // Count the actual lines in selection
            const text = selection.toString();
            const lineCount = text.split('\n').length;
            endLine = endLine ?? (startLine + lineCount - 1);
          }
        }
      }
    }

    // If still nothing, use 1 as fallback (shouldn't happen with proper markup)
    if (startLine === null) startLine = 1;
    if (endLine === null) {
      const text = selection.toString();
      const lineCount = text.split('\n').length;
      endLine = startLine + lineCount - 1;
    }
  }

  // Ensure start <= end
  if (startLine > endLine) {
    [startLine, endLine] = [endLine, startLine];
  }

  return { startLine, endLine };
}

export function useCodeSelection({
  filePath,
  instanceId,
  getLineNumber,
  enabled = true,
}: UseCodeSelectionOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<SelectionData | null>(null);
  const addReference = useCodeReferencesStore((state) => state.addReference);

  const clearSelection = useCallback(() => {
    setSelection(null);
  }, []);

  const addToChat = useCallback(() => {
    if (!selection) return;

    addReference(instanceId, {
      filePath,
      startLine: selection.startLine,
      endLine: selection.endLine,
      content: selection.text,
    });

    clearSelection();
    // Clear the browser selection
    window.getSelection()?.removeAllRanges();
  }, [selection, instanceId, filePath, addReference, clearSelection]);

  // Handle selection changes
  const handleSelectionChange = useCallback(() => {
    if (!enabled || !containerRef.current) return;

    const browserSelection = window.getSelection();
    if (!browserSelection || browserSelection.isCollapsed) {
      setSelection(null);
      return;
    }

    // Check if selection is within our container
    const range = browserSelection.getRangeAt(0);
    if (!containerRef.current.contains(range.commonAncestorContainer)) {
      setSelection(null);
      return;
    }

    const text = browserSelection.toString().trim();
    if (!text) {
      setSelection(null);
      return;
    }

    // Get line numbers
    const lineRange = getSelectionLineRange(browserSelection, getLineNumber);
    if (!lineRange) {
      setSelection(null);
      return;
    }

    // Calculate popup position
    const rect = range.getBoundingClientRect();
    const position = {
      x: rect.left + rect.width / 2 - 75, // Center the popup (approx 150px wide)
      y: rect.top - POPUP_OFFSET_Y,
    };

    // Keep popup in viewport
    position.x = Math.max(8, Math.min(position.x, window.innerWidth - 160));
    position.y = Math.max(8, position.y);

    // If popup would be above viewport, show below selection
    if (position.y < 40) {
      position.y = rect.bottom + POPUP_OFFSET_Y;
    }

    setSelection({
      text,
      startLine: lineRange.startLine,
      endLine: lineRange.endLine,
      position,
    });
  }, [enabled, getLineNumber]);

  // Listen for selection changes with debounce for double-click support
  useEffect(() => {
    if (!enabled) return;

    let debounceTimeout: ReturnType<typeof setTimeout> | null = null;

    // Debounced selection handler - waits for rapid events to settle (e.g., double-click)
    const debouncedSelectionChange = () => {
      if (debounceTimeout) {
        clearTimeout(debounceTimeout);
      }
      debounceTimeout = setTimeout(() => {
        handleSelectionChange();
        debounceTimeout = null;
      }, SELECTION_DEBOUNCE_MS);
    };

    // Use mouseup instead of selectionchange for better timing
    const handleMouseUp = () => {
      // Use debounced handler to support double-click selection of entire lines/words
      debouncedSelectionChange();
    };

    // Handle keyboard selection (Shift+Arrow keys)
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.shiftKey || e.key === 'Shift') {
        // Keyboard selection doesn't need debounce
        requestAnimationFrame(handleSelectionChange);
      }
    };

    // Clear selection on mousedown outside
    const handleMouseDown = (e: MouseEvent) => {
      const popup = document.querySelector('.code-selection-popup');
      if (popup && popup.contains(e.target as Node)) {
        return; // Don't clear if clicking the popup
      }
      // Clear will happen naturally when selection changes
    };

    // Handle Cmd+L keyboard shortcut
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const modifier = isMac ? e.metaKey : e.ctrlKey;

      if (modifier && e.key.toLowerCase() === 'l' && selection) {
        e.preventDefault();
        addToChat();
      }
    };

    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('keyup', handleKeyUp);
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      if (debounceTimeout) {
        clearTimeout(debounceTimeout);
      }
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keyup', handleKeyUp);
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled, handleSelectionChange, selection, addToChat]);

  // Clear selection when clicking outside container
  useEffect(() => {
    if (!selection) return;

    const handleClickOutside = (e: MouseEvent) => {
      const popup = document.querySelector('.code-selection-popup');
      if (popup?.contains(e.target as Node)) return;
      if (containerRef.current?.contains(e.target as Node)) return;

      clearSelection();
    };

    // Use capture to get the event before it's handled
    document.addEventListener('mousedown', handleClickOutside, true);
    return () => document.removeEventListener('mousedown', handleClickOutside, true);
  }, [selection, clearSelection]);

  return {
    /** Ref to attach to the container element */
    containerRef,
    /** Current selection data, or null if nothing selected */
    selection,
    /** Clear the current selection */
    clearSelection,
    /** Add the current selection to chat */
    addToChat,
  };
}
