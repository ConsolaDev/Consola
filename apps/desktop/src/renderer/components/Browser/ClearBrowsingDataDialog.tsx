import { browserBridge } from '../../services/browserBridge';
import { ConfirmDialog } from '../Dialogs/ConfirmDialog';

interface ClearBrowsingDataDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Confirms, then wipes the window's workspace's browsing data. The names what
 * goes and what stays, since signing out of every site is not undoable.
 * A failure is shown in the dialog (`ConfirmDialog` keeps it open on a
 * rejection) rather than leaving the person to think it worked.
 */
export function ClearBrowsingDataDialog({ open, onOpenChange }: ClearBrowsingDataDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Clear browsing data?"
      description="Signs you out of every site in this workspace and removes its cookies, site storage, cache, visited pages and approved certificates. Open pages stay open, with their zoom reset. Other workspaces are not touched."
      confirmLabel="Clear browsing data"
      destructive
      onConfirm={() => browserBridge.clearData()}
    />
  );
}
