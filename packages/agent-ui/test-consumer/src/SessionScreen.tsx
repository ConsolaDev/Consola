// An embedding app's screen, as cloud-web's session screens and the desktop write one. It knows
// `@consola/agent-ui` only by name: what `package.json`'s `exports` publish for it.
import { AgentChat } from '@consola/agent-ui';
import type { AgentChatProps } from '@consola/agent-ui';
import '@consola/agent-ui/styles.css';
import type { JSX } from 'react';

const HOST = 'http://127.0.0.1:7420';

const fetchNewPass = async (): Promise<string> => 'pass-for-sprocket';

export function SessionScreen(props: { readonly sessionId: string }): JSX.Element {
  return (
    <AgentChat
      hostUrl={HOST}
      pass="pass"
      sessionId={props.sessionId}
      onPassExpired={fetchNewPass}
    />
  );
}

export const withoutRenewal: AgentChatProps = { hostUrl: HOST, pass: 'pass', sessionId: 'acme' };

// The props are typed, not `any`: each of these is an error, and an unused `@ts-expect-error`
// is one too.

// @ts-expect-error `sessionId` is required.
export const withoutSession: AgentChatProps = { hostUrl: HOST, pass: 'pass' };

export const renewedWithNumber: AgentChatProps = {
  ...withoutRenewal,
  // @ts-expect-error `onPassExpired` answers the new pass, a string.
  onPassExpired: async () => 42,
};

// @ts-expect-error The props are only these four.
export const withTheme: AgentChatProps = { ...withoutRenewal, theme: 'dark' };
