import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { conductorBridge } from '../../services/conductorBridge';
import './styles.css';

/** Mirrors CONDUCTOR_NAME_PATTERN in main's ConductorScaffold. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface OrchestrationDialogProps {
  workspaceId: string;
  onClose: () => void;
}

/**
 * The orchestration door: one kickoff box. Everything agent-deck makes users
 * hand-author, Consola generates — as real files, and the preview says exactly
 * where they will land before anything is written.
 *
 * A creation gesture, not an entity: submitting scaffolds the directory, mints
 * the group and launches the conductor session in the main process, and this
 * dialog walks away. The new group arrives through the ordinary
 * workspace-changed broadcast.
 */
export function OrchestrationDialog({ workspaceId, onClose }: OrchestrationDialogProps) {
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === workspaceId)
  );
  const scopes = workspace?.scopes ?? [];

  const [name, setName] = useState('');
  const [kickoff, setKickoff] = useState('');
  const [scopeId, setScopeId] = useState<string | undefined>(scopes[0]?.id);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameValid = NAME_PATTERN.test(name);
  const hostScope = scopes.find((candidate) => candidate.id === scopeId);
  const canSubmit = nameValid && kickoff.trim().length > 0 && !!hostScope && !submitting;

  const submit = async () => {
    if (!canSubmit || !hostScope) return;
    setError(null);
    setSubmitting(true);
    try {
      await conductorBridge.create({
        workspaceId,
        scopeId: hostScope.id,
        name,
        kickoff: kickoff.trim(),
      });
      onClose();
    } catch (raised) {
      // Nothing was created — main refuses an existing conductor directory
      // rather than overwriting it. Keep the dialog open so the kickoff is not
      // lost, and say exactly which path collided.
      setError(raised instanceof Error ? raised.message : String(raised));
    } finally {
      setSubmitting(false);
    }
  };

  const previewPath = `${hostScope?.path ?? '<scope>'}/conductor/${nameValid ? name : '<name>'}/`;

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content orchestration-dialog">
          <Dialog.Title className="dialog-title">New orchestration</Dialog.Title>
          <Dialog.Description className="dialog-description">
            A conductor session with a brief on disk, in a group of its own.
          </Dialog.Description>
          <div className="dialog-form">
            <div className="dialog-field">
              <label className="dialog-label" htmlFor="orchestration-name">
                Name
              </label>
              <input
                id="orchestration-name"
                className="dialog-input"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. symbalance-api"
              />
              {name.length > 0 && !nameValid && (
                <span className="dialog-error">
                  Letters, digits, dots, dashes and underscores only; up to 64 characters,
                  starting with a letter or digit.
                </span>
              )}
            </div>

            <div className="dialog-field">
              <label className="dialog-label" htmlFor="orchestration-kickoff">
                Kickoff — the conductor takes it from here
              </label>
              <textarea
                id="orchestration-kickoff"
                className="dialog-input orchestration-kickoff"
                rows={5}
                value={kickoff}
                onChange={(event) => setKickoff(event.target.value)}
                placeholder="Deliver the feature across the repos involved. Split into tasks, assign workers per repo, escalate contradictions to me."
              />
            </div>

            <div className="dialog-field">
              <label className="dialog-label" htmlFor="orchestration-scope">
                Host scope — where the conductor directory is generated
              </label>
              <select
                id="orchestration-scope"
                className="dialog-input"
                value={scopeId ?? ''}
                onChange={(event) => setScopeId(event.target.value)}
              >
                {scopes.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name} — {candidate.path}
                  </option>
                ))}
              </select>
            </div>

            <div className="dialog-field">
              <span className="dialog-label">Generated · editable on disk</span>
              <pre className="orchestration-preview">
                {`${previewPath}
  CLAUDE.md   · role, reading order
  POLICY.md   · auto vs escalate rules
  state.json  · survives compaction`}
              </pre>
            </div>

            {error && <div className="orchestration-error">{error}</div>}
          </div>
          <div className="dialog-actions">
            <button className="dialog-button-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              className="dialog-button-primary"
              onClick={() => void submit()}
              disabled={!canSubmit}
            >
              {submitting ? 'Starting…' : 'Start conductor'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
