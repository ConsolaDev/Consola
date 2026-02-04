import { useState, useMemo } from 'react';
import { Box, Text } from '@radix-ui/themes';

export interface DiffViewProps {
  filePath: string;
  oldString: string;
  newString: string;
  maxLines?: number;  // For collapsing long diffs
}

interface DiffLine {
  type: 'removed' | 'added' | 'context';
  content: string;
  lineNumber?: number;
}

function generateSimpleDiff(oldStr: string, newStr: string): DiffLine[] {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const diffLines: DiffLine[] = [];

  // Simple diff: show all removed lines, then all added lines
  // This is a basic approach; for more sophisticated diffs, use a diff library

  // Find common prefix for context
  let prefixLen = 0;
  while (
    prefixLen < oldLines.length &&
    prefixLen < newLines.length &&
    oldLines[prefixLen] === newLines[prefixLen]
  ) {
    prefixLen++;
  }

  // Find common suffix for context
  let suffixLen = 0;
  while (
    suffixLen < oldLines.length - prefixLen &&
    suffixLen < newLines.length - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  // Add context prefix (up to 3 lines)
  const contextPrefixStart = Math.max(0, prefixLen - 3);
  for (let i = contextPrefixStart; i < prefixLen; i++) {
    diffLines.push({
      type: 'context',
      content: oldLines[i],
      lineNumber: i + 1
    });
  }

  // Add removed lines (from old, excluding common prefix/suffix)
  const removedEnd = oldLines.length - suffixLen;
  for (let i = prefixLen; i < removedEnd; i++) {
    diffLines.push({
      type: 'removed',
      content: oldLines[i],
      lineNumber: i + 1
    });
  }

  // Add added lines (from new, excluding common prefix/suffix)
  const addedEnd = newLines.length - suffixLen;
  for (let i = prefixLen; i < addedEnd; i++) {
    diffLines.push({
      type: 'added',
      content: newLines[i],
      lineNumber: i + 1
    });
  }

  // Add context suffix (up to 3 lines)
  const contextSuffixEnd = Math.min(suffixLen, 3);
  for (let i = 0; i < contextSuffixEnd; i++) {
    const idx = newLines.length - suffixLen + i;
    diffLines.push({
      type: 'context',
      content: newLines[idx],
      lineNumber: idx + 1
    });
  }

  return diffLines;
}

function countChanges(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === 'added') added++;
    if (line.type === 'removed') removed++;
  }
  return { added, removed };
}

export function DiffView({ filePath, oldString, newString, maxLines = 20 }: DiffViewProps) {
  const [expanded, setExpanded] = useState(false);

  const diffLines = useMemo(
    () => generateSimpleDiff(oldString, newString),
    [oldString, newString]
  );

  const changes = useMemo(() => countChanges(diffLines), [diffLines]);
  const shouldCollapse = diffLines.length > maxLines;

  const displayLines = useMemo(() => {
    if (!shouldCollapse || expanded) {
      return diffLines;
    }
    return diffLines.slice(0, maxLines);
  }, [diffLines, shouldCollapse, expanded, maxLines]);

  const hiddenLineCount = diffLines.length - maxLines;

  return (
    <Box className="diff-view">
      <Box className="diff-header">
        <Text size="1" color="gray">
          {filePath}
          {' · '}
          <Text color="green">+{changes.added}</Text>
          {' '}
          <Text color="red">-{changes.removed}</Text>
        </Text>
      </Box>
      <Box className="diff-content">
        {displayLines.map((line, idx) => (
          <Box key={idx} className={`diff-line ${line.type}`}>
            <span className="diff-line-prefix">
              {line.type === 'removed' ? '-' : line.type === 'added' ? '+' : ' '}
            </span>
            <span className="diff-line-content">{line.content || ' '}</span>
          </Box>
        ))}
      </Box>
      {shouldCollapse && (
        <Box
          className="tool-expand-button"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <Text size="1">▲ Collapse</Text>
          ) : (
            <Text size="1">▼ +{hiddenLineCount} more lines</Text>
          )}
        </Box>
      )}
    </Box>
  );
}
