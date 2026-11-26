import { useId, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowRight,
  Cloud,
  Folder,
  FolderPlus,
  GitBranch,
  Home,
  Inbox,
  Laptop,
  Plus,
  Search,
  X,
  Zap,
} from 'lucide-react';
import { WorkspaceIcon } from '../WorkspaceIcon';
import { dialogBridge } from '../../services/dialogBridge';
import { useNewWorkspaceDialogStore } from '../../stores/newWorkspaceDialogStore';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import {
  NEW_WORKSPACE_STEPS,
  WORKSPACE_LOCATIONS,
  canContinue,
  emptyDraft,
  mergeFolders,
} from '../../utils/newWorkspaceDraft';
import type {
  NewWorkspaceDraft,
  NewWorkspaceStep,
  WorkspaceLocation,
} from '../../utils/newWorkspaceDraft';
import { isMac } from '../../utils/platform';
import { createWorkspaceFromFolders } from '../../utils/workspaceActions';
import type { FolderInfo } from '../../types/electron';
import './styles.css';
import './new-workspace-dialog.css';

/** How many of the person's other workspaces the preview's rail shows above the new one. */
const PREVIEW_RAIL_OTHERS = 3;

/**
 * Making a workspace, one question at a time: where it runs, its name, its
 * folders. The picture beside the questions is the app as it will look, so
 * each answer shows up where it will live (the rail, the title bar, the
 * sidebar's scopes) before anything is made.
 */
export function NewWorkspaceDialog() {
  const openedAt = useNewWorkspaceDialogStore((state) => state.openedAt);
  const close = useNewWorkspaceDialogStore((state) => state.close);
  if (!openedAt) return null;
  return <NewWorkspaceFlow key={openedAt} onClose={close} />;
}

