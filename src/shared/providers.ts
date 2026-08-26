/**
 * Git hosting providers a workspace can be bound to.
 *
 * Shared by main and renderer: the renderer reads display copy from
 * PROVIDER_META, main resolves a driver by id. Token-free by construction —
 * a provider's credential is borrowed inside main and never described here.
 */

/**
 * A union, like HarnessDriverId: supporting another provider means adding a
 * member here, an entry below, and a driver under src/main/providers/ —
 * nothing else may branch on the value.
 */
export type GitProviderId = 'github';

/** What a workspace stores about the account it acts as. */
export interface ProviderBinding {
  accountLogin: string;
  /** Scopes the Inbox query; absent = every repo the account can see. */
  org?: string;
}

/** One account the provider CLI's keyring holds. */
export interface ProviderAccount {
  login: string;
  /** Whether the CLI itself would use this account today. */
  active: boolean;
}

/** What probing a provider CLI found. Feeds the binding panel. */
export interface ProviderProbeResult {
  /** The binary was found and runs. */
  available: boolean;
  /** Path actually resolved, when one was found. */
  resolvedBinary?: string;
  version?: string;
  /** Empty when nobody is signed in — the UI offers the login hint. */
  accounts: ProviderAccount[];
  error?: string;
}

export interface ProviderMeta {
  id: GitProviderId;
  /** "GitHub" */
  displayName: string;
  /** The binary the user installs, e.g. "gh". */
  cliName: string;
  /** The command that signs an account in, e.g. "gh auth login". */
  loginHint: string;
  installHint: string;
  /**
   * The fixed context header prepended to every action body, per item type.
   * Placeholders are the ones workItemPrompt.ts substitutes.
   */
  seedHeaderTemplate: Record<'pr' | 'issue', string>;
  /**
   * Canonical web URL per item type, `{{repo}}`/`{{number}}` substituted by
   * workItemUrl. Per-provider so a future non-GitHub driver names its own
   * host and path shape instead of workItemUrl hardcoding one.
   */
  webUrlTemplate: Record<'pr' | 'issue', string>;
}

export const PROVIDER_META: Record<GitProviderId, ProviderMeta> = {
  github: {
    id: 'github',
    displayName: 'GitHub',
    cliName: 'gh',
    loginHint: 'gh auth login',
    installHint: 'brew install gh (or see cli.github.com)',
    seedHeaderTemplate: {
      pr: 'This session is for pull request #{{number}} ("{{title}}") in {{repo}}. You are in a dedicated git worktree for it, so the user\'s own checkout stays untouched. Start with `gh pr view {{number}}` to read it.',
      issue: 'This session is for issue #{{number}} ("{{title}}") in {{repo}}. You are in a dedicated git worktree for it, so the user\'s own checkout stays untouched. Start with `gh issue view {{number}}` to read it.',
    },
    webUrlTemplate: {
      pr: 'https://github.com/{{repo}}/pull/{{number}}',
      issue: 'https://github.com/{{repo}}/issues/{{number}}',
    },
  },
};

/**
 * Whether an unknown value names a provider Consola has a driver for.
 *
 * An own-property check rather than `in`: this guards IPC payloads, and
 * `'toString' in PROVIDER_META` would be true.
 */
export function isGitProviderId(value: unknown): value is GitProviderId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROVIDER_META, value);
}
