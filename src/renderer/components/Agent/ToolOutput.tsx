import { useState, useMemo } from 'react';
import { Box, Text, Flex } from '@radix-ui/themes';
import { parseToolOutput, countLines } from './toolOutputParser';

export interface ToolOutputProps {
  content: unknown;
  maxLines?: number;  // Default 10
}

export function ToolOutput({ content, maxLines = 10 }: ToolOutputProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const parsed = useMemo(() => parseToolOutput(content), [content]);
  const lineCount = useMemo(() => countLines(parsed.content), [parsed.content]);
  const shouldCollapse = lineCount > maxLines;

  if (!parsed.content) {
    return null;
  }

  const displayContent = useMemo(() => {
    if (!shouldCollapse || expanded) {
      return parsed.content;
    }
    // Show first maxLines
    const lines = parsed.content.split('\n');
    return lines.slice(0, maxLines).join('\n');
  }, [parsed.content, shouldCollapse, expanded, maxLines]);

  const hiddenLineCount = lineCount - maxLines;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(parsed.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <Box className="tool-output-container">
      <Box
        className={`tool-output-content ${shouldCollapse && !expanded ? 'collapsed' : ''} ${parsed.isError ? 'error' : ''}`}
      >
        <Text as="div" size="1">
          {displayContent}
        </Text>
        <Box className="tool-output-copy" onClick={handleCopy}>
          <Text size="1">{copied ? 'Copied!' : 'Copy'}</Text>
        </Box>
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
