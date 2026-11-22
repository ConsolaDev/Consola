// `@consola/agent-ui`'s published types (`package.json` `exports`), written by hand
// (AGENTS.md, "Types"): `src/index.ts` reaches t3's copy, whose `~/` paths resolve only under this
// package's tsconfig. `src/publishedTypes.ts` fails the typecheck when these differ from it.
import type { JSX } from 'react';

export interface AgentChatProps {
  /**
   * The host's address, `http(s)://host:port` (or its socket's, `ws(s)://host:port`, read as
   * the same host over `http(s)://`). Its socket is `ws(s)://host:port/ws`.
   */
  readonly hostUrl: string;
  /** The session pass: the only credential the host takes. */
  readonly pass: string;
  /** The session the host serves; t3's environment and thread are both named by it. */
  readonly sessionId: string;
  /**
   * Called when the host refuses the pass (it expired); the chat reconnects with the pass it
   * answers. Without it, or when it fails (logged) or answers a pass the host refuses too, the
   * chat says its pass was refused.
   */
  readonly onPassExpired?: () => Promise<string>;
}

/**
 * t3's chat for one `@consola/host` session. Everything inside is t3's, copied unchanged;
 * `import '@consola/agent-ui/styles.css'` styles it, and nothing outside this element.
 */
export declare function AgentChat(props: AgentChatProps): JSX.Element;
