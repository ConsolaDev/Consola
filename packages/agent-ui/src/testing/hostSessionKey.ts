/** The replay host the browser tests connect to (`hostSession.ts`). */
export type HostSession = {
  readonly hostUrl: string;
  readonly pass: string;
  /** The private key the host trusts (`passKeys.ts`), for the `signHostPass` command. */
  readonly passKeyFile: string;
  readonly sessionId: string;
  /** What the fixture's assistant answered. */
  readonly assistantText: string;
};

/** The key `hostSession.ts` provides it under (Vitest's `provide` and `inject`). */
export const HOST_SESSION_KEY = 'consolaAgentUiHost';
