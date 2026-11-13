import {
    CHECKS_QUERY,
    ISSUE_QUERY,
    MUTATIONS,
    PULL_REQUEST_ID_QUERY,
    PULL_REQUEST_QUERY,
    REVIEW_THREADS_QUERY,
    THREAD_COMMENTS_QUERY,
    assertOwners,
    checksIncomplete,
    incompleteThreads,
    issueDetails,
    nodeOwnersQuery,
    parseChecks,
    parseFiles,
    parseIssueHeader,
    parsePullRequestHeader,
    parsePullRequestId,
    parseStartedReviewId,
    parseThreadComments,
    parseThreads,
    parseTimeline,
    pullRequestDetails,
    timelineQuery,
    toThread,
    type OwnedNodeType,
} from './itemDetails';
import type { WorkItemDetails as SharedWorkItemDetails, WorkItemMutation } from '../../../shared/workItemDetails';
import { workItemMutationSchema } from '../../../shared/workItemDetails';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { PROVIDER_META } from '../../../shared/providers';
import type {
    GitProviderId,
    ProviderAccount,
    ProviderBinding,
    ProviderProbeResult,
} from '../../../shared/providers';
import type { InboxItem, WorkItemRef } from '../../../shared/workItems';
import { workItemUrl } from '../../../shared/workItems';
import { renderSeedHeader } from '../../../shared/workItemPrompt';
import { getLoginEnv, loginEnvProblem } from '../../LoginEnvironment';
import type { CheckoutOptions, GitProviderDriver, WorkItemDetails } from '../GitProviderDriver';
import type { PullRequestLookup, PullRequestQuery } from '../pullRequests';
import { INBOX_QUERY, INBOX_SEARCH_ALIASES, parseInboxPayload, searchStrings } from './inboxQuery';
import { parsePullsResponse, pullsEndpoint } from './pullRequests';
import { diffArgs, parseWorkItemDetails, viewArgs } from './workItemDetails';

const execFileAsync = promisify(execFile);

/**
 * GitHub, driven through the `gh` CLI.
 *
 * Consola stores zero GitHub credentials: `gh` owns the keyring, and this
 * driver borrows a per-account token at the moment it is needed. Tokens live
 * in memory for minutes — only so an account change is picked up promptly;
 * the tokens themselves are long-lived — and are never persisted and never
 * put on an IPC channel. There is deliberately no `gh auth switch` anywhere:
 * two workspaces on two accounts must be able to run at the same time.
 *
 * Everything gh-shaped lives here: the GraphQL fetch, `gh pr checkout`,
 * `gh repo clone`, remote-URL matching, the seed header. The services above
 * only ever see the GitProviderDriver interface.
 */

const BINARY_NAME = 'gh';
const RUN_TIMEOUT_MS = 10000;
const TOKEN_TTL_MS = 5 * 60 * 1000;
const WEB_HOST = 'github.com';
/** Parallel `gh api` calls per lookup batch: quick for a handful, polite for dozens. */
const PR_LOOKUP_CONCURRENCY = 4;

const REVIEW_EVENTS = { approve: 'APPROVE', 'request-changes': 'REQUEST_CHANGES', comment: 'COMMENT' } as const;

/** Each kind of edit: its mutation, and what the id it is given must be. */
const EDITS = {
    comment: { query: MUTATIONS.editComment, type: 'IssueComment' },
    review: { query: MUTATIONS.editReview, type: 'PullRequestReview' },
    'review-comment': { query: MUTATIONS.editReviewComment, type: 'PullRequestReviewComment' },
} as const;

/** The variables every item query takes. The service has already held `repo` to `owner/name`. */
function itemVars(ref: WorkItemRef): { owner: string; name: string; number: number } {
    const [owner, name] = ref.repo.split('/');
    return { owner, name, number: ref.number };
}

async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    work: (item: T) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await work(items[index]);
        }
    });
    await Promise.all(lanes);
    return results;
}

