import { useState, useRef, useEffect } from 'react';
import { Send, ChevronDown } from 'lucide-react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useWorkspaceStore, type Workspace } from '../../stores/workspaceStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useAgentStore } from '../../stores/agentStore';
import { sessionStorageBridge } from '../../services/sessionStorageBridge';
import './styles.css';

interface NewSessionViewProps {
  workspace: Workspace;
}

function generateSessionInstanceId(workspaceId: string): string {
  const sessionId = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
  return `workspace-${workspaceId}-session-${sessionId}`;
}

export function NewSessionView({ workspace }: NewSessionViewProps) {
  const [prompt, setPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const createSession = useWorkspaceStore((state) => state.createSession);
  const updateSession = useWorkspaceStore((state) => state.updateSession);

  const setActiveWorkspace = useNavigationStore((state) => state.setActiveWorkspace);
  const setActiveSession = useNavigationStore((state) => state.setActiveSession);

  const sendMessage = useAgentStore((state) => state.sendMessage);

  // Focus the textarea when the view mounts
  useEffect(() => {
    textareaRef.current?.focus();
  }, [workspace.id]);

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
      // Create session with empty name (won't show in sidebar until name is generated)
      const instanceId = generateSessionInstanceId(workspace.id);
      const session = createSession(workspace.id, {
        name: '',
        workspaceId: workspace.id,
        instanceId,
      });

      if (!session) {
        setIsSubmitting(false);
        return;
      }

      // Set as active immediately
      setActiveSession(session.id);

      // Start agent query
      sendMessage(instanceId, workspace.path, trimmedPrompt, {});

      // Generate name from prompt asynchronously
      sessionStorageBridge.generateName(trimmedPrompt).then((name) => {
        if (name) {
          updateSession(workspace.id, session.id, { name });
        }
      });

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
