import { useState, useCallback, useRef, useEffect, KeyboardEvent, ChangeEvent, useMemo } from 'react';
import { Plus, ArrowRight, Square, ChevronDown } from 'lucide-react';
import { ModelUsage } from '../../../shared/types';

interface CommandSuggestion {
  name: string;
  description: string;
  type: 'skill' | 'command';
}

interface ChatInputProps {
  onSend: (message: string) => void;
  onInterrupt: () => void;
  isRunning: boolean;
  disabled: boolean;
  model: string | null;
  modelUsage: ModelUsage | null;
  skills?: string[];
  slashCommands?: string[];
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

export function ChatInput({ onSend, onInterrupt, isRunning, disabled, model, modelUsage, skills = [], slashCommands = [] }: ChatInputProps) {
  console.log('[ChatInput] Render with skills:', skills, 'slashCommands:', slashCommands);
  const [input, setInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Build list of all available commands
  const allCommands = useMemo((): CommandSuggestion[] => {
    const commands: CommandSuggestion[] = [];

    // Add skills
    for (const skill of skills) {
      commands.push({
        name: skill,
        description: `Invoke ${skill} skill`,
        type: 'skill'
      });
    }

    // Add slash commands
    for (const cmd of slashCommands) {
      commands.push({
        name: cmd,
        description: '',
        type: 'command'
      });
    }

    console.log('[ChatInput] allCommands built:', commands.length);
    return commands;
  }, [skills, slashCommands]);

  // Filter commands based on input
  const filteredCommands = useMemo(() => {
    if (!input.startsWith('/')) {
      console.log('[ChatInput] filteredCommands: input does not start with /');
      return [];
    }

    const query = input.slice(1).toLowerCase();
    const filtered = allCommands
      .filter(cmd => cmd.name.toLowerCase().includes(query))
      .slice(0, 8); // Limit to 8 suggestions
    console.log('[ChatInput] filteredCommands:', filtered.length, 'query:', query);
    return filtered;
  }, [input, allCommands]);

  // Show/hide suggestions based on input
  useEffect(() => {
    const shouldShow = input.startsWith('/') && filteredCommands.length > 0 && !isRunning;
    console.log('[ChatInput] shouldShow:', shouldShow, 'input:', input, 'filteredCommands.length:', filteredCommands.length, 'isRunning:', isRunning);
    setShowSuggestions(shouldShow);
    if (shouldShow) {
      setSelectedIndex(0);
    }
  }, [input, filteredCommands.length, isRunning]);

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

  const selectCommand = useCallback((command: CommandSuggestion) => {
    setInput(`/${command.name} `);
    setShowSuggestions(false);
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Handle suggestion navigation
    if (showSuggestions && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => (prev + 1) % filteredCommands.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => (prev - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        selectCommand(filteredCommands[selectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSuggestions(false);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend, showSuggestions, filteredCommands, selectedIndex, selectCommand]);

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

  console.log('[ChatInput] Render - showSuggestions:', showSuggestions, 'filteredCommands.length:', filteredCommands.length);

  return (
    <div className="chat-input-wrapper">
      {/* Command suggestions dropdown - outside the card to avoid overflow:hidden clipping */}
      {showSuggestions && (
        <div ref={suggestionsRef} className="command-suggestions">
          {filteredCommands.map((cmd, idx) => (
            <div
              key={cmd.name}
              className={`command-item ${idx === selectedIndex ? 'selected' : ''}`}
              onClick={() => selectCommand(cmd)}
              onMouseEnter={() => setSelectedIndex(idx)}
            >
              <span className="command-name">/{cmd.name}</span>
              {cmd.description && (
                <span className="command-description">{cmd.description}</span>
              )}
            </div>
          ))}
        </div>
      )}
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
    </div>
  );
}
