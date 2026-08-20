/**
 * GitHub-facing shapes shared by main and renderer.
 *
 * Deliberately token-free: a token is borrowed from `gh` inside the main
 * process at the moment it is needed and never crosses IPC. Anything defined
 * here may end up in a renderer, so nothing here may ever carry a credential.
 */

/** One account in the `gh` keyring, as `gh auth status` reports it. */
export interface GhAccount {
  login: string;
  /** Whether `gh` itself would use this account today (its active account). */
  active: boolean;
}

/** What probing the `gh` CLI found. Feeds the settings account picker. */
export interface GhProbeResult {
  /** The binary was found and runs. */
  available: boolean;
  /** Path actually resolved, when one was found. */
  resolvedBinary?: string;
  version?: string;
  /** Empty when nobody is signed in — the UI offers `gh auth login`. */
  accounts: GhAccount[];
  error?: string;
}

/**
 * A remote work item a session was launched from. Immutable on the session,
 * like `harnessId`: it names why the session exists.
 */
export interface WorkItemRef {
  provider: 'github';
  /** "owner/name", e.g. "sympower/controller-app". */
  repo: string;
  type: 'pr' | 'issue';
  number: number;
}
