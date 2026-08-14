import { useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { useHarnessStore, type Harness } from '../../stores/harnessStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { HarnessCard } from './HarnessCard';
import { AddHarnessWizard } from './AddHarnessWizard';
import { EditHarnessDialog } from './EditHarnessDialog';
import './styles.css';

/**
 * The Harnesses settings section.
 *
 * A harness is a configured agent CLI: its binary, its config directory, and
 * the arguments it launches with. Consola coordinates them rather than
 * embedding any one of them, so several can coexist — a work login and a
 * personal one, or two different installs.
 */
export function HarnessesSection() {
  const harnesses = useHarnessStore((state) => state.harnesses);
  const probeAll = useHarnessStore((state) => state.probeAll);
  const workspaces = useWorkspaceStore((state) => state.workspaces);

  const [isAdding, setIsAdding] = useState(false);
  const [editing, setEditing] = useState<Harness | null>(null);

  // Health is a live fact about the machine, so check it when the section is
  // opened rather than polling in the background.
  useEffect(() => {
    void probeAll();
  }, [probeAll]);

  // How many sessions each harness still owns, which decides whether archiving
  // it would strand conversations.
  const sessionCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const workspace of workspaces) {
      for (const session of workspace.sessions) {
        counts[session.harnessId] = (counts[session.harnessId] ?? 0) + 1;
      }
    }
    return counts;
  }, [workspaces]);

  const active = harnesses.filter((harness) => !harness.archived);
  const archived = harnesses.filter((harness) => harness.archived);

  return (
    <div className="settings-modal-section">
      <div className="harness-section-header">
        <h2 className="settings-modal-section-title">Harnesses</h2>
        <div className="harness-section-actions">
          <button
            type="button"
            className="harness-icon-button"
            onClick={() => void probeAll()}
            aria-label="Re-check all harnesses"
            title="Re-check all"
          >
            <RefreshCw size={14} />
          </button>
          <button
            type="button"
            className="dialog-button-primary harness-add-button"
            onClick={() => setIsAdding(true)}
          >
            <Plus size={14} />
            Add harness
          </button>
        </div>
      </div>

      <p className="harness-section-description">
        Each harness is a separate agent CLI installation. Giving one its own
        config directory keeps its login and history apart from the others.
      </p>

      <div className="harness-list">
        {active.map((harness) => (
          <HarnessCard
            key={harness.id}
            harness={harness}
            sessionCount={sessionCounts[harness.id] ?? 0}
            onEdit={setEditing}
          />
        ))}
      </div>

      {archived.length > 0 && (
        <>
          <div className="harness-archived-heading">Archived</div>
          <p className="harness-section-description">
            Kept so their existing conversations can still be resumed, since
            each transcript lives in the config directory that wrote it.
          </p>
          <div className="harness-list">
            {archived.map((harness) => (
              <HarnessCard
                key={harness.id}
                harness={harness}
                sessionCount={sessionCounts[harness.id] ?? 0}
                onEdit={setEditing}
              />
            ))}
          </div>
        </>
      )}

      <AddHarnessWizard open={isAdding} onOpenChange={setIsAdding} />
      <EditHarnessDialog harness={editing} onClose={() => setEditing(null)} />
    </div>
  );
}
