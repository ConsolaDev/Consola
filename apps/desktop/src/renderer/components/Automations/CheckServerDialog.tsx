import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { ServerFacts } from '../../../shared/automations';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { checkDialogLines } from './callWords';
import '../Dialogs/styles.css';

/**
 * Asks before Check server starts a server: what it starts, as the person,
 * and that it lists its tools and calls none. Start it once is the person's
 * own start; main's refusal (a stale version, a check already under way, a
 * problem) is shown under the lines, word for word. It stays open until the
 * check ends, which the page then shows; it records no acceptance.
 */
export function CheckServerDialog({
  facts,
  onStart,
  onClose,
}: {
  facts: ServerFacts;
  onStart: () => Promise<void>;
  onClose: () => void;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { title, lines } = checkDialogLines(facts);

  const start = async () => {
    if (starting) return;
    setError(null);
    setStarting(true);
    try {
      await onStart();
      onClose();
    } catch (failure) {
      setError(ipcErrorMessage(failure));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && !starting && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content automations-check-dialog">
          <Dialog.Title className="dialog-title">{title}</Dialog.Title>
          <Dialog.Description asChild>
            <div className="dialog-description automations-check-lines">
              {lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </Dialog.Description>
          {error && (
            <p className="dialog-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="dialog-button-secondary"
              onClick={onClose}
              disabled={starting}
            >
              Cancel
            </button>
            <button
              type="button"
              className="dialog-button-primary"
              onClick={() => void start()}
              disabled={starting}
            >
              {starting ? 'Starting…' : 'Start it once'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
