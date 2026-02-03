import { Box } from '@radix-ui/themes';

interface StreamingIndicatorProps {
  isThinking: boolean;
}

export function StreamingIndicator({ isThinking }: StreamingIndicatorProps) {
  return (
    <Box className={`streaming-indicator ${isThinking ? 'thinking' : 'writing'}`}>
      <span className="cursor" />
    </Box>
  );
}
