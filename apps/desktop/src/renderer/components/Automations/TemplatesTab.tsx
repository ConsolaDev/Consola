import type { AutomationsSnapshot, TemplateView } from '../../../shared/automations';
import type { Workspace } from '../../../shared/workspace';
import { automationsBridge } from '../../services/automationsBridge';
import { useAutomationsStore } from '../../stores/automationsStore';
import { useIntent } from './parts';

/**
 * The ready-made automations, one card each. A template this workspace
 * cannot run is dimmed and says what to do about it; one already in the file
 * says which entry. Shared by the Templates tab, the empty Activity and the
 * New automation panel.
 */
export function TemplateCards({ workspace, snapshot }: { workspace: Workspace; snapshot: AutomationsSnapshot }) {
  const openPanel = useAutomationsStore((state) => state.openPanel);
  const { busy, error, act } = useIntent();

  return (
    <div className="automations-templates">
      {error && <div className="automations-error" role="alert">{error}</div>}
      <ul className="automations-list">
        {snapshot.templates.map((template) => (
          <li key={template.id}>
            <TemplateCard
              template={template}
              busy={busy !== null}
              onAdd={() => void act(`add:${template.id}`, () => automationsBridge.addTemplate(workspace.id, template.id))}
              onCustomize={() => openPanel({ kind: 'new', basis: { template: template.id } })}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function TemplateCard({
  template,
  busy,
  onAdd,
  onCustomize,
}: {
  template: TemplateView;
  busy: boolean;
  onAdd: () => void;
  onCustomize: () => void;
}) {
  const missing = Boolean(template.missing);
  return (
    <div className={`automations-card automations-template ${missing ? 'automations-template-missing' : ''}`}>
      <div className="automations-card-main">
        <span className="automations-name">{template.title}</span>
        <p className="automations-summary">{template.description}</p>
        {template.needs.length > 0 && <div className="automations-meta">Needs: {template.needs.join(', ')}</div>}
        {template.missing && <div className="automations-problem">{template.missing}</div>}
        {template.addedAs && <div className="automations-added">✓ Added as {template.addedAs}</div>}
      </div>
      <div className="automations-card-actions">
        <button
          type="button"
          className="dialog-button-secondary automations-small-button"
          disabled={missing || busy}
          onClick={onCustomize}
        >
          Customize…
        </button>
        {!template.addedAs && (
          <button
            type="button"
            className="dialog-button-primary automations-small-button"
            disabled={missing || busy}
            onClick={onAdd}
          >
            Add
          </button>
        )}
      </div>
    </div>
  );
}

export function TemplatesTab({ workspace, snapshot }: { workspace: Workspace; snapshot: AutomationsSnapshot }) {
  return (
    <div className="automations-activity">
      <TemplateCards workspace={workspace} snapshot={snapshot} />
    </div>
  );
}
