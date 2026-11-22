import * as path from 'node:path';
import type { BranchPullRequestAnswer, FoundPullRequest } from '../../shared/branchPullRequest';
import type { GitProviderId } from '../../shared/providers';
import { INBOX_REFRESH_INTERVAL_MS } from '../../shared/workItems';
import type { Workspace } from '../../shared/workspace';
import type { BranchIdentity } from '../gitBranch';
import { describeError } from './errors';
import type { GitProviderDriver } from './GitProviderDriver';
import type { PullRequestQuery, PullRequestState } from './pullRequests';

/** A branch's pull request is asked about at most once per Inbox interval. */
export const BRANCH_LOOKUP_TTL_MS = INBOX_REFRESH_INTERVAL_MS;

export interface BranchPullRequestFinderDeps {
  getWorkspace(id: string): Workspace | undefined;
  /** getProviderDriver: throws on an id this build does not know. */
  resolveDriver(id: GitProviderId): GitProviderDriver;
  /** Login env plus the account's token, composed in main. Rejects when the token cannot be borrowed. */
  composeEnv(driver: GitProviderDriver, accountLogin: string): Promise<NodeJS.ProcessEnv>;
  /** The folder's branch, its name on the remote, and origin; null outside git. */
  readIdentity(dir: string): Promise<BranchIdentity | null>;
  now(): number;
}

/** A driver that can map origin to a repository and look a branch's pull requests up. */
type LookupDriver = GitProviderDriver &
  Required<Pick<GitProviderDriver, 'lookupPullRequests' | 'repoOfRemote'>>;

function canLookUp(driver: GitProviderDriver | null): driver is LookupDriver {
  return !!driver?.lookupPullRequests && !!driver.repoOfRemote;
}

/** What one lookup found, before it is stamped with the local branch it is answered for. */
type Outcome =
  | { kind: 'found'; pullRequest: FoundPullRequest }
  | { kind: 'none' }
  | { kind: 'failed'; error: string };

/**
 * Drops every answer asked `BRANCH_LOOKUP_TTL_MS` ago or longer: no find
 * serves it again, so the map holds only branches asked about lately.
 */
function dropStaleAnswers(answers: Map<string, { at: number }>, now: number): void {
  for (const [key, { at }] of answers) {
    if (now - at >= BRANCH_LOOKUP_TTL_MS) answers.delete(key);
  }
}

/** Newest first in; the open one wins, else the newest; null for none. */
export function pickPullRequest(states: readonly PullRequestState[]): PullRequestState | null {
  return states.find((state) => state.status === 'open') ?? states[0] ?? null;
}

/**
 * The pull request a checkout's branch has, for a session linked to none.
 *
 * Main reads the branch from the folder itself, so the renderer never names
 * one, and the driver maps origin to the repository the pull request lives in.
 *
 * The budget: the provider is asked at most once per `BRANCH_LOOKUP_TTL_MS`
 * (the Inbox's own interval) for each provider, account, repository and
 * branch name on the remote, however many sessions, folders or windows ask.
 * Callers that ask at once share one request, and only `force` (the person's
 * Refresh or Retry) asks sooner. A failure is kept as long as an answer, so a
 * broken CLI is not asked again on every session switch. An answer is dated
 * from when it was asked, not when it landed, so a caller that asks again one
 * interval after its answer arrived finds it old.
 *
 * An answer is never written to the session record. It is only shown, and
 * the session is linked when the person presses Link.
 */
export class BranchPullRequestFinder {
  private readonly answers = new Map<string, { at: number; outcome: Outcome }>();
  private readonly inFlight = new Map<string, Promise<Outcome>>();

  constructor(private readonly deps: BranchPullRequestFinderDeps) {}

  public async find(
    workspaceId: unknown,
    dir: unknown,
    options: { force?: boolean } = {},
  ): Promise<BranchPullRequestAnswer> {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return { kind: 'none', branch: null };
    const provider =
      typeof workspaceId === 'string' ? this.deps.getWorkspace(workspaceId)?.provider : undefined;
    if (!provider) return { kind: 'none', branch: null };

    const identity = await this.deps.readIdentity(dir);
    const branch = identity?.branch;
    if (!identity || !branch) return { kind: 'none', branch: null };
    // From here every answer names the branch, so the renderer can tell an
    // answer for this checkout from one for the branch it was on before.
    const driver = this.driverFor(provider.id);
    if (!canLookUp(driver) || !identity.originUrl) return { kind: 'none', branch };
    const repo = driver.repoOfRemote(identity.originUrl);
    if (!repo) return { kind: 'none', branch };
    if (provider.org && repo.split('/')[0].toLowerCase() !== provider.org.toLowerCase()) {
      return { kind: 'none', branch };
    }

    const query = { repo, headBranch: identity.remoteBranch ?? branch };
    const key = JSON.stringify([
      provider.id,
      provider.accountLogin.toLowerCase(),
      repo.toLowerCase(),
      query.headBranch,
    ]);
    const outcome = await this.outcomeFor(key, options.force === true, () =>
      this.ask(driver, provider.id, provider.accountLogin, query),
    );
    return { ...outcome, branch };
  }

  /** A provider this build does not know has nothing to ask. */
  private driverFor(id: GitProviderId): GitProviderDriver | null {
    try {
      return this.deps.resolveDriver(id);
    } catch {
      return null;
    }
  }

  /** The fresh answer unless forced, else the request already running, else a new one. */
  private outcomeFor(key: string, force: boolean, ask: () => Promise<Outcome>): Promise<Outcome> {
    const now = this.deps.now();
    dropStaleAnswers(this.answers, now);
    // Every answer left is fresh.
    const cached = this.answers.get(key);
    if (!force && cached) return Promise.resolve(cached.outcome);
    const running = this.inFlight.get(key);
    if (running) return running;
    const request = ask()
      .then((outcome) => {
        this.answers.set(key, { at: now, outcome });
        return outcome;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }

  /** One provider call. Never rejects: whatever goes wrong is the answer. */
  private async ask(
    driver: LookupDriver,
    providerId: GitProviderId,
    accountLogin: string,
    query: Extract<PullRequestQuery, { headBranch: string }>,
  ): Promise<Outcome> {
    try {
      const env = await this.deps.composeEnv(driver, accountLogin);
      const [lookup] = await driver.lookupPullRequests([query], env);
      // One answer per query is the driver's contract; none is not "no PR".
      if (!lookup) throw new Error('The provider gave no answer for this branch.');
      if (lookup.error) return { kind: 'failed', error: lookup.error };
      const pr = pickPullRequest(lookup.pullRequests);
      if (!pr) return { kind: 'none' };
      return {
        kind: 'found',
        pullRequest: {
          ref: { provider: providerId, repo: query.repo, type: 'pr', number: pr.number },
          status: pr.status,
          url: pr.url,
        },
      };
    } catch (error) {
      return { kind: 'failed', error: describeError(error) };
    }
  }
}
