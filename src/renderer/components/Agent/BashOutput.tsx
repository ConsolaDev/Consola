import { useState, useMemo } from 'react';
import { Box, Text } from '@radix-ui/themes';
import { countLines } from './toolOutputParser';

export interface BashOutputProps {
  stdout: string;
  stderr: string;
  interrupted: boolean;
  maxLines?: number;
}

export function BashOutput({ stdout, stderr, interrupted, maxLines = 10 }: BashOutputProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const content = stdout || stderr;
  const lineCount = useMemo(() => countLines(content), [content]);
  const shouldCollapse = lineCount > maxLines;

  const displayContent = useMemo(() => {
    if (!shouldCollapse || expanded) {
      return stdout;
    }
    const lines = stdout.split('\n');
    return lines.slice(0, maxLines).join('\n');
  }, [stdout, shouldCollapse, expanded, maxLines]);

  const hiddenLineCount = lineCount - maxLines;

  const handleCopy = async () => {
    try {
      // Copy both stdout and stderr if present
      const textToCopy = stderr ? `${stdout}\n\nstderr:\n${stderr}` : stdout;
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  // Nothing to show
  if (!stdout && !stderr && !interrupted) {
    return null;
  }

  return (
    <Box className="bash-output">
      {interrupted && (
        <Box className="bash-interrupted">
          <Text size="1">Interrupted</Text>
        </Box>
      )}
      {stdout && (
        <Box
          className={`tool-output-content ${shouldCollapse && !expanded ? 'collapsed' : ''}`}
        >
          <Text as="div" size="1">
            {displayContent}
          </Text>
          <Box className="tool-output-copy" onClick={handleCopy}>
            <Text size="1">{copied ? 'Copied!' : 'Copy'}</Text>
          </Box>
        </Box>
      )}
      {stderr && (
        <Box className="bash-stderr-section">
          <Text className="bash-stderr-label" size="1">stderr</Text>
          <Box className="tool-output-content bash-stderr">
            <Text as="div" size="1">
              {stderr}
            </Text>
          </Box>
        </Box>
      )}
      {shouldCollapse && stdout && (
        <Box
          className="tool-expand-button"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <Text size="1">Collapse</Text>
          ) : (
            <Text size="1">+{hiddenLineCount} more lines</Text>
          )}
        </Box>
      )}
    </Box>
  );
}
