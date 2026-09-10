import { useState, useEffect, useRef, type ReactNode } from 'react';
import { ChevronDown, Boxes, Check, AlertCircle } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useWorkspaceStore, type Workspace } from '../../stores/workspaceStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { isSelectableHarness, useHarnessStore } from '../../stores/harnessStore';
import { useHarnessCapabilities } from '../../hooks/useHarnessCapabilities';
import { PromptComposer } from '../PromptComposer';
import { HarnessIcon } from '../HarnessIcon';
import { CheckoutPicker } from '../CheckoutPicker/CheckoutPicker';
import { generateSessionInstanceId, openNewSessionComposer } from '../../utils/sessionActions';
import { homeScope, useHomeStore } from '../../stores/homeStore';
import { ScopeSelector } from '../Sidebar/ScopeSelector';
import type { SessionCheckout } from '../../../shared/sessionCheckout';
import './styles.css';
import './new-session.css';

function Picker({ label, children, options, disabled, notice, className = '' }: {
  label: string; children: ReactNode; disabled?: boolean; notice?: string; className?: string;
  options: { id: string; label: string; selected: boolean; onSelect: () => void; detail?: string; icon?: ReactNode }[];
}) {
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild><button className={`composer-control ${className}`} aria-label={label} disabled={disabled}>{children}<ChevronDown size={12} /></button></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="dropdown-content conversation-picker-menu" side="bottom" align="start" sideOffset={8}>
      <DropdownMenu.Label className="conversation-picker-label">{label}</DropdownMenu.Label>
      {notice && <div className="conversation-picker-notice" role="status">{notice}</div>}
      {options.map(option => <DropdownMenu.Item key={option.id} className="dropdown-item" onSelect={option.onSelect} title={option.detail}>
        <span className="conversation-picker-option-label">{option.icon}{option.label}</span>{option.selected && <Check size={14} />}
      </DropdownMenu.Item>)}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

export function NewSessionView({ workspace }: { workspace: Workspace }) {
  const [prompt, setPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState('');
  const [checkout, setCheckout] = useState<SessionCheckout>({ mode: 'current' });
  const workspaces = useWorkspaceStore(state => state.workspaces);
  const createSession = useWorkspaceStore(state => state.createSession);
  const setActiveSession = useNavigationStore(state => state.setActiveSession);
  const setPendingPrompt = useTerminalStore(state => state.setPendingPrompt);
  const harnesses = useHarnessStore(state => state.harnesses);
  const selectableHarnesses = harnesses.filter(isSelectableHarness);
  const [selectedHarnessId, setSelectedHarnessId] = useState(workspace.defaultHarnessId);
  const selectedHarness = selectableHarnesses.find(harness => harness.id === selectedHarnessId) ?? selectableHarnesses[0];
  const [selectedModel, setSelectedModel] = useState<string>();
  const { capabilities, loading: modelsLoading, unavailable: modelsError, retry: retryModels } = useHarnessCapabilities(selectedHarness, true);
  const models = capabilities?.models ?? [];
  const selectedModelInfo = models.find(model => model.value === selectedModel);
  const selectedScopeId = useHomeStore(state => state.scopeIds[workspace.id]);
  const selectedScope = homeScope(workspace, selectedScopeId);
  const draftGroupId = useHomeStore(state => state.draftGroupIds[workspace.id]);
  const groups = workspace.groups.filter(group => !group.archivedAt);
  const selectedGroup = groups.find(group => group.id === draftGroupId);

  useEffect(() => { setSelectedHarnessId(workspace.defaultHarnessId); }, [workspace.id, workspace.defaultHarnessId]);
  useEffect(() => { setSelectedModel(undefined); }, [selectedHarness?.id]);
  useEffect(() => { setCheckout({ mode: 'current' }); setError(''); }, [workspace.id, selectedScope?.id]);

  const handleSubmit = async () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || submittingRef.current || !selectedScope || !selectedHarness) return;
    submittingRef.current = true;
    setIsSubmitting(true);
    setError('');
    try {
      const instanceId = generateSessionInstanceId(workspace.id);
      const session = await createSession(workspace.id, {
        name: 'New Session', workspaceId: workspace.id, instanceId,
        harnessId: selectedHarness.id, model: selectedModel, scopeId: selectedScope.id, groupId: selectedGroup?.id,
      }, checkout);
      if (!session) throw new Error('The conversation could not be created. Please try again.');
      setPendingPrompt(instanceId, trimmedPrompt);
      if (useNavigationStore.getState().activeWorkspaceId === workspace.id) {
        setActiveSession(session.id);
      }
      setPrompt('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  return <div className="new-session-view">
    <div className="new-session-content">
      <h1 className="conversation-heading">What should we build in{' '}
        <Picker label="Choose workspace" className="conversation-workspace" disabled={isSubmitting} options={workspaces.map(ws => ({ id: ws.id, label: ws.name, selected: ws.id === workspace.id, onSelect: () => { void openNewSessionComposer(ws.id); } }))}>{workspace.name}</Picker><span>?</span>
      </h1>
      <div className="conversation-compose-area" aria-busy={isSubmitting}>
        <PromptComposer value={prompt} onChange={setPrompt} onSubmit={handleSubmit} harness={selectedHarness}
          placeholder="Describe a task, ask a question, or explore an idea…" disabled={isSubmitting || !selectedHarness || !selectedScope} submitting={isSubmitting} autoFocus
          controls={<>
            <Picker label="Choose agent" disabled={isSubmitting || !selectableHarnesses.length} options={selectableHarnesses.map(harness => ({ id: harness.id, label: harness.name, icon: <HarnessIcon driverId={harness.driverId} decorative />, selected: harness.id === selectedHarness?.id, onSelect: () => setSelectedHarnessId(harness.id) }))}>
              {selectedHarness && <HarnessIcon driverId={selectedHarness.driverId} decorative />}<span>{selectedHarness?.name ?? 'No agents available'}</span>
            </Picker>
            <span className="composer-divider" />
            <Picker label="Choose model" disabled={isSubmitting || modelsLoading} notice={modelsError ?? (capabilities && !models.length ? 'This agent returned no models. You can still use its default.' : undefined)} options={[
              { id: 'default', label: 'Default model', selected: selectedModel === undefined, onSelect: () => setSelectedModel(undefined) },
              ...models.map(model => ({ id: model.value, label: model.displayName, selected: model.value === selectedModel, detail: model.description, onSelect: () => setSelectedModel(model.value) })),
              ...(modelsError ? [{ id: 'retry-models', label: 'Retry loading models', selected: false, onSelect: retryModels }] : []),
            ]}><span>{selectedModelInfo?.displayName ?? (modelsLoading ? 'Loading models…' : modelsError ? 'Models unavailable' : 'Default model')}</span></Picker>
            <span className="composer-divider" />
            <ScopeSelector workspace={workspace} disabled={isSubmitting} className="composer-control" />
            {groups.length > 0 && <>
              <span className="composer-divider" />
              <Picker label="Choose group" disabled={isSubmitting} options={[
                { id: 'ungrouped', label: 'Ungrouped', selected: !selectedGroup, onSelect: () => useHomeStore.getState().setDraftGroup(workspace.id) },
                ...groups.map(group => ({ id: group.id, label: group.name, selected: group.id === selectedGroup?.id, onSelect: () => useHomeStore.getState().setDraftGroup(workspace.id, group.id) })),
              ]}><Boxes size={14} /><span>{selectedGroup?.name ?? 'Ungrouped'}</span></Picker>
            </>}
          </>} />
        {selectedScope && <CheckoutPicker key={`${workspace.id}:${selectedScope.id}`} workspaceId={workspace.id} scope={selectedScope} value={checkout} onChange={next => { setCheckout(next); setError(''); }} disabled={isSubmitting} />}
      </div>
      {(error || !selectedScope || !selectedHarness) && <div className="conversation-error" role="alert"><AlertCircle size={16} /><span>{error || (!selectedScope ? 'Add a folder to this workspace to start a conversation.' : 'Enable an agent in Settings to start a conversation.')}</span></div>}
      <div className="new-session-hint">{isSubmitting ? (checkout.mode === 'new' ? 'Preparing your worktree…' : 'Starting your conversation…') : <><span><kbd>↵</kbd> Send</span><span><kbd>⇧ ↵</kbd> New line</span><span><kbd>/</kbd> Commands <span className="hint-dot">·</span> <kbd>@</kbd> Agents</span></>}</div>
    </div>
  </div>;
}
