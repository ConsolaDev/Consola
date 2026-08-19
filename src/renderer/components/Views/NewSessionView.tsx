import { useState, useRef, useEffect } from 'react';
import { Send, ChevronDown } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useWorkspaceStore, type Workspace } from '../../stores/workspaceStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { isSelectableHarness, useHarnessStore } from '../../stores/harnessStore';
import { generateSessionInstanceId } from '../../utils/sessionActions';
import './styles.css';

interface NewSessionViewProps {
  workspace: Workspace;
}

export function NewSessionView({ workspace }: NewSessionViewProps) {
  const [prompt, setPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  // Focus the textarea when the view mounts, and follow the workspace's own
  // default whenever the workspace changes.
  useEffect(() => {
    textareaRef.current?.focus();
    setSelectedHarnessId(workspace.defaultHarnessId);
  }, [workspace.id, workspace.defaultHarnessId]);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, [prompt]);

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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
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
        </div>

        <div className="new-session-input-container">
          <textarea
            ref={textareaRef}
            className="new-session-input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything..."
            rows={1}
            disabled={isSubmitting}
          />
          <button
            className="new-session-submit"
            onClick={handleSubmit}
            disabled={!prompt.trim() || isSubmitting}
            aria-label="Send message"
          >
            <Send size={18} />
          </button>
        </div>

        <div className="new-session-hint">
          Press <kbd>Enter</kbd> to send, <kbd>Shift + Enter</kbd> for new line
        </div>
      </div>
    </div>
  );
}
