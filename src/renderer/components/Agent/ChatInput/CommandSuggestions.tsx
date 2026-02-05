import { RefObject } from 'react';
import { CommandSuggestion } from './useChatInput';

interface CommandSuggestionsProps {
  suggestions: CommandSuggestion[];
  selectedIndex: number;
  onSelect: (command: CommandSuggestion) => void;
  onHover: (index: number) => void;
  containerRef?: RefObject<HTMLDivElement | null>;
}

export function CommandSuggestions({
  suggestions,
  selectedIndex,
  onSelect,
  onHover,
  containerRef
}: CommandSuggestionsProps) {
  if (suggestions.length === 0) return null;

  return (
    <div ref={containerRef} className="command-suggestions">
      {suggestions.map((cmd, idx) => (
        <CommandItem
          key={cmd.name}
          command={cmd}
          isSelected={idx === selectedIndex}
          onClick={() => onSelect(cmd)}
          onMouseEnter={() => onHover(idx)}
        />
      ))}
    </div>
  );
}

interface CommandItemProps {
  command: CommandSuggestion;
  isSelected: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
}

function CommandItem({ command, isSelected, onClick, onMouseEnter }: CommandItemProps) {
  return (
    <div
      className={`command-item ${isSelected ? 'selected' : ''}`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
    >
      <span className="command-name">/{command.name}</span>
      {command.description && (
        <span className="command-description">{command.description}</span>
      )}
    </div>
  );
}
