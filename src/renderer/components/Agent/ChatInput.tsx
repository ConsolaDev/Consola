import { useState, useCallback, KeyboardEvent } from 'react';
import { Box, Flex, Button } from '@radix-ui/themes';

interface ChatInputProps {
  onSend: (message: string) => void;
  onInterrupt: () => void;
  isRunning: boolean;
  disabled: boolean;
}

export function ChatInput({ onSend, onInterrupt, isRunning, disabled }: ChatInputProps) {
  const [input, setInput] = useState('');

  const handleSend = useCallback(() => {
    if (input.trim() && !isRunning) {
      onSend(input.trim());
      setInput('');
    }
  }, [input, isRunning, onSend]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  return (
    <Box className="chat-input-container">
      <Flex gap="2" align="end">
        <textarea
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask Claude..."
          disabled={disabled || isRunning}
          rows={1}
        />
        {isRunning ? (
          <Button
            className="chat-button stop"
            onClick={onInterrupt}
          >
            Stop
          </Button>
        ) : (
          <Button
            className="chat-button send"
            onClick={handleSend}
            disabled={!input.trim() || disabled}
          >
            Send
          </Button>
        )}
      </Flex>
    </Box>
  );
}
