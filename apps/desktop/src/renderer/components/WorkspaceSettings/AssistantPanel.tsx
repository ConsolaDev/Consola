import { Check } from 'lucide-react';
import { useWorkspaceStore, type Workspace } from '../../stores/workspaceStore';
import { assistantItemMode, type AssistantItemMode } from '../../../shared/workspace';

interface AssistantPanelProps {
  workspace: Workspace;
}

const OPTIONS: { mode: AssistantItemMode; name: string; description: string }[] = [
  {
    mode: 'full-tools',
    name: 'Full tools',
    description: "Stops once at Claude's trust prompt on a new worktree.",
  },
  {
    mode: 'read-only',
    name: 'Read-only, unattended',
    description: 'No stops; can only read and report.',
  },
  {
    mode: 'assistant-picks',
    name: 'Assistant picks per request',
    description: 'The Assistant chooses for each pull request or issue.',
  },
];

/**
 * How sessions the Assistant starts on a pull request or issue run. Commits on
 * click like the harness list; the choice is read when a session starts, so it
 * never changes one already running.
 */
export function AssistantPanel({ workspace }: AssistantPanelProps) {
  const updateWorkspace = useWorkspaceStore((state) => state.updateWorkspace);
  const current = assistantItemMode(workspace);

  return (
    <section className="ws-panel">
      <div className="ws-panel-header">
        <h3 className="ws-panel-title">Sessions the Assistant runs on pull requests and issues</h3>
      </div>
      <div
        className="ws-choice-list"
        role="radiogroup"
        aria-label="Sessions the Assistant runs on pull requests and issues"
      >
        {OPTIONS.map(({ mode, name, description }) => {
          const selected = mode === current;
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`ws-choice-row ${selected ? 'selected' : ''}`}
              onClick={() => void updateWorkspace(workspace.id, { assistantItemMode: mode })}
            >
              <span className="ws-choice-name">
                {name}
                <span className="ws-choice-description">{description}</span>
              </span>
              {selected && <Check size={14} />}
            </button>
          );
        })}
      </div>
      <p className="ws-panel-hint">Applies to the next session it starts.</p>
    </section>
  );
}
