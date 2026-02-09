/**
 * CodeReferencesContainer Component
 *
 * Container for displaying multiple code reference pills above the chat input.
 * Renders only when there are references to display.
 */

import { memo } from 'react';
import { CodeReferencePill } from './CodeReferencePill';
import { useCodeReferencesStore, type CodeReference } from '../../stores/codeReferencesStore';

interface CodeReferencesContainerProps {
  /** Instance ID for the current agent/chat session */
  instanceId: string;
}

export const CodeReferencesContainer = memo(function CodeReferencesContainer({
  instanceId,
}: CodeReferencesContainerProps) {
  const references = useCodeReferencesStore((state) => state.getReferences(instanceId));
  const removeReference = useCodeReferencesStore((state) => state.removeReference);

  if (references.length === 0) {
    return null;
  }

  return (
    <div className="code-references-container">
      {references.map((ref) => (
        <CodeReferencePill
          key={ref.id}
          reference={ref}
          onRemove={() => removeReference(instanceId, ref.id)}
        />
      ))}
    </div>
  );
});
