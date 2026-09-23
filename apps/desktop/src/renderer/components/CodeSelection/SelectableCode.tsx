/**
 * SelectableCode Component
 *
 * A wrapper component that adds code selection functionality to any child content.
 * Shows the selection popup when text is selected within the wrapper.
 *
 * Usage:
 * ```tsx
 * <SelectableCode filePath="/path/to/file.ts" instanceId="agent-1">
 *   <SyntaxHighlighter>{code}</SyntaxHighlighter>
 * </SelectableCode>
 * ```
 */

import { ReactNode, memo } from 'react';
import { createPortal } from 'react-dom';
import { SelectionPopup } from './SelectionPopup';
import { useCodeSelection, type UseCodeSelectionOptions } from './useCodeSelection';

interface SelectableCodeProps {
  /** The file path this code belongs to */
  filePath: string;
  /** Instance ID for the chat session */
  instanceId: string;
  /** Child content to make selectable */
  children: ReactNode;
  /** Additional class name for the wrapper */
  className?: string;
  /** Custom line number getter function */
  getLineNumber?: UseCodeSelectionOptions['getLineNumber'];
  /** Whether selection is enabled (default: true) */
  enabled?: boolean;
}

export const SelectableCode = memo(function SelectableCode({
  filePath,
  instanceId,
  children,
  className = '',
  getLineNumber,
  enabled = true,
}: SelectableCodeProps) {
  const { containerRef, selection, addToChat } = useCodeSelection({
    filePath,
    instanceId,
    getLineNumber,
    enabled,
  });

  return (
    <div ref={containerRef} className={`selectable-code ${className}`.trim()}>
      {children}
      {selection && createPortal(
        <SelectionPopup
          position={selection.position}
          onAddToChat={addToChat}
        />,
        document.body
      )}
    </div>
  );
});
