import { Box, Text, Flex } from '@radix-ui/themes';
import type { ToolExecution } from '../../stores/agentStore';

interface ToolStatusProps {
  activeTools: ToolExecution[];
}

export function ToolStatus({ activeTools }: ToolStatusProps) {
  if (activeTools.length === 0) return null;

  return (
    <Box className="tool-status">
      <Text size="1" className="tool-status-label">Active Tools</Text>
      <Flex direction="column" gap="1">
        {activeTools.map(tool => (
          <Flex key={tool.id} align="center" gap="2" className="tool-item">
            <span className={`tool-badge ${tool.status}`}>
              {tool.status === 'pending' ? 'Running' : tool.status}
            </span>
            <Text size="2" className="tool-name">{tool.toolName}</Text>
          </Flex>
        ))}
      </Flex>
    </Box>
  );
}