function NewWorkspaceFlow({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<NewWorkspaceStep>('location');
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const [draft, setDraft] = useState<NewWorkspaceDraft>(emptyDraft);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const creatingRef = useRef(false);

  const index = NEW_WORKSPACE_STEPS.indexOf(step);
  const isLast = index === NEW_WORKSPACE_STEPS.length - 1;
  const ready = canContinue(step, draft);

  const goTo = (next: number) => {
    setDirection(next > index ? 'forward' : 'back');
    setStep(NEW_WORKSPACE_STEPS[next]);
    setError('');
  };

  const addFolders = async () => {
    let picked: FolderInfo[];
    try {
      picked = await dialogBridge.selectFolders();
    } catch (reason) {
      setError(
        `Could not open the folder picker: ${reason instanceof Error ? reason.message : String(reason)}`,
      );
      return;
    }
    if (!picked.length) return;
    setError('');
    setDraft((current) => ({ ...current, folders: mergeFolders(current.folders, picked) }));
  };

  const removeFolder = (path: string) =>
    setDraft((current) => ({
      ...current,
      folders: current.folders.filter((folder) => folder.path !== path),
    }));

  const create = async () => {
    if (creatingRef.current || !canContinue('folders', draft)) return;
    creatingRef.current = true;
    setCreating(true);
    setError('');
    try {
      await createWorkspaceFromFolders(draft.folders, draft.name);
      onClose();
    } catch (reason) {
      creatingRef.current = false;
      setCreating(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready || creating) return;
    if (isLast) void create();
    else goTo(index + 1);
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        // Half-made is not a state a workspace can be left in.
        if (!open && !creatingRef.current) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content new-workspace-dialog">
          <Dialog.Title className="sr-only">New workspace</Dialog.Title>
          <form className="nw-form" onSubmit={submit} noValidate>
            <div
              className="nw-progress"
              role="progressbar"
              aria-label="Workspace setup"
              aria-valuemin={1}
              aria-valuemax={NEW_WORKSPACE_STEPS.length}
              aria-valuenow={index + 1}
              aria-valuetext={`Step ${index + 1} of ${NEW_WORKSPACE_STEPS.length}`}
            >
              {NEW_WORKSPACE_STEPS.map((name, position) => (
                <span
                  key={name}
                  data-state={position < index ? 'done' : position === index ? 'current' : 'next'}
                />
              ))}
            </div>

            <div key={step} className="nw-step" data-direction={direction}>
              {step === 'location' && (
                <LocationStep
                  location={draft.location}
                  onChange={(location) => setDraft((current) => ({ ...current, location }))}
                />
              )}
              {step === 'name' && (
                <NameStep
                  name={draft.name}
                  onChange={(name) => setDraft((current) => ({ ...current, name }))}
                />
              )}
              {step === 'folders' && (
                <FoldersStep
                  folders={draft.folders}
                  disabled={creating}
                  onAdd={() => void addFolders()}
                  onRemove={removeFolder}
                />
              )}
            </div>

            {error && (
              <p className="nw-error" role="alert">
                {error}
              </p>
            )}

            <div className="nw-actions">
              <button
                type="submit"
                className="dialog-button-primary nw-next"
                disabled={!ready || creating}
              >
                {isLast ? (creating ? 'Creating…' : 'Create workspace') : 'Next'}
                {!isLast && <ArrowRight size={14} aria-hidden="true" className="nw-next-arrow" />}
              </button>
              {index > 0 && (
                <button
                  type="button"
                  className="nw-back"
                  onClick={() => goTo(index - 1)}
                  disabled={creating}
                >
                  Back
                </button>
              )}
            </div>
          </form>

          <WorkspacePreview draft={draft} step={step} />

          <Dialog.Close asChild>
            <button type="button" className="dialog-close nw-close" aria-label="Close">
              <X size={16} />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function StepHeading({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h2 className="nw-title">{title}</h2>
      <Dialog.Description className="nw-lede">{children}</Dialog.Description>
    </>
  );
}

const LOCATION_COPY: Record<
  WorkspaceLocation,
  { name: string; icon: typeof Laptop; detail: string }
> = {
  local: {
    name: 'Local',
    icon: Laptop,
    detail: 'Sessions run on your computer, in folders you choose.',
  },
  cloud: {
    name: 'Cloud',
    icon: Cloud,
    // Not "everything runs remotely": local sessions stay, and the cloud adds
    // the team on top of them.
    detail:
      'For working with your team: shared factories and automations, long runs in the cloud, and colleagues invited into sessions on your computer.',
  },
};

function LocationStep({
  location,
  onChange,
}: {
  location: WorkspaceLocation;
  onChange: (location: WorkspaceLocation) => void;
}) {
  const name = useId();
  return (
    <>
      <StepHeading title="Where will this workspace run?">
        A workspace keeps one project’s folders and sessions together, with its own place in the
        rail.
      </StepHeading>
      <div
        className="nw-locations"
        role="radiogroup"
        aria-label="Where it runs"
        // Enter answers the question, as it does in the name field: a radio
        // is not a field the browser submits its form from.
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          event.currentTarget.closest('form')?.requestSubmit();
        }}
      >
        {WORKSPACE_LOCATIONS.map(({ id, available }) => {
          const copy = LOCATION_COPY[id];
          const Icon = copy.icon;
          return (
            <label
              key={id}
              className="nw-location"
              data-checked={location === id ? '' : undefined}
              data-disabled={available ? undefined : ''}
            >
              <input
                type="radio"
                className="nw-location-input"
                name={name}
                value={id}
                checked={location === id}
                disabled={!available}
                onChange={() => onChange(id)}
                autoFocus={location === id}
              />
              <span className="nw-location-icon">
                <Icon size={18} aria-hidden="true" />
              </span>
              <span className="nw-location-copy">
                <span className="nw-location-name">
                  {copy.name}
                  {!available && <span className="nw-badge">Coming soon</span>}
                </span>
                <span className="nw-location-detail">{copy.detail}</span>
              </span>
              <span className="nw-location-mark" aria-hidden="true" />
            </label>
          );
        })}
      </div>
    </>
  );
}

function NameStep({ name, onChange }: { name: string; onChange: (name: string) => void }) {
  const inputId = useId();
  return (
    <>
      <StepHeading title="Name your workspace">
        Something you’ll recognise in the rail, like the project or the area of work. You can change
        it later.
      </StepHeading>
      <label className="sr-only" htmlFor={inputId}>
        Workspace name
      </label>
      <input
        id={inputId}
        className="nw-input"
        value={name}
        onChange={(event) => onChange(event.target.value)}
        placeholder="e.g. Checkout redesign"
        autoComplete="off"
        spellCheck={false}
        autoFocus
      />
    </>
  );
}

function FoldersStep({
  folders,
  disabled,
  onAdd,
  onRemove,
}: {
  folders: FolderInfo[];
  disabled: boolean;
  onAdd: () => void;
  onRemove: (path: string) => void;
}) {
  const listLabel = useId();
  return (
    <>
      <StepHeading title="Choose its folders">
        Each folder becomes a scope, a place its sessions can run. A frontend and a backend can
        share one workspace.
      </StepHeading>
      {folders.length === 0 ? (
        <button type="button" className="nw-drop" onClick={onAdd} disabled={disabled} autoFocus>
          <FolderPlus size={18} aria-hidden="true" />
          <span className="nw-drop-copy">
            <span className="nw-drop-title">Choose folders…</span>
            <span className="nw-drop-hint">One or more, repositories or plain folders.</span>
          </span>
        </button>
      ) : (
        <>
          <span id={listLabel} className="sr-only">
            Scopes
          </span>
          <ul className="nw-folders" aria-labelledby={listLabel}>
            {folders.map((folder) => (
              <li key={folder.path} className="nw-folder">
                {folder.isGitRepo ? (
                  <GitBranch size={14} aria-label="Git repository" />
                ) : (
                  <Folder size={14} aria-label="Folder" />
                )}
                <span className="nw-folder-text">
                  <span className="nw-folder-name">{folder.name}</span>
                  <small title={folder.path}>{folder.path}</small>
                </span>
                <button
                  type="button"
                  className="nw-folder-remove"
                  aria-label={`Remove ${folder.name}`}
                  onClick={() => onRemove(folder.path)}
                  disabled={disabled}
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="nw-add" onClick={onAdd} disabled={disabled} autoFocus>
            <FolderPlus size={14} aria-hidden="true" /> Add another folder
          </button>
        </>
      )}
    </>
  );
}

/**
 * A small Consola, drawn from the app's own surfaces and the person's own
 * rail, that fills in as they answer. Decorative: everything it shows is
 * already said by the form beside it.
 */
function WorkspacePreview({ draft, step }: { draft: NewWorkspaceDraft; step: NewWorkspaceStep }) {
  const others = useWorkspaceStore((state) => state.workspaces).slice(0, PREVIEW_RAIL_OTHERS);
  const name = draft.name.trim();
  const icon = name ? (
    <WorkspaceIcon name={name} size={22} borderRadius={6} />
  ) : (
    <span className="nw-app-icon-empty" />
  );
  return (
    <div className="nw-preview" aria-hidden="true">
      <div className="nw-app" data-step={step}>
        <div className="nw-app-titlebar">
          {isMac && (
            <span className="nw-app-lights">
              <i />
              <i />
              <i />
            </span>
          )}
          <span className="nw-app-menu" data-focus={step === 'name' ? '' : undefined}>
            {name ? (
              <WorkspaceIcon name={name} size={12} borderRadius={3} />
            ) : (
              <span className="nw-app-icon-empty nw-app-icon-empty-sm" />
            )}
            <span className="nw-app-menu-name" data-empty={name ? undefined : ''}>
              {name || 'Your workspace'}
            </span>
          </span>
        </div>
        <div className="nw-app-rail">
          {others.map((workspace) => (
            <span key={workspace.id} className="nw-app-rail-item">
              <WorkspaceIcon
                icon={workspace.icon}
                name={workspace.name}
                size={22}
                borderRadius={6}
              />
            </span>
          ))}
          <span
            className="nw-app-rail-item nw-app-rail-current"
            data-focus={step === 'name' ? '' : undefined}
          >
            {icon}
          </span>
          <Plus size={14} className="nw-app-rail-add" />
        </div>
        <div className="nw-app-sidebar">
          <div className="nw-app-search">
            <Search size={10} />
            <span>Search</span>
          </div>
          <div className="nw-app-nav">
            <span className="nw-app-nav-item nw-app-nav-active">
              <Home size={11} />
              Home
            </span>
            <span className="nw-app-nav-item">
              <Inbox size={11} />
            </span>
          </div>
          <div className="nw-app-row">
            <Zap size={11} />
            Automations
          </div>
          <hr className="nw-app-divider" />
          <div className="nw-app-scopes" data-focus={step === 'folders' ? '' : undefined}>
            <div className="nw-app-heading">Scopes</div>
            {draft.folders.length > 0 ? (
              draft.folders.map((folder) => (
                <div key={folder.path} className="nw-app-row nw-app-scope">
                  {folder.isGitRepo ? <GitBranch size={11} /> : <Folder size={11} />}
                  <span>{folder.name}</span>
                </div>
              ))
            ) : (
              <>
                <span className="nw-app-ghost" />
                <span className="nw-app-ghost nw-app-ghost-short" />
              </>
            )}
          </div>
        </div>
        <div className="nw-app-content">
          <div className="nw-app-title" data-empty={name ? undefined : ''}>
            {name || 'Your workspace'}
          </div>
          <div className="nw-app-composer">
            <span>Start a session…</span>
          </div>
        </div>
      </div>
    </div>
  );
}
