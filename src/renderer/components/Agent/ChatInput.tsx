import { useState, useCallback, useRef, useEffect, KeyboardEvent, ChangeEvent } from 'react';
import { Plus, ArrowRight, Square, ChevronDown } from 'lucide-react';
import { ModelUsage } from '../../../shared/types';

interface ChatInputProps {
  onSend: (message: string) => void;
  onInterrupt: () => void;
  isRunning: boolean;
  disabled: boolean;
  model: string | null;
  modelUsage: ModelUsage | null;
}

const MIN_HEIGHT = 24;
const MAX_HEIGHT = 160;

function formatModelName(modelId: string | null): string {
  if (!modelId) return 'Claude';

  // Extract friendly name: "claude-sonnet-4-20250514" -> "Sonnet 4"
  const match = modelId.match(/claude-(\w+)-(\d+)/);
  if (match) {
    const [, variant, version] = match;
    return `${variant.charAt(0).toUpperCase() + variant.slice(1)} ${version}`;
  }

  return modelId;
}

export function ChatInput({ onSend, onInterrupt, isRunning, disabled, model, modelUsage }: ChatInputProps) {
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

  const handleAttach = useCallback(() => {
    // TODO: Implement file attachment
    console.log('Attach file');
  }, []);

  // Calculate context usage for display
  const totalTokens = modelUsage
    ? modelUsage.inputTokens + modelUsage.outputTokens
    : 0;
  const contextWindow = modelUsage?.contextWindow ?? 200_000;
  const percentage = contextWindow > 0 ? (totalTokens / contextWindow) * 100 : 0;
  const statusClass = percentage >= 85 ? 'critical' : percentage >= 70 ? 'warning' : '';

  const canSend = input.trim() && !disabled && !isRunning;
  const hasContent = input.length > 0;

  return (
    <div className="chat-input-card">
      <textarea
        ref={textareaRef}
        className={`chat-input-textarea ${hasContent ? 'has-content' : ''}`}
        value={input}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="What would you like to do?"
        disabled={disabled || isRunning}
        rows={1}
      />
      <div className="chat-input-toolbar">
        <div className="chat-input-toolbar-left">
          <button
            className="chat-input-icon-btn attach"
            onClick={handleAttach}
            disabled={disabled}
            aria-label="Attach file"
          >
            <Plus size={16} strokeWidth={1.5} />
          </button>
          <button className="chat-input-dropdown-btn" disabled>
            <ChevronDown size={12} strokeWidth={2} />
            <span>Fast</span>
          </button>
          <div className={`chat-input-context ${statusClass}`}>
            <ChevronDown size={12} strokeWidth={2} />
            <span className="chat-input-model">{formatModelName(model)}</span>
            {modelUsage && (
              <span className="chat-input-tokens">
                ({percentage.toFixed(0)}%)
              </span>
            )}
          </div>
        </div>
        <div className="chat-input-toolbar-right">
          {isRunning ? (
            <button
              className="chat-input-send-btn stop"
              onClick={onInterrupt}
              aria-label="Stop"
            >
              <Square size={14} />
            </button>
          ) : (
            <button
              className="chat-input-send-btn"
              onClick={handleSend}
              disabled={!canSend}
              aria-label="Send message"
            >
              <ArrowRight size={16} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
