import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { Group } from '../../../shared/workspace';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { GroupEmojiPicker } from '../GroupEmojiPicker';
import './styles.css';

interface NewGroupDialogProps {
  workspaceId: string;
  group?: Group;
  onClose: () => void;
  /**
   * The group just created, before the dialog closes. Lets a caller that
   * opened this to reach a group it does not have yet — "Move to group ▸ New
   * group…" — use it, instead of creating one and leaving the session behind.
   */
  onCreated?: (group: Group) => void | Promise<void>;
}

/** Shared create/edit form; changes stay local until Save. */
export function NewGroupDialog({ workspaceId, group: existingGroup, onClose, onCreated }: NewGroupDialogProps) {
  const [name, setName] = useState(existingGroup?.name ?? '');
  const [emoji, setEmoji] = useState(existingGroup?.emoji);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      if (existingGroup) {
        await useWorkspaceStore.getState().updateGroup(workspaceId, existingGroup.id, { name: trimmed, emoji });
        onClose();
        return;
      }
      const group = await useWorkspaceStore.getState().createGroup(workspaceId, { name: trimmed, emoji });
      // Inside the try on purpose: a callback that fails leaves the dialog
      // open with its message, rather than closing over a half-done move.
      await onCreated?.(group);
      onClose();
    } catch (err) {
      // Keep the dialog open so the name is not lost, and say what happened
      // instead of a native alert.
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
          <Dialog.Title className="dialog-title">{existingGroup ? 'Rename group' : 'New group'}</Dialog.Title>
          <Dialog.Description className="dialog-description">
            Give your group a name and an optional emoji.
          </Dialog.Description>
          <div className="dialog-form">
            <div className="dialog-field">
              <label className="dialog-label" htmlFor="new-group-name">
                Name
              </label>
              <div className="group-name-field">
                <GroupEmojiPicker value={emoji} onChange={setEmoji} disabled={submitting} />
                <input
                  id="new-group-name"
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
              {submitting ? 'Saving…' : existingGroup ? 'Save' : 'Create'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
