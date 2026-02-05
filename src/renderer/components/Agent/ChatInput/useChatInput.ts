import { useState, useCallback, useRef, useEffect, useMemo, KeyboardEvent, ChangeEvent } from 'react';
import { ModelUsage } from '../../../../shared/types';

export interface CommandSuggestion {
  name: string;
  description: string;
  type: 'skill' | 'command';
}

export interface UseChatInputOptions {
  onSend: (message: string) => void;
  isRunning: boolean;
  skills?: string[];
  slashCommands?: string[];
}

const MIN_HEIGHT = 24;
const MAX_HEIGHT = 160;

export function useChatInput({ onSend, isRunning, skills = [], slashCommands = [] }: UseChatInputOptions) {
  const [input, setInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Build list of all available commands
  const allCommands = useMemo((): CommandSuggestion[] => {
    const commands: CommandSuggestion[] = [];

    for (const skill of skills) {
      commands.push({
        name: skill,
        description: `Invoke ${skill} skill`,
        type: 'skill'
      });
    }

    for (const cmd of slashCommands) {
      commands.push({
        name: cmd,
        description: '',
        type: 'command'
      });
    }

    return commands;
  }, [skills, slashCommands]);

  // Filter commands based on input
  const filteredCommands = useMemo(() => {
    if (!input.startsWith('/')) return [];

    const query = input.slice(1).toLowerCase();
    return allCommands
      .filter(cmd => cmd.name.toLowerCase().includes(query))
      .slice(0, 8);
  }, [input, allCommands]);

  // Show/hide suggestions based on input
  useEffect(() => {
    const shouldShow = input.startsWith('/') && filteredCommands.length > 0 && !isRunning;
    setShowSuggestions(shouldShow);
    if (shouldShow) {
      setSelectedIndex(0);
    }
  }, [input, filteredCommands.length, isRunning]);

  // Auto-resize textarea based on content
  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    const newHeight = Math.min(Math.max(textarea.scrollHeight, MIN_HEIGHT), MAX_HEIGHT);
    textarea.style.height = `${newHeight}px`;
  }, []);

  // Adjust height when input changes
  useEffect(() => {
    adjustHeight();
  }, [input, adjustHeight]);

  const resetInput = useCallback(() => {
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = `${MIN_HEIGHT}px`;
    }
  }, []);

  const handleSend = useCallback(() => {
    if (input.trim() && !isRunning) {
      onSend(input.trim());
      resetInput();
    }
  }, [input, isRunning, onSend, resetInput]);

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

  const canSend = Boolean(input.trim()) && !isRunning;
  const hasContent = input.length > 0;

  return {
    // State
    input,
    showSuggestions,
    selectedIndex,
    filteredCommands,
    canSend,
    hasContent,

    // Refs
    textareaRef,

    // Handlers
    handleChange,
    handleKeyDown,
    handleSend,
    selectCommand,
    setSelectedIndex,
  };
}

// Utility functions for context usage display
export function formatModelName(modelId: string | null): string {
  if (!modelId) return 'Claude';

  const match = modelId.match(/claude-(\w+)-(\d+)/);
  if (match) {
    const [, variant, version] = match;
    return `${variant.charAt(0).toUpperCase() + variant.slice(1)} ${version}`;
  }

  return modelId;
}

export function getContextUsage(modelUsage: ModelUsage | null) {
  const totalTokens = modelUsage
    ? modelUsage.inputTokens + modelUsage.outputTokens
    : 0;
  const contextWindow = modelUsage?.contextWindow ?? 200_000;
  const percentage = contextWindow > 0 ? (totalTokens / contextWindow) * 100 : 0;
  const statusClass = percentage >= 85 ? 'critical' : percentage >= 70 ? 'warning' : '';

  return { percentage, statusClass };
}
