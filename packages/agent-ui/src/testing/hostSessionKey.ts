/** The replay host the browser tests connect to, as the global setup provides it (`hostSession.ts`). */
export type ProvidedHost = {
  readonly hostUrl: string;
  /** The private key the host trusts (`passKeys.ts`), for the `signHostPass` command. */
  readonly passKeyFile: string;
  /**
   * How long the pass each test is handed lives (`render.tsx`'s `host()`): the longest a pass
   * may (`PASS_MAX_LIFETIME_SECONDS`, five minutes), longer than any test may run.
   */
  readonly passLifetimeSeconds: number;
  readonly sessionId: string;
  /** What the fixture's assistant answered. */
  readonly assistantText: string;
  /** The title the thread is given once its first turn has run. */
  readonly threadTitle: string;
};

/** The replay host as a test sees it (`render.tsx`'s `host()`): with a pass signed for the test. */
export type HostSession = ProvidedHost & { readonly pass: string };

/** The key `hostSession.ts` provides it under (Vitest's `provide` and `inject`). */
export const HOST_SESSION_KEY = 'consolaAgentUiHost';
