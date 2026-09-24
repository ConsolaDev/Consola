import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Select } from '@radix-ui/themes';
import { ArrowUpRight, Boxes, Cpu, Folder, GitBranch, Layers2, Loader2, X } from 'lucide-react';
import { HarnessIcon } from '../HarnessIcon';
import { WorkspaceIcon } from '../WorkspaceIcon';
import { useWorkspaceStore, type Workspace } from '../../stores/workspaceStore';
import { isSelectableHarness, useHarnessStore } from '../../stores/harnessStore';
import { useNewSessionDialogStore, type NewSessionDestination } from '../../stores/newSessionDialogStore';
import { homeScope, useHomeStore } from '../../stores/homeStore';
import { useHarnessCapabilities } from '../../hooks/useHarnessCapabilities';
import { createSessionAndOpen } from '../../utils/sessionActions';
import { CheckoutPicker } from '../CheckoutPicker/CheckoutPicker';
import type { SessionCheckout } from '../../../shared/sessionCheckout';
import './styles.css';
import '../Views/new-session.css';
import './new-session-dialog.css';

export function NewSessionDialog() {
  const destination = useNewSessionDialogStore(state => state.destination);
  const close = useNewSessionDialogStore(state => state.close);
  const workspaces = useWorkspaceStore(state => state.workspaces);
  const workspace = workspaces.find(ws => ws.id === destination?.workspaceId);
  useEffect(() => {
    if (destination && !workspace) close();
  }, [destination, workspace, close]);
  if (!destination || !workspace) return null;
  return <SessionOptions key={`${workspace.id}:${destination.scopeId}:${destination.groupId}`} workspace={workspace}
    destination={destination} initialError={destination.error} onClose={close} />;
}

