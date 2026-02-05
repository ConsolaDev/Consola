/**
 * CommandHighlightContext
 *
 * React context to provide command/skill information throughout the component tree.
 * This allows nested components (like MarkdownRenderer) to access highlighting info
 * without prop drilling.
 */

import React, { createContext, useContext, useMemo, ReactNode } from 'react';
import { useCommandHighlighting, UseCommandHighlightingResult } from './useCommandHighlighting';

interface CommandHighlightContextValue extends UseCommandHighlightingResult {
  /** Array of available skill names */
  skills: string[];
  /** Array of available slash command names */
  slashCommands: string[];
}

const CommandHighlightContext = createContext<CommandHighlightContextValue | null>(null);

export interface CommandHighlightProviderProps {
  /** Array of available skill names */
  skills?: string[];
  /** Array of available slash command names */
  slashCommands?: string[];
  /** Child components */
  children: ReactNode;
}

/**
 * Provider component that makes command highlighting utilities available
 * to all child components via context.
 *
 * @example
 * ```tsx
 * <CommandHighlightProvider skills={['commit']} slashCommands={['help']}>
 *   <ChatMessage ... />
 * </CommandHighlightProvider>
 * ```
 */
export function CommandHighlightProvider({
  skills = [],
  slashCommands = [],
  children,
}: CommandHighlightProviderProps) {
  const highlighting = useCommandHighlighting({ skills, slashCommands });

  const value = useMemo<CommandHighlightContextValue>(
    () => ({
      ...highlighting,
      skills,
      slashCommands,
    }),
    [highlighting, skills, slashCommands]
  );

  return (
    <CommandHighlightContext.Provider value={value}>
      {children}
    </CommandHighlightContext.Provider>
  );
}

/**
 * Hook to access command highlighting utilities from context.
 * Returns null if used outside of a CommandHighlightProvider.
 *
 * @example
 * ```tsx
 * const highlighting = useCommandHighlightContext();
 * if (highlighting) {
 *   const segments = highlighting.parseText('Try /commit');
 * }
 * ```
 */
export function useCommandHighlightContext(): CommandHighlightContextValue | null {
  return useContext(CommandHighlightContext);
}

/**
 * Hook to access command highlighting utilities from context.
 * Throws an error if used outside of a CommandHighlightProvider.
 * Use this when you know the provider is always present.
 *
 * @example
 * ```tsx
 * const { parseText, isKnownCommand } = useRequiredCommandHighlightContext();
 * ```
 */
export function useRequiredCommandHighlightContext(): CommandHighlightContextValue {
  const context = useContext(CommandHighlightContext);
  if (!context) {
    throw new Error(
      'useRequiredCommandHighlightContext must be used within a CommandHighlightProvider'
    );
  }
  return context;
}
