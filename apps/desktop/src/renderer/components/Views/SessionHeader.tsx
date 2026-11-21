import { useState } from 'react';
import {
  checkoutPathForSession,
  scopeForSession,
  type Session,
  type Workspace,
} from '../../../shared/workspace';
import { useBrowserAgentDot } from '../../stores/browserAgentDotStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useCheckout } from '../../stores/checkoutStore';
import { scopeTrail } from '../../utils/scopeTrail';
import { tildePath } from '../../utils/displayPath';
import { renameSession } from '../../utils/sessionActions';
import { SessionNameEditor } from '../SessionName/SessionNameEditor';
import { useTabFacts } from '../SidePanel/useTabFacts';
import { PathDisplay } from './PathDisplay';
import { ShortcutButton } from './ShortcutButton';
import { SidePanelToggle } from './SidePanelToggle';
import { CheckoutChip } from './CheckoutChip';
import { SnoozeChip } from '../Snooze/SnoozeChip';
import './styles.css';

/**
 * The top of a session's pane: "scope / name", where its edits land, and the
 * pane toggles. The pane runs to the window's top edge, so this row is the
 * title bar beside the navigation strip, as in production, while staying on
 * the pane whose terminal and side panel read the checkout it names. The
 * scope leads, as the workspace did before the strip's menu named it: the
 * session's own scope, not its checkout, which the chip covers.
 *
 * Key it by session: the checkout is re-read on mount, because the agent on
 * screen may just have changed branch.
 */
export function SessionHeader({ workspace, session }: { workspace: Workspace; session: Session }) {
  const isBrowserVisible = useNavigationStore((state) => state.isBrowserVisible);
  const toggleBrowser = useNavigationStore((state) => state.toggleBrowser);
  const browserAgentDot = useBrowserAgentDot(session.id);
  const cwd = checkoutPathForSession(workspace, session) ?? '';
  const checkout = useCheckout(cwd || null, { fresh: true });
  const facts = useTabFacts(workspace, session);
  const scope = scopeForSession(workspace, session);
  const [isRenaming, setIsRenaming] = useState(false);

  return (
    <div className="workspace-view-header">
      {scope && (
        <h1 className="workspace-view-title">
          <span className="workspace-view-scope" title={tildePath(scope.path)}>
            {scopeTrail(workspace.scopes, scope).label}
          </span>
          {session.name && (
            <>
              <span className="workspace-view-separator">/</span>
              {/* Double-click renames, as on the sidebar row. The name is
                  carved out of the header's drag region for that; a single
                  click does nothing. */}
              {isRenaming ? (
                <SessionNameEditor
                  initialName={session.name}
                  className="session-header-rename-input"
                  ariaLabel="Session name"
                  onCommit={(name) => renameSession(workspace.id, session, name)}
                  onClose={() => setIsRenaming(false)}
                />
              ) : (
                // biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut only; keyboard renaming is F2 on the sidebar row and Rename in the ⋯ menu
                <span className="workspace-view-session" onDoubleClick={() => setIsRenaming(true)}>
                  {session.name}
                </span>
              )}
            </>
          )}
        </h1>
      )}
      <CheckoutChip checkout={checkout} />
      <SnoozeChip workspaceId={workspace.id} session={session} />
      {cwd && (
        <PathDisplay
          path={cwd}
          className="workspace-view-path"
          // The checkout chip's tooltip already names the folder; only a
          // folder outside git, which gets no chip, needs it printed here.
          showPath={checkout?.kind === 'none'}
          isBrowserVisible={isBrowserVisible}
          onToggleBrowser={toggleBrowser}
          browserAgentDot={browserAgentDot}
        >
          <ShortcutButton kind="changes" facts={facts} />
          <ShortcutButton kind="files" facts={facts} />
          <ShortcutButton kind="terminal" facts={facts} />
        </PathDisplay>
      )}
      {/* Outside PathDisplay, which needs a checkout: the side panel does not. */}
      <SidePanelToggle />
    </div>
  );
}
