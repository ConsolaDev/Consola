/**
 * Code Selection Context
 *
 * Provides instanceId and file path context to deeply nested code components.
 * This enables code selection functionality without prop drilling.
 */

import { createContext, useContext, ReactNode, useMemo } from 'react';

interface CodeSelectionContextValue {
  /** The current agent instance ID */
  instanceId: string;
  /** Optional base file path (used when file path isn't known at render time) */
  basePath?: string;
}

const CodeSelectionContext = createContext<CodeSelectionContextValue | null>(null);

interface CodeSelectionProviderProps {
  children: ReactNode;
  instanceId: string;
  basePath?: string;
}

export function CodeSelectionProvider({ children, instanceId, basePath }: CodeSelectionProviderProps) {
  const value = useMemo(() => ({ instanceId, basePath }), [instanceId, basePath]);

  return (
    <CodeSelectionContext.Provider value={value}>
      {children}
    </CodeSelectionContext.Provider>
  );
}

/**
 * Hook to get the code selection context.
 * Returns null if not within a provider (selection will be disabled).
 */
export function useCodeSelectionContext(): CodeSelectionContextValue | null {
  return useContext(CodeSelectionContext);
}
