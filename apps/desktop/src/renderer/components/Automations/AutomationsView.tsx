import type { Workspace } from '../../stores/workspaceStore';

interface AutomationsViewProps {
  workspace: Workspace;
}

/** The workspace's automations, over the session pane. */
export function AutomationsView({ workspace }: AutomationsViewProps) {
  return (
    <section className="automations-view" aria-label="Automations">
      <header className="automations-header">
        <h1>Automations · {workspace.name}</h1>
      </header>
    </section>
  );
}
