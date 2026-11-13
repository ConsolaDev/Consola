import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal } from 'lucide-react';
import { listedSessions, type Session, type Workspace } from '../../../shared/workspace';
import { useAssistantRequests } from '../../hooks/useAssistantRequests';
import { assistantBridge } from '../../services/assistantBridge';
import { useAssistantStore } from '../../stores/assistantStore';
import { activateSession } from '../../utils/sessionActions';

const FRESH_CONFIRMATION =
  'Start a fresh conversation? The current one closes; its transcript stays in Claude’s history.';

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * The Assistant pane's header, in place of a session's name and checkout.
 *
 * It says how much the Assistant can see, because that is the answer to "what
 * will it know about?". There is no branch or folder chip: its folder is not
 * a repo, and the folder it runs in is not where anything is edited.
 */
export function AssistantHeader({ workspace, session }: { workspace: Workspace; session: Session }) {
  const sees = `sees ${count(listedSessions(workspace).length, 'session')} in ${count(workspace.scopes.length, 'scope')}`;
  const waiting = useAssistantRequests(workspace).length;
  const trayHidden = useAssistantStore((state) => state.tray[workspace.id]?.hidden ?? false);
  const setTrayHidden = useAssistantStore((state) => state.setTrayHidden);

  const startFresh = async () => {
    if (!window.confirm(FRESH_CONFIRMATION)) return;
    const next = await assistantBridge.startFresh(workspace.id);
    activateSession(workspace.id, next.id);
  };

  return (
    <>
      <h1 className="workspace-view-title">
        <span className="assistant-header-spark" aria-hidden="true">✦ </span>
        <span>Assistant</span>
      </h1>
      {/* The workspace menu beside it already names the workspace. */}
      <span className="assistant-header-sub">{sees}</span>
      <span className="assistant-header-spacer" />
      {waiting > 0 && trayHidden && (
        <button
          type="button"
          className="assistant-header-waiting"
          aria-label={`Show ${waiting} waiting for your approval`}
          onClick={() => setTrayHidden(workspace.id, false)}
        >
          {waiting} waiting ▸
        </button>
      )}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="assistant-header-menu" aria-label="Assistant actions" data-session-id={session.id}>
            <MoreHorizontal size={16} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="dropdown-content" align="end" sideOffset={4}>
            <DropdownMenu.Item className="dropdown-item" onSelect={() => void startFresh()}>
              Start a fresh conversation
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </>
  );
}
