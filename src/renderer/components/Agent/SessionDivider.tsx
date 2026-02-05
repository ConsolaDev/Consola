import { Box, Text } from '@radix-ui/themes';

interface SessionDividerProps {
  type: 'session-cleared' | 'session-compacted';
  timestamp: number;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function SessionDivider({ type, timestamp }: SessionDividerProps) {
  const label = type === 'session-cleared' ? 'Session cleared' : 'Context compacted';

  return (
    <Box className="session-divider">
      <Box className="session-divider-line" />
      <Text size="1" className="session-divider-label">
        {label} · {formatTime(timestamp)}
      </Text>
      <Box className="session-divider-line" />
    </Box>
  );
}
