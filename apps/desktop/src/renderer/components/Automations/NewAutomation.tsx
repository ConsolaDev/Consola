import { useId, useState } from 'react';
import type { AuthoringBasis } from '../../../shared/automations';
import type { Workspace } from '../../../shared/workspace';
import { automationsBridge } from '../../services/automationsBridge';
import { useAutomationsStore } from '../../stores/automationsStore';
import { useHarnessStore } from '../../stores/harnessStore';
import { homeScope, useHomeStore } from '../../stores/homeStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { activateSession } from '../../utils/sessionActions';
import { useIntent } from './parts';
import { TemplateCards } from './TemplatesTab';

/**
 * "New automation", "Change with agent" and "Customize…": the person says
 * what they want, and Start opens an ordinary session — full tools, under
 * their own CLI permissions, on the workspace's default harness — whose
 * agent drafts the entry with them. The new session opens in Home.
 */
export function NewAutomation({ workspace, basis }: { workspace: Workspace; basis?: AuthoringBasis }) {
  const fieldId = useId();
  const snapshot = useAutomationsStore((state) => state.snapshots[workspace.id]);
  // The record's name: asking the harness itself would start a process.
  const harnessName = useHarnessStore(
    (state) => state.harnesses.find((harness) => harness.id === workspace.defaultHarnessId)?.name
  );
  const [description, setDescription] = useState('');
  const { busy, error, act } = useIntent();
  const canStart = description.trim().length > 0 || basis !== undefined;

  const start = () =>
    void act('start', async () => {
      const navigation = useNavigationStore.getState();
      const activeSessionId = navigation.activeWorkspaceId === workspace.id ? navigation.activeSessionId : null;
      const scope = homeScope(workspace, useHomeStore.getState().scopeIds[workspace.id], activeSessionId);
      const session = await automationsBridge.startAuthoring({
        workspaceId: workspace.id,
        description: description.trim(),
        ...(scope ? { scopeId: scope.id } : {}),
        ...(basis ? { basis } : {}),
      });
      // Done here: coming back to Automations should not find the draft again.
      useAutomationsStore.getState().closePanel();
      activateSession(workspace.id, session.id);
    });

  return (
    <div className="automations-new">
      {basis && <p className="automations-summary">{basisInWords(basis, snapshot?.templates)}</p>}
      <label htmlFor={fieldId} className="automations-panel-label">
        What should it do, and when?
      </label>
      <textarea
        id={fieldId}
        className="automations-textarea"
        data-autofocus
        rows={4}
        placeholder="Every weekday at 9:00, list the pull requests waiting for my review."
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canStart && busy === null) {
            event.preventDefault();
            start();
          }
        }}
      />
      <div className="automations-panel-row">
        <span className="automations-meta">Starts a session on {harnessName ?? workspace.defaultHarnessId}</span>
        <button
          type="button"
          className="dialog-button-primary automations-small-button"
          disabled={!canStart || busy !== null}
          onClick={start}
        >
          {busy === 'start' ? 'Starting…' : 'Start'}
        </button>
      </div>
      <p className="automations-hint">
        Its agent works out the entry with you, shows it to you, and adds it to factory.yml once you agree.
      </p>
      {error && <div className="automations-error" role="alert">{error}</div>}

      {snapshot && snapshot.templates.length > 0 && (
        <section className="automations-section" aria-label="Templates">
          <h3 className="automations-section-title">Or start from a template</h3>
          <TemplateCards workspace={workspace} snapshot={snapshot} />
        </section>
      )}
    </div>
  );
}

function basisInWords(basis: AuthoringBasis, templates: Array<{ id: string; title: string }> = []): string {
  if ('automation' in basis) return `Changes ${basis.automation}, starting from its entry in factory.yml.`;
  const title = templates.find((template) => template.id === basis.template)?.title ?? basis.template;
  return `Starts from the template “${title}”.`;
}
