import { Box, Text } from '@radix-ui/themes';

interface ChatMessageProps {
  type: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export function ChatMessage({ type, content, timestamp }: ChatMessageProps) {
  const isUser = type === 'user';

  return (
    <Box className={`chat-message ${isUser ? 'user' : 'assistant'}`}>
      <Text size="1" className="message-meta">
        {isUser ? 'You' : 'Claude'} · {new Date(timestamp).toLocaleTimeString()}
      </Text>
      <Text as="div" className="message-content">
        {content}
      </Text>
    </Box>
  );
}
