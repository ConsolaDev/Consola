import { useRef, useEffect } from 'react';
import { Box, Flex, Text, Button } from '@radix-ui/themes';
import { useAgent } from '../../hooks/useAgent';
import './styles.css';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { ProcessingIndicator } from './ProcessingIndicator';
import { ApprovalCard } from './ApprovalCard';
import { ContextStatusBar } from './ContextStatusBar';

interface AgentPanelProps {
  instanceId: string;
  cwd: string;
}

export function AgentPanel({ instanceId, cwd }: AgentPanelProps) {
  const {
    isAvailable,
    isRunning,
    messages,
    toolHistory,
    pendingInputs,
    error,
    isProcessing,
    model,
    modelUsage,
    sendMessage,
    interrupt,
    clearError,
    respondToInput
  } = useAgent(instanceId, cwd);

  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages or pending inputs
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, pendingInputs]);

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
                toolHistory={toolHistory}
              />
            ))}
            {/* Pending approval requests */}
            {pendingInputs.filter(r => r.status === 'pending').map(request => (
              <ApprovalCard
                key={request.requestId}
                request={request}
                onRespond={respondToInput}
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

      {/* Context Status Bar */}
      <ContextStatusBar model={model} modelUsage={modelUsage} />

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
