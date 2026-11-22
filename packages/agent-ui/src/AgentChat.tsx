import type { JSX } from 'react';

export interface AgentChatProps {
  readonly hostUrl: string;
  readonly pass: string;
  readonly sessionId: string;
  readonly onPassExpired?: () => Promise<string>;
}

export function AgentChat(_props: AgentChatProps): JSX.Element {
  return <div className="consola-agent-ui" />;
}
