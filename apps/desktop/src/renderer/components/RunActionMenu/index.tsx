import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, CornerDownLeft, LoaderCircle, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { actionConversation, type WorkItemAction } from '../../../shared/workItemActions';
import type { Session, Workspace } from '../../../shared/workspace';
import { useTerminalStore } from '../../stores/terminalStore';
import { runActionInSession } from '../../utils/sessionActions';
import { sessionStatusFor } from '../../utils/sessionStatus';
import { ConfirmDialog } from '../Dialogs/ConfirmDialog';
import './styles.css';

interface RunActionMenuProps {
  workspace: Workspace;
  session: Session;
  /** The host's own button class, so the trigger sits in its row like a native control. */
  triggerClassName: string;
  /** After main took the run: the Inbox opens the session, a session's own strip stays put. */
  onRan?: () => void;
}

const HINTS = {
  continue: 'Continues this conversation',
  fresh: 'Starts a fresh conversation',
} as const;

/**
 * The workspace's actions, run in a session that already exists — the
 * follow-up pass on the same job, in the same tab, instead of a new session
 * per pass. Each action says what it does to the conversation, because that
 * is its own setting: one continues it, another starts the session over
 * with a clean context.
 *
 * Starting over stops whatever the session is doing, so a fresh action on a
 * session that is working or waiting on an answer asks first. A continued
 * one never needs to: main queues it until Claude is quiet, and never types
 * it into a menu.
 *
 * A failure stays in the open menu, under the item that caused it, rather
 * than in the host's layout: the Inbox row and the strip have no room for a
 * line of their own, and the menu is where the person is looking.
 */
export function RunActionMenu({ workspace, session, triggerClassName, onRan }: RunActionMenuProps) {
  const status = useTerminalStore((state) => sessionStatusFor(state.terminals[session.instanceId]));
  const [open, setOpen] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<WorkItemAction | null>(null);

  const type = session.workItem?.type;
  if (!type || !workspace.provider) return null;
  const actions = workspace.actions.filter((action) => action.appliesTo.includes(type));
  if (actions.length === 0) return null;

  const run = async (action: WorkItemAction) => {
    setRunningId(action.id);
    setError(null);
    try {
      const message = await runActionInSession(workspace.id, session, action.id);
      if (message) {
        setError(message);
        return;
      }
      setOpen(false);
      onRan?.();
    } finally {
      setRunningId(null);
    }
  };

  const choose = (action: WorkItemAction) => {
    const interrupting = status === 'working' || status === 'needs-attention';
    if (actionConversation(action) === 'fresh' && interrupting) {
      setOpen(false);
      setConfirming(action);
      return;
    }
    void run(action);
  };

  const label = type === 'pr' ? 'pull request' : 'issue';

  return (
    <>
      <DropdownMenu.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setError(null);
        }}
      >
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className={`${triggerClassName} run-action-trigger`}
            aria-label={`Run an action in ${session.name}`}
            title={`Run one of this workspace's ${label} actions in this session`}
            data-running={runningId !== null || undefined}
          >
            Run
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="dropdown-content run-action-menu"
            sideOffset={4}
            align="end"
            data-testid="run-action-menu"
          >
            <DropdownMenu.Label className="run-action-menu-label">Run in this session</DropdownMenu.Label>
            {actions.map((action) => {
              const conversation = actionConversation(action);
              const pending = runningId === action.id;
              const Icon = pending ? LoaderCircle : conversation === 'fresh' ? RotateCcw : CornerDownLeft;
              return (
                <DropdownMenu.Item
                  key={action.id}
                  className="dropdown-item run-action-item"
                  data-action-id={action.id}
                  data-conversation={conversation}
                  disabled={runningId !== null}
                  onSelect={(event) => {
                    // Kept open until main answers, so a refusal lands here.
                    event.preventDefault();
                    choose(action);
                  }}
                >
                  <Icon
                    size={13}
                    aria-hidden="true"
                    className={pending ? 'run-action-icon run-action-icon--spin' : 'run-action-icon'}
                  />
                  <span className="run-action-text">
                    {action.name}
                    <small>{HINTS[conversation]}</small>
                  </span>
                </DropdownMenu.Item>
              );
            })}
            {error && (
              <p className="run-action-menu-error" role="alert">
                {error}
              </p>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(next) => {
          if (!next) setConfirming(null);
        }}
        title="Start a fresh conversation?"
        description={`${
          status === 'needs-attention'
            ? 'This session is waiting on an answer from you.'
            : 'Claude is still working in this session.'
        } “${confirming?.name ?? ''}” stops it and starts over in a new conversation, in the same tab and checkout. The current conversation stays in Claude's history.`}
        confirmLabel="Start fresh"
        onConfirm={async () => {
          if (!confirming) return;
          const message = await runActionInSession(workspace.id, session, confirming.id);
          if (message) throw new Error(message);
          onRan?.();
        }}
      />
    </>
  );
}
