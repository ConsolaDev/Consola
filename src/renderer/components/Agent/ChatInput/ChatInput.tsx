import { useCallback } from 'react';
import { ModelUsage } from '../../../../shared/types';
import { useChatInput } from './useChatInput';
import { CommandSuggestions } from './CommandSuggestions';
import { InputToolbar } from './InputToolbar';
import { HighlightedInput } from './HighlightedInput';

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

export function ChatInput({
  onSend,
  onInterrupt,
  isRunning,
  disabled,
  model,
  modelUsage,
  skills = [],
  slashCommands = []
}: ChatInputProps) {
  const {
    input,
    showSuggestions,
    selectedIndex,
    filteredCommands,
    canSend,
    textareaRef,
    handleChange,
    handleKeyDown,
    handleSend,
    selectCommand,
    executeCommand,
    setSelectedIndex,
  } = useChatInput({ onSend, isRunning, skills, slashCommands });

  const handleAttach = useCallback(() => {
    // TODO: Implement file attachment
    console.log('Attach file');
  }, []);

  return (
    <div className="chat-input-wrapper">
      <CommandSuggestions
        suggestions={filteredCommands}
        selectedIndex={selectedIndex}
        onSelect={selectCommand}
        onExecute={executeCommand}
        onHover={setSelectedIndex}
        open={showSuggestions}
      />

      <div className="chat-input-card">
        <HighlightedInput
          ref={textareaRef}
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="What would you like to do?"
          disabled={disabled || isRunning}
          rows={1}
          skills={skills}
          slashCommands={slashCommands}
        />

        <InputToolbar
          model={model}
          modelUsage={modelUsage}
          isRunning={isRunning}
          canSend={canSend}
          disabled={disabled}
          onSend={handleSend}
          onInterrupt={onInterrupt}
          onAttach={handleAttach}
        />
      </div>
    </div>
  );
}
