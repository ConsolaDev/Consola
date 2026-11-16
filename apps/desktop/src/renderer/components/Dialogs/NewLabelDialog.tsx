import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { Label } from '../../../shared/workspace';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { GroupEmojiPicker } from '../GroupEmojiPicker';
import './styles.css';

interface NewLabelDialogProps {
  workspaceId: string;
  onClose: () => void;
  /**
   * The label just created, before the dialog closes. Lets a caller that
   * opened this to reach a label it does not have yet ("Labels ▸ New label…")
   * use it, instead of creating one and leaving the session without it.
   * Editing an existing label is `EditLabelDialog`.
   */
  onCreated?: (label: Label) => void | Promise<void>;
}

/** Name and optional emoji for a new label; nothing is written until Create. */
export function NewLabelDialog({ workspaceId, onClose, onCreated }: NewLabelDialogProps) {
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const label = await useWorkspaceStore.getState().createLabel(workspaceId, { name: trimmed, emoji });
      // Inside the try on purpose: a callback that fails leaves the dialog
      // open with its message, rather than closing over a half-done assignment.
      await onCreated?.(label);
      onClose();
    } catch (err) {
      // Keep the dialog open so the name is not lost.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title className="dialog-title">New label</Dialog.Title>
          <Dialog.Description className="dialog-description">
            Give your label a name and an optional emoji.
          </Dialog.Description>
          <div className="dialog-form">
            <div className="dialog-field">
              <label className="dialog-label" htmlFor="new-label-name">
                Name
              </label>
              <div className="group-name-field">
                <GroupEmojiPicker subject="label" value={emoji} onChange={setEmoji} disabled={submitting} />
                <input
                  id="new-label-name"
                  className="dialog-input"
                  autoFocus
                  disabled={submitting}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void create();
                  }}
                  placeholder="e.g. bump lodash v5"
                />
              </div>
              {error && <span className="dialog-error" role="alert">{error}</span>}
            </div>
          </div>
          <div className="dialog-actions">
            <button className="dialog-button-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              className="dialog-button-primary"
              onClick={() => void create()}
              disabled={!name.trim() || submitting}
            >
              {submitting ? 'Saving…' : 'Create'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
