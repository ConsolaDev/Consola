/**
 * Hook for command highlighting functionality.
 *
 * Provides memoized command parsing and lookup structures
 * for efficient rendering of highlighted text.
 */

import { useMemo } from 'react';
import {
  buildCommandLookups,
  parseTextWithCommands,
  TextSegment,
  CommandMatch,
} from './commandHighlighter';

export interface UseCommandHighlightingOptions {
  /** Array of available skill names */
  skills?: string[];
  /** Array of available slash command names */
  slashCommands?: string[];
}

export interface UseCommandHighlightingResult {
  /** Parse text and return segments with command highlighting info */
  parseText: (text: string) => TextSegment[];
  /** Set of known command/skill names for quick lookup */
  knownCommands: Set<string>;
  /** Map of command names to their types */
  commandTypes: Map<string, 'skill' | 'command'>;
  /** Check if a command name is known */
  isKnownCommand: (name: string) => boolean;
  /** Get the type of a command */
  getCommandType: (name: string) => 'skill' | 'command' | undefined;
}

/**
 * Hook for parsing and highlighting command/skill references in text.
 *
 * @param options - Configuration options including available skills and commands
 * @returns Object with parsing utilities and lookup methods
 *
 * @example
 * ```tsx
 * const { parseText, isKnownCommand } = useCommandHighlighting({
 *   skills: ['commit', 'review-pr'],
 *   slashCommands: ['help', 'clear']
 * });
 *
 * const segments = parseText('Try using /commit to commit your changes');
 * // segments = [
 * //   { text: 'Try using ', isCommand: false },
 * //   { text: '/commit', isCommand: true, command: { name: 'commit', isKnown: true, type: 'skill' } },
 * //   { text: ' to commit your changes', isCommand: false }
 * // ]
 * ```
 */
export function useCommandHighlighting(
  options: UseCommandHighlightingOptions = {}
): UseCommandHighlightingResult {
  const { skills = [], slashCommands = [] } = options;

  // Memoize the lookup structures
  const { knownCommands, commandTypes } = useMemo(
    () => buildCommandLookups(skills, slashCommands),
    [skills, slashCommands]
  );

  // Memoize the parse function
  const parseText = useMemo(() => {
    return (text: string): TextSegment[] => {
      return parseTextWithCommands(text, knownCommands, commandTypes);
    };
  }, [knownCommands, commandTypes]);

  // Helper to check if a command is known
  const isKnownCommand = useMemo(() => {
    return (name: string): boolean => knownCommands.has(name);
  }, [knownCommands]);

  // Helper to get command type
  const getCommandType = useMemo(() => {
    return (name: string): 'skill' | 'command' | undefined => commandTypes.get(name);
  }, [commandTypes]);

  return {
    parseText,
    knownCommands,
    commandTypes,
    isKnownCommand,
    getCommandType,
  };
}

/**
 * Simple hook variant that just provides the parse function
 * when you don't need the full lookup capabilities.
 */
export function useParseCommandText(
  skills: string[] = [],
  slashCommands: string[] = []
): (text: string) => TextSegment[] {
  const { parseText } = useCommandHighlighting({ skills, slashCommands });
  return parseText;
}
