import { useState, useCallback, useRef, useEffect, KeyboardEvent, ChangeEvent } from 'react';
import { Box, Flex, Button } from '@radix-ui/themes';

interface ChatInputProps {
  onSend: (message: string) => void;
  onInterrupt: () => void;
  isRunning: boolean;
  disabled: boolean;
}

const MIN_HEIGHT = 28;
const MAX_HEIGHT = 160;

export function ChatInput({ onSend, onInterrupt, isRunning, disabled }: ChatInputProps) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea based on content
  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to auto to get accurate scrollHeight
    textarea.style.height = 'auto';

    // Calculate new height within bounds
    const newHeight = Math.min(Math.max(textarea.scrollHeight, MIN_HEIGHT), MAX_HEIGHT);
    textarea.style.height = `${newHeight}px`;
  }, []);

  // Adjust height when input changes
  useEffect(() => {
    adjustHeight();
  }, [input, adjustHeight]);

  const handleSend = useCallback(() => {
    if (input.trim() && !isRunning) {
      onSend(input.trim());
      setInput('');
      // Reset height after sending
      if (textareaRef.current) {
        textareaRef.current.style.height = `${MIN_HEIGHT}px`;
      }
    }
  }, [input, isRunning, onSend]);

  const handleChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
  }, []);

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
          ref={textareaRef}
          className="chat-input"
          value={input}
          onChange={handleChange}
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
