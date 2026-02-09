import { useCallback } from 'react';
import { useChatInput } from './useChatInput';
import { CommandSuggestions } from './CommandSuggestions';
import { InputToolbar } from './InputToolbar';
import { HighlightedInput } from './HighlightedInput';
import { CodeReferencesContainer } from '../../CodeSelection';
import { useCodeReferencesStore, formatReferencesForMessage } from '../../../stores/codeReferencesStore';
import { ModelUsage } from '../../../../shared/types';

interface ChatInputProps {
  onSend: (message: string) => void;
  onInterrupt: () => void;
  isRunning: boolean;
  disabled: boolean;
  skills?: string[];
  slashCommands?: string[];
  modelUsage?: ModelUsage | null;
  instanceId: string;
}

export function ChatInput({
  onSend,
  onInterrupt,
  isRunning,
  disabled,
  skills = [],
  slashCommands = [],
  modelUsage = null,
  instanceId
}: ChatInputProps) {
  const consumeReferences = useCodeReferencesStore((state) => state.consumeReferences);
  const hasReferences = useCodeReferencesStore(
    (state) => (state.referencesByInstance.get(instanceId)?.length ?? 0) > 0
  );

  // Wrap onSend to include code references
  const handleSendWithReferences = useCallback((message: string) => {
    const references = consumeReferences(instanceId);
    const referencesText = formatReferencesForMessage(references);
    onSend(referencesText + message);
  }, [onSend, consumeReferences, instanceId]);

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
  } = useChatInput({ onSend: handleSendWithReferences, isRunning, skills, slashCommands });

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
        {/* Code references above input */}
        {hasReferences && <CodeReferencesContainer instanceId={instanceId} />}

        <HighlightedInput
          ref={textareaRef}
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="What would you like to do?"
          disabled={disabled}
          rows={1}
          skills={skills}
          slashCommands={slashCommands}
        />

        <InputToolbar
          isRunning={isRunning}
          canSend={canSend || hasReferences}
          disabled={disabled}
          onSend={handleSend}
          onInterrupt={onInterrupt}
          onAttach={handleAttach}
          modelUsage={modelUsage}
        />
      </div>
    </div>
  );
}
