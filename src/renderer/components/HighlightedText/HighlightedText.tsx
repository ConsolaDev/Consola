/**
 * HighlightedText Component
 *
 * Renders text with command/skill references highlighted in a distinct color.
 * Commands that are recognized (known) are highlighted differently from unknown commands.
 */

import React from 'react';
import { TextSegment } from './commandHighlighter';
import { useCommandHighlighting } from './useCommandHighlighting';
import './styles.css';

export interface HighlightedTextProps {
  /** The text to render with highlights */
  text: string;
  /** Array of available skill names */
  skills?: string[];
  /** Array of available slash command names */
  slashCommands?: string[];
  /** Additional CSS class for the container */
  className?: string;
  /** Whether to render as inline element (span) or block (div) */
  inline?: boolean;
}

/**
 * Component that renders text with command/skill references highlighted.
 *
 * @example
 * ```tsx
 * <HighlightedText
 *   text="Try using /commit to save your changes"
 *   skills={['commit', 'review-pr']}
 *   slashCommands={['help', 'clear']}
 * />
 * ```
 */
export function HighlightedText({
  text,
  skills = [],
  slashCommands = [],
  className = '',
  inline = false,
}: HighlightedTextProps) {
  const { parseText } = useCommandHighlighting({ skills, slashCommands });

  if (!text) {
    return null;
  }

  const segments = parseText(text);
  const Container = inline ? 'span' : 'div';

  return (
    <Container className={`highlighted-text ${className}`.trim()}>
      {segments.map((segment, index) => (
        <TextSegmentRenderer key={index} segment={segment} />
      ))}
    </Container>
  );
}

/**
 * Props for pre-parsed segments rendering.
 * Use this when you've already parsed the text and want to render segments directly.
 */
export interface HighlightedSegmentsProps {
  /** Pre-parsed text segments */
  segments: TextSegment[];
  /** Additional CSS class for the container */
  className?: string;
  /** Whether to render as inline element (span) or block (div) */
  inline?: boolean;
}

/**
 * Renders pre-parsed text segments with command highlighting.
 * Use this component when you need more control over parsing (e.g., for performance).
 *
 * @example
 * ```tsx
 * const { parseText } = useCommandHighlighting({ skills });
 * const segments = useMemo(() => parseText(text), [text, parseText]);
 *
 * return <HighlightedSegments segments={segments} />;
 * ```
 */
export function HighlightedSegments({
  segments,
  className = '',
  inline = false,
}: HighlightedSegmentsProps) {
  if (!segments || segments.length === 0) {
    return null;
  }

  const Container = inline ? 'span' : 'div';

  return (
    <Container className={`highlighted-text ${className}`.trim()}>
      {segments.map((segment, index) => (
        <TextSegmentRenderer key={index} segment={segment} />
      ))}
    </Container>
  );
}

interface TextSegmentRendererProps {
  segment: TextSegment;
}

/**
 * Renders a single text segment, either as plain text or as a highlighted command.
 */
function TextSegmentRenderer({ segment }: TextSegmentRendererProps) {
  if (!segment.isCommand) {
    return <>{segment.text}</>;
  }

  const { command } = segment;
  const isKnown = command?.isKnown ?? false;
  const type = command?.type;

  // Build CSS classes
  const classes = [
    'command-highlight',
    isKnown ? 'command-highlight--known' : 'command-highlight--unknown',
    type ? `command-highlight--${type}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classes} title={isKnown ? `${type}: ${command?.name}` : undefined}>
      {segment.text}
    </span>
  );
}

/**
 * Standalone component for rendering a single command badge.
 * Useful for displaying command references in isolation.
 */
export interface CommandBadgeProps {
  /** Command name (without the leading slash) */
  name: string;
  /** Whether this is a known command */
  isKnown?: boolean;
  /** Type of command */
  type?: 'skill' | 'command';
  /** Whether to include the leading slash in display */
  showSlash?: boolean;
}

export function CommandBadge({
  name,
  isKnown = false,
  type,
  showSlash = true,
}: CommandBadgeProps) {
  const classes = [
    'command-highlight',
    'command-badge',
    isKnown ? 'command-highlight--known' : 'command-highlight--unknown',
    type ? `command-highlight--${type}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classes}>
      {showSlash ? '/' : ''}
      {name}
    </span>
  );
}
