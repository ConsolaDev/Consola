import { useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { INBOX_SECTIONS, sectionItemType, type InboxSection } from '../../../shared/inboxSections';
import { PROVIDER_META } from '../../../shared/providers';
import {
  createDefaultActions,
  createDefaultSectionDefaults,
  type WorkItemAction,
} from '../../../shared/workItemActions';
import { generateId } from '../../../shared/ids';
import { useWorkspaceStore, type Workspace } from '../../stores/workspaceStore';
import { ConfirmDialog } from '../Dialogs/ConfirmDialog';

export interface ActionsPanelProps {
  workspace: Workspace;
}

type ItemType = WorkItemAction['appliesTo'][number];
type SectionDefaults = Workspace['sectionDefaults'];

interface Draft {
  name: string;
  appliesTo: ItemType[];
  prompt: string;
}

interface Editing {
  id: string;
  draft: Draft;
  isNew: boolean;
}

const PLACEHOLDERS = '{{number}} {{repo}} {{title}} {{url}} {{type}}';

const APPLIES_LABELS: Record<ItemType, string> = { pr: 'Pull requests', issue: 'Issues' };

function appliesSummary(appliesTo: ItemType[]): string {
  return appliesTo.map((type) => (type === 'pr' ? 'PRs' : 'Issues')).join(' · ');
}

/** What is wrong with a draft, or null when it can be saved. Mirrors main's rules. */
function draftProblem(draft: Draft): string | null {
  if (!draft.name.trim()) return 'An action needs a name.';
  if (draft.appliesTo.length === 0) return 'Pick at least one of pull requests and issues.';
  if (!draft.prompt.trim()) return 'An action needs a prompt.';
  return null;
}

function moveWithin<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * The workspace's actions: what you can start on an Inbox item.
 *
 * Every mutation is one validated write of `actions` plus `sectionDefaults`
 * through workspace:set-actions — there is no per-action CRUD — so the
 * panel edits a draft locally and commits whole lists. Main's rejection is
 * shown inline and the panel keeps what is on disk. Sessions are never
 * touched: they hold a name snapshot, so renaming or deleting an action
 * changes nothing about what a past session was.
 */
export function ActionsPanel({ workspace }: ActionsPanelProps) {
  const setActions = useWorkspaceStore((state) => state.setActions);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  // One write in flight at a time: without this, a double-click on Move
  // up/down, Save or Delete would fire two commits against the same
  // not-yet-refreshed `workspace.actions`, racing each other. Mirrors
  // ConfirmDialog's own isConfirming guard.
  const [busy, setBusy] = useState(false);

  const provider = workspace.provider;
  if (!provider) {
    return (
      <section className="ws-panel" data-testid="actions-panel">
        <div className="ws-panel-header">
          <h3 className="ws-panel-title">Actions</h3>
        </div>
        <p className="ws-panel-hint">
          Actions become available once a provider account is bound in the Provider section.
        </p>
      </section>
    );
  }
  const providerName = PROVIDER_META[provider.id].displayName;
  const headerTemplates = PROVIDER_META[provider.id].seedHeaderTemplate;
  const actions = workspace.actions;
  const defaults = workspace.sectionDefaults;

  // Returns the rejection message, or null on success. A plain return value
  // rather than thrown/caught state: restoreDefaults needs the message
  // synchronously, in the same tick, to decide whether to throw it onward to
  // ConfirmDialog — `error` state set here would still read as last
  // render's value at that point, since React state isn't synchronous.
  const writeActions = async (
    nextActions: WorkItemAction[],
    nextDefaults: SectionDefaults
  ): Promise<string | null> => {
    try {
      await setActions(workspace.id, nextActions, nextDefaults);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  const commit = async (nextActions: WorkItemAction[], nextDefaults: SectionDefaults) => {
    setBusy(true);
    try {
      const message = await writeActions(nextActions, nextDefaults);
      // The whole write was rejected; disk is unchanged, so is the list.
      setError(message);
      return message === null;
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (action: WorkItemAction) =>
    setEditing({
      id: action.id,
      draft: { name: action.name, appliesTo: [...action.appliesTo], prompt: action.prompt },
      isNew: false,
    });

  const startAdd = () =>
    setEditing({
      id: generateId(),
      draft: { name: '', appliesTo: ['pr'], prompt: '' },
      isNew: true,
    });

  const updateDraft = (patch: Partial<Draft>) =>
    setEditing((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current));

  const toggleApplies = (type: ItemType) =>
    setEditing((current) => {
      if (!current) return current;
      const has = current.draft.appliesTo.includes(type);
      const appliesTo = has
        ? current.draft.appliesTo.filter((candidate) => candidate !== type)
        : [...current.draft.appliesTo, type];
      return { ...current, draft: { ...current.draft, appliesTo } };
    });

  const saveEdit = async () => {
    if (!editing) return;
    const problem = draftProblem(editing.draft);
    if (problem) {
      setError(problem);
      return;
    }
    const record: WorkItemAction = {
      id: editing.id,
      name: editing.draft.name.trim(),
      appliesTo: editing.draft.appliesTo,
      prompt: editing.draft.prompt,
    };
    const nextActions = editing.isNew
      ? [...actions, record]
      : actions.map((action) => (action.id === record.id ? record : action));
    if (await commit(nextActions, defaults)) setEditing(null);
  };

  const deleteAction = async (id: string) => {
    // A default pointing at a deleted action would dangle; clear it in the
    // same write so main never sees the inconsistent pair.
    const nextDefaults: SectionDefaults = {};
    for (const [section, actionId] of Object.entries(defaults) as [InboxSection, string][]) {
      if (actionId !== id) nextDefaults[section] = actionId;
    }
    const ok = await commit(
      actions.filter((action) => action.id !== id),
      nextDefaults
    );
    if (ok) setEditing(null);
  };

  const reorder = (fromId: string, toId: string) => {
    const from = actions.findIndex((action) => action.id === fromId);
    const to = actions.findIndex((action) => action.id === toId);
    const next = moveWithin(actions, from, to);
    if (next !== actions) void commit(next, defaults);
  };

  const nudge = (id: string, delta: -1 | 1) => {
    const from = actions.findIndex((action) => action.id === id);
    const next = moveWithin(actions, from, from + delta);
    if (next !== actions) void commit(next, defaults);
  };

  const setDefault = (section: InboxSection, actionId: string) => {
    const nextDefaults: SectionDefaults = { ...defaults };
    if (actionId) {
      nextDefaults[section] = actionId;
    } else {
      delete nextDefaults[section];
    }
    void commit(actions, nextDefaults);
  };

  const restoreDefaults = async () => {
    const fresh = createDefaultActions();
    const message = await writeActions(fresh, createDefaultSectionDefaults(fresh));
    if (message) {
      // Thrown rather than routed through the panel's `error` state:
      // ConfirmDialog catches this itself and shows it once, in the dialog
      // it came from. Setting panel state here too would show the same
      // rejection twice, since the dialog's render already reflects the
      // throw before this component's next render would show the state.
      throw new Error(message);
    }
    setError(null);
    setEditing(null);
  };

  const renderEditor = (current: Editing) => {
    const headerType: ItemType = current.draft.appliesTo.includes('pr') ? 'pr' : 'issue';
    return (
      <div className="ws-action-edit" key={current.id} data-action-id={current.id}>
        <div className="ws-field">
          <label className="ws-field-label" htmlFor={`action-name-${current.id}`}>
            Name
          </label>
          <input
            id={`action-name-${current.id}`}
            className="dialog-input ws-input"
            aria-label="Action name"
            value={current.draft.name}
            onChange={(event) => updateDraft({ name: event.target.value })}
            autoFocus
          />
        </div>
        <div className="ws-field">
          <span className="ws-field-label">Applies to</span>
          <div className="ws-chips">
            {(['pr', 'issue'] as ItemType[]).map((type) => {
              const on = current.draft.appliesTo.includes(type);
              return (
                <button
                  type="button"
                  key={type}
                  className={`ws-chip ${on ? 'on' : ''}`}
                  aria-pressed={on}
                  onClick={() => toggleApplies(type)}
                >
                  {APPLIES_LABELS[type]}
                </button>
              );
            })}
          </div>
        </div>
        <div className="ws-field">
          <span className="ws-field-label">Context header · sent first by {providerName}</span>
          {/* Raw template on purpose: the editor shows what is stored, and
              the placeholders are what the body may use too. */}
          <pre className="ws-action-header">{headerTemplates[headerType]}</pre>
        </div>
        <div className="ws-field">
          <label className="ws-field-label" htmlFor={`action-prompt-${current.id}`}>
            Prompt
          </label>
          <textarea
            id={`action-prompt-${current.id}`}
            className="dialog-input ws-textarea"
            aria-label="Action prompt"
            rows={4}
            value={current.draft.prompt}
            onChange={(event) => updateDraft({ prompt: event.target.value })}
            placeholder="A short job for the agent, or a bare slash command such as /security-review"
          />
        </div>
        <div className="ws-action-edit-actions">
          {!current.isNew && (
            <button
              type="button"
              className="dialog-button-secondary ws-panel-action ws-action-delete"
              onClick={() => void deleteAction(current.id)}
              disabled={busy}
            >
              <Trash2 size={13} />
              Delete
            </button>
          )}
          <span className="ws-action-edit-spacer" />
          <button
            type="button"
            className="dialog-button-secondary ws-panel-action"
            onClick={() => {
              setEditing(null);
              setError(null);
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="dialog-button-primary ws-panel-action"
            onClick={() => void saveEdit()}
            disabled={busy}
          >
            Save
          </button>
        </div>
      </div>
    );
  };

  return (
    <section className="ws-panel" data-testid="actions-panel">
      <div className="ws-panel-header">
        <h3 className="ws-panel-title">Actions</h3>
        <div className="ws-action-toolbar">
          <button
            type="button"
            className="dialog-button-secondary ws-panel-action"
            onClick={() => setConfirmingRestore(true)}
          >
            <RotateCcw size={13} />
            Restore defaults
          </button>
          <button
            type="button"
            className="dialog-button-secondary ws-panel-action"
            onClick={startAdd}
            disabled={editing !== null || busy}
          >
            <Plus size={14} />
            Add action
          </button>
        </div>
      </div>
      <p className="ws-panel-hint">
        What you can start on an Inbox item. The section default is the highlighted button in the
        detail pane; drag to reorder. Placeholders: <code>{PLACEHOLDERS}</code>.
      </p>

      <div className="ws-row-list">
        {actions.map((action, index) => {
          if (editing && !editing.isNew && editing.id === action.id) return renderEditor(editing);
          return (
            <div
              key={action.id}
              className={`ws-row ws-action-row ${dragId === action.id ? 'dragging' : ''} ${
                overId === action.id && dragId !== action.id ? 'drop-target' : ''
              }`}
              data-action-id={action.id}
              draggable={editing === null && !busy}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                setDragId(action.id);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                if (overId !== action.id) setOverId(action.id);
              }}
              onDragLeave={() => setOverId(null)}
              onDrop={(event) => {
                event.preventDefault();
                if (dragId) reorder(dragId, action.id);
                setDragId(null);
                setOverId(null);
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
            >
              <span className="ws-row-icon ws-action-grip" aria-hidden="true">
                <GripVertical size={13} />
              </span>
              <span className="ws-row-name ws-action-name">{action.name}</span>
              <span className="ws-row-chip">{appliesSummary(action.appliesTo)}</span>
              <span className="ws-row-path ws-action-preview" title={action.prompt}>
                {action.prompt}
              </span>
              <button
                type="button"
                className="ws-row-action"
                onClick={() => nudge(action.id, -1)}
                disabled={index === 0 || editing !== null || busy}
                aria-label={`Move ${action.name} up`}
                title="Move up"
              >
                <ArrowUp size={13} />
              </button>
              <button
                type="button"
                className="ws-row-action"
                onClick={() => nudge(action.id, 1)}
                disabled={index === actions.length - 1 || editing !== null || busy}
                aria-label={`Move ${action.name} down`}
                title="Move down"
              >
                <ArrowDown size={13} />
              </button>
              <button
                type="button"
                className="ws-row-action"
                onClick={() => startEdit(action)}
                disabled={editing !== null || busy}
                aria-label={`Edit ${action.name}`}
                title="Edit"
              >
                <Pencil size={13} />
              </button>
            </div>
          );
        })}
        {editing?.isNew && renderEditor(editing)}
        {actions.length === 0 && !editing && (
          <p className="ws-panel-hint">No actions. Add one, or restore the defaults.</p>
        )}
      </div>

      {error && <span className="dialog-error">{error}</span>}

      <div className="ws-archived-heading">Default per Inbox section</div>
      <div className="ws-defaults-grid">
        {INBOX_SECTIONS.map((section) => {
          const type = sectionItemType(section.id);
          const options = actions.filter((action) => action.appliesTo.includes(type));
          return (
            <label className="ws-default-row" key={section.id}>
              <span>{section.label}</span>
              <select
                className="ws-select"
                value={defaults[section.id] ?? ''}
                onChange={(event) => setDefault(section.id, event.target.value)}
                aria-label={`Default action for ${section.label}`}
                disabled={busy}
              >
                <option value="">None</option>
                {options.map((action) => (
                  <option key={action.id} value={action.id}>
                    {action.name}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>

      <ConfirmDialog
        open={confirmingRestore}
        onOpenChange={setConfirmingRestore}
        title="Restore the default actions?"
        description="Replaces every action and section default with the built-in set. Sessions already started keep the names they were started with."
        confirmLabel="Restore defaults"
        onConfirm={restoreDefaults}
      />
    </section>
  );
}
