import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal, Zap } from 'lucide-react';
import { CommandSuggestion } from './useChatInput';
import './command-suggestions.css';

interface CommandSuggestionsProps {
  suggestions: CommandSuggestion[];
  selectedIndex: number;
  onSelect: (command: CommandSuggestion) => void;
  onExecute: (command: CommandSuggestion) => void;
  onHover: (index: number) => void;
  open: boolean;
}

export function CommandSuggestions({
  suggestions,
  selectedIndex,
  onSelect,
  onExecute,
  onHover,
  open
}: CommandSuggestionsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const lastMousePos = useRef<{ x: number; y: number } | null>(null);

  // Track if mouse has actually moved (not just scroll moving items under cursor)
  const handleMouseMove = useCallback((e: React.MouseEvent, idx: number) => {
    const currentPos = { x: e.clientX, y: e.clientY };

    // Only update selection if mouse actually moved
    if (
      lastMousePos.current === null ||
      lastMousePos.current.x !== currentPos.x ||
      lastMousePos.current.y !== currentPos.y
    ) {
      lastMousePos.current = currentPos;
      if (idx !== selectedIndex) {
        onHover(idx);
      }
    }
  }, [selectedIndex, onHover]);

  // Scroll selected item into view when selection changes
  useEffect(() => {
    if (open && itemRefs.current[selectedIndex]) {
      itemRefs.current[selectedIndex]?.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth'
      });
    }
  }, [selectedIndex, open]);

  if (!open || suggestions.length === 0) return null;

  return (
    <div ref={containerRef} className="cmd-suggestions-content" role="listbox">
      {suggestions.map((cmd, idx) => (
        <div
          key={cmd.name}
          ref={(el) => { itemRefs.current[idx] = el; }}
          role="option"
          aria-selected={idx === selectedIndex}
          data-type={cmd.type}
          className={`cmd-suggestion-item ${idx === selectedIndex ? 'selected' : ''}`}
          onClick={() => onExecute(cmd)}
          onMouseMove={(e) => handleMouseMove(e, idx)}
        >
          <span className="cmd-suggestion-icon">
            {cmd.type === 'skill' ? <Zap size={12} /> : <Terminal size={12} />}
          </span>
          <span className="cmd-suggestion-name">/{cmd.name}</span>
          {cmd.description && (
            <span className="cmd-suggestion-desc">{cmd.description}</span>
          )}
          {idx === selectedIndex && (
            <span className="cmd-suggestion-hint">↵</span>
          )}
        </div>
      ))}
    </div>
  );
}
