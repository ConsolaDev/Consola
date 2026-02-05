import { Box, Text } from '@radix-ui/themes';
import { ThinkingBlock } from './ThinkingBlock';
import { MarkdownRenderer } from '../Markdown';
import { ToolBlock, ToolStatus as ToolBlockStatus } from './ToolBlock';
import { FileContentBlock } from './FileContentBlock';
import type { ContentBlock, ToolExecution } from '../../stores/agentStore';

interface ChatMessageProps {
  type: 'user' | 'assistant';
  content: string;
  contentBlocks?: ContentBlock[];
  timestamp: number;
  toolHistory?: ToolExecution[];
}

export function ChatMessage({
  type,
  content,
  contentBlocks,
  toolHistory = []
}: ChatMessageProps) {
  const isUser = type === 'user';

  // Find tool result by tool_use block ID
  const findToolResult = (toolUseId: string): ToolExecution | undefined => {
    return toolHistory.find(t => t.toolUseId === toolUseId);
  };

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
              // Check if this text block has file content attached
              if (block.file) {
                return (
                  <FileContentBlock
                    key={idx}
                    file={block.file}
                  />
                );
              }
              return (
                <MarkdownRenderer
                  key={idx}
                  content={block.text}
                />
              );
            }
            if (block.type === 'tool_use') {
              const toolResult = findToolResult(block.id);
              let status: ToolBlockStatus = 'pending';
              if (toolResult) {
                status = toolResult.status === 'error' ? 'error' : 'complete';
              }
              return (
                <ToolBlock
                  key={idx}
                  name={block.name}
                  input={block.input}
                  status={status}
                  output={toolResult?.toolResponse}
                />
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
