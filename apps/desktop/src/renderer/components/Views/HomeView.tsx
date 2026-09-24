import { useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Folder, FolderPlus, GitBranch, Layers, Loader2, SquareTerminal, X } from 'lucide-react';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { isSelectableHarness, useHarnessStore } from '../../stores/harnessStore';
import { useSettings } from '../../contexts/SettingsContext';
import { dialogBridge } from '../../services/dialogBridge';
import { createWorkspaceFromFolders } from '../../utils/workspaceActions';
import { isMac } from '../../utils/platform';
import type { FolderInfo } from '../../types/electron';
import './styles.css';

/**
 * The three nouns everything else is built from. Taught once, here, because
 * the rest of the app assumes them: the rail lists workspaces, the sidebar
 * filters by scope, and every pane is a session.
 */
const CONCEPTS = [
  {
    icon: Layers,
    term: 'Workspace',
    text: 'One project or area of work, with its own place in the rail and its own sessions.',
  },
  {
    icon: Folder,
    term: 'Scope',
    text: 'A folder inside a workspace. Put a frontend and a backend repo in one workspace, and choose which one each session runs in.',
  },
  {
    icon: SquareTerminal,
    term: 'Session',
    text: 'A Claude Code conversation in one scope. It keeps working while you look elsewhere.',
  },
];

export function HomeView() {
  const hasWorkspaces = useWorkspaceStore((state) => state.workspaces.length > 0);

  return (
    <div className="home-view">
      <div className="home-view-content">
        <img className="home-view-icon" src="./icon.svg" width={56} height={56} alt="" />
        <h1 className="home-view-title">{hasWorkspaces ? 'Open a workspace' : 'Welcome to Consola'}</h1>
        <p className="home-view-description">
          {hasWorkspaces
            ? 'Pick one from the rail on the left, or set up a new one.'
            : 'Run Claude Code across your projects: organized, side by side, and always running.'}
        </p>
        <WorkspaceSetup intro={!hasWorkspaces && (
          <>
            <dl className="home-concepts">
              {CONCEPTS.map(({ icon: Icon, term, text }) => (
                <div key={term} className="home-concept">
                  <dt><Icon size={16} aria-hidden="true" />{term}</dt>
                  <dd>{text}</dd>
                </div>
              ))}
            </dl>
            <AgentCheck />
          </>
        )} />
      </div>
    </div>
  );
}

/**
 * Whether the agent a first session would launch is actually there.
 *
 * Informational, never a gate: the session terminal shows the CLI's own
 * error just as well, but finding out here saves a confusing first run.
 */
function AgentCheck() {
  const harness = useHarnessStore((state) => state.harnesses.find((candidate) => candidate.isBuiltIn) ?? state.harnesses.find(isSelectableHarness));
  const status = useHarnessStore((state) => (harness ? state.statuses[harness.id] : undefined));
  const probeHarness = useHarnessStore((state) => state.probeHarness);
  const { openSettings } = useSettings();

  useEffect(() => {
    if (harness && !status) void probeHarness(harness.id);
  }, [harness, status, probeHarness]);

  if (!harness) return null;

  const state = status?.state ?? 'probing';
  const signedInAs = status?.account?.emailAddress ?? status?.account?.displayName;
  let message: string;
  if (state === 'ok') {
    message = signedInAs
      ? `${harness.name} is ready${status?.version ? ` (${status.version})` : ''}. Signed in as ${signedInAs}.`
      : `${harness.name} is installed. Your first session will ask you to sign in.`;
  } else if (state === 'error') {
    message = `${harness.name} was not found. Install it, then check again. Consola runs the CLI you already use.`;
  } else {
    message = `Looking for ${harness.name}…`;
  }

  return (
    <div className={`home-agent-check home-agent-check-${state}`} role="status">
      {state === 'ok' ? <CheckCircle2 size={16} /> : state === 'error' ? <AlertCircle size={16} /> : <Loader2 size={16} className="home-spinner" />}
      <span>{message}</span>
      {state === 'error' && (
        <span className="home-agent-actions">
          <button type="button" className="home-link-button" onClick={() => void probeHarness(harness.id)}>Check again</button>
          <button type="button" className="home-link-button" onClick={openSettings}>Agent settings</button>
        </span>
      )}
    </div>
  );
}

/**
 * Pick folders, review them as scopes, name the workspace, create it.
 *
 * Reviewing before creating is the point: it is the one moment a new user
 * sees that a workspace can hold several folders, and that each becomes a
 * scope. The quick door (the rail's ＋, ⌘N) skips straight to creation.
 *
 * The intro gives way once folders are picked: by then the scope list says
 * the same thing concretely, and the form needs the room.
 */
function WorkspaceSetup({ intro }: { intro: ReactNode }) {
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [name, setName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState('');

  const addFolders = async () => {
    const picked = await dialogBridge.selectFolders();
    if (!picked.length) return;
    setError('');
    const next = [...folders, ...picked.filter((folder) => !folders.some((existing) => existing.path === folder.path))];
    setFolders(next);
    if (!name.trim()) setName(next[0].name);
  };

  // The suggested name follows the first folder until someone types their own.
  const removeFolder = (path: string) => {
    const next = folders.filter((folder) => folder.path !== path);
    if (name === folders[0]?.name) setName(next[0]?.name ?? '');
    setFolders(next);
  };

  const create = async () => {
    if (!folders.length || isCreating) return;
    setIsCreating(true);
    setError('');
    try {
      await createWorkspaceFromFolders(folders, name);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setIsCreating(false);
    }
  };

  if (!folders.length) {
    return (
      <>
      {intro}
      <div className="home-setup-start">
        <button type="button" className="home-view-button" onClick={() => void addFolders()}>
          <FolderPlus size={18} />
          <span>Choose project folders</span>
        </button>
        <p className="home-view-shortcut">
          Choose one or more. Each folder becomes a scope. <kbd>{isMac ? '⌘' : 'Ctrl'}</kbd><kbd>N</kbd> also works.
        </p>
      </div>
      </>
    );
  }

  return (
    <form className="home-setup" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <label className="home-setup-label" htmlFor="home-workspace-name">Workspace name</label>
      <input id="home-workspace-name" className="home-setup-input" value={name} onChange={(event) => setName(event.target.value)}
        placeholder="e.g. Checkout redesign" disabled={isCreating} autoFocus />
      <div className="home-setup-label" id="home-scopes-label">Scopes</div>
      <ul className="home-setup-scopes" aria-labelledby="home-scopes-label">
        {folders.map((folder) => (
          <li key={folder.path} className="home-setup-scope">
            {folder.isGitRepo ? <GitBranch size={14} aria-label="Git repository" /> : <Folder size={14} aria-label="Folder" />}
            <span className="home-setup-scope-text"><span>{folder.name}</span><small title={folder.path}>{folder.path}</small></span>
            <button type="button" className="home-setup-remove" aria-label={`Remove ${folder.name}`} onClick={() => removeFolder(folder.path)} disabled={isCreating}>
              <X size={14} />
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="home-link-button home-setup-add" onClick={() => void addFolders()} disabled={isCreating}>
        <FolderPlus size={14} /> Add another folder
      </button>
      <p className="home-setup-hint">You can add, rename and remove scopes later in workspace settings.</p>
      {error && <p className="home-setup-error" role="alert">{error}</p>}
      <button type="submit" className="home-view-button home-setup-submit" disabled={isCreating || !name.trim()}>
        {isCreating ? 'Creating…' : 'Create workspace'}
      </button>
    </form>
  );
}
