import { useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import {
  ArrowRight,
  Bell,
  Bot,
  Check,
  CircleCheck,
  CircleDashed,
  Clock,
  GitBranch,
  Github,
  Hand,
  Inbox,
  SquareTerminal,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type {
  AutomationsSnapshot,
  TemplateNeed,
  TemplateNeedSection,
  TemplatePreview,
  TemplateService,
  TemplateView,
} from '../../../shared/automations';
import type { Workspace } from '../../../shared/workspace';
import { useWorkspaceSettings } from '../../contexts/WorkspaceSettingsContext';
import { automationsBridge } from '../../services/automationsBridge';
import { useAutomationsStore } from '../../stores/automationsStore';
import { useHarnessStore } from '../../stores/harnessStore';
import { HarnessIcon } from '../HarnessIcon';
import { useIntent } from './parts';
import { templateModeWords } from './presentation';

/**
 * The ready-made automations, as a gallery: one card each, the way n8n and
 * GitHub's starter workflows lay theirs out. A card says what the template
 * works with, what it does in three lines (when, what runs, how it treats
 * you), and whether this workspace is ready for it — with the way to get
 * ready. One already in the file says which entry, and opens it. The card
 * itself opens the template's panel: its pipeline and the exact entry Add
 * writes. Shared by the Templates tab, the empty Activity and the New
 * automation panel.
 */
export function TemplateCards({
  workspace,
  snapshot,
  intro = false,
}: {
  workspace: Workspace;
  snapshot: AutomationsSnapshot;
  /** The Templates tab's own line on what a template is; the empty state and the New panel say it themselves. */
  intro?: boolean;
}) {
  const openPanel = useAutomationsStore((state) => state.openPanel);
  const selected = useAutomationsStore((state) => (state.panel?.kind === 'template' ? state.panel.id : null));
  const { openWorkspaceSettings } = useWorkspaceSettings();
  const { busy, error, add, justAdded } = useTemplateAdd(workspace.id);
  const ready = snapshot.templates.filter((template) => !template.addedAs && !template.missing).length;
  const added = snapshot.templates.filter((template) => template.addedAs).length;

  return (
    <div className="automations-templates">
      {intro && (
        <div className="automations-templates-intro">
          <p>Each template adds one entry to factory.yml, filled in for this workspace. Open one to see exactly what it writes.</p>
          <span className="automations-templates-tally">
            {[ready > 0 ? `${ready} ready to add` : null, added > 0 ? `${added} added` : null].filter(Boolean).join(' · ')}
          </span>
        </div>
      )}
      {error && (
        <div className="automations-error" role="alert">
          {error}
        </div>
      )}
      <ul className="automations-list automations-template-grid">
        {snapshot.templates.map((template) => (
          <li key={template.id}>
            <TemplateCard
              workspace={workspace}
              template={template}
              selected={selected === template.id}
              adding={busy === `add:${template.id}`}
              busy={busy !== null}
              justAdded={justAdded.has(template.id)}
              onOpen={() => openPanel({ kind: 'template', id: template.id })}
              onAdd={() => add(template.id)}
              onCustomize={() => openPanel({ kind: 'new', basis: { template: template.id } })}
              onOpenAutomation={(name) => openPanel({ kind: 'automation', name })}
              onFix={(section) => openWorkspaceSettings(workspace.id, section)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Keeps a click on a control inside the card from also opening the card. */
const inside = (handler?: () => void) => (event: MouseEvent) => {
  event.stopPropagation();
  handler?.();
};

function TemplateCard({
  workspace,
  template,
  selected,
  adding,
  busy,
  justAdded,
  onOpen,
  onAdd,
  onCustomize,
  onOpenAutomation,
  onFix,
}: {
  workspace: Workspace;
  template: TemplateView;
  selected: boolean;
  adding: boolean;
  busy: boolean;
  justAdded: boolean;
  onOpen: () => void;
  onAdd: () => void;
  onCustomize: () => void;
  onOpenAutomation: (name: string) => void;
  onFix: (section: TemplateNeedSection) => void;
}) {
  const missing = Boolean(template.missing);
  const classes = [
    'automations-template',
    missing ? 'automations-template-missing' : '',
    template.addedAs ? 'automations-template-added' : '',
    justAdded ? 'automations-template-just-added' : '',
  ].join(' ');
  return (
    // The card opens the template for a pointer; its title is the same action for a keyboard.
    <div className={classes} aria-current={selected ? 'true' : undefined} onClick={onOpen}>
      <div className="automations-template-body">
        <div className="automations-template-top">
          <ServiceTiles workspace={workspace} template={template} />
          <span className="automations-template-category">{template.category}</span>
        </div>
        <button type="button" className="automations-template-title" onClick={inside(onOpen)}>
          {template.title}
        </button>
        <p className="automations-template-description">{template.description}</p>
        {template.preview && <TemplateFacts preview={template.preview} />}
        {/* At the foot of the body, so every card in a row says it at the same height. */}
        <div className="automations-template-status" onClick={inside()}>
          {template.addedAs ? (
            <AddedAs name={template.addedAs} onOpen={() => onOpenAutomation(template.addedAs!)} />
          ) : (
            <SetupChecklist needs={template.needs} onFix={onFix} />
          )}
        </div>
      </div>
      <div className="automations-template-foot" onClick={inside()}>
        <div className="automations-template-actions">
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
              {adding ? 'Adding…' : 'Add'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Add, with the templates added since this view opened remembered, so the
 * one just added can say so once, as it lands.
 */
export function useTemplateAdd(workspaceId: string) {
  const { busy, error, act } = useIntent();
  const [justAdded, setJustAdded] = useState<ReadonlySet<string>>(() => new Set());
  const add = (id: string) =>
    void act(`add:${id}`, async () => {
      await automationsBridge.addTemplate(workspaceId, id);
      setJustAdded((previous) => new Set(previous).add(id));
    });
  return { busy, error, add, justAdded };
}

const SERVICES: Record<TemplateService, { label: string; Icon: LucideIcon }> = {
  github: { label: 'GitHub', Icon: Github },
  git: { label: 'Git', Icon: GitBranch },
  consola: { label: 'Consola', Icon: SquareTerminal },
};

/**
 * What a template works with, as tiles, as n8n's template cards show the
 * nodes a workflow uses. A prompt's agent runs on the workspace's own
 * harness, so that tile is this workspace's CLI rather than the template's.
 */
export function ServiceTiles({
  workspace,
  template,
  labelled = false,
}: {
  workspace: Workspace;
  template: TemplateView;
  /** Each tile with its name beside it, where there is room (the template's panel). */
  labelled?: boolean;
}) {
  const harness = useHarnessStore((state) =>
    state.harnesses.find((candidate) => candidate.id === workspace.defaultHarnessId)
  );
  const tiles: Array<{ key: string; label: string; icon: ReactNode }> = template.services.map((service) => {
    const { label, Icon } = SERVICES[service];
    return { key: service, label, icon: <Icon size={15} aria-hidden="true" /> };
  });
  if (template.preview?.kind === 'agent') {
    tiles.push({
      key: 'agent',
      label: harness?.name ?? 'Your agent CLI',
      icon: harness ? <HarnessIcon driverId={harness.driverId} decorative /> : <Bot size={15} aria-hidden="true" />,
    });
  }
  return (
    <ul className={`automations-services ${labelled ? 'automations-services-labelled' : ''}`} aria-label="Works with">
      {tiles.map((tile, index) => (
        <li
          key={tile.key}
          className="automations-service"
          title={labelled ? undefined : tile.label}
          style={{ '--order': index } as CSSProperties}
        >
          <span className="automations-service-tile">{tile.icon}</span>
          <span className={labelled ? 'automations-service-name' : 'sr-only'}>{tile.label}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The pipeline a template adds, in three lines and in its order: what fires
 * it, how it treats you, what runs. The same icons as the pipeline's nodes.
 */
export function TemplateFacts({ preview }: { preview: TemplatePreview }) {
  const TriggerIcon = preview.onEvent ? Inbox : Clock;
  const ModeIcon = preview.mode === 'notify' ? Bell : Hand;
  const isAgent = preview.kind === 'agent';
  return (
    <ul className="automations-template-facts">
      <li>
        <TriggerIcon size={13} aria-hidden="true" />
        <span className="sr-only">When: </span>
        <span className="automations-template-fact-text" title={preview.trigger}>
          {preview.trigger}
        </span>
        {preview.schedule && <code className="automations-cron">{preview.schedule}</code>}
      </li>
      <li>
        <ModeIcon size={13} aria-hidden="true" />
        <span className="sr-only">Asks: </span>
        <span className="automations-template-fact-text">{templateModeWords(preview.mode)}</span>
      </li>
      <li>
        {isAgent ? <Bot size={13} aria-hidden="true" /> : <Wrench size={13} aria-hidden="true" />}
        <span className="sr-only">Runs: </span>
        <span className="automations-template-fact-text">
          {isAgent ? (
            `${preview.runs}, in a read-only session`
          ) : (
            <code>{preview.target.split('#').pop()}</code>
          )}
        </span>
      </li>
    </ul>
  );
}

/**
 * What a template needs, each ticked when the workspace has it; one it
 * lacks is the way to get it, straight to that part of Workspace settings.
 */
export function SetupChecklist({
  needs,
  onFix,
  detailed = false,
}: {
  needs: TemplateNeed[];
  onFix: (section: TemplateNeedSection) => void;
  /**
   * Every need on its own line, as the template's panel lists them. A card's
   * foot is one line whatever the template needs, so cards in a row keep
   * their feet level: "Ready", or the first thing to do and how many more.
   */
  detailed?: boolean;
}) {
  if (needs.length === 0 || (!detailed && needs.every((need) => need.met))) {
    return (
      <p
        className={`automations-setup automations-setup-none ${detailed ? 'automations-setup-detailed' : ''}`}
        title={needs.length > 0 ? needs.map((need) => `${need.label}: set up`).join('\n') : undefined}
      >
        <Check size={13} aria-hidden="true" />
        {needs.length === 0 ? 'No setup needed' : 'Ready to add'}
      </p>
    );
  }
  if (!detailed) {
    const unmet = needs.filter((need) => !need.met);
    const [first] = unmet;
    return (
      <p className="automations-setup automations-setup-unmet">
        <CircleDashed size={13} aria-hidden="true" />
        <button type="button" className="automations-setup-fix" onClick={() => onFix(first.fix.section)}>
          {first.fix.label}
          <ArrowRight size={12} aria-hidden="true" />
        </button>
        {unmet.length > 1 && (
          <span className="automations-setup-more" title={unmet.slice(1).map((need) => need.fix.label).join('\n')}>
            +{unmet.length - 1} more
          </span>
        )}
      </p>
    );
  }
  return (
    <ul className={`automations-setup ${detailed ? 'automations-setup-detailed' : ''}`} aria-label="Setup">
      {needs.map((need) => (
        <li key={need.label} className={need.met ? 'automations-setup-met' : 'automations-setup-unmet'}>
          {need.met ? <CircleCheck size={13} aria-hidden="true" /> : <CircleDashed size={13} aria-hidden="true" />}
          {need.met ? (
            <span>
              {need.label}
              <span className="sr-only">: set up</span>
            </span>
          ) : (
            <button type="button" className="automations-setup-fix" onClick={() => onFix(need.fix.section)}>
              {need.fix.label}
              <ArrowRight size={12} aria-hidden="true" />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** A template already in the file, by the entry that does it; opens that automation. */
function AddedAs({ name, onOpen }: { name: string; onOpen: () => void }) {
  return (
    <button type="button" className="automations-added-as" onClick={onOpen}>
      <CircleCheck size={14} className="automations-added-check" aria-hidden="true" />
      <span>
        Added as <span className="automations-added-name">{name}</span>
      </span>
      <ArrowRight size={12} className="automations-added-arrow" aria-hidden="true" />
    </button>
  );
}

/**
 * A workspace with nothing in factory.yml yet: what automations are, the
 * way to write one, and the templates to start from. Shared by an empty
 * Activity and an empty Automations tab.
 */
export function GetStarted({ workspace, snapshot }: { workspace: Workspace; snapshot: AutomationsSnapshot }) {
  const openPanel = useAutomationsStore((state) => state.openPanel);
  return (
    <div className="automations-empty-state">
      <Zap size={20} className="automations-empty-icon" aria-hidden="true" />
      <p className="automations-empty-lede">
        Automations work in this workspace without you: on a schedule, or when a pull request asks for your review.
        Each runs a prompt, one of your actions or a Consola tool, and can ask you before it acts.
      </p>
      <div className="automations-empty-actions">
        <button type="button" className="dialog-button-primary" onClick={() => openPanel({ kind: 'new' })}>
          New automation
        </button>
      </div>
      <TemplateCards workspace={workspace} snapshot={snapshot} />
    </div>
  );
}

export function TemplatesTab({ workspace, snapshot }: { workspace: Workspace; snapshot: AutomationsSnapshot }) {
  return (
    <div className="automations-activity">
      <TemplateCards workspace={workspace} snapshot={snapshot} intro />
    </div>
  );
}
