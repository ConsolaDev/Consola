/**
 * HighlightedText Module
 *
 * Provides components, hooks, and utilities for detecting and highlighting
 * command/skill references in text.
 */

// Components
export { HighlightedText, HighlightedSegments, CommandBadge } from './HighlightedText';
export type { HighlightedTextProps, HighlightedSegmentsProps, CommandBadgeProps } from './HighlightedText';

// Context
export {
  CommandHighlightProvider,
  useCommandHighlightContext,
  useRequiredCommandHighlightContext,
} from './CommandHighlightContext';
export type { CommandHighlightProviderProps } from './CommandHighlightContext';

// Hooks
export { useCommandHighlighting, useParseCommandText } from './useCommandHighlighting';
export type { UseCommandHighlightingOptions, UseCommandHighlightingResult } from './useCommandHighlighting';

// Utilities
export {
  findCommandReferences,
  parseTextWithCommands,
  hasCommandReferences,
  buildCommandLookups,
} from './commandHighlighter';
export type { CommandMatch, TextSegment } from './commandHighlighter';
