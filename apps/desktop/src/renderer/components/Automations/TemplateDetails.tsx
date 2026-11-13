import { useId, useState } from 'react';
import { ArrowRight, Bot, CircleCheck, FileCode, Plus, Workflow } from 'lucide-react';
import type { AutomationView, TemplatePreview, TemplateView } from '../../../shared/automations';
import type { Workspace } from '../../../shared/workspace';
import { useWorkspaceSettings } from '../../contexts/WorkspaceSettingsContext';
import { useAutomationsStore } from '../../stores/automationsStore';
import { EntryCode, PipelineGraph } from './AutomationPipeline';
import { useNow } from './parts';
import { ServiceTiles, SetupChecklist, useTemplateAdd } from './TemplatesTab';

const NO_RUNS: never[] = [];

/**
 * One template, before it is added: as n8n opens a template and GitHub
 * opens a starter workflow — what it works with and does, what this
 * workspace still needs for it, its pipeline, and the exact entry Add
 * appends to factory.yml, drawn as the addition it is. Once added, it
 * points at the automation it became.
 */
export function TemplateDetails({ workspace, id }: { workspace: Workspace; id: string }) {
  const snapshot = useAutomationsStore((state) => state.snapshots[workspace.id]);
  const openPanel = useAutomationsStore((state) => state.openPanel);
  const { openWorkspaceSettings } = useWorkspaceSettings();
  const { busy, error, add, justAdded } = useTemplateAdd(workspace.id);
  const [view, setView] = useState<'graph' | 'yaml'>('graph');
  const now = useNow(60_000);
  const setupHeading = useId();
  const pipelineHeading = useId();

  if (!snapshot) return <p className="automations-hint">Loading…</p>;
  const template = snapshot.templates.find((candidate) => candidate.id === id);
  if (!template) return <p className="automations-hint">Consola no longer offers this template.</p>;

  const missing = Boolean(template.missing);
  const preview = template.preview;
  const addedAs = template.addedAs;

  return (
    <div className={`automations-detail ${justAdded.has(template.id) ? 'automations-template-just-added' : ''}`}>
      {error && (
        <div className="automations-error" role="alert">
          {error}
        </div>
      )}

      <div className="automations-lead">
        <div className="automations-template-lead">
          <div className="automations-template-top">
            <ServiceTiles workspace={workspace} template={template} labelled />
            <span className="automations-template-category">{template.category}</span>
          </div>
          <p className="automations-template-lead-text">{template.description}</p>
          {addedAs && (
            <p className="automations-template-lead-added">
              <CircleCheck size={14} className="automations-added-check" aria-hidden="true" />
              Added as <span className="automations-added-name">{addedAs}</span>
            </p>
          )}
        </div>
        <div className="automations-lead-actions">
          {addedAs ? (
            <button
              type="button"
              className="dialog-button-primary automations-small-button"
              onClick={() => openPanel({ kind: 'automation', name: addedAs })}
            >
              Open automation
              <ArrowRight size={12} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="dialog-button-primary automations-small-button"
              disabled={missing || busy !== null}
              onClick={() => add(template.id)}
            >
              <Plus size={12} aria-hidden="true" />
              {busy === `add:${template.id}` ? 'Adding…' : 'Add'}
            </button>
          )}
          <button
            type="button"
            className="dialog-button-secondary automations-small-button"
            disabled={missing || busy !== null}
            title="Start a session where an agent adapts it with you before writing it"
            onClick={() => openPanel({ kind: 'new', basis: { template: template.id } })}
          >
            <Bot size={12} aria-hidden="true" />
            Customize…
          </button>
        </div>
      </div>

      <section className="automations-detail-section" aria-labelledby={setupHeading}>
        <div className="automations-detail-section-head">
          <h3 id={setupHeading} className="automations-section-title">
            Setup
          </h3>
        </div>
        <SetupChecklist
          needs={template.needs}
          detailed
          onFix={(section) => openWorkspaceSettings(workspace.id, section)}
        />
      </section>

      {preview && (
        <section className="automations-detail-section" aria-labelledby={pipelineHeading}>
          <div className="automations-detail-section-head">
            <h3 id={pipelineHeading} className="automations-section-title">
              Pipeline
            </h3>
            <div className="automations-segmented automations-view-toggle" role="group" aria-label="Show the pipeline as">
              <button
                type="button"
                className={`automations-segment ${view === 'graph' ? 'active' : ''}`}
                aria-pressed={view === 'graph'}
                onClick={() => setView('graph')}
              >
                <Workflow size={12} aria-hidden="true" />
                Graph
              </button>
              <button
                type="button"
                className={`automations-segment ${view === 'yaml' ? 'active' : ''}`}
                aria-pressed={view === 'yaml'}
                onClick={() => setView('yaml')}
              >
                <FileCode size={12} aria-hidden="true" />
                YAML
              </button>
            </div>
          </div>
          {view === 'graph' ? (
            <PipelineGraph
              automation={draftAutomation(template, preview)}
              runs={NO_RUNS}
              now={now}
              place={() => undefined}
              onOpenRun={() => {}}
              draft
            />
          ) : (
            <EntryCode text={preview.entry} addition />
          )}
          <p className="automations-hint">
            {addedAs
              ? `Already in factory.yml as ${addedAs}; change it there, or with an agent from its details.`
              : 'Add appends this entry to factory.yml as shown. Customize starts a session where an agent adapts it with you first.'}
          </p>
        </section>
      )}
    </div>
  );
}

/** The entry a template would add, as the pipeline draws an automation that is in the file. */
function draftAutomation(template: TemplateView, preview: TemplatePreview): AutomationView {
  return {
    name: template.id,
    mode: preview.mode,
    trigger: preview.trigger,
    ...(preview.schedule ? { schedule: preview.schedule } : {}),
    onEvent: preview.onEvent,
    kind: preview.kind,
    runs: preview.runs,
    target: preview.target,
    nextRunAt: preview.nextRunAt,
  };
}
