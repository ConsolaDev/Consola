import { useEffect } from 'react';
import { Zap } from 'lucide-react';
import type { Workspace } from '../../../shared/workspace';
import { sidebarRowState } from '../Automations/presentation';
import { useAutomationsStore, WINDOW_LOADED_AT } from '../../stores/automationsStore';
import { useNavigationStore } from '../../stores/navigationStore';

/**
 * The workspace's Automations, pinned under the Assistant: every workspace
 * has one, with or without a factory.yml. It reads like a session row and
 * says only the most urgent thing — runs waiting for the person, failures
 * since they last looked at Activity, or agents running.
 */
export function AutomationsNavItem({ workspace }: { workspace: Workspace }) {
  const isActive = useNavigationStore(state => state.overlay === 'automations');
  const snapshot = useAutomationsStore(state => state.snapshots[workspace.id]);
  const lastSeen = useAutomationsStore(state => state.lastSeen[workspace.id] ?? WINDOW_LOADED_AT);

  useEffect(() => { void useAutomationsStore.getState().load(workspace.id); }, [workspace.id]);

  const state = sidebarRowState(snapshot, lastSeen);

  return <button type="button" className={`automations-nav-item ${isActive ? 'active' : ''}`}
    aria-current={isActive ? 'page' : undefined}
    onClick={() => useNavigationStore.getState().openAutomations()}>
    <Zap size={14} className="automations-nav-icon" aria-hidden="true" />
    <span className="automations-nav-label">Automations</span>
    {state.kind === 'waiting' && <span className="automations-nav-pill automations-nav-pill--waiting">{state.count} waiting</span>}
    {state.kind === 'failed' && <span className="automations-nav-pill automations-nav-pill--failed">{state.count} failed</span>}
    {state.kind === 'running' && <><span className="session-status-indicator session-status-indicator--working" aria-hidden="true" /><span className="automations-nav-word">{state.count} running</span></>}
  </button>;
}
