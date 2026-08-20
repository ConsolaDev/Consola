import { useState, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useWorkspaceStore, type Workspace } from '../../stores/workspaceStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { isSelectableHarness, useHarnessStore } from '../../stores/harnessStore';
import { useHarnessCapabilities } from '../../hooks/useHarnessCapabilities';
import { PromptComposer } from '../PromptComposer';
import { generateSessionInstanceId } from '../../utils/sessionActions';
import './styles.css';

interface NewSessionViewProps {
  workspace: Workspace;
}

export function NewSessionView({ workspace }: NewSessionViewProps) {
  const [prompt, setPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const createSession = useWorkspaceStore((state) => state.createSession);

  const setActiveWorkspace = useNavigationStore((state) => state.setActiveWorkspace);
  const setActiveSession = useNavigationStore((state) => state.setActiveSession);

  const setPendingPrompt = useTerminalStore((state) => state.setPendingPrompt);

  const harnesses = useHarnessStore((state) => state.harnesses);
  // Archived and disabled harnesses stay out of the picker, but a workspace
  // may still name one as its default, so fall back to something selectable.
  const selectableHarnesses = harnesses.filter(isSelectableHarness);
  const [selectedHarnessId, setSelectedHarnessId] = useState(workspace.defaultHarnessId);
  const selectedHarness =
    selectableHarnesses.find((harness) => harness.id === selectedHarnessId) ??
    selectableHarnesses[0];

  // Which model this conversation will be pinned to. Undefined means no
  // `--model` flag at all, leaving the CLI on its own default.
  const [selectedModel, setSelectedModel] = useState<string | undefined>(undefined);

  // The composer probes for these too; both read the same cached answer, so
  // naming the models here costs nothing extra.
  const { capabilities } = useHarnessCapabilities(selectedHarness, true);
  const models = capabilities?.models ?? [];
  const selectedModelInfo = models.find((model) => model.value === selectedModel);

  // Follow the workspace's own default whenever the workspace changes.
  useEffect(() => {
    setSelectedHarnessId(workspace.defaultHarnessId);
  }, [workspace.id, workspace.defaultHarnessId]);

  // A model belongs to the harness that offers it, so a different harness
  // starts from its default again rather than keeping a value it may not have.
  useEffect(() => {
    setSelectedModel(undefined);
  }, [selectedHarness?.id]);

  const handleWorkspaceChange = (workspaceId: string) => {
    setActiveWorkspace(workspaceId);
  };

  const handleSubmit = async () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || isSubmitting) return;

    setIsSubmitting(true);

    try {
      // Placeholder name until Claude writes a summary for the conversation,
      // which ContentView then adopts.
      const instanceId = generateSessionInstanceId(workspace.id);
      const session = await createSession(workspace.id, {
        name: 'New Session',
        workspaceId: workspace.id,
        instanceId,
        // Fixed now and never changed: the conversation's transcript will live
        // in this harness's config directory, and resuming reads it back.
        harnessId: selectedHarness?.id ?? workspace.defaultHarnessId,
        // Fixed now for the same reason as the harness: every later launch,
        // including a resume, replays it.
        model: selectedModel,
      });

      if (!session) {
        setIsSubmitting(false);
        return;
      }

      // Hand the prompt to the terminal, which delivers it once the CLI has
      // finished starting up.
      setPendingPrompt(instanceId, trimmedPrompt);

      // Set as active immediately
      setActiveSession(session.id);

      // Clear the input
      setPrompt('');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="new-session-view">
      <div className="new-session-content">
        <div className="new-session-header">
          <span>Start new conversation in</span>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button className="workspace-dropdown-trigger">
                <span>{workspace.name}</span>
                <ChevronDown size={14} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="dropdown-content workspace-dropdown-content" sideOffset={4}>
                {workspaces.map((ws) => (
                  <DropdownMenu.Item
                    key={ws.id}
                    className={`dropdown-item ${ws.id === workspace.id ? 'active' : ''}`}
                    onSelect={() => handleWorkspaceChange(ws.id)}
                  >
                    {ws.name}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>

          {selectableHarnesses.length > 1 && selectedHarness && (
            <>
              <span>using</span>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button className="workspace-dropdown-trigger">
                    <span
                      className="new-session-harness-dot"
                      style={{ background: selectedHarness.accentColor }}
                    />
                    <span>{selectedHarness.name}</span>
                    <ChevronDown size={14} />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    className="dropdown-content workspace-dropdown-content"
                    sideOffset={4}
                  >
                    {selectableHarnesses.map((harness) => (
                      <DropdownMenu.Item
                        key={harness.id}
                        className={`dropdown-item ${
                          harness.id === selectedHarness.id ? 'active' : ''
                        }`}
                        onSelect={() => setSelectedHarnessId(harness.id)}
                      >
                        <span
                          className="new-session-harness-dot"
                          style={{ background: harness.accentColor }}
                        />
                        {harness.name}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </>
          )}

          {models.length > 0 && (
            <>
              <span>on</span>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button className="workspace-dropdown-trigger">
                    <span>{selectedModelInfo?.displayName ?? 'Default model'}</span>
                    <ChevronDown size={14} />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    className="dropdown-content workspace-dropdown-content"
                    sideOffset={4}
                  >
                    {/* Leaving the model unset is a real choice, not an empty
                        one: it is what lets the CLI's own default apply, and
                        keep applying as that default changes. */}
                    <DropdownMenu.Item
                      className={`dropdown-item ${selectedModel === undefined ? 'active' : ''}`}
                      onSelect={() => setSelectedModel(undefined)}
                    >
                      Default model
                    </DropdownMenu.Item>
                    {models.map((model) => (
                      <DropdownMenu.Item
                        key={model.value}
                        className={`dropdown-item ${
                          model.value === selectedModel ? 'active' : ''
                        }`}
                        onSelect={() => setSelectedModel(model.value)}
                        title={model.description}
                      >
                        {model.displayName}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </>
          )}
        </div>

        <PromptComposer
          value={prompt}
          onChange={setPrompt}
          onSubmit={handleSubmit}
          harness={selectedHarness}
          disabled={isSubmitting}
          autoFocus
        />

        <div className="new-session-hint">
          Press <kbd>Enter</kbd> to send, <kbd>Shift + Enter</kbd> for new line
        </div>
      </div>
    </div>
  );
}
