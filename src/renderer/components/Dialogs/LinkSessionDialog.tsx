import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { sessionLabel } from '../../../shared/sessionLabel';
import { useInboxStore } from '../../stores/inboxStore';
import {
  useLinkSessionDialogStore,
  type LinkSessionDialogMode,
} from '../../stores/linkSessionDialogStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { SearchableList } from '../SearchableList';
import { itemRowsFor, sessionRowsFor, type LinkRow } from './linkSessionRows';
import './styles.css';

/** A key that changes whenever the dialog is opened for a different target. */
function modeKey(mode: LinkSessionDialogMode): string {
  return mode.kind === 'pick-session'
    ? `pick-session:${mode.workspaceId}:${mode.item.workItem.repo}#${mode.item.workItem.number}`
    : `pick-item:${mode.workspaceId}:${mode.session.id}`;
}

/**
 * Link a session to a work item — from either end.
 *
 * Self-mounting from its store, like CloneDialog: the openers (the Inbox
 * pane, a sidebar row's menu) live in trees that unmount, and the dialog
 * must not. Linking is metadata only: main rewrites `workItem` on the
 * record, the session keeps its folder and gets no prompt. Main's refusals
 * (a conductor, a session already on another item) arrive as rejections
 * and are shown inline; the dialog stays open.
 */
export function LinkSessionDialog() {
  const mode = useLinkSessionDialogStore((state) => state.mode);
  const close = useLinkSessionDialogStore((state) => state.close);
  if (!mode) return null;
  // Keyed so reopening for another target starts with a clean query,
  // highlight and error rather than the previous target's leftovers.
  return <LinkSessionDialogBody key={modeKey(mode)} mode={mode} onClose={close} />;
}

interface LinkSessionDialogBodyProps {
  mode: LinkSessionDialogMode;
  onClose: () => void;
}

function LinkSessionDialogBody({ mode, onClose }: LinkSessionDialogBodyProps) {
  const workspace = useWorkspaceStore((state) =>
    state.workspaces.find((candidate) => candidate.id === mode.workspaceId)
  );
  const updateSession = useWorkspaceStore((state) => state.updateSession);
  const terminals = useTerminalStore((state) => state.terminals);
  const items = useInboxStore((state) => state.snapshots[mode.workspaceId]?.items);

  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const rows = useMemo<LinkRow[]>(() => {
    if (!workspace) return [];
    return mode.kind === 'pick-session'
      ? sessionRowsFor(workspace, mode.item, terminals)
      : itemRowsFor(items ?? [], mode.session);
  }, [workspace, mode, terminals, items]);

  const active = rows.find((row) => row.id === activeId && !row.disabled) ?? null;

  const submit = async (row: LinkRow) => {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await updateSession(mode.workspaceId, row.sessionId, { workItem: row.workItem });
      onClose();
    } catch (err) {
      // Main refused (conductor, or already linked to a different item):
      // say so in place and leave the picker where it was.
      setError(ipcErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const title =
    mode.kind === 'pick-session'
      ? `Link a session to ${mode.item.workItem.repo.split('/').pop() ?? mode.item.workItem.repo}#${mode.item.workItem.number}`
      : `Link "${sessionLabel(mode.session)}" to a work item`;
  const emptyMessage =
    mode.kind === 'pick-session' ? 'No sessions in this workspace.' : 'No inbox items to link to.';

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content link-session-dialog"
          // The Inbox closes its detail pane on Esc; a dialog's Esc must not
          // reach that listener, or one keypress would close both.
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          <Dialog.Title className="dialog-title">{title}</Dialog.Title>
          <Dialog.Description className="dialog-description">
            Linking is metadata only: the session keeps its folder and gets no prompt.
          </Dialog.Description>
          <SearchableList
            items={rows}
            query={query}
            onQueryChange={setQuery}
            placeholder={mode.kind === 'pick-session' ? 'Search sessions...' : 'Search inbox items...'}
            inputAriaLabel={mode.kind === 'pick-session' ? 'Search sessions' : 'Search inbox items'}
            emptyMessage={emptyMessage}
            activeId={activeId}
            onActiveChange={setActiveId}
            onActivate={(row) => void submit(row)}
            leadingSlot={(row) =>
              row.status ? (
                <span className={`status-dot status-dot--${row.status}`} aria-hidden="true" />
              ) : null
            }
          />
          {error && <span className="dialog-error">{error}</span>}
          <div className="dialog-actions">
            <button className="dialog-button-secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button
              className="dialog-button-primary"
              onClick={() => active && void submit(active)}
              disabled={!active || submitting}
            >
              Link
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
