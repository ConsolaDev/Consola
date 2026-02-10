import { useEffect, useRef, useMemo, useCallback } from 'react';
import { Box, Flex, Text, Button } from '@radix-ui/themes';
import { useAgent } from '../../hooks/useAgent';
import { useSelectAll } from '../../hooks/useSelectAll';
import './styles.css';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { ProcessingIndicator } from './ProcessingIndicator';
import { ApprovalCard } from './ApprovalCard';
import { SessionDivider } from './SessionDivider';
import { ToolCluster } from './ToolCluster';
import { TodoListPanel } from './TodoListPanel';
import { groupMessages } from './groupContentBlocks';
import { CommandHighlightProvider } from '../HighlightedText';
import { CodeSelectionProvider } from '../../contexts/CodeSelectionContext';

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
    todos,
    error,
    isProcessing,
    model,
    modelUsage,
    skills,
    slashCommands,
    trustMode,
    sendMessage,
    interrupt,
    clearError,
    respondToInput,
    setTrustMode
  } = useAgent(instanceId, cwd, additionalDirectories);

  const messagesRef = useSelectAll<HTMLDivElement>();
  const isNearBottomRef = useRef(true);

  // Track whether user is near the bottom of the scroll container
  const handleScroll = useCallback(() => {
    if (!messagesRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = messagesRef.current;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    isNearBottomRef.current = distanceFromBottom < 50;
  }, [messagesRef]);

  // Attach scroll listener to the messages container
  useEffect(() => {
    const container = messagesRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [messagesRef, handleScroll]);

  // Group consecutive tool-only messages into clusters
  const groupedMessages = useMemo(() => groupMessages(messages), [messages]);

  // Auto-scroll to bottom on new messages or pending inputs, only if user is near the bottom
  useEffect(() => {
    if (messagesRef.current && isNearBottomRef.current) {
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
      {/* Messages area - wrapped with providers for command highlighting and code selection */}
      <CodeSelectionProvider instanceId={instanceId} basePath={cwd}>
        <CommandHighlightProvider skills={skills} slashCommands={slashCommands}>
          <Box ref={messagesRef} tabIndex={0} className="messages-container">
          {messages.length === 0 && !isProcessing ? (
            <Flex align="center" justify="center" className="empty-state">
              <Text color="gray">Start a conversation with Claude</Text>
            </Flex>
          ) : (
            <>
              {groupedMessages.map((group, idx) => {
                if (group.kind === 'tool-cluster') {
                  // Render clustered tool messages
                  return (
                    <ToolCluster
                      key={`cluster-${group.messages[0].id}`}
                      blocks={group.toolBlocks}
                      toolHistory={toolHistory}
                    />
                  );
                }

                // Single message
                const msg = group.message;
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
      </CodeSelectionProvider>

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

      {/* Todo list — visible above input when active */}
      <TodoListPanel todos={todos} isRunning={isRunning} />

      {/* Input */}
      <ChatInput
        onSend={sendMessage}
        onInterrupt={interrupt}
        isRunning={isRunning}
        disabled={false}
        skills={skills}
        slashCommands={slashCommands}
        modelUsage={modelUsage}
        instanceId={instanceId}
        trustMode={trustMode}
        onSetTrustMode={setTrustMode}
        pendingInputsCount={pendingInputs.filter(r => r.status === 'pending').length}
      />
    </Flex>
  );
}