function SessionOptions({ workspace: initialWorkspace, destination, initialError, onClose }: {
  workspace: Workspace; destination: NewSessionDestination; initialError?: string; onClose: () => void;
}) {
  const workspaces = useWorkspaceStore(state => state.workspaces);
  const [workspaceId, setWorkspaceId] = useState(initialWorkspace.id);
  const workspace = workspaces.find(ws => ws.id === workspaceId) ?? initialWorkspace;
  const [scopeId, setScopeId] = useState(destination.scopeId);
  const scope = homeScope(workspace, scopeId);
  const [groupId, setGroupId] = useState(destination.groupId);
  const groups = workspace.groups.filter(group => !group.archivedAt);
  const group = groups.find(candidate => candidate.id === groupId);
  const harnesses = useHarnessStore(state => state.harnesses).filter(isSelectableHarness);
  const [harnessId, setHarnessId] = useState(workspace.defaultHarnessId);
  const harness = harnesses.find(candidate => candidate.id === harnessId) ?? harnesses[0];
  const [model, setModel] = useState<string>();
  const { capabilities, loading, unavailable, retry } = useHarnessCapabilities(harness, true);
  const [checkout, setCheckout] = useState<SessionCheckout>({ mode: 'current' });
  const [error, setError] = useState(initialError ?? '');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const create = async () => {
    if (submittingRef.current || !scope || !harness) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError('');
    try {
      await createSessionAndOpen(workspace.id, { scopeId: scope.id, groupId: group?.id, harnessId: harness.id, model, checkout });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return <Dialog.Root open onOpenChange={open => { if (!open && !submittingRef.current) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content new-session-dialog" aria-busy={submitting}>
        <header className="session-options-header">
          <Dialog.Title className="dialog-title">New session with options</Dialog.Title>
          <Dialog.Description className="dialog-description">Choose your agent and a place to work.</Dialog.Description>
          <Dialog.Close className="dialog-close" disabled={submitting} aria-label="Close session options"><X size={16} aria-hidden="true" /></Dialog.Close>
        </header>
        <div className="dialog-form">
          <SessionOptionPicker label="Workspace" value={workspace.id} disabled={submitting}
            options={workspaces.map(ws => ({ value: ws.id, label: ws.name, icon: <WorkspaceIcon icon={ws.icon} name={ws.name} size={20} /> }))}
            onChange={value => {
              const next = workspaces.find(ws => ws.id === value);
              if (!next) return;
              setWorkspaceId(next.id);
              setScopeId(homeScope(next, useHomeStore.getState().scopeIds[next.id])?.id);
              setGroupId(undefined);
              setHarnessId(next.defaultHarnessId);
              setModel(undefined);
              setCheckout({ mode: 'current' });
              setError('');
            }} />
          <div className="session-options-grid">
            <SessionOptionPicker label="Agent" value={harness?.id} placeholder="No agents available" disabled={submitting || !harnesses.length}
              options={harnesses.map(agent => ({ value: agent.id, label: agent.name, icon: <HarnessIcon driverId={agent.driverId} decorative /> }))}
              onChange={value => { setHarnessId(value); setModel(undefined); }} />
            <SessionOptionPicker label="Model" value={model ?? 'default-model'} disabled={submitting || loading}
              options={[
                { value: 'default-model', label: loading ? 'Loading models…' : 'Default model', icon: <Cpu size={16} />, detail: 'Use the agent’s default' },
                ...(capabilities?.models ?? []).map(option => ({ value: option.value, label: option.displayName, icon: <Cpu size={16} />, detail: option.description })),
              ]}
              onChange={value => setModel(value === 'default-model' ? undefined : value)} />
            <SessionOptionPicker label="Scope" value={scope?.id} placeholder="No scopes available" disabled={submitting || !workspace.scopes.length}
              options={workspace.scopes.map(candidate => ({ value: candidate.id, label: candidate.name, icon: candidate.isGitRepo ? <GitBranch size={16} /> : <Folder size={16} />, detail: candidate.path }))}
              onChange={value => { setScopeId(value); setCheckout({ mode: 'current' }); setError(''); }} />
            <SessionOptionPicker label="Group" value={group?.id ?? 'ungrouped'} disabled={submitting}
              options={[
                { value: 'ungrouped', label: 'Ungrouped', icon: <Layers2 size={16} /> },
                ...groups.map(candidate => ({ value: candidate.id, label: candidate.name, icon: <Boxes size={16} /> })),
              ]}
              onChange={value => setGroupId(value === 'ungrouped' ? undefined : value)} />
          </div>
          {unavailable && <p className="session-options-notice" role="status">Models unavailable. You can use the agent’s default. <button className="first-session-link" disabled={submitting} onClick={retry}>Retry</button></p>}
          {scope && <div className="dialog-field">
            <span className="dialog-label">Checkout</span>
            <CheckoutPicker key={`${workspace.id}:${scope.id}`} workspaceId={workspace.id} scope={scope} value={checkout} onChange={next => { setCheckout(next); setError(''); }} disabled={submitting} />
          </div>}
          {(error || !scope || !harness) && <p className="dialog-error" role="alert">{error || (!scope ? 'Add a scope in workspace settings to start a session.' : 'Enable an agent in Settings to start a session.')}</p>}
        </div>
        <div className="dialog-actions session-options-actions">
          <button className="dialog-button-secondary" disabled={submitting} onClick={onClose}>Cancel</button>
          <button className="dialog-button-primary" disabled={submitting || !scope || !harness} onClick={() => void create()}>
            {submitting && <Loader2 size={14} className="composer-spinner" aria-hidden="true" />}
            {submitting ? (checkout.mode === 'new' ? 'Preparing worktree…' : 'Creating…') : 'Create session'}
            {!submitting && <ArrowUpRight size={16} className="session-create-arrow" aria-hidden="true" />}
          </button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

interface SessionOption {
  value: string;
  label: string;
  icon: ReactNode;
  detail?: string;
}

/** Shared marks in the selected value and menu make destinations easy to scan. */
function SessionOptionPicker({ label, value, options, onChange, disabled, placeholder }: {
  label: string; value?: string; options: SessionOption[]; onChange: (value: string) => void;
  disabled?: boolean; placeholder?: string;
}) {
  const id = useId();
  const selected = options.find(option => option.value === value);
  return <div className="dialog-field">
    <label className="dialog-label" htmlFor={id}>{label}</label>
    <Select.Root value={value ?? ''} onValueChange={onChange} disabled={disabled}>
      <Select.Trigger id={id} className="session-option-trigger" aria-label={label} title={selected?.detail}>
        <span className="session-option-value">
          <span className="session-option-icon" aria-hidden="true">{selected?.icon}</span>
          <span className="session-option-name">{selected?.label ?? placeholder}</span>
        </span>
      </Select.Trigger>
      <Select.Content className="session-option-menu" position="popper" sideOffset={6} align="start">
        {options.map((option, index) => <Select.Item key={option.value} value={option.value} textValue={option.label} aria-labelledby={`${id}-${index}-label`} aria-describedby={option.detail ? `${id}-${index}-detail` : undefined} className="session-option-item" title={option.detail}>
          <span className="session-option-value">
            <span className="session-option-icon" aria-hidden="true">{option.icon}</span>
            <span className="session-option-copy"><span id={`${id}-${index}-label`} className="session-option-name">{option.label}</span>{option.detail && <span id={`${id}-${index}-detail`} className="session-option-detail">{option.detail}</span>}</span>
          </span>
        </Select.Item>)}
      </Select.Content>
    </Select.Root>
  </div>;
}
