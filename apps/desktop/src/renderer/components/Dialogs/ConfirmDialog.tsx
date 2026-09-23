import { useEffect, useId, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import './styles.css';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Concrete consequences, not mood: what goes, and what stays. */
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Exact text required before enabling the confirmation button. */
  confirmationText?: string;
  onConfirm: () => void | Promise<void>;
}

/**
 * A styled stand-in for window.confirm: one action, named plainly, with its
 * consequences in the description. A rejected confirm keeps the dialog open
 * and says what happened instead of closing over it.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = false,
  confirmationText,
  onConfirm,
}: ConfirmDialogProps) {
  const [isConfirming, setIsConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const confirmationId = useId();
  const canConfirm = confirmationText === undefined || confirmation === confirmationText;

  useEffect(() => {
    setConfirmation('');
    setError(null);
  }, [open, confirmationText]);

  const handleOpenChange = (next: boolean) => {
    if (!next) setError(null);
    onOpenChange(next);
  };

  const handleConfirm = async () => {
    if (isConfirming || !canConfirm) return;
    setError(null);
    setIsConfirming(true);
    try {
      await onConfirm();
      handleOpenChange(false);
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setIsConfirming(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title className="dialog-title">{title}</Dialog.Title>
          <Dialog.Description className="dialog-description">{description}</Dialog.Description>
          {confirmationText !== undefined && (
            <div className="dialog-field">
              <label className="dialog-label" htmlFor={confirmationId}>
                Type <strong>{confirmationText}</strong> to confirm
              </label>
              <input
                id={confirmationId}
                className="dialog-input"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={isConfirming}
              />
            </div>
          )}
          {error && <span className="dialog-error">{error}</span>}
          <div className="dialog-actions">
            {/* Without a text field, initial focus lands on Cancel. */}
            <button
              className="dialog-button-secondary"
              onClick={() => handleOpenChange(false)}
              disabled={isConfirming}
            >
              {cancelLabel}
            </button>
            <button
              className={destructive ? 'dialog-button-danger' : 'dialog-button-primary'}
              onClick={() => void handleConfirm()}
              disabled={isConfirming || !canConfirm}
            >
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
