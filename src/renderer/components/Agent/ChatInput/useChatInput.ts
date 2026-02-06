import { useState, useCallback, useRef, useEffect, useMemo, KeyboardEvent, ChangeEvent } from 'react';

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

// Built-in slash commands with descriptions (always available)
const BUILTIN_COMMANDS: CommandSuggestion[] = [
  { name: 'clear', description: 'Reset conversation context', type: 'command' },
  { name: 'compact', description: 'Optimize context window', type: 'command' },
  { name: 'help', description: 'Show available commands', type: 'command' },
];

export function useChatInput({ onSend, isRunning, skills = [], slashCommands = [] }: UseChatInputOptions) {
  const [input, setInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Build list of all available commands (deduplicated - skills take priority, then SDK commands, then builtins)
  const allCommands = useMemo((): CommandSuggestion[] => {
    const commandMap = new Map<string, CommandSuggestion>();

    // Add skills first (they have richer metadata)
    for (const skill of skills) {
      commandMap.set(skill, {
        name: skill,
        description: `Invoke ${skill} skill`,
        type: 'skill'
      });
    }

    // Add slash commands from SDK (only if not already present as a skill)
    for (const cmd of slashCommands) {
      if (!commandMap.has(cmd)) {
        // Check if it's a builtin with a description
        const builtin = BUILTIN_COMMANDS.find(b => b.name === cmd);
        commandMap.set(cmd, {
          name: cmd,
          description: builtin?.description || '',
          type: 'command'
        });
      }
    }

    // Add builtin commands if not already present (ensures /clear, /compact, /help always appear)
    for (const builtin of BUILTIN_COMMANDS) {
      if (!commandMap.has(builtin.name)) {
        commandMap.set(builtin.name, builtin);
      }
    }

    return Array.from(commandMap.values());
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

  // Execute command directly (for Enter key on suggestions)
  const executeCommand = useCallback((command: CommandSuggestion) => {
    const commandText = `/${command.name}`;
    setShowSuggestions(false);
    onSend(commandText);
    resetInput();
  }, [onSend, resetInput]);


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
      if (e.key === 'Tab') {
        // Tab = autocomplete the command name
        e.preventDefault();
        selectCommand(filteredCommands[selectedIndex]);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        // Enter = execute the command directly
        e.preventDefault();
        executeCommand(filteredCommands[selectedIndex]);
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
  }, [handleSend, showSuggestions, filteredCommands, selectedIndex, selectCommand, executeCommand]);

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
    executeCommand,
    setSelectedIndex,
  };
}
