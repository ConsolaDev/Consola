import { ProviderBindingPanel } from '../Provider';
import type { Workspace } from '../../stores/workspaceStore';
import '../WorkspaceSettings/styles.css';
import '../Dialogs/styles.css';

/** The same setup flow is available from Inbox and workspace settings. */
export function InboxSetup({ workspace }: { workspace: Workspace }) {
  return (
    <div className="inbox-view">
      <header className="inbox-header"><h1 className="inbox-title">Inbox</h1></header>
      <div className="inbox-main inbox-setup-main">
        <section className="inbox-setup" aria-label="Set up GitHub">
          <ProviderBindingPanel key={workspace.id} workspace={workspace} />
        </section>
      </div>
    </div>
  );
}
