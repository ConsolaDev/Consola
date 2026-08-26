import { useState } from 'react';
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
  onConfirm,
}: ConfirmDialogProps) {
  const [isConfirming, setIsConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = (next: boolean) => {
    if (!next) setError(null);
    onOpenChange(next);
  };

  const handleConfirm = async () => {
    if (isConfirming) return;
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
          {error && <span className="dialog-error">{error}</span>}
          <div className="dialog-actions">
            {/* Cancel first, so the dialog's initial focus lands on the safe
                way out rather than the destructive action. */}
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
              disabled={isConfirming}
            >
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
