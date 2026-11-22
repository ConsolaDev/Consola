// The chat's stylesheet: a library build writes the CSS its entry imports, so this is what
// makes `dist/agent-ui.css` (`@consola/agent-ui/styles.css`) hold it.
import './styles.css';

export { AgentChat, type AgentChatProps } from './AgentChat.tsx';
