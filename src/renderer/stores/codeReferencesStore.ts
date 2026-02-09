/**
 * Code References Store
 *
 * Manages code snippet references that users add to their chat context.
 * Each reference contains file path, line range, and the selected code content.
 */

import { create } from 'zustand';

export interface CodeReference {
  /** Unique identifier */
  id: string;
  /** Absolute path to the file */
  filePath: string;
  /** Starting line number (1-indexed) */
  startLine: number;
  /** Ending line number (1-indexed) */
  endLine: number;
  /** The selected code content */
  content: string;
  /** Timestamp when added */
  addedAt: number;
}

interface CodeReferencesState {
  /** Map of instanceId -> array of code references */
  referencesByInstance: Map<string, CodeReference[]>;

  /** Get all references for an instance */
  getReferences: (instanceId: string) => CodeReference[];

  /** Add a new code reference */
  addReference: (instanceId: string, reference: Omit<CodeReference, 'id' | 'addedAt'>) => void;

  /** Remove a specific reference */
  removeReference: (instanceId: string, referenceId: string) => void;

  /** Clear all references for an instance */
  clearReferences: (instanceId: string) => void;

  /** Consume all references (get and clear) for sending with a message */
  consumeReferences: (instanceId: string) => CodeReference[];
}

let nextId = 1;

function generateId(): string {
  return `ref_${Date.now()}_${nextId++}`;
}

export const useCodeReferencesStore = create<CodeReferencesState>((set, get) => ({
  referencesByInstance: new Map(),

  getReferences: (instanceId: string) => {
    return get().referencesByInstance.get(instanceId) ?? [];
  },

  addReference: (instanceId: string, reference: Omit<CodeReference, 'id' | 'addedAt'>) => {
    set((state) => {
      const newMap = new Map(state.referencesByInstance);
      const existing = newMap.get(instanceId) ?? [];

      // Check for duplicates (same file and overlapping lines)
      const isDuplicate = existing.some(
        (ref) =>
          ref.filePath === reference.filePath &&
          ref.startLine === reference.startLine &&
          ref.endLine === reference.endLine
      );

      if (isDuplicate) {
        return state; // Don't add duplicates
      }

      const newReference: CodeReference = {
        ...reference,
        id: generateId(),
        addedAt: Date.now(),
      };

      newMap.set(instanceId, [...existing, newReference]);
      return { referencesByInstance: newMap };
    });
  },

  removeReference: (instanceId: string, referenceId: string) => {
    set((state) => {
      const newMap = new Map(state.referencesByInstance);
      const existing = newMap.get(instanceId) ?? [];
      const filtered = existing.filter((ref) => ref.id !== referenceId);

      if (filtered.length === 0) {
        newMap.delete(instanceId);
      } else {
        newMap.set(instanceId, filtered);
      }

      return { referencesByInstance: newMap };
    });
  },

  clearReferences: (instanceId: string) => {
    set((state) => {
      const newMap = new Map(state.referencesByInstance);
      newMap.delete(instanceId);
      return { referencesByInstance: newMap };
    });
  },

  consumeReferences: (instanceId: string) => {
    const references = get().getReferences(instanceId);
    if (references.length > 0) {
      get().clearReferences(instanceId);
    }
    return references;
  },
}));

/**
 * Format code references into a string to prepend to the user message.
 * Creates a clear, parseable format for the AI to understand the context.
 */
export function formatReferencesForMessage(references: CodeReference[]): string {
  if (references.length === 0) return '';

  const formatted = references.map((ref) => {
    const lineInfo =
      ref.startLine === ref.endLine
        ? `line ${ref.startLine}`
        : `lines ${ref.startLine}-${ref.endLine}`;

    return `<code-reference file="${ref.filePath}" ${lineInfo}>
${ref.content}
</code-reference>`;
  });

  return formatted.join('\n\n') + '\n\n';
}
