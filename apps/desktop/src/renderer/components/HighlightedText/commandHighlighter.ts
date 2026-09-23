/**
 * Command/Skill Highlighter Utility
 *
 * Detects and parses command and skill references in text.
 * Commands/skills are identified by:
 * - Starting with a forward slash (/)
 * - Followed by a valid command/skill name
 */

export interface CommandMatch {
  /** The full matched text including the slash */
  match: string;
  /** The command/skill name without the slash */
  name: string;
  /** Start index in the original text */
  startIndex: number;
  /** End index in the original text */
  endIndex: number;
  /** Whether this is a known command/skill */
  isKnown: boolean;
  /** Type of the command if known */
  type?: 'skill' | 'command';
}

export interface TextSegment {
  /** The text content of this segment */
  text: string;
  /** Whether this segment is a command/skill reference */
  isCommand: boolean;
  /** Command match details if this is a command segment */
  command?: CommandMatch;
}

/**
 * Regular expression to match command/skill references.
 * Matches: /command-name, /skill_name, /some:qualified:name
 * Does not match: URLs like https://example.com
 */
const COMMAND_REGEX = /(?<![a-zA-Z0-9:])\/([a-zA-Z][a-zA-Z0-9_:-]*)/g;

/**
 * Find all command/skill references in a text string.
 *
 * @param text - The text to search for commands
 * @param knownCommands - Optional set of known command names (without slash)
 * @param commandTypes - Optional map of command names to their types
 * @returns Array of command matches found in the text
 */
export function findCommandReferences(
  text: string,
  knownCommands?: Set<string>,
  commandTypes?: Map<string, 'skill' | 'command'>
): CommandMatch[] {
  const matches: CommandMatch[] = [];
  let match: RegExpExecArray | null;

  // Reset regex state
  COMMAND_REGEX.lastIndex = 0;

  while ((match = COMMAND_REGEX.exec(text)) !== null) {
    const fullMatch = match[0];
    const commandName = match[1];
    const startIndex = match.index;
    const endIndex = startIndex + fullMatch.length;

    // Skip if this looks like part of a URL path (preceded by :// or :)
    const precedingText = text.slice(Math.max(0, startIndex - 3), startIndex);
    if (precedingText.endsWith('://') || precedingText.endsWith(':')) {
      continue;
    }

    const isKnown = knownCommands?.has(commandName) ?? false;
    const type = commandTypes?.get(commandName);

    matches.push({
      match: fullMatch,
      name: commandName,
      startIndex,
      endIndex,
      isKnown,
      type,
    });
  }

  return matches;
}

/**
 * Parse text into segments, separating command references from plain text.
 *
 * @param text - The text to parse
 * @param knownCommands - Optional set of known command names (without slash)
 * @param commandTypes - Optional map of command names to their types
 * @returns Array of text segments
 */
export function parseTextWithCommands(
  text: string,
  knownCommands?: Set<string>,
  commandTypes?: Map<string, 'skill' | 'command'>
): TextSegment[] {
  if (!text) {
    return [];
  }

  const matches = findCommandReferences(text, knownCommands, commandTypes);

  if (matches.length === 0) {
    return [{ text, isCommand: false }];
  }

  const segments: TextSegment[] = [];
  let currentIndex = 0;

  for (const match of matches) {
    // Add text before this command if any
    if (match.startIndex > currentIndex) {
      segments.push({
        text: text.slice(currentIndex, match.startIndex),
        isCommand: false,
      });
    }

    // Add the command segment
    segments.push({
      text: match.match,
      isCommand: true,
      command: match,
    });

    currentIndex = match.endIndex;
  }

  // Add remaining text after last command
  if (currentIndex < text.length) {
    segments.push({
      text: text.slice(currentIndex),
      isCommand: false,
    });
  }

  return segments;
}

/**
 * Check if a text contains any command references.
 *
 * @param text - The text to check
 * @returns True if the text contains at least one command reference
 */
export function hasCommandReferences(text: string): boolean {
  if (!text) return false;
  COMMAND_REGEX.lastIndex = 0;
  return COMMAND_REGEX.test(text);
}

/**
 * Build a Set and Map from command arrays for efficient lookup.
 *
 * @param skills - Array of skill names
 * @param commands - Array of command names
 * @returns Object containing the Set and Map for lookups
 */
export function buildCommandLookups(
  skills: string[] = [],
  commands: string[] = []
): {
  knownCommands: Set<string>;
  commandTypes: Map<string, 'skill' | 'command'>;
} {
  const knownCommands = new Set<string>();
  const commandTypes = new Map<string, 'skill' | 'command'>();

  for (const skill of skills) {
    knownCommands.add(skill);
    commandTypes.set(skill, 'skill');
  }

  for (const cmd of commands) {
    knownCommands.add(cmd);
    commandTypes.set(cmd, 'command');
  }

  return { knownCommands, commandTypes };
}
