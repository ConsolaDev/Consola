import { Box, Text } from '@radix-ui/themes';
import { ThinkingBlock } from './ThinkingBlock';
import { MarkdownRenderer } from '../Markdown';
import type { ContentBlock } from '../../stores/agentStore';

interface ChatMessageProps {
  type: 'user' | 'assistant';
  content: string;
  contentBlocks?: ContentBlock[];
  timestamp: number;
}

export function ChatMessage({
  type,
  content,
  contentBlocks,
  timestamp
}: ChatMessageProps) {
  const isUser = type === 'user';

  // Render content blocks for assistant messages
  const renderContent = () => {
    // User messages: render as markdown
    if (isUser) {
      return (
        <Box className="message-content">
          <MarkdownRenderer content={content} />
        </Box>
      );
    }

    // Assistant messages with content blocks
    if (contentBlocks?.length) {
      return (
        <Box className="message-content">
          {contentBlocks.map((block, idx) => {
            if (block.type === 'thinking') {
              return (
                <ThinkingBlock
                  key={idx}
                  content={block.thinking}
                />
              );
            }
            if (block.type === 'text') {
              return <MarkdownRenderer key={idx} content={block.text} />;
            }
            if (block.type === 'tool_use') {
              return (
                <Box key={idx} className="tool-use-inline">
                  <Text size="1" color="gray">Used {block.name}</Text>
                </Box>
              );
            }
            return null;
          })}
        </Box>
      );
    }

    // Fallback: plain content as markdown
    return (
      <Box className="message-content">
        <MarkdownRenderer content={content} />
      </Box>
    );
  };

  // User messages get a subtle bubble, assistant messages are plain
  if (isUser) {
    return (
      <Box className="chat-message user">
        {renderContent()}
      </Box>
    );
  }

  // Assistant messages: no bubble, just content
  return (
    <Box className="chat-message assistant">
      {renderContent()}
    </Box>
  );
}
