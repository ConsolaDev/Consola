import { AgentChat } from '@consola/agent-ui';
import type { AgentChatProps } from '@consola/agent-ui';
import '@consola/agent-ui/styles.css';

/**
 * A running session's chat: t3's, through `@consola/agent-ui`, connected straight to the
 * session's host with a pass from the cell. Its stylesheet styles nothing outside it. The chat is
 * large, so `SessionPage` loads this module only when a session runs (`lazy`), and the rest of the
 * app never carries it.
 */
export function SessionChat(props: AgentChatProps) {
  return (
    <div className="session-chat-frame">
      <AgentChat {...props} />
    </div>
  );
}
