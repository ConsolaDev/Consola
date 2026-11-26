import { useEffect } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Folder,
  Layers,
  Loader2,
  Plus,
  SquareTerminal,
} from 'lucide-react';
import { useWorkspaceStore } from '../../stores/workspaceStore';
import { isSelectableHarness, useHarnessStore } from '../../stores/harnessStore';
import { useSettings } from '../../contexts/SettingsContext';
import { openNewWorkspaceDialog } from '../../stores/newWorkspaceDialogStore';
import { isMac } from '../../utils/platform';
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
        <h1 className="home-view-title">
          {hasWorkspaces ? 'Open a workspace' : 'Welcome to Consola'}
        </h1>
        <p className="home-view-description">
          {hasWorkspaces
            ? 'Pick one from the rail on the left, or set up a new one.'
            : 'Run Claude Code across your projects: organized, side by side, and always running.'}
        </p>
        {!hasWorkspaces && (
          <>
            <dl className="home-concepts">
              {CONCEPTS.map(({ icon: Icon, term, text }) => (
                <div key={term} className="home-concept">
                  <dt>
                    <Icon size={16} aria-hidden="true" />
                    {term}
                  </dt>
                  <dd>{text}</dd>
                </div>
              ))}
            </dl>
            <AgentCheck />
          </>
        )}
        {/* The same dialog the rail's ＋, ⌘N and the palette open: where the
            workspace runs, its name, then its folders. */}
        <div className="home-setup-start">
          <button type="button" className="home-view-button" onClick={openNewWorkspaceDialog}>
            <Plus size={18} aria-hidden="true" />
            <span>New workspace</span>
          </button>
          <p className="home-view-shortcut">
            <kbd>{isMac ? '⌘' : 'Ctrl'}</kbd>
            <kbd>N</kbd> also works.
          </p>
        </div>
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
  const harness = useHarnessStore(
    (state) =>
      state.harnesses.find((candidate) => candidate.isBuiltIn) ??
      state.harnesses.find(isSelectableHarness),
  );
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
      {state === 'ok' ? (
        <CheckCircle2 size={16} />
      ) : state === 'error' ? (
        <AlertCircle size={16} />
      ) : (
        <Loader2 size={16} className="home-spinner" />
      )}
      <span>{message}</span>
      {state === 'error' && (
        <span className="home-agent-actions">
          <button
            type="button"
            className="home-link-button"
            onClick={() => void probeHarness(harness.id)}
          >
            Check again
          </button>
          <button
            type="button"
            className="home-link-button"
            onClick={() => openSettings('harnesses')}
          >
            Agent settings
          </button>
        </span>
      )}
    </div>
  );
}
