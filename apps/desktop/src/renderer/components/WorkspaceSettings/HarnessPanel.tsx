import { Check } from 'lucide-react';
import { useWorkspaceStore, type Workspace } from '../../stores/workspaceStore';
import { isSelectableHarness, useHarnessStore } from '../../stores/harnessStore';

interface HarnessPanelProps {
  workspace: Workspace;
}

/**
 * The workspace's default harness — preselected when a conversation starts
 * here. One already-confirming click, so choosing commits immediately, the
 * same way the WorkspaceSwitcher's submenu always has.
 */
export function HarnessPanel({ workspace }: HarnessPanelProps) {
  const updateWorkspace = useWorkspaceStore((state) => state.updateWorkspace);
  const harnesses = useHarnessStore((state) => state.harnesses);
  const selectable = harnesses.filter(isSelectableHarness);

  return (
    <section className="ws-panel">
      <div className="ws-panel-header">
        <h3 className="ws-panel-title">Default harness</h3>
      </div>
      <p className="ws-panel-hint">
        Preselected when starting a conversation in this workspace. Existing
        sessions keep the harness they started on.
      </p>
      <div className="ws-choice-list" role="radiogroup" aria-label="Default harness">
        {selectable.map((harness) => {
          const isDefault = harness.id === workspace.defaultHarnessId;
          return (
            <button
              key={harness.id}
              type="button"
              role="radio"
              aria-checked={isDefault}
              className={`ws-choice-row ${isDefault ? 'selected' : ''}`}
              onClick={() =>
                void updateWorkspace(workspace.id, { defaultHarnessId: harness.id })
              }
            >
              <span
                className="workspace-harness-dot"
                style={{ background: harness.accentColor }}
                aria-hidden="true"
              />
              <span className="ws-choice-name">{harness.name}</span>
              {isDefault && <Check size={14} />}
            </button>
          );
        })}
      </div>
    </section>
  );
}
