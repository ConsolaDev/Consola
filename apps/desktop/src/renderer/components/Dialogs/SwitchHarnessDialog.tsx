import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowLeftRight, Loader2, X } from 'lucide-react';
import type { HarnessSwitchPreview } from '../../../shared/harnessSwitch';
import type { Session } from '../../../shared/workspace';
import { workspaceBridge } from '../../services/workspaceBridge';
import { useHarnessStore } from '../../stores/harnessStore';
import { showToast } from '../../stores/toastStore';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { activateSession } from '../../utils/sessionActions';
import { HarnessIcon } from '../HarnessIcon';
import './styles.css';
import '../Views/new-session.css';

interface SwitchHarnessDialogProps {
  workspaceId: string;
  session: Session;
  onClose: () => void;
}

/**
 * Carry a session on with another harness, in the same tab — for when the
 * one it runs on has hit its limit, or another agent should take over.
 *
 * Every row says what switching there would do, or why it cannot, as main
 * decided it: whether the conversation forks with its whole history or is
 * handed over as a transcript depends on the drivers, which the renderer
 * never reasons about.
 */
export function SwitchHarnessDialog({ workspaceId, session, onClose }: SwitchHarnessDialogProps) {
  const harnesses = useHarnessStore((state) => state.harnesses);
  const current = harnesses.find((harness) => harness.id === session.harnessId);
  const [previews, setPreviews] = useState<HarnessSwitchPreview[] | null>(null);
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    let live = true;
    workspaceBridge
      .previewHarnessSwitch(workspaceId, session.id)
      .then((next) => {
        if (!live) return;
        setPreviews(next);
        setSelected(next.find((preview) => preview.ok)?.harnessId);
      })
      .catch((reason) => {
        if (live) setError(ipcErrorMessage(reason));
      });
    return () => {
      live = false;
    };
  }, [workspaceId, session.id]);

  const confirm = async () => {
    if (submittingRef.current || !selected) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError('');
    try {
      const result = await workspaceBridge.switchHarness(workspaceId, session.id, selected);
      // The new harness may ask something first — whether to trust this
      // folder — so the person lands where it will ask.
      activateSession(workspaceId, session.id);
      // Said here rather than only in the terminal: a CLI that opens on its
      // own screen (Claude does) hides whatever was printed before it.
      showToast(result.summary);
      onClose();
    } catch (reason) {
      setError(ipcErrorMessage(reason));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const chosen = previews?.find((preview) => preview.harnessId === selected);

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !submittingRef.current) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content switch-harness-dialog" aria-busy={submitting}>
          <Dialog.Title className="dialog-title">Switch harness</Dialog.Title>
          <Dialog.Description className="dialog-description">
            Carry “{session.name}” on with another harness, in this same tab.
            {current ? ` It runs on ${current.name} now.` : ''}
          </Dialog.Description>
          <Dialog.Close className="dialog-close" disabled={submitting} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </Dialog.Close>

          <div className="dialog-form">
            {previews === null && !error && (
              <p className="switch-harness-status" role="status">
                <Loader2 size={14} className="composer-spinner" aria-hidden="true" /> Checking your
                harnesses…
              </p>
            )}
            {previews?.length === 0 && (
              <p className="switch-harness-status" role="status">
                No other harness is enabled. Add or enable one in Settings › Harnesses.
              </p>
            )}
            {previews && previews.length > 0 && (
              <div className="switch-harness-options" role="radiogroup" aria-label="Harness">
                {previews.map((preview) => {
                  const harness = harnesses.find((candidate) => candidate.id === preview.harnessId);
                  if (!harness) return null;
                  const disabled = submitting || !preview.ok;
                  return (
                    <label
                      key={preview.harnessId}
                      className="switch-harness-option"
                      data-selected={selected === preview.harnessId || undefined}
                      aria-disabled={!preview.ok || undefined}
                    >
                      <input
                        type="radio"
                        name="switch-harness"
                        value={preview.harnessId}
                        checked={selected === preview.harnessId}
                        disabled={disabled}
                        onChange={() => {
                          setSelected(preview.harnessId);
                          setError('');
                        }}
                      />
                      <HarnessIcon driverId={harness.driverId} decorative />
                      <span className="switch-harness-option-copy">
                        <span className="switch-harness-option-name">{harness.name}</span>
                        <span className="switch-harness-option-detail">
                          {preview.ok ? preview.summary : preview.reason}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
            {error && (
              <p className="dialog-error" role="alert">
                {error}
              </p>
            )}
          </div>

          <div className="dialog-actions">
            <button className="dialog-button-secondary" disabled={submitting} onClick={onClose}>
              Cancel
            </button>
            <button
              className="dialog-button-primary"
              disabled={submitting || !chosen?.ok}
              onClick={() => void confirm()}
            >
              {submitting ? (
                <Loader2 size={14} className="composer-spinner" aria-hidden="true" />
              ) : (
                <ArrowLeftRight size={14} aria-hidden="true" />
              )}
              {submitting ? 'Switching…' : 'Switch'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
