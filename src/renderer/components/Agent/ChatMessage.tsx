import { Box, Text } from '@radix-ui/themes';
import { ThinkingBlock } from './ThinkingBlock';
import { StreamingIndicator } from './StreamingIndicator';
import type { ContentBlock } from '../../stores/agentStore';

interface ChatMessageProps {
  type: 'user' | 'assistant';
  content: string;
  contentBlocks?: ContentBlock[];
  isStreaming?: boolean;
  isThinking?: boolean;
  timestamp: number;
}

export function ChatMessage({
  type,
  content,
  contentBlocks,
  isStreaming,
  isThinking,
  timestamp
}: ChatMessageProps) {
  const isUser = type === 'user';

  // Render content blocks for assistant messages
  const renderContent = () => {
    if (isUser || !contentBlocks?.length) {
      return <Text as="div" className="message-content">{content}</Text>;
    }

    return (
      <Box className="message-content">
        {contentBlocks.map((block, idx) => {
          if (block.type === 'thinking') {
            return (
              <ThinkingBlock
                key={idx}
                content={block.thinking}
                defaultExpanded={isStreaming}
              />
            );
          }
          if (block.type === 'text') {
            return <Text key={idx} as="div">{block.text}</Text>;
          }
          if (block.type === 'tool_use') {
            return (
              <Box key={idx} className="tool-use-inline">
                <Text size="1" color="gray">Using {block.name}...</Text>
              </Box>
            );
          }
          return null;
        })}
        {isStreaming && <StreamingIndicator isThinking={isThinking || false} />}
      </Box>
    );
  };

  return (
    <Box className={`chat-message ${isUser ? 'user' : 'assistant'} ${isStreaming ? 'streaming' : ''}`}>
      <Text size="1" className="message-meta">
        {isUser ? 'You' : 'Claude'} · {new Date(timestamp).toLocaleTimeString()}
        {isStreaming && <span className="streaming-badge">streaming</span>}
      </Text>
      {renderContent()}
    </Box>
  );
}
