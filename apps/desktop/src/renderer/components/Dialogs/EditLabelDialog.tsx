import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { Label } from '../../../shared/workspace';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { GroupEmojiPicker } from '../GroupEmojiPicker';
import './styles.css';

/**
 * Rename a label and set or clear its emoji: the same form, and the same
 * picker, a group is edited with. Changes stay local until Save, and Save
 * always sends the emoji key, so removing one is a clear rather than a no-op.
 * The label keeps its id, so every assignment it carries survives a rename.
 */
export function EditLabelDialog({
  workspaceId,
  label,
  onClose,
}: {
  workspaceId: string;
  label: Label;
  onClose: () => void;
}) {
  const [name, setName] = useState(label.name);
  const [emoji, setEmoji] = useState(label.emoji);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await useWorkspaceStore
        .getState()
        .updateLabel(workspaceId, label.id, { name: trimmed, emoji });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title className="dialog-title">Edit label</Dialog.Title>
          <Dialog.Description className="dialog-description">
            Give your label a name and an optional emoji.
          </Dialog.Description>
          <div className="dialog-form">
            <div className="dialog-field">
              <label className="dialog-label" htmlFor="edit-label-name">
                Name
              </label>
              <div className="group-name-field">
                <GroupEmojiPicker
                  subject="label"
                  value={emoji}
                  onChange={setEmoji}
                  disabled={submitting}
                />
                <input
                  id="edit-label-name"
                  className="dialog-input"
                  autoFocus
                  disabled={submitting}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void save();
                  }}
                />
              </div>
              {error && (
                <span className="dialog-error" role="alert">
                  {error}
                </span>
              )}
            </div>
          </div>
          <div className="dialog-actions">
            <button type="button" className="dialog-button-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="dialog-button-primary"
              onClick={() => void save()}
              disabled={!name.trim() || submitting}
            >
              {submitting ? 'Saving…' : 'Save'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
