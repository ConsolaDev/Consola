import { useState } from 'react';
import { Box, Text, Flex } from '@radix-ui/themes';

interface ThinkingBlockProps {
  content: string;
  defaultExpanded?: boolean;
}

export function ThinkingBlock({ content, defaultExpanded = false }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <Box className="thinking-block">
      <Flex
        align="center"
        gap="1"
        className="thinking-header"
        onClick={() => setExpanded(!expanded)}
        style={{ cursor: 'pointer' }}
      >
        <span className="thinking-chevron">{expanded ? '▼' : '▶'}</span>
        <Text size="1" color="gray">Thinking</Text>
      </Flex>
      {expanded && (
        <Box className="thinking-content">
          <Text size="2" color="gray">{content}</Text>
        </Box>
      )}
    </Box>
  );
}
