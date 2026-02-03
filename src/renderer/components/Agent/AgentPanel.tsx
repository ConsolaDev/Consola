import { useRef, useEffect } from 'react';
import { Box, Flex, Text, Button } from '@radix-ui/themes';
import { useAgent } from '../../hooks/useAgent';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { ToolStatus } from './ToolStatus';
import { ProcessingIndicator } from './ProcessingIndicator';

export function AgentPanel() {
  const {
    isAvailable,
    isRunning,
    messages,
    activeTools,
    error,
    isProcessing,
    sendMessage,
    interrupt,
    clearError
  } = useAgent();

  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  if (!isAvailable) {
    return (
      <Flex align="center" justify="center" className="agent-panel unavailable">
        <Text color="gray">Claude Agent API not available</Text>
      </Flex>
    );
  }

  return (
    <Flex direction="column" className="agent-panel">
      {/* Messages area */}
      <Box ref={scrollRef} className="messages-container">
        {messages.length === 0 && !isProcessing ? (
          <Flex align="center" justify="center" className="empty-state">
            <Text color="gray">Start a conversation with Claude</Text>
          </Flex>
        ) : (
          <>
            {messages.map(msg => (
              <ChatMessage
                key={msg.id}
                type={msg.type}
                content={msg.content}
                contentBlocks={msg.contentBlocks}
                timestamp={msg.timestamp}
              />
            ))}
            {isProcessing && <ProcessingIndicator />}
          </>
        )}
      </Box>

      {/* Error display */}
      {error && (
        <Box className="error-banner">
          <Flex justify="between" align="center">
            <Text size="2" className="error-text">{error}</Text>
            <Button size="1" variant="ghost" onClick={clearError}>
              Dismiss
            </Button>
          </Flex>
        </Box>
      )}

      {/* Tool status */}
      <ToolStatus activeTools={activeTools} />

      {/* Input */}
      <ChatInput
        onSend={sendMessage}
        onInterrupt={interrupt}
        isRunning={isRunning}
        disabled={false}
      />
    </Flex>
  );
}