interface RunResult {
    stdout: string;
    stderr: string;
    failed: boolean;
    errorMessage?: string;
}

function isExecutable(candidate: string): boolean {
    try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/** Trim `gh version 2.63.1 (2026-01-15)` down to the version itself. */
function parseVersion(stdout: string): string | undefined {
    const match = stdout.match(/gh version (\S+)/);
    return match?.[1];
}

/**
 * The accounts `gh auth status` lists, with their active flags.
 *
 * Parsed line-by-line: an account line opens an entry and the following
 * `Active account:` line closes it. The masked token lines are deliberately
 * never captured — this result crosses IPC.
 */
function parseAccounts(text: string): ProviderAccount[] {
    const accounts: ProviderAccount[] = [];
    for (const line of text.split('\n')) {
        const login = line.match(/Logged in to \S+ account (\S+)/);
        if (login) {
            accounts.push({ login: login[1], active: false });
            continue;
        }
        const active = line.match(/Active account:\s*(true|false)/);
        if (active && accounts.length > 0) {
            accounts[accounts.length - 1].active = active[1] === 'true';
        }
    }
    return accounts;
}

/**
 * Drop any line that could carry a credential, for text that ends up in
 * `ProviderProbeResult.error` or an InboxSnapshot's error — both cross IPC.
 *
 * `parseAccounts` only recognizes today's `gh auth status` wording; a future
 * or unusual wording could slip past it while the masked `Token:` line is
 * still present, so the fallback text is scrubbed independently of parsing
 * rather than trusted just because parsing found nothing. Matches gh's own
 * credential-label lines (`Token:` / `Token scopes:`, anchored to the start
 * of the line so only the label counts) and any line carrying a raw or
 * masked token value (gh's `gho_`/`ghp_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`
 * prefixes) — deliberately NOT the bare word "token" anywhere in a line: gh
 * uses that word in genuine, non-secret diagnostics too (e.g. "no oauth
 * token found for account X"), and matching it unconditionally would drop
 * that useful text, pushing callers toward a less-safe, unscrubbed fallback
 * — which is exactly the failure mode this function exists to prevent.
 */
function stripTokenLines(text: string): string {
    return text
        .split('\n')
        .filter(
            (line) =>
                !/^\s*[-*]?\s*tokens?\s*(scopes?)?\s*:/i.test(line) &&
                !/\bgh[oprsu]_|\bgithub_pat_/i.test(line)
        )
        .join('\n')
        .trim();
}

/**
 * Node's `execFile` prefixes a non-zero-exit error's `message` with
 * `Command failed: <argv>` — an echo of the argv we already built ourselves,
 * never new information, and for `gh auth token` it always names the
 * "token" subcommand, which `stripTokenLines`'s label match deliberately
 * leaves alone as ordinary text. Dropped unconditionally before an error
 * message is used as a scrub source, so it never reintroduces the bare word
 * "token" (or, for a command with a query argument, that argument) into a
 * user-facing message.
 */
function stripCommandEcho(message: string): string {
    return message.replace(/^Command failed:.*(\n|$)/, '');
}

/**
 * `owner/repo` (lowercased) from a git remote URL that names github.com, or
 * null for anything else.
 *
 * Lowercased because GitHub treats repo names case-insensitively while
 * remembering the display casing — a clone made from a differently-cased URL
 * must still resolve. The host is checked because the same owner/name on
 * another host is a different repository entirely, and matching it would
 * point an agent's `gh` calls at the wrong one.
 */
function parseGitHubRemote(url: string): string | null {
    const trimmed = url.trim().replace(/\.git$/, '');
    if (!trimmed) return null;
    // scp-style: git@github.com:owner/repo
    const scp = trimmed.match(/^[^@\s/]+@([^:\s/]+):(.+)$/);
    // url-style: https://github.com/owner/repo or ssh://git@github.com/owner/repo
    const web = trimmed.match(/^\w+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/);
    const host = (scp?.[1] ?? web?.[1])?.toLowerCase();
    const repoPath = (scp?.[2] ?? web?.[2])?.replace(/^\/+/, '');
    if (host !== WEB_HOST || !repoPath) return null;
    const parts = repoPath.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`.toLowerCase();
}

export class GitHubDriver implements GitProviderDriver {
    readonly id: GitProviderId = 'github';
    readonly tokenEnvVar = 'GH_TOKEN';

    private readonly tokenCache = new Map<string, { token: string; fetchedAt: number }>();

    constructor(
        private readonly getEnv: () => NodeJS.ProcessEnv = getLoginEnv,
        private readonly tokenTtlMs: number = TOKEN_TTL_MS,
        private readonly envProblem: () => string | null = loginEnvProblem
    ) {}

    /**
     * Whether `gh` is installed, its version, and the keyring accounts.
     *
     * Feeds the binding panel's account picker and its "install gh" empty
     * state. Deliberately uncached: it runs when the panel opens, and
     * installing `gh` or running `gh auth login` must take effect without an
     * app restart.
     */
    public async probe(): Promise<ProviderProbeResult> {
        const binary = this.resolveBinary();
        if (!binary) {
            return {
                available: false,
                accounts: [],
                error: this.notFoundMessage(),
            };
        }

        const version = await this.run(binary, ['--version']);
        if (version.failed) {
            return {
                available: false,
                resolvedBinary: binary,
                accounts: [],
                // Both sources scrubbed: errorMessage embeds stderr verbatim
                // (via Node's "Command failed: ..." wrapping), so leaving it
                // raw would undo the scrub the moment stderr alone reduces
                // to nothing.
                error:
                    stripTokenLines(version.stderr) ||
                    stripTokenLines(stripCommandEcho(version.errorMessage ?? '')) ||
                    `\`${binary}\` did not run.`,
            };
        }

        // `gh auth status` exits non-zero and writes to stderr when nobody is
        // signed in (and historically wrote its report to stderr even on
        // success), so both streams are parsed and a failure is not fatal.
        const status = await this.run(binary, ['auth', 'status']);
        const accounts = parseAccounts(`${status.stdout}\n${status.stderr}`);

        return {
            available: true,
            resolvedBinary: binary,
            version: parseVersion(version.stdout),
            accounts,
            // Scrubbed rather than raw: this field crosses IPC, and a gh
            // version whose account-line wording parseAccounts doesn't
            // recognize would otherwise carry its masked `Token:` line
            // straight through here.
            ...(accounts.length === 0
                ? {
                      error:
                          stripTokenLines(`${status.stderr}\n${status.stdout}`) ||
                          'No GitHub accounts are signed in. Run `gh auth login`.',
                  }
                : {}),
        };
    }

    /**
     * A token for one keyring account, via `gh auth token --user <login>`.
     *
     * Cached in memory for a few minutes and nowhere else. Throws with gh's
     * own stderr on failure — the caller decides how to degrade.
     */
    public async token(accountLogin: string): Promise<string> {
        const cached = this.tokenCache.get(accountLogin);
        if (cached && Date.now() - cached.fetchedAt < this.tokenTtlMs) {
            return cached.token;
        }

        const binary = this.resolveBinary();
        if (!binary) {
            throw new Error(this.notFoundMessage());
        }

        const result = await this.run(binary, ['auth', 'token', '--user', accountLogin]);
        if (result.failed) {
            // Scrubbed like probe()'s failures, and both sources scrubbed
            // for the same reason: this error reaches InboxService's
            // InboxSnapshot.error, which is broadcast to every renderer, so
            // no raw subprocess text may cross that line — including via
            // errorMessage's verbatim copy of stderr once stderr alone
            // scrubs to nothing (e.g. stderr that is only a masked token
            // line). The literal fallback deliberately avoids the word
            // "token" itself, so a rejection is never mistaken for a leak.
            throw new Error(
                stripTokenLines(result.stderr) ||
                    stripTokenLines(stripCommandEcho(result.errorMessage ?? '')) ||
                    `gh could not authenticate ${accountLogin}.`
            );
        }

        const token = result.stdout.trim();
        if (!token) {
            throw new Error(`gh returned an empty token for ${accountLogin}.`);
        }

        this.tokenCache.set(accountLogin, { token, fetchedAt: Date.now() });
        return token;
    }

    /**
     * One `gh api graphql` call, five searches, parsed into neutral items.
     *
     * `env` is the caller's composed environment — the login env plus
     * GH_TOKEN — so the request runs as the workspace's account rather than
     * whatever the keyring considers active. The flag list is derived from
     * INBOX_SEARCH_ALIASES so the query, the parser and this argv cannot
     * drift apart. Parse failures propagate: an unrecognised reply must
     * never read as an empty inbox.
     */
    public async fetchInbox(binding: ProviderBinding, env: NodeJS.ProcessEnv): Promise<InboxItem[]> {
        const searches = searchStrings(binding.accountLogin, binding.org);
        const args = ['api', 'graphql', '-f', `query=${INBOX_QUERY}`];
        for (const alias of INBOX_SEARCH_ALIASES) {
            args.push('-f', `${alias}=${searches[alias]}`);
        }
        const stdout = await this.exec(args, env);
        return parseInboxPayload(JSON.parse(stdout));
    }

    /**
     * Everything the Inbox pane draws, as the workspace's account: the item
     * and the viewer's pending review (one query), its whole timeline and
     * review threads (each paginated to the end), and the changed files'
     * patches on REST, the only place GitHub serves them. Each request runs
     * at once; a thread or check list longer than its first page is
     * completed afterwards.
     */
    public async fetchDetails(ref: WorkItemRef, env: NodeJS.ProcessEnv): Promise<SharedWorkItemDetails> {
        const vars = itemVars(ref);
        if (ref.type !== 'pr') {
            const [header, timeline] = await Promise.all([
                this.graphql(ISSUE_QUERY, vars, env),
                this.graphql(timelineQuery('issue'), vars, env, true),
            ]);
            return issueDetails(parseIssueHeader(header), parseTimeline(timeline, 'issue'));
        }
        const [rawHeader, rawTimeline, rawThreads, rawFiles] = await Promise.all([
            this.graphql(PULL_REQUEST_QUERY, vars, env),
            this.graphql(timelineQuery('pr'), vars, env, true),
            this.graphql(REVIEW_THREADS_QUERY, vars, env, true),
            this.paginate(`repos/${ref.repo}/pulls/${ref.number}/files?per_page=100`, env),
        ]);
        const header = parsePullRequestHeader(rawHeader);
        const timeline = parseTimeline(rawTimeline, 'pr');
        const files = parseFiles(rawFiles);
        const threads = parseThreads(rawThreads);
        const [moreComments, checks] = await Promise.all([
            Promise.all(incompleteThreads(threads).map(async (thread) =>
                [thread.id, parseThreadComments(await this.graphql(THREAD_COMMENTS_QUERY, { id: thread.id }, env, true))] as const)),
            checksIncomplete(header) ? this.graphql(CHECKS_QUERY, vars, env, true).then(parseChecks) : Promise.resolve(undefined),
        ]);
        const complete = new Map(moreComments);
        return pullRequestDetails(header, timeline, threads.map((thread) => toThread(thread, complete.get(thread.id))), files, checks);
    }

    /**
     * One explicit write, always naming the item's repo. Writes addressed by
     * an id (a thread, a comment, a review) first ask GitHub which item that
     * id belongs to, and refuse one that is not this item's: the workspace's
     * org check is made on the ref, and an id would otherwise step around it.
     */
    public async mutateItem(ref: WorkItemRef, input: WorkItemMutation, env: NodeJS.ProcessEnv): Promise<void> {
        const mutation = workItemMutationSchema.parse(input);
        const prOnly: WorkItemMutation['kind'][] = [
            'review', 'merge', 'ready', 'update-branch', 'delete-comment', 'reply', 'resolve-thread', 'line-comment', 'discard-review',
        ];
        if (prOnly.includes(mutation.kind) && ref.type !== 'pr') {
            throw new Error('This action requires a pull request.');
        }
        const target = [String(ref.number), '--repo', `github.com/${ref.repo}`];
        const closing = (comment: string | undefined) => (comment ? ['--comment', comment] : []);
        switch (mutation.kind) {
            case 'comment':
                await this.exec([ref.type, 'comment', ...target, '--body', mutation.body], env);
                return;
            case 'edit':
                await this.exec([ref.type, 'edit', ...target, '--title', mutation.title, '--body', mutation.body], env);
                return;
            case 'close':
                if (mutation.reason && ref.type !== 'issue') throw new Error('Only an issue is closed with a reason.');
                await this.exec([
                    ref.type, 'close', ...target, ...closing(mutation.comment),
                    ...(mutation.reason ? ['--reason', mutation.reason === 'not-planned' ? 'not planned' : 'completed'] : []),
                ], env);
                return;
            case 'reopen':
                await this.exec([ref.type, 'reopen', ...target, ...closing(mutation.comment)], env);
                return;
            case 'ready':
                await this.exec(['pr', 'ready', ...target, ...(mutation.draft ? ['--undo'] : [])], env);
                return;
            case 'merge':
                await this.exec(['pr', 'merge', ...target, `--${mutation.method}`, '--match-head-commit', mutation.headOid,
                    ...(mutation.auto ? ['--auto'] : [])], env);
                return;
            case 'update-branch':
                // A merge of the base into the head, never a rebase: a rebase
                // rewrites commits other people may have checked out.
                await this.exec(['pr', 'update-branch', ...target], env);
                return;
            case 'review':
                if (mutation.pendingReviewId) {
                    await this.assertOwned(ref, [{ id: mutation.pendingReviewId, type: 'PullRequestReview' }], env);
                    await this.graphql(MUTATIONS.submitReview, {
                        id: mutation.pendingReviewId, event: REVIEW_EVENTS[mutation.event], ...(mutation.body ? { body: mutation.body } : {}),
                    }, env);
                    return;
                }
                if (mutation.event !== 'approve' && !mutation.body) throw new Error('A review comment is required.');
                await this.exec(['pr', 'review', ...target, `--${mutation.event}`, ...(mutation.body ? ['--body', mutation.body] : [])], env);
                return;
            case 'discard-review':
                await this.assertOwned(ref, [{ id: mutation.reviewId, type: 'PullRequestReview' }], env);
                await this.graphql(MUTATIONS.discardReview, { id: mutation.reviewId }, env);
                return;
            case 'edit-comment': {
                const { query, type } = EDITS[mutation.target];
                await this.assertOwned(ref, [{ id: mutation.id, type }], env);
                await this.graphql(query, { id: mutation.id, body: mutation.body }, env);
                return;
            }
            case 'delete-comment':
                await this.assertOwned(ref, [{ id: mutation.id, type: 'PullRequestReviewComment' }], env);
                await this.graphql(MUTATIONS.deleteReviewComment, { id: mutation.id }, env);
                return;
            case 'reply':
                await this.assertOwned(ref, [
                    { id: mutation.threadId, type: 'PullRequestReviewThread' },
                    ...(mutation.pendingReviewId ? [{ id: mutation.pendingReviewId, type: 'PullRequestReview' as const }] : []),
                ], env);
                await this.graphql(MUTATIONS.reply, {
                    threadId: mutation.threadId, body: mutation.body, ...(mutation.pendingReviewId ? { reviewId: mutation.pendingReviewId } : {}),
                }, env);
                return;
            case 'resolve-thread':
                await this.assertOwned(ref, [{ id: mutation.threadId, type: 'PullRequestReviewThread' }], env);
                await this.graphql(mutation.resolved ? MUTATIONS.resolveThread : MUTATIONS.unresolveThread, { threadId: mutation.threadId }, env);
                return;
            case 'line-comment':
                await this.lineComment(ref, mutation, env);
                return;
        }
    }

    /**
     * A comment on lines of the diff, anchored to the head commit the diff
     * was read at — never quietly moved to a newer one: if the pull request
     * has moved on, GitHub refuses, and the reader is told.
     *
     * Posted at once over REST, or held in the viewer's pending review over
     * GraphQL, starting the review first when there is none. GitHub keeps one
     * pending review per person, so a standalone comment cannot be posted
     * while one is open; the pane offers only the review then.
     */
    private async lineComment(
        ref: WorkItemRef,
        mutation: Extract<WorkItemMutation, { kind: 'line-comment' }>,
        env: NodeJS.ProcessEnv
    ): Promise<void> {
        if ((mutation.startLine === undefined) !== (mutation.startSide === undefined)) {
            throw new Error('A range needs both its first line and its side.');
        }
        if (mutation.startLine !== undefined && mutation.startSide === mutation.side && mutation.startLine >= mutation.line) {
            throw new Error('A range must start before the line it ends on.');
        }
        if (mutation.mode === 'single') {
            await this.exec([
                'api', '--hostname', WEB_HOST, `repos/${ref.repo}/pulls/${ref.number}/comments`, '--method', 'POST',
                '-f', `body=${mutation.body}`, '-f', `commit_id=${mutation.headOid}`, '-f', `path=${mutation.path}`,
                '-F', `line=${mutation.line}`, '-f', `side=${mutation.side}`,
                ...(mutation.startLine !== undefined ? ['-F', `start_line=${mutation.startLine}`, '-f', `start_side=${mutation.startSide}`] : []),
            ], env);
            return;
        }
        let reviewId = mutation.pendingReviewId;
        if (reviewId) {
            await this.assertOwned(ref, [{ id: reviewId, type: 'PullRequestReview' }], env);
        } else {
            const pullRequestId = parsePullRequestId(await this.graphql(PULL_REQUEST_ID_QUERY, itemVars(ref), env));
            reviewId = parseStartedReviewId(await this.graphql(MUTATIONS.startReview, { pullRequestId, commit: mutation.headOid }, env));
        }
        await this.graphql(MUTATIONS.addThread, {
            reviewId, body: mutation.body, path: mutation.path, line: mutation.line, side: mutation.side,
            ...(mutation.startLine !== undefined ? { startLine: mutation.startLine, startSide: mutation.startSide! } : {}),
        }, env);
    }

    /** Throws unless each id is a thing of its type on this item (itemDetails.assertOwners). */
    private async assertOwned(ref: WorkItemRef, nodes: Array<{ id: string; type: OwnedNodeType }>, env: NodeJS.ProcessEnv): Promise<void> {
        const vars = Object.fromEntries(nodes.map((node, index) => [`n${index}`, node.id]));
        assertOwners(await this.graphql(nodeOwnersQuery(nodes.length), vars, env), nodes, ref.repo, ref.number);
    }

    /**
     * One `gh api graphql` call. Strings go as raw fields (`-f`), so text
     * someone typed is never read as `@file` or converted; only the numbers
     * this driver builds itself go typed (`-F`). With `paginate`, gh follows
     * the query's one pageInfo to the end and hands back every page.
     */
    private async graphql(query: string, vars: Record<string, string | number>, env: NodeJS.ProcessEnv, paginate = false): Promise<unknown> {
        const args = ['api', 'graphql', '--hostname', WEB_HOST, ...(paginate ? ['--paginate', '--slurp'] : []), '-f', `query=${query}`];
        for (const [key, value] of Object.entries(vars)) {
            args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
        }
        return JSON.parse(await this.exec(args, env));
    }

    /** A REST list, every page of it. */
    private async paginate(endpoint: string, env: NodeJS.ProcessEnv): Promise<unknown[]> {
        const pages = JSON.parse(await this.exec(['api', '--hostname', WEB_HOST, endpoint, '--paginate', '--slurp'], env));
        if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) throw new Error('Unexpected GitHub list response.');
        return pages.flat();
    }

    /**
     * `gh pr checkout <n>` inside the worktree — gh owns the branch naming
     * and the fetch, with GH_TOKEN in `env`. An issue has no branch on
     * GitHub to fetch; WorktreeService creates its local `consola/issue-<n>`
     * branch itself, so for an issue there is nothing to do here.
     * `--force` is gh's own reset of a local branch it reuses.
     */
    public async checkout(worktreeDir: string, ref: WorkItemRef, env: NodeJS.ProcessEnv, options: CheckoutOptions = {}): Promise<void> {
        if (ref.type !== 'pr') return;
        await this.exec(['pr', 'checkout', String(ref.number), ...(options.resetBranch ? ['--force'] : [])], env, worktreeDir);
    }

    /**
     * `gh repo clone` rather than bare `git clone`: gh authenticates from
     * GH_TOKEN in the subprocess env, so private repos clone as the
     * workspace's account and Consola still stores zero credentials.
     */
    public async cloneRepo(repo: string, destinationDir: string, env: NodeJS.ProcessEnv): Promise<void> {
        await this.exec(['repo', 'clone', repo, destinationDir], env);
    }

    public matchesRemote(remoteUrl: string, repo: string): boolean {
        return parseGitHubRemote(remoteUrl) === repo.toLowerCase();
    }

    public workItemUrl(ref: WorkItemRef): string {
        return workItemUrl(ref);
    }

    /**
     * Uploads pasted into a PR or issue: `/user-attachments/assets/<id>`, and
     * the older per-repo `/<owner>/<repo>/assets/<n>/<id>`. In a private repo
     * both answer 404 without a token, and with one they redirect to a
     * short-lived signed URL. Exactly github.com over https, so the token is
     * never offered to any other host.
     */
    public isPrivateAsset(url: URL): boolean {
        if (url.protocol !== 'https:' || url.hostname !== WEB_HOST || url.port || url.username || url.password) return false;
        return /^\/user-attachments\/assets\/[\w-]+$/.test(url.pathname)
            || /^\/[\w.-]+\/[\w.-]+\/assets\/\d+\/[\w-]+$/.test(url.pathname);
    }

    public seedHeader(ref: WorkItemRef, item?: InboxItem): string {
        return renderSeedHeader(PROVIDER_META.github.seedHeaderTemplate, ref, item);
    }

    public repoOfRemote(remoteUrl: string): string | null {
        return parseGitHubRemote(remoteUrl);
    }

    /**
     * `gh pr view --json` (and `gh pr diff` for a pull request), always with
     * `--repo`: what an item is must never depend on the folder it is asked
     * from.
     */
    public async describeWorkItem(ref: WorkItemRef, env: NodeJS.ProcessEnv): Promise<WorkItemDetails> {
        const [view, diff] = await Promise.all([
            this.exec(viewArgs(ref), env),
            ref.type === 'pr' ? this.exec(diffArgs(ref), env) : Promise.resolve(undefined),
        ]);
        return parseWorkItemDetails(view, diff);
    }

    /**
     * One `gh api` call per query, a few at a time. Each query fails on its
     * own: one deleted repository must not hide the state of every other PR.
     */
    public async lookupPullRequests(
        queries: PullRequestQuery[],
        env: NodeJS.ProcessEnv
    ): Promise<PullRequestLookup[]> {
        return mapWithConcurrency(queries, PR_LOOKUP_CONCURRENCY, async (query) => {
            try {
                const endpoint = pullsEndpoint(query);
                // Endpoint first, flags after: gh accepts either order.
                const stdout = await this.exec(['api', endpoint, '--hostname', WEB_HOST], env);
                return { query, pullRequests: parsePullsResponse(query, stdout) };
            } catch (error) {
                return {
                    query,
                    pullRequests: [],
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        });
    }

    /**
     * Why `resolveBinary` came back empty. When Consola never got the login
     * shell's PATH, `gh` is most likely installed and simply out of sight, so
     * "not installed" would send the user looking in the wrong place.
     */
    private notFoundMessage(): string {
        const problem = this.envProblem();
        return problem
            ? `\`gh\` is not on PATH: Consola could not read your login shell's environment (${problem}), ` +
                  'so it has only the bare PATH apps are launched with. Restart Consola to try again.'
            : '`gh` is not installed or not on PATH.';
    }

    /**
     * Absolute path to `gh`, or null when nothing was found.
     *
     * `CONSOLA_GH_PATH` wins first — the seam the unit tests and the
     * Playwright rig use to point at a stub `gh` without touching the real
     * PATH or a real install. Otherwise this searches the login-shell PATH
     * like every binary Consola drives: a Dock-launched app inherits a
     * minimal environment, and getLoginEnv restores whatever the user's shell
     * profile puts on PATH — including Homebrew.
     *
     * Deliberately uncached (both branches) so installing `gh`, or changing
     * the override, takes effect without a restart.
     */
    private resolveBinary(): string | null {
        // No hardcoded fallback locations (unlike ClaudeDriver): getLoginEnv
        // already reproduces the user's real PATH, and machine-wide fallbacks
        // would make "gh is absent" untestable — and would override a user's
        // intentional PATH choice.
        const override = process.env.CONSOLA_GH_PATH;
        if (override) return override;

        const searchPath = this.getEnv().PATH ?? '';
        for (const dir of searchPath.split(path.delimiter)) {
            if (!dir) continue;
            const candidate = path.join(dir, BINARY_NAME);
            if (isExecutable(candidate)) return candidate;
        }
        return null;
    }

    /** probe/token: run in the ambient login env, never throw, hand back both streams. */
    private run(binary: string, args: string[]): Promise<RunResult> {
        return new Promise((resolve) => {
            execFile(
                binary,
                args,
                {
                    env: this.getEnv() as { [key: string]: string },
                    timeout: RUN_TIMEOUT_MS,
                    maxBuffer: 1024 * 1024,
                },
                (error, stdout, stderr) =>
                    resolve({
                        stdout,
                        stderr,
                        failed: error !== null,
                        errorMessage: error?.message,
                    })
            );
        });
    }

    /**
     * fetch/checkout/clone: run in the caller's composed env, surfacing
     * stderr as the Error message.
     *
     * The binary is resolved fresh on every call — a PATH scan is a handful
     * of stat calls — so CONSOLA_GH_PATH and a newly installed gh both take
     * effect at once. A bare `gh` when nothing resolves lets the spawn fail
     * loudly rather than inventing a location.
     */
    private async exec(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<string> {
        const binary = this.resolveBinary() ?? BINARY_NAME;
        try {
            const { stdout } = await execFileAsync(binary, args, {
                cwd,
                env: env as { [key: string]: string },
                maxBuffer: 10 * 1024 * 1024,
                // Unlike run(), this used to have no timeout: a hung `gh api
                // graphql` (or any exec caller) would pin
                // InboxService.inFlight[workspaceId] forever.
                timeout: 60_000,
            });
            return stdout;
        } catch (error) {
            const stderr = (error as { stderr?: string | Buffer }).stderr?.toString().trim() ?? '';
            const exitCode = (error as { code?: number | string }).code;
            // Scrubbed like probe()/token(): fetchInbox's rejection can
            // become InboxSnapshot.error, broadcast to every renderer, and
            // all three callers run with GH_TOKEN in `env`. The fallback
            // deliberately never falls back to error.message: that embeds
            // the full argv (fetchInbox's is a multi-KB GraphQL document),
            // so it names only the verb/noun that was run and gh's exit
            // code instead.
            throw new Error(
                stripTokenLines(stderr) ||
                    `gh ${args.slice(0, 2).join(' ')} failed${
                        exitCode !== undefined ? ` (exit ${exitCode})` : ''
                    }.`
            );
        }
    }
}
