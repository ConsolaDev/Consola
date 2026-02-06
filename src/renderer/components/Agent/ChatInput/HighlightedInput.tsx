/**
 * HighlightedInput Component
 *
 * A textarea with command/skill highlighting overlay.
 * Uses a transparent textarea layered over a highlighted div
 * to show syntax highlighting while maintaining full input functionality.
 */

import React, { forwardRef, useMemo, useRef, useEffect, useCallback, ChangeEvent, KeyboardEvent } from 'react';
import { useCommandHighlighting, HighlightedSegments } from '../../HighlightedText';
import './highlighted-input.css';

export interface HighlightedInputProps {
  /** Current input value */
  value: string;
  /** Change handler */
  onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  /** Keydown handler */
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Input placeholder */
  placeholder?: string;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Additional class name for the wrapper */
  className?: string;
  /** Number of visible rows */
  rows?: number;
  /** Array of skill names for highlighting */
  skills?: string[];
  /** Array of command names for highlighting */
  slashCommands?: string[];
}

/**
 * A textarea component with command highlighting overlay.
 * Renders commands/skills with colored highlights while maintaining
 * full text input functionality.
 */
export const HighlightedInput = forwardRef<HTMLTextAreaElement, HighlightedInputProps>(
  function HighlightedInput(
    {
      value,
      onChange,
      onKeyDown,
      placeholder,
      disabled = false,
      className = '',
      rows = 1,
      skills = [],
      slashCommands = [],
    },
    forwardedRef
  ) {
    const { parseText } = useCommandHighlighting({ skills, slashCommands });
    const backdropRef = useRef<HTMLDivElement>(null);
    const internalRef = useRef<HTMLTextAreaElement>(null);

    // Combine forwarded ref with internal ref
    const setRefs = useCallback((node: HTMLTextAreaElement | null) => {
      internalRef.current = node;
      if (typeof forwardedRef === 'function') {
        forwardedRef(node);
      } else if (forwardedRef) {
        forwardedRef.current = node;
      }
    }, [forwardedRef]);

    // Parse the input text into segments for highlighting
    const segments = useMemo(() => parseText(value), [parseText, value]);

    // Check if we have any commands to highlight
    const hasHighlights = segments.some((s) => s.isCommand);

    // Sync scroll between textarea and backdrop
    const handleScroll = useCallback(() => {
      if (internalRef.current && backdropRef.current) {
        backdropRef.current.scrollTop = internalRef.current.scrollTop;
        backdropRef.current.scrollLeft = internalRef.current.scrollLeft;
      }
    }, []);

    // Attach scroll listener
    useEffect(() => {
      const textarea = internalRef.current;
      if (textarea) {
        textarea.addEventListener('scroll', handleScroll);
        return () => textarea.removeEventListener('scroll', handleScroll);
      }
    }, [handleScroll]);

    return (
      <div className={`highlighted-input-container ${className}`.trim()}>
        {/* Background layer with highlighted text */}
        <div
          ref={backdropRef}
          className="highlighted-input-backdrop"
          aria-hidden="true"
        >
          {value ? (
            <HighlightedSegments segments={segments} inline />
          ) : (
            <span className="highlighted-input-placeholder">{placeholder}</span>
          )}
          {/* Add trailing space to match textarea behavior */}
          {value && <span>&nbsp;</span>}
        </div>

        {/* Transparent textarea on top for actual input */}
        <textarea
          ref={setRefs}
          className={`highlighted-input-textarea ${hasHighlights ? 'has-highlights' : ''} ${value ? 'has-content' : ''}`}
          value={value}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={rows}
          spellCheck={false}
        />
      </div>
    );
  }
);
