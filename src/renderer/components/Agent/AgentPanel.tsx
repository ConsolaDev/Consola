import { useEffect } from 'react';
import { Box, Flex, Text, Button } from '@radix-ui/themes';
import { useAgent } from '../../hooks/useAgent';
import { useSelectAll } from '../../hooks/useSelectAll';
import './styles.css';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { ProcessingIndicator } from './ProcessingIndicator';
import { ApprovalCard } from './ApprovalCard';
import { SessionDivider } from './SessionDivider';
import { TrustModeBanner } from './TrustModeBanner';
import { CommandHighlightProvider } from '../HighlightedText';

interface AgentPanelProps {
  instanceId: string;
  cwd: string;
  additionalDirectories?: string[];
}

export function AgentPanel({ instanceId, cwd, additionalDirectories }: AgentPanelProps) {
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
    skills,
    slashCommands,
    trustMode,
    trustModeEnabledAt,
    sendMessage,
    interrupt,
    clearError,
    respondToInput,
    setTrustMode
  } = useAgent(instanceId, cwd, additionalDirectories);

  const messagesRef = useSelectAll<HTMLDivElement>();

  // Auto-scroll to bottom on new messages or pending inputs
  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
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
      {/* Messages area - wrapped with CommandHighlightProvider for command highlighting */}
      <CommandHighlightProvider skills={skills} slashCommands={slashCommands}>
        <Box ref={messagesRef} tabIndex={0} className="messages-container">
          {messages.length === 0 && !isProcessing ? (
            <Flex align="center" justify="center" className="empty-state">
              <Text color="gray">Start a conversation with Claude</Text>
            </Flex>
          ) : (
            <>
              {messages.map(msg => {
                if (msg.type === 'system') {
                  return (
                    <SessionDivider
                      key={msg.id}
                      type={msg.subtype}
                      timestamp={msg.timestamp}
                    />
                  );
                }
                return (
                  <ChatMessage
                    key={msg.id}
                    type={msg.type}
                    content={msg.content}
                    contentBlocks={msg.type === 'assistant' ? msg.contentBlocks : undefined}
                    timestamp={msg.timestamp}
                    toolHistory={toolHistory}
                  />
                );
              })}
              {/* Trust Mode Banner - show when there are pending approvals or trust mode is active */}
              <TrustModeBanner
                trustMode={trustMode}
                trustModeEnabledAt={trustModeEnabledAt}
                onSetTrustMode={setTrustMode}
                pendingInputsCount={pendingInputs.filter(r => r.status === 'pending').length}
              />
              {/* Pending approval requests - only show if trust mode is off */}
              {trustMode === 'off' && pendingInputs.filter(r => r.status === 'pending').map(request => (
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
      </CommandHighlightProvider>

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

      {/* Input */}
      <ChatInput
        onSend={sendMessage}
        onInterrupt={interrupt}
        isRunning={isRunning}
        disabled={false}
        skills={skills}
        slashCommands={slashCommands}
      />
    </Flex>
  );
}
