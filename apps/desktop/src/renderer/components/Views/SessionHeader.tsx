import { useState } from 'react';
import {
  checkoutPathForSession,
  scopeForSession,
  type Session,
  type Workspace,
} from '../../../shared/workspace';
import { useNavigationStore } from '../../stores/navigationStore';
import { useShellStore } from '../../stores/shellStore';
import { useCheckout } from '../../stores/checkoutStore';
import { scopeTrail } from '../../utils/scopeTrail';
import { tildePath } from '../../utils/displayPath';
import { renameSession } from '../../utils/sessionActions';
import { SessionNameEditor } from '../SessionName/SessionNameEditor';
import { PathDisplay } from './PathDisplay';
import { CheckoutChip } from './CheckoutChip';
import './styles.css';

/**
 * The top of a session's pane: "scope / name", where its edits land, and the
 * pane toggles. The pane runs to the window's top edge, so this row is the
 * title bar beside the navigation strip, as in production, while staying on
 * the pane whose terminal and explorer run in the checkout it names. The
 * scope leads, as the workspace did before the strip's menu named it: the
 * session's own scope, not its checkout, which the chip covers.
 *
 * Key it by session: the checkout is re-read on mount, because the agent on
 * screen may just have changed branch.
 */
export function SessionHeader({ workspace, session }: { workspace: Workspace; session: Session }) {
  const isExplorerVisible = useNavigationStore((state) => state.isExplorerVisible);
  const toggleExplorer = useNavigationStore((state) => state.toggleExplorer);
  const isBrowserVisible = useNavigationStore((state) => state.isBrowserVisible);
  const toggleBrowser = useNavigationStore((state) => state.toggleBrowser);
  const isTerminalVisible = useShellStore((state) => state.open[session.instanceId] ?? false);
  const toggleTerminal = useShellStore((state) => state.toggle);
  const cwd = checkoutPathForSession(workspace, session) ?? '';
  const checkout = useCheckout(cwd || null, { fresh: true });
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
      {cwd && (
        <PathDisplay
          path={cwd}
          className="workspace-view-path"
          // The checkout chip's tooltip already names the folder; only a
          // folder outside git, which gets no chip, needs it printed here.
          showPath={checkout?.kind === 'none'}
          showExplorerToggle
          isExplorerVisible={isExplorerVisible}
          onToggleExplorer={toggleExplorer}
          isBrowserVisible={isBrowserVisible}
          onToggleBrowser={toggleBrowser}
          isTerminalVisible={isTerminalVisible}
          onToggleTerminal={() => toggleTerminal(session.instanceId)}
        />
      )}
    </div>
  );
}
