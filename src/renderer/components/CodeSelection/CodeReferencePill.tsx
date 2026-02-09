/**
 * CodeReferencePill Component
 *
 * A compact pill displaying a code reference with filename and line range.
 * Appears in the chat input area to show selected code snippets.
 */

import { memo } from 'react';
import { Info, X } from 'lucide-react';
import type { CodeReference } from '../../stores/codeReferencesStore';

interface CodeReferencePillProps {
  /** The code reference to display */
  reference: CodeReference;
  /** Called when the remove button is clicked */
  onRemove: () => void;
}

/**
 * Extract just the filename from a full path
 */
function getFilename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1];
}

/**
 * Format line range for display
 */
function formatLineRange(startLine: number, endLine: number): string {
  if (startLine === endLine) {
    return `(${startLine})`;
  }
  return `(${startLine}-${endLine})`;
}

export const CodeReferencePill = memo(function CodeReferencePill({
  reference,
  onRemove,
}: CodeReferencePillProps) {
  const filename = getFilename(reference.filePath);
  const lineRange = formatLineRange(reference.startLine, reference.endLine);

  return (
    <div className="code-reference-pill" title={`${reference.filePath} ${lineRange}`}>
      <span className="code-reference-pill-icon">
        <Info size={14} />
      </span>
      <span className="code-reference-pill-label">
        <span className="code-reference-pill-filename">{filename}</span>
        <span className="code-reference-pill-lines">{lineRange}</span>
      </span>
      <button
        className="code-reference-pill-remove"
        onClick={onRemove}
        type="button"
        aria-label={`Remove ${filename} reference`}
      >
        <X size={12} />
      </button>
    </div>
  );
});
