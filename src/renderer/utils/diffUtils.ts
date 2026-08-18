import type { GitDiffHunk } from '../types/electron';

export interface DiffLine {
  type: 'context' | 'add' | 'remove';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

/**
 * Build a unified diff view from hunks.
 * This creates a single list of lines that shows context, additions, and removals inline.
 */
export function buildUnifiedDiff(
  oldContent: string,
  newContent: string,
  hunks: GitDiffHunk[]
): DiffLine[] {
  if (hunks.length === 0) {
    // No hunks means no changes - just show the new content as context
    return newContent.split('\n').map((content, idx) => ({
      type: 'context' as const,
      content,
      oldLineNumber: idx + 1,
      newLineNumber: idx + 1,
    }));
  }

  const result: DiffLine[] = [];
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  let oldLineIdx = 0;
  let newLineIdx = 0;

  for (const hunk of hunks) {
    // Add context lines before the hunk
    while (oldLineIdx < hunk.oldStart - 1 && newLineIdx < hunk.newStart - 1) {
      result.push({
        type: 'context',
        content: newLines[newLineIdx] ?? oldLines[oldLineIdx] ?? '',
        oldLineNumber: oldLineIdx + 1,
        newLineNumber: newLineIdx + 1,
      });
      oldLineIdx++;
      newLineIdx++;
    }

    // Add the hunk lines
    for (const line of hunk.lines) {
      result.push({
        type: line.type,
        content: line.content,
        oldLineNumber: line.oldLineNumber,
        newLineNumber: line.newLineNumber,
      });

      if (line.type === 'remove') {
        oldLineIdx = Math.max(oldLineIdx, (line.oldLineNumber ?? 0));
      } else if (line.type === 'add') {
        newLineIdx = Math.max(newLineIdx, (line.newLineNumber ?? 0));
      } else {
        oldLineIdx = Math.max(oldLineIdx, (line.oldLineNumber ?? 0));
        newLineIdx = Math.max(newLineIdx, (line.newLineNumber ?? 0));
      }
    }
  }

  // Add remaining context lines after the last hunk
  while (newLineIdx < newLines.length) {
    result.push({
      type: 'context',
      content: newLines[newLineIdx],
      oldLineNumber: oldLineIdx < oldLines.length ? oldLineIdx + 1 : undefined,
      newLineNumber: newLineIdx + 1,
    });
    oldLineIdx++;
    newLineIdx++;
  }

  return result;
}
