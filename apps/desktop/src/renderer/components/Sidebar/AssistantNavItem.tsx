import { useEffect } from 'react';
import { assistantSession, type Workspace } from '../../../shared/workspace';
import { useAssistantStore } from '../../stores/assistantStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { assistantRowState } from '../../utils/assistantRow';
import { ASSISTANT_SHORTCUT_LABEL } from '../../utils/platform';
import { openAssistant } from '../../utils/sessionActions';
import { sessionStatusFor } from '../../utils/sessionStatus';

const DISABLED_TITLE = 'Add a scope to use the Assistant.';

/**
 * The workspace's Assistant, pinned above the scope picker because, unlike
 * everything below it, it is not filtered to one scope. It reads like a
 * session row: the same status dots, the same active background.
 */
export function AssistantNavItem({ workspace }: { workspace: Workspace }) {
  const assistant = assistantSession(workspace);
  const isActive = useNavigationStore(state => !state.isInboxOpen && !!assistant && state.activeSessionId === assistant.id);
  const status = useTerminalStore(state => assistant ? sessionStatusFor(state.terminals[assistant.instanceId]) : undefined);
  const unseenFinished = useAssistantStore(state => state.activity[workspace.id]?.unseenFinished ?? 0);

  useEffect(() => { void useAssistantStore.getState().load(workspace.id); }, [workspace.id]);

  const state = assistantRowState({ hasScopes: workspace.scopes.length > 0, status, unseenFinished, isActive });
  const disabled = state.kind === 'disabled';

  return <button type="button" className={`assistant-nav-item ${isActive ? 'active' : ''}`}
    aria-disabled={disabled || undefined} title={disabled ? DISABLED_TITLE : undefined}
    aria-current={isActive ? 'page' : undefined}
    onClick={() => { if (!disabled) void openAssistant(workspace.id); }}>
    <span className="assistant-spark" aria-hidden="true">✦</span>
    <span className="assistant-nav-label">Assistant</span>
    {state.kind === 'idle' && <kbd className="assistant-nav-shortcut">{ASSISTANT_SHORTCUT_LABEL}</kbd>}
    {state.kind === 'working' && <><span className="session-status-indicator session-status-indicator--working" aria-hidden="true" /><span className="assistant-nav-word">working</span></>}
    {state.kind === 'needs-you' && <><span className="session-status-indicator session-status-indicator--needs-attention" aria-hidden="true" /><span className="assistant-nav-word assistant-nav-word--attention">needs you</span></>}
    {state.kind === 'done' && <><span className="session-status-indicator session-status-indicator--done" aria-hidden="true" /><span className="assistant-nav-word">{state.count} done</span></>}
  </button>;
}
